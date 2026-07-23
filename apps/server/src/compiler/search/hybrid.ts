/**
 * Hybrid search orchestrator (DUA-192 M1-RET-02).
 *
 * Combines pgvector cosine-similarity candidate recall (RET-01) with
 * PostgreSQL full-text search (FTS-01) into a single relevance‑ranked,
 * de‑duplicated result set.
 *
 * Two modes, governed by the deployment's {@link SemanticCapability}:
 *
 *   `vector`  — query embedding → vector recall (primary) → FTS supplement
 *               → weighted score fusion → dedup → sort → stable pagination.
 *   `fts-only` — pure FTS via {@link ftsSearchConcepts}; every result is
 *                marked `ftsFallback: true` and the response carries
 *                `degraded: true`.  The degradation is **explicit** — the
 *                system never pretends vector search succeeded when
 *                semantic capability is unavailable (§5.5).
 *
 * Red lines satisfied:
 * - Every query carries scope (team_id + project_id) — no unscoped entry point.
 * - Cross‑team / missing‑scope probes return empty, indistinguishable from
 *   "no concepts exist" (anti‑enumeration).
 * - Semantic degradation is explicit and observable.
 * - No fixtures, no hard‑coded results, no mock vector distances.
 * - Composite cursor pagination (relevance + UUID tiebreaker), never offset.
 */
import { isProjectScope, getTeamId, getProjectId } from '../../auth/scope.js';
import type { ScopeContext } from '../../auth/scope.js';
import type { AppDb } from '../../db/client.js';
import {
  ftsSearchConcepts,
  type FtsSearchRow,
} from '../../db/repositories/concepts-fts-search.js';
import {
  findSimilarConcepts,
  type SimilarConceptRow,
} from '../../db/repositories/concepts-vector-search.js';
import type { EmbeddingClient } from '../../llm/embedding/port.js';
import type { SemanticCapability } from '../../llm/embedding/capability.js';

// ── Result shape ──────────────────────────────────────────────────────────

export interface HybridSearchRow {
  readonly uuid: string;
  readonly path: string;
  readonly type: string;
  readonly status: string;
  readonly confidence: string;
  readonly title: string;
  readonly tags: string[];
  readonly lastConfirmed: Date;
  /** Combined relevance score [0, 1] — higher is more relevant. */
  readonly relevance: number;
  /** True when this result was produced by FTS rather than semantic vector search. */
  readonly ftsFallback: boolean;
  /** First ~200 chars of body for the index-row summary. */
  readonly bodySnippet: string;
}

export interface HybridSearchResult {
  readonly rows: HybridSearchRow[];
  /** True when semantic search was unavailable and the query fell back entirely to FTS. */
  readonly degraded: boolean;
  readonly hasMore: boolean;
}

// ── Options ────────────────────────────────────────────────────────────────

export interface HybridSearchOptions {
  /** Filter by concept type. */
  readonly type?: string;
  /** Filter by concept status. */
  readonly status?: string;
  /** Maximum results per page (default 20, max 100). */
  readonly limit?: number;
  /** Cursor: relevance score of the last result on the previous page. */
  readonly cursorRelevance?: number;
  /** Cursor: UUID of the last result on the previous page (tiebreaker). */
  readonly cursorId?: string;
}

// ── Score fusion constants ─────────────────────────────────────────────────

/** Weight given to the vector similarity score in the combined score. */
const VECTOR_WEIGHT = 0.7;
/** Weight given to the FTS rank in the combined score. */
const FTS_WEIGHT = 0.3;

/**
 * Multiplier applied to the per‑source batch limit so the merge step has
 * enough headroom to satisfy a page even when the two sources return largely
 * disjoint result sets.  The final page is always capped at `limit`.
 */
const BATCH_MULTIPLIER = 5;

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_BATCH = 200; // safety cap — prevents unbounded fetch

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Clamp a similarity value to [0, 1] for score fusion.
 * Cosine similarity from pgvector can be negative (opposite-direction
 * embeddings), but negative similarity is not useful for ranking.
 */
