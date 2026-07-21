/**
 * Embedding client factory (AGPL-3.0-only, M1-EMB-01).
 *
 * Resolves a {@link ResolvedLlmConfig} into an {@link EmbeddingClient} or
 * `null`. The factory performs config validation and assembly only; the
 * real HTTP call path lives inline (following the pattern established by
 * the LLM factory) and will be extracted to a dedicated adapter in EMB-02.
 *
 * Supported providers (OpenAI-compatible embeddings endpoint):
 *   - `openai`      → https://api.openai.com/v1/embeddings
 *   - `openrouter`  → https://openrouter.ai/api/v1/embeddings
 *   - `custom`      → {baseUrl}/embeddings (any OpenAI-compatible endpoint)
 *
 * Unsupported providers (return `null`, upper layer falls back to FTS):
 *   - `claude`      → no public embedding API
 *
 * Rejected synchronously (throws {@link LlmError}):
 *   - `platform-managed` → not available in self-hosted build (§7)
 *   - `custom` with no default model and no explicit override
 */
import type { LlmProviderConfig, ResolvedLlmConfig } from '../../config/llm.js';
import { LlmError } from '../types.js';
import type { FetchLike } from '../types.js';
import type { EmbeddingClient, EmbeddingClientDeps } from './port.js';
import { EMBEDDING_DIMENSION } from './port.js';

// Re-export for consumers.
export { EMBEDDING_DIMENSION } from './port.js';
export type { EmbeddingClient, EmbeddingClientDeps } from './port.js';

/** OpenAI API host. */
const OPENAI_BASE_URL = 'https://api.openai.com/v1';
/** OpenRouter API host. */
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/** Default per-request timeout. */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Default embedding models per provider. These output 1536-dimensional
 * vectors matched to the project's fixed embedding target (AGENTS.md §4).
 *
 * `text-embedding-3-small` is OpenAI's recommended 1536-d model.
 * For OpenRouter the model identifier is prefixed `openai/` per their
 * routing convention. `custom` has no universal default; an explicit model
 * must be supplied via {@link EmbeddingClientDeps.defaultModel}.
 */
export const DEFAULT_EMBEDDING_MODELS: Readonly<
  Record<'openai' | 'openrouter' | 'custom', string>
> = Object.freeze({
  openai: 'text-embedding-3-small',
  openrouter: 'openai/text-embedding-3-small',
  custom: '',
});



/**
 * Build a provider-neutral {@link EmbeddingClient} for a resolved BYO config.
 *
 * @returns An {@link EmbeddingClient} for embedding-capable providers, or
 *          `null` when the provider does not support embeddings (Claude).
 *          Throws synchronously for `platform-managed` or an unusable custom
 *          config, before any network I/O.
 */
