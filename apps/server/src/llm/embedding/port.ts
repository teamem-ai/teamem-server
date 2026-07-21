/**
 * Embedding generation port (AGPL-3.0-only, M1-EMB-01).
 *
 * Defines the single boundary for text-to-vector embedding generation.
 * The caller (concept-page writer, search indexer, etc.) depends on this
 * interface, not on any concrete provider, so swapping embedding backends
 * is a composition-root wiring change.
 *
 * The project's fixed embedding target is 1536 dimensions (AGENTS.md §4).
 * When a configured provider does not support embeddings — Claude, for
 * example — the factory returns `null`, and the upper layer must explicitly
 * fall back to full-text search (§5.5: never pretend vector search succeeded
 * when semantic capability is unavailable).
 */
import type { FetchLike } from '../types.js';

/** Fixed embedding dimension per AGENTS.md §4. */
export const EMBEDDING_DIMENSION = 1536;

/**
 * Provider-neutral embedding client. One operation: take an array of input
 * strings and return an equal-length array of 1536-dimensional vectors.
 */
export interface EmbeddingClient {
  /**
   * Generate embeddings for an array of input strings.
   *
   * @returns An array of vectors, one per input, each of length
   *          {@link EMBEDDING_DIMENSION} (1536). The returned array is
   *          guaranteed to have the same length as `inputs`.
   * @throws  An {@link import('../types.js').LlmError} on failure (timeout,
   *          HTTP error, provider error, validation failure).
   */
  generate(inputs: string[]): Promise<number[][]>;
}

/**
 * Injectable dependencies for the embedding factory. Mirrors
 * {@link import('../types.js').LlmClientDeps} so the same composition-root
 * overrides (fetch, default model, timeout) apply to both LLM and embedding.
 */
export interface EmbeddingClientDeps {
  /** Override the default embedding model for the provider. */
  defaultModel?: string;
  /** Default per-request timeout in ms. */
  defaultTimeoutMs?: number;
  /** Transport; defaults to `globalThis.fetch`. */
  fetch?: FetchLike;
}