function clampSimilarity(s: number): number {
  return Math.max(0, Math.min(1, s));
}

/**
 * Compute combined relevance score:
 *   - In both sources: weighted average
 *   - Vector only:       scaled vector score
 *   - FTS only:          scaled FTS score
 */
function combinedScore(
  vectorSimilarity: number | undefined,
  ftsRank: number | undefined,
): number {
  if (vectorSimilarity !== undefined && ftsRank !== undefined) {
    return VECTOR_WEIGHT * clampSimilarity(vectorSimilarity) + FTS_WEIGHT * ftsRank;
  }
  if (vectorSimilarity !== undefined) {
    return VECTOR_WEIGHT * clampSimilarity(vectorSimilarity);
  }
  // ftsRank must be defined here
  return FTS_WEIGHT * (ftsRank ?? 0);
}

// ── Core hybrid search ─────────────────────────────────────────────────────

/**
 * Execute a hybrid (vector + FTS) or FTS‑only search scoped to a project.
 *
 * ## Vector mode (`capability.mode === 'vector'`)
 *
 * 1. Generate a query embedding via `embeddingClient.generate([query])`.
 * 2. Call {@link findSimilarConcepts} for cosine‑similarity recall.
 * 3. Call {@link ftsSearchConcepts} for keyword recall.
 * 4. Merge by UUID with weighted score fusion:
 *    - Both sources: `0.7 × vector + 0.3 × fts`
 *    - Vector only:  `0.7 × vector`
 *    - FTS only:     `0.3 × fts`
 * 5. Sort by combined relevance DESC, UUID ASC (tiebreaker).
 * 6. Apply cursor pagination and cap at `limit`.
 *
 * ## FTS‑only mode (`capability.mode === 'fts-only'`)
 *
 * 1. Call {@link ftsSearchConcepts} directly.
 * 2. Mark every row `ftsFallback: true` and the result `degraded: true`.
 *
 * ## Scope enforcement
 *
 * - `allProjects` scope → returns `[]` immediately.  A project‑level
 *   hybrid search is not meaningful without a concrete project.
 * - Cross‑team: the SQL‑level `team_id` predicates in both sub‑queries
 *   return zero rows — indistinguishable from "no concepts exist."
 *
 * @param db             - The Drizzle database instance.
 * @param scope          - Authenticated scope context (must be project scope).
 * @param query          - Raw user query text (natural language or keywords).
 * @param capability     - Resolved semantic capability of the deployment.
 * @param embeddingClient - Required when `capability.mode === 'vector'`;
 *                          ignored otherwise.
 * @param options        - Optional filters, limit, and cursor.
 */