export function createEmbeddingClient(
  config: LlmProviderConfig,
  deps: EmbeddingClientDeps = {},
): EmbeddingClient | null {
  if (config.kind === 'platform-managed') {
    // Re-assert at the boundary: the factory is the last place a managed
    // shape could sneak through. Failing here means no transport, no fetch
    // URL, and no headers are ever constructed with a managed config —
    // the rejection provably precedes any network I/O (covered by tests).
    throw new LlmError('config_rejected', 'custom', '');
  }

  const resolved: ResolvedLlmConfig = config;

  // Only OpenAI-compatible providers support embeddings. Claude has no
  // public embedding API; return `null` so the upper layer can explicitly
  // fall back to full-text search (§5.5).
  if (resolved.kind === 'claude') {
    return null;
  }

  const provider = resolved.kind;
  const model = deps.defaultModel ?? DEFAULT_EMBEDDING_MODELS[provider];
  if (!model) {
    throw new LlmError('config_rejected', provider, '');
  }

  const timeoutMs = deps.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchFn = deps.fetch ?? globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    throw new LlmError('config_rejected', provider, '');
  }

  const url = embeddingEndpoint(resolved);

  return {
    generate: (inputs) =>
      runEmbedding(
        provider,
        url,
        resolved.apiKey,
        model,
        timeoutMs,
        fetchFn,
        inputs,
      ),
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Core embedding call path                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

async function runEmbedding(
  provider: 'openai' | 'openrouter' | 'custom',
  url: string,
  apiKey: string,
  model: string,
  timeoutMs: number,
  fetchFn: FetchLike,
  inputs: string[],
): Promise<number[][]> {
  if (inputs.length === 0) return [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    };
    if (provider === 'openrouter') {
      headers['X-Title'] = 'teamem';
    }

    const init: RequestInit = {
      method: 'POST',
      signal: controller.signal,
      headers,
      body: JSON.stringify({
        model,
        input: inputs,
        encoding_format: 'float',
      }),
    };

    let response: Response;
    try {
      response = await fetchFn(url, init);
    } catch (err) {
      if (controller.signal.aborted) {
        throw new LlmError('timeout', provider, '');
      }
      throw new LlmError(
        err instanceof Error && err.name === 'AbortError'
          ? 'aborted'
          : 'provider_error',
        provider,
        '',
      );
    }

    if (!response.ok) {
      await drain(response);
      throw new LlmError('http_error', provider, '', {
        httpStatus: response.status,
      });
    }

    const raw = await response.text();
    return parseOpenAiEmbeddingResponse(provider, raw, inputs.length);
  } catch (err) {
    if (err instanceof LlmError) throw err;
    // Unexpected failure — wrap without attaching raw error as cause
    // (§5.3: logs/inspect must not leak provider internals).
    throw new LlmError('provider_error', provider, '');
  } finally {
    clearTimeout(timer);
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Response parsing & validation                                              */
/* ────────────────────────────────────────────────────────────────────────── */

function parseOpenAiEmbeddingResponse(
  provider: 'openai' | 'openrouter' | 'custom',
  raw: string,
  expectedCount: number,
): number[][] {
  let envelope: unknown;
  try {
    envelope = JSON.parse(raw);
  } catch {
    throw new LlmError('provider_error', provider, '');
  }

  if (!isObject(envelope)) {
    throw new LlmError('provider_error', provider, '');
  }

  const data = envelope.data;
  if (!Array.isArray(data)) {
    throw new LlmError('provider_error', provider, '');
  }

  // Sort by index to preserve input order regardless of response ordering.
  const sorted = [...data].sort((a, b) => {
    const ai = isObject(a) ? Number(a.index ?? 0) : 0;
    const bi = isObject(b) ? Number(b.index ?? 0) : 0;
    return ai - bi;
  });

  const vectors: number[][] = [];
  for (const item of sorted) {
    if (!isObject(item)) {
      throw new LlmError('provider_error', provider, '');
    }
    const embedding = item.embedding;
    if (!Array.isArray(embedding)) {
      throw new LlmError('provider_error', provider, '');
    }
    if (embedding.length !== EMBEDDING_DIMENSION) {
      throw new LlmError('provider_error', provider, '');
    }
    // Every element must be a number (not null, not string, etc.).
    if (!embedding.every((v) => typeof v === 'number')) {
      throw new LlmError('provider_error', provider, '');
    }
    vectors.push(embedding as number[]);
  }

  if (vectors.length !== expectedCount) {
    throw new LlmError('provider_error', provider, '');
  }

  return vectors;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Helpers                                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

function embeddingEndpoint(config: ResolvedLlmConfig): string {
  switch (config.kind) {
    case 'openai':
      return `${OPENAI_BASE_URL}/embeddings`;
    case 'openrouter':
      return `${OPENROUTER_BASE_URL}/embeddings`;
    case 'custom': {
      const base = config.baseUrl.replace(/\/+$/, '');
      return `${base}/embeddings`;
    }
    default:
      // Unreachable: only embedding-capable providers reach here, and
      // platform-managed / claude are handled earlier in createEmbeddingClient.
      throw new LlmError('config_rejected', config.kind as 'openai', '');
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function drain(response: Response): Promise<void> {
  try {
    await response.text();
  } catch {
    // Ignore read errors on the discarded error body.
  }
}
