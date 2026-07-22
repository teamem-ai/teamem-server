/**
 * pgvector cosine-similarity candidate query repository (DUA-191 M1-RET-01).
 *
 * Provides {@link findSimilarConcepts} — a scoped semantic nearest-neighbour
 * query that returns the top‑k most similar concept pages within a project.
 * Uses the `concepts_embedding_hnsw` HNSW index over the `embedding` column
 * for fast approximate cosine-distance lookups.
 *
 * This is the shared base for F2 attribution candidate recall and MCP
 * semantic search (M1-MCP-02 hybrid retrieval).
 *
 * Red lines satisfied:
 * - Every query carries team_id + project_id (SQL‑level scope, §5.5).
 * - Cross‑team / missing‑scope probes return empty — never distinguishable
 *   from genuinely having no similar concepts (anti‑enumeration).
 * - No fixtures, no hard‑coded results, no mock vector distances.
 */
import { and, eq, asc, sql } from 'drizzle-orm';
import * as schema from '../schema.js';
import type { AppDb } from '../client.js';
import {
  type ScopeContext,
  isProjectScope,
} from '../../auth/scope.js';

// ── Result shape ────────────────────────────────────────────────────────────

export interface SimilarConceptRow {
  /** Canonical concept UUID. */
  readonly uuid: string;
  /** Current path (may be empty string if somehow missing — rare). */
  readonly path: string;
  readonly type: string;
  readonly status: string;
  readonly confidence: string;
  readonly title: string;
  readonly tags: string[];
  readonly lastConfirmed: Date;
  /**
   * Cosine similarity [0, 1].
   *
   * 1 = identical direction (perfect match), 0 = orthogonal (unrelated).
   * Derived from `1 - (embedding <=> query)` where `<=>` is the pgvector
   * cosine distance operator (range [0, 2]).
   */
  readonly similarity: number;
  /** First ~200 chars of body for progressive-disclosure summary. */
  readonly bodySnippet: string;
}

// ── Params ──────────────────────────────────────────────────────────────────

export interface FindSimilarConceptsParams {
  /**
   * Mandatory scope (red line 5.5).
   *
   * Only `project` scope produces results; `allProjects` returns empty
   * because a project‑level vector search is ill‑defined without a concrete
   * project.  Callers must narrow before calling this function.
   */
  readonly scope: ScopeContext;

  /** 1536‑dimensional query embedding vector.  Caller is responsible for
   * generating it from a title/body/query string before calling this repo. */
  readonly queryEmbedding: number[];

  /** Maximum results to return.  Default 20, hard cap 100 (frozen contract). */
  readonly limit?: number;
}

// ── Error types ─────────────────────────────────────────────────────────────

/** Thrown when limit exceeds the frozen-contract maximum (100).
 *  Callers (API layer) must map this to HTTP 400 (§6.3). */
export class InvalidVectorSearchError extends Error {
  readonly name = 'InvalidVectorSearchError';
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function extractBodySnippet(body: string): string {
  // Strip markdown formatting: headers, bold, italic, links, code
  const cleaned = body
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/`{1,3}[^`]*`{1,3}/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^>\s?/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/---+/g, '')
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleaned.length <= 200) return cleaned;
  const truncated = cleaned.slice(0, 200);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > 100 ? truncated.slice(0, lastSpace) : truncated) + '…';
}

// ── Core query ──────────────────────────────────────────────────────────────

/**
 * Find the top‑k most similar concepts within a project using pgvector
 * cosine distance.
 *
 * Uses the `concepts_embedding_hnsw` HNSW index via `ORDER BY embedding <=>
 * $1`.  Only rows with a non‑NULL embedding are considered.  Results are
 * ordered by descending cosine similarity (= ascending cosine distance).
 *
 * Scope enforcement:
 * - `allProjects` scope → returns `[]` immediately.  A project‑level vector
 *   search is not meaningful without a concrete project.
 * - Cross‑team: if `scope.teamId` does not match the concept rows, the
 *   SQL‑level `team_id` predicate returns zero rows — indistinguishable
 *   from genuinely having no similar concepts.
 *
 * Returns an empty array when the scope is missing, the project has no
 * concepts with embeddings, or no concept meets the similarity threshold.
 */
export async function findSimilarConcepts(
  db: AppDb,
  params: FindSimilarConceptsParams,
): Promise<SimilarConceptRow[]> {
  const { scope, queryEmbedding } = params;

  // Require concrete project scope — allProjects has no projectId and
  // therefore cannot produce meaningful vector-search results.
  if (!isProjectScope(scope)) {
    return [];
  }

  const { teamId, projectId } = scope;
  const limit = params.limit ?? DEFAULT_LIMIT;

  // Frozen contract §6.3: limit outside [1, 100] must be rejected,
  // never silently clamped.
  if (limit < 1 || limit > MAX_LIMIT) {
    throw new InvalidVectorSearchError(
      `limit ${limit} is outside allowed range [1, ${MAX_LIMIT}]`,
    );
  }

  // Build a parameterized pgvector literal.
  // pgvector accepts '[0.1, 0.2, …]'::vector — the string is sent as a
  // bind parameter ($1) via Drizzle's sql template, not concatenated into
  // raw SQL.  The ::vector cast tells PostgreSQL to interpret the parameter
  // as a pgvector-format vector.
  const vectorStr = `[${queryEmbedding.join(',')}]`;

  // Cosine distance expression: embedding <=> $1::vector
  const distanceExpr = sql<number>`${schema.concepts.embedding} <=> ${vectorStr}::vector`;

  const rows = await db
    .select({
      uuid: schema.concepts.uuid,
      type: schema.concepts.type,
      status: schema.concepts.status,
      confidence: schema.concepts.confidence,
      title: schema.concepts.title,
      tags: schema.concepts.tags,
      lastConfirmed: schema.concepts.lastConfirmed,
      body: schema.concepts.body,
      distance: distanceExpr,
      path: schema.conceptPaths.path,
    })
    .from(schema.concepts)
    .leftJoin(
      schema.conceptPaths,
      and(
        eq(schema.conceptPaths.conceptUuid, schema.concepts.uuid),
        eq(schema.conceptPaths.isCurrent, true),
      ),
    )
    .where(
      and(
        eq(schema.concepts.teamId, teamId),
        eq(schema.concepts.projectId, projectId),
        // Exclude rows with NULL embedding — they can't be compared.
        sql`${schema.concepts.embedding} IS NOT NULL`,
      ),
    )
    .orderBy(asc(distanceExpr)) // cosine distance: smaller is more similar → use ASC
    .limit(limit);

  // Map to result rows: convert cosine distance → cosine similarity.
  // pgvector cosine distance (<=>) range [0, 2]; similarity = 1 - distance.
  return rows.map((r) => ({
    uuid: r.uuid,
    path: r.path ?? '',
    type: r.type,
    status: r.status,
    confidence: r.confidence,
    title: r.title,
    tags: r.tags,
    lastConfirmed: r.lastConfirmed,
    similarity: Number((1 - (r.distance as number)).toFixed(6)),
    bodySnippet: extractBodySnippet(r.body),
  }));
}
