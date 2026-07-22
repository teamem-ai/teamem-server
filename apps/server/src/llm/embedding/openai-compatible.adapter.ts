/**
 * OpenAI-compatible embedding adapter (AGPL-3.0-only, M1-EMB-02).
 *
 * Constructs and executes HTTP requests against OpenAI-compatible
 * `/embeddings` endpoints, parses responses, validates vector dimensions,
 * and redacts errors. Covers OpenAI official, OpenRouter, and custom
 * `base_url` on-premise/internal endpoints.
 *
 * The adapter's single job is text → vectors at the wire level:
 *   1. Build the request (URL, headers, body) for the embeddings endpoint.
 *   2. Execute via injected `fetch` with timeout/abort orchestration.
 *   3. Parse the response envelope, extract `data[].embedding` sorted by
 *      index, and validate every vector has exactly
 *      {@link EMBEDDING_DIMENSION} dimensions (1536).
 *   4. Redact all error surfaces — no API key, request body, or provider
 *      payload ever escapes via an error message.
 *
 * Every vector dimension is checked; non-1536 is treated as a configuration
 * error and rejected explicitly — no silent truncation or zero-padding.
 */
import { EMBEDDING_DIMENSION } from './port.js';
import { LlmError, type FetchLike } from '../types.js';
import type { ResolvedLlmConfig } from '../../config/llm.js';

// ── Provider base URLs ──────────────────────────────────────────────────────

/** OpenAI API host. */
export const OPENAI_BASE_URL = 'https://api.openai.com/v1';
/** OpenRouter API host. */
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

// ── Default models ──────────────────────────────────────────────────────────

/**
 * Default embedding models per provider. These output 1536-dimensional
 * vectors matched to the project's fixed embedding target (AGENTS.md §4).
 *
 * `text-embedding-3-small` is OpenAI's recommended 1536-d model.
 * For OpenRouter the model identifier is prefixed `openai/` per their
 * routing convention. `custom` has no universal default; an explicit model
 * must be supplied by the caller.
 */
export const DEFAULT_EMBEDDING_MODELS: Readonly<
  Record<'openai' | 'openrouter' | 'custom', string>
> = Object.freeze({
  openai: 'text-embedding-3-small',
  openrouter: 'openai/text-embedding-3-small',
  custom: '',
});

// ── Endpoint resolution ─────────────────────────────────────────────────────

/**
 * Build the embeddings endpoint URL for a resolved provider config.
 *
 * Strips trailing slashes from custom `baseUrl` so `https://host.test/v1///`
 * produces `https://host.test/v1/embeddings`.
 */
export function embeddingEndpoint(config: ResolvedLlmConfig): string {
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
      // platform-managed / claude are handled earlier in the factory.
      throw new LlmError('config_rejected', config.kind as 'openai', '');
  }
}

// ── Core embedding call ─────────────────────────────────────────────────────

/**
 * Parameters for a single embeddings API call.
 */
export interface EmbeddingApiCall {
  /** Provider kind — used only for error attribution and the OpenRouter
   *  `X-Title` header; does not affect the URL (already resolved). */
  provider: 'openai' | 'openrouter' | 'custom';
  /** Fully-resolved endpoint URL (from {@link embeddingEndpoint}). */
  url: string;
  /** API key sent as `Authorization: Bearer <key>`. */
  apiKey: string;
  /** Model identifier to request. */
  model: string;
  /** Per-request timeout in milliseconds. */
  timeoutMs: number;
  /** Injectable transport. */
  fetchFn: FetchLike;
  /** Input texts to embed. Empty array returns `[]` without a network call. */
  inputs: string[];
}

/**
 * Execute an embeddings API call against an OpenAI-compatible endpoint.
 *
 * Every vector in the response is validated to have exactly
 * {@link EMBEDDING_DIMENSION} elements. A vector with any other dimension
 * causes the entire call to fail with `provider_error` — no silent
 * truncation, no zero-padding, no partial acceptance.
 *
 * @returns An equal-length array of vectors, one per input.
 * @throws  {@link LlmError} on timeout, abort, HTTP error, or malformed
 *          response. Error messages are redacted (§5.3): no API key,
 *          request body, or provider payload is retained.
 */
export async function callEmbeddingApi(
  call: EmbeddingApiCall,
): Promise<number[][]> {
  const { provider, url, apiKey, model, timeoutMs, fetchFn, inputs } = call;

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

// ── Response parsing & validation ───────────────────────────────────────────

/**
 * Parse an OpenAI-compatible embeddings response body.
 *
 * Sorts returned items by their `index` field to guarantee input order
 * preservation regardless of the response ordering. Every vector is checked:
 *   - Must be an array of exactly {@link EMBEDDING_DIMENSION} numbers.
 *   - Every element must be `typeof 'number'` (no null, string, etc.).
 *   - The total count must equal `expectedCount`.
 *
 * Non-conforming responses throw `provider_error` — no partial acceptance,
 * no silent dimension coercion.
 */
export function parseOpenAiEmbeddingResponse(
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

// ── Helpers ─────────────────────────────────────────────────────────────────

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
