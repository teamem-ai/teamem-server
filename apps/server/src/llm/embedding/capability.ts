/**
 * Semantic capability detection (AGPL-3.0-only, M1-EMB-03).
 *
 * Provides the single decision point for whether the current deployment can
 * perform semantic (vector) search or must fall back to full-text search.
 *
 * The write path (concept page creation) and the retrieval path (search,
 * MCP get_page context) both read this capability to decide behaviour:
 *
 *   - `vector` → the embedding client is available; generate embeddings
 *     during concept writes and use pgvector similarity in search.
 *   - `fts-only` → no embedding client; leave the embedding column NULL
 *     during writes (a legal, explicitly-nullable column) and route all
 *     search through PostgreSQL full-text search (`tsvector` / GIN).
 *
 * The degradation is **explicit** — it is surfaced via the `log` callback
 * (or structured metrics in production) so operators can observe the mode
 * switch. The system never silently pretends vector search succeeded when
 * semantic capability is unavailable (§5.5 / AGENTS.md red line).
 */
import type { EmbeddingClient } from './port.js';

/**
 * The resolved semantic capability of the current deployment.
 *
 * `vector`  — an {@link EmbeddingClient} is wired and can produce 1536-d
 *             embeddings for concept pages and query vectors for search.
 * `fts-only` — no embedding client is available; all search degrades to
 *              PostgreSQL full-text search (`websearch_to_tsquery` against
 *              the `concepts_search_fts_gin` GIN index).
 */
export interface SemanticCapability {
  readonly mode: 'vector' | 'fts-only';
}

/**
 * Resolve the deployment's semantic capability from the (optional) embedding
 * client wired at the composition root.
 *
 * Injected at startup and read by every path that needs to decide between
 * vector and FTS behaviour — concept page writes, search, MCP context, etc.
 *
 * @param embeddingClient - The resolved {@link EmbeddingClient}, or `null`
 *   when the configured provider does not support embeddings (e.g. Claude).
 * @param options.log     - Optional callback that receives the degradation
 *   reason. Production deployments wire this to structured logging/metrics
 *   so the mode switch is observable. When omitted, the degradation is
 *   still enforced — only the observability side is skipped.
 *
 * @returns `{ mode: 'vector' }` when `embeddingClient` is non-null;
 *          `{ mode: 'fts-only' }` when `embeddingClient` is null.
 */
export function resolveSemanticCapability(
  embeddingClient: EmbeddingClient | null,
  options?: { log?: (message: string) => void },
): SemanticCapability {
  if (embeddingClient) {
    return { mode: 'vector' };
  }
  options?.log?.(
    'Semantic capability unavailable: no embedding client configured. ' +
      'Falling back to full-text search (fts-only). ' +
      'Set a supported embedding provider (openai, openrouter, or custom) to enable vector search.',
  );
  return { mode: 'fts-only' };
}
