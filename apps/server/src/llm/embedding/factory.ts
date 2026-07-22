/**
 * Embedding client factory (AGPL-3.0-only, M1-EMB-01).
 *
 * Resolves a {@link ResolvedLlmConfig} into an {@link EmbeddingClient} or
 * `null`. The factory performs config validation and assembly only; the
 * real HTTP call path is delegated to the OpenAI-compatible embedding
 * adapter ({@link ./openai-compatible.adapter.js}).
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
import type { EmbeddingClient, EmbeddingClientDeps } from './port.js';
import {
  DEFAULT_EMBEDDING_MODELS,
  embeddingEndpoint,
  callEmbeddingApi,
} from './openai-compatible.adapter.js';

// Re-export for consumers.
export { EMBEDDING_DIMENSION } from './port.js';
export type { EmbeddingClient, EmbeddingClientDeps } from './port.js';
export { DEFAULT_EMBEDDING_MODELS, OPENAI_BASE_URL, OPENROUTER_BASE_URL } from './openai-compatible.adapter.js';

/** Default per-request timeout in milliseconds. */
const DEFAULT_TIMEOUT_MS = 30_000;

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
      callEmbeddingApi({
        provider,
        url,
        apiKey: resolved.apiKey,
        model,
        timeoutMs,
        fetchFn,
        inputs,
      }),
  };
}