export async function hybridSearch(
  db: AppDb,
  scope: ScopeContext,
  query: string,
  capability: SemanticCapability,
  embeddingClient?: EmbeddingClient | null,
  options: HybridSearchOptions = {},
): Promise<HybridSearchResult> {
  // ── Scope enforcement ──────────────────────────────────────────────────
  // allProjects has no projectId; vector search requires a concrete project.
  if (!isProjectScope(scope)) {
    return { rows: [], degraded: capability.mode === 'fts-only', hasMore: false };
  }

  const teamId = getTeamId(scope);
  const projectId = getProjectId(scope);
  const limit = Math.min(options.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

  // ── FTS‑only path ──────────────────────────────────────────────────────
  if (capability.mode === 'fts-only') {
    const ftsResult = await ftsSearchConcepts(db, {
      teamId,
      projectId,
      query,
      type: options.type,
      status: options.status,
      limit,
      cursorRelevance: options.cursorRelevance,
      cursorId: options.cursorId,
    });

    const rows: HybridSearchRow[] = ftsResult.rows.map((r) => ({
      uuid: r.uuid,
      path: r.path,
      type: r.type,
      status: r.status,
      confidence: r.confidence,
      title: r.title,
      tags: r.tags,
      lastConfirmed: r.lastConfirmed,
      relevance: r.relevance,
      ftsFallback: true,
      bodySnippet: r.bodySnippet,
    }));

    return { rows, degraded: true, hasMore: ftsResult.hasMore };
  }

  // ── Vector path ────────────────────────────────────────────────────────
  if (!embeddingClient) {
    // Degrade gracefully: capability says vector but no client wired.
    // This shouldn't happen in normal operation (the composition root should
    // keep them consistent), but defend against mis‑wiring.
    const ftsResult = await ftsSearchConcepts(db, {
      teamId,
      projectId,
      query,
      type: options.type,
      status: options.status,
      limit,
      cursorRelevance: options.cursorRelevance,
      cursorId: options.cursorId,
    });

    const rows: HybridSearchRow[] = ftsResult.rows.map((r) => ({
      uuid: r.uuid,
      path: r.path,
      type: r.type,
      status: r.status,
      confidence: r.confidence,
      title: r.title,
      tags: r.tags,
      lastConfirmed: r.lastConfirmed,
      relevance: r.relevance,
      ftsFallback: true,
      bodySnippet: r.bodySnippet,
    }));

    return { rows, degraded: true, hasMore: ftsResult.hasMore };
  }

  // ── Generate query embedding ──────────────────────────────────────────
  let queryEmbedding: number[];
  try {
    const embeddings = await embeddingClient.generate([query]);
    if (!embeddings || embeddings.length === 0) {
      // Embedding generation returned empty — fall back to FTS.
      const ftsResult = await ftsSearchConcepts(db, {
        teamId,
        projectId,
        query,
        type: options.type,
        status: options.status,
        limit,
        cursorRelevance: options.cursorRelevance,
        cursorId: options.cursorId,
      });
      const rows: HybridSearchRow[] = ftsResult.rows.map((r) => ({
        uuid: r.uuid,
        path: r.path,
        type: r.type,
        status: r.status,
        confidence: r.confidence,
        title: r.title,
        tags: r.tags,
        lastConfirmed: r.lastConfirmed,
        relevance: r.relevance,
        ftsFallback: true,
        bodySnippet: r.bodySnippet,
      }));
      return { rows, degraded: true, hasMore: ftsResult.hasMore };
    }
    queryEmbedding = embeddings[0]!;
  } catch (err) {
    // Embedding generation failed — fall back to FTS.
    console.error(
      JSON.stringify({
        event: 'hybrid_search_embedding_failed',
        projectId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    const ftsResult = await ftsSearchConcepts(db, {
      teamId,
      projectId,
      query,
      type: options.type,
      status: options.status,
      limit,
      cursorRelevance: options.cursorRelevance,
      cursorId: options.cursorId,
    });
    const rows: HybridSearchRow[] = ftsResult.rows.map((r) => ({
      uuid: r.uuid,
      path: r.path,
      type: r.type,
      status: r.status,
      confidence: r.confidence,
      title: r.title,
      tags: r.tags,
      lastConfirmed: r.lastConfirmed,
      relevance: r.relevance,
      ftsFallback: true,
      bodySnippet: r.bodySnippet,
    }));
    return { rows, degraded: true, hasMore: ftsResult.hasMore };
  }

  // ── Parallel: vector recall + FTS ─────────────────────────────────────
  const batchLimit = Math.min(limit * BATCH_MULTIPLIER, MAX_BATCH);

  const [vectorRows, ftsResult] = await Promise.all([
    findSimilarConcepts(db, {
      scope,
      queryEmbedding,
      limit: batchLimit,
    }).catch((err) => {
      // Vector search failure → log and return empty (FTS will still contribute).
      console.error(
        JSON.stringify({
          event: 'hybrid_search_vector_failed',
          projectId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      return [] as SimilarConceptRow[];
    }),
    ftsSearchConcepts(db, {
      teamId,
      projectId,
      query,
      type: options.type,
      status: options.status,
      limit: batchLimit,
      // No cursor at source level — we merge and then paginate.
    }).catch((err) => {
      // FTS failure → log and return empty (vector will still contribute).
      console.error(
        JSON.stringify({
          event: 'hybrid_search_fts_failed',
          projectId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      return { rows: [] as FtsSearchRow[], hasMore: false };
    }),
  ]);

  // ── Merge by UUID ─────────────────────────────────────────────────────
  const merged = new Map<
    string,
    {
      uuid: string;
      path: string;
      type: string;
      status: string;
      confidence: string;
      title: string;
      tags: string[];
      lastConfirmed: Date;
      vectorSimilarity: number | undefined;
      ftsRank: number | undefined;
      bodySnippet: string;
    }
  >();

  // Index vector results.
  for (const r of vectorRows) {
    merged.set(r.uuid, {
      uuid: r.uuid,
      path: r.path,
      type: r.type,
      status: r.status,
      confidence: r.confidence,
      title: r.title,
      tags: r.tags,
      lastConfirmed: r.lastConfirmed,
      vectorSimilarity: r.similarity,
      ftsRank: undefined,
      bodySnippet: r.bodySnippet,
    });
  }

  // Merge FTS results — update existing entries or add new ones.
  for (const r of ftsResult.rows) {
    const existing = merged.get(r.uuid);
    if (existing) {
      existing.ftsRank = r.relevance;
      // Prefer the vector body snippet (typically more representative),
      // but keep whichever is longer as a heuristic.
      if (r.bodySnippet.length > existing.bodySnippet.length) {
        existing.bodySnippet = r.bodySnippet;
      }
    } else {
      merged.set(r.uuid, {
        uuid: r.uuid,
        path: r.path,
        type: r.type,
        status: r.status,
        confidence: r.confidence,
        title: r.title,
        tags: r.tags,
        lastConfirmed: r.lastConfirmed,
        vectorSimilarity: undefined,
        ftsRank: r.relevance,
        bodySnippet: r.bodySnippet,
      });
    }
  }

  // ── Compute combined scores ───────────────────────────────────────────
  const scored = Array.from(merged.values()).map((m) => ({
    ...m,
    relevance: combinedScore(m.vectorSimilarity, m.ftsRank),
    ftsFallback: m.vectorSimilarity === undefined,
  }));

  // ── Sort: combined relevance DESC, UUID ASC (tiebreaker) ──────────────
  scored.sort((a, b) => {
    const delta = b.relevance - a.relevance;
    if (delta !== 0) return delta;
    return a.uuid.localeCompare(b.uuid);
  });

  // ── Apply cursor pagination ───────────────────────────────────────────
  let startIdx = 0;
  if (options.cursorRelevance !== undefined && options.cursorId) {
    // Find the first result that is strictly after the cursor position.
    // Composite cursor: (relevance < cursorValue) OR (relevance == cursorValue AND uuid > cursorId)
    startIdx = scored.findIndex((r) => {
      if (r.relevance < options.cursorRelevance!) return true;
      if (r.relevance === options.cursorRelevance! && r.uuid > options.cursorId!) return true;
      return false;
    });
    if (startIdx === -1) {
      // All results are at or before the cursor — no more pages.
      return { rows: [], degraded: false, hasMore: false };
    }
  }

  const page = scored.slice(startIdx, startIdx + limit + 1);
  const hasMore = page.length > limit;
  const finalRows = hasMore ? page.slice(0, limit) : page;

  const rows: HybridSearchRow[] = finalRows.map((r) => ({
    uuid: r.uuid,
    path: r.path,
    type: r.type,
    status: r.status,
    confidence: r.confidence,
    title: r.title,
    tags: r.tags,
    lastConfirmed: r.lastConfirmed,
    relevance: Math.round(r.relevance * 1000) / 1000, // round to 3 decimal places
    ftsFallback: r.ftsFallback,
    bodySnippet: r.bodySnippet,
  }));

  return { rows, degraded: false, hasMore };
}
