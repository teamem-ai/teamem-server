/**
 * F2 candidate recall — embedding narrowing (DUA-198 M1-F2-02).
 *
 * Provides {@link recallCandidates} — the pre-merge candidate shortlist
 * generator. Given a new F1-extracted concept, it recalls the top‑k most
 * semantically similar existing concept pages within the same project,
 * using either pgvector cosine similarity (when semantic capability is
 * `vector`) or PostgreSQL full-text search (when capability is `fts-only`).
 *
 * The returned shortlist feeds directly into F2-03's merge-decider, which
 * hands the candidates to a strong model for the final merge decision.
 * By narrowing from "all pages" to "top‑5 similar pages" we save LLM
 * tokens and improve attribution accuracy.
 *
 * Red lines satisfied:
 * - Every query carries team_id + project_id via ScopeContext (§5.5).
 * - Cross-team / allProjects scope returns empty — indistinguishable from
 *   "no similar concepts exist" (anti-enumeration).
 * - FTS degradation is explicit: each result row carries `mode: 'fts'`
 *   so the caller knows semantic search was unavailable (§5.5).
 * - No fixtures, no hard-coded results, no mock embedding distances.
 *
 * Dependencies:
 * - AppDb (scoped vector / FTS queries)
 * - EmbeddingClient (generate query embedding in vector mode)
 * - SemanticCapability (decide vector vs fts-only mode at call time)
 * - findSimilarConcepts (RET-01 shared vector search repository)
 */

import { and, eq, desc, sql } from 'drizzle-orm';
import * as schema from '../../db/schema.js';
import type { AppDb } from '../../db/client.js';
import { EMBEDDING_DIMENSION, type EmbeddingClient } from '../../llm/embedding/port.js';
import type { SemanticCapability } from '../../llm/embedding/capability.js';
import {
  findSimilarConcepts,
} from '../../db/repositories/concepts-vector-search.js';
import {
  type ScopeContext,
  isProjectScope,
} from '../../auth/scope.js';

// ── Result shape ────────────────────────────────────────────────────────────

/**
 * A single candidate concept recalled for the F2 merge-decider.
 *
 * Lightweight — contains only the semantic fields the strong model needs
 * plus a similarity (vector) or relevance (FTS) score. The caller (F2-03)
 * enriches with evidence summaries before building the merge prompt.
 */
export interface CandidateRecallResult {
  /** Canonical concept UUID — the immutable identity. */
  readonly uuid: string;
  /** Current path (readable locator; may be empty string if missing). */
  readonly path: string;
  /** Concept type. */
  readonly type: string;
  /** Concept status. */
  readonly status: string;
  /** Concept title. */
  readonly title: string;
  /** Concept tags. */
  readonly tags: string[];
  /**
   * Similarity / relevance score in [0, 1].
   *
   * In vector mode this is the cosine similarity derived from pgvector
   * cosine distance (1 − distance). In fts-only mode this is the
   * normalised ts_rank value. Higher = more similar.
   */
  readonly similarity: number;
  /** Which recall mode produced this result — observable degradation. */
  readonly mode: 'vector' | 'fts';
  /** First ~200 chars of the body for progressive-disclosure summary. */
  readonly bodySnippet: string;
}

// ── Error types ─────────────────────────────────────────────────────────────

/** Thrown when embedding generation fails in vector mode. The caller
 *  (F2 compiler) must treat this as a compilation failure — retry or
 *  route to human review, never silently no-op. */
export class CandidateRecallError extends Error {
  readonly name = 'CandidateRecallError';
}

// ── Dependencies ────────────────────────────────────────────────────────────

/**
 * Injectable dependencies for {@link recallCandidates}.
 *
 * `db` and `capability` are required. `embeddingClient` is only used
 * in vector mode; when absent in fts-only mode it is ignored.
 */
export interface RecallCandidatesDeps {
  readonly db: AppDb;
  readonly embeddingClient: EmbeddingClient | null;
  readonly capability: SemanticCapability;
}

// ── Params ──────────────────────────────────────────────────────────────────

export interface RecallCandidatesParams {
  /** Mandatory scope (red line §5.5). Only project scope produces results. */
  readonly scope: ScopeContext;
  /** The new F1-extracted concept whose title + body drive the search. */
  readonly newConcept: {
    readonly title: string;
    readonly body: string;
  };
  /** Maximum candidates to return. Default 5, max 20 (hard-coded cap). */
  readonly limit?: number;
  /**
   * Optional pre-computed query embedding (1536-d). When provided in
   * vector mode, the internal `embeddingClient.generate()` call is
   * skipped — the caller is responsible for ensuring the embedding
   * matches the `newConcept.title` + `newConcept.body` content.
   *
   * Ignored in fts-only mode.
   */
  readonly queryEmbedding?: number[];
}

// ── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;

// ── FTS fallback helpers ────────────────────────────────────────────────────

/**
 * Sanitize text for `websearch_to_tsquery`.
 *
 * PostgreSQL's `websearch_to_tsquery` is designed for user input, but we
 * apply additional guards: strip control characters, collapse whitespace,
 * and enforce a max length. We use the `simple` config for multi-language
 * compatibility (incl. CJK — DUA-190).
 */
function sanitizeFtsInput(raw: string): string {
  return raw
    .replace(/[\x00-\x1f\x7f]/g, ' ') // strip control chars
    .replace(/\s+/g, ' ')              // collapse whitespace
    .trim()
    .slice(0, 1000);
}

/**
 * Extract a one-line summary from concept body markdown for progressive
 * disclosure. Same algorithm as concepts-vector-search and concepts-search
 * repositories — kept local because this is the F2 compiler's own result
 * shaping, not a shared utility (yet).
 */
function extractBodySnippet(body: string): string {
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

// ── Main entry point ────────────────────────────────────────────────────────

/**
 * Recall the top‑k most similar existing concept pages for a new
 * F1-extracted concept.
 *
 * **Vector mode** (`capability.mode === 'vector'`):
 *  1. Generates a 1536‑dimensional embedding from the new concept's
 *     `title + body` via the injected {@link EmbeddingClient}.
 *  2. Queries pgvector via {@link findSimilarConcepts} (RET-01) for the
 *     top‑k most similar concepts by cosine distance within the project.
 *  3. Returns results with `mode: 'vector'` and cosine similarity scores.
 *
 * **FTS-only mode** (`capability.mode === 'fts-only'`):
 *  1. Builds a full-text search query from the new concept's `title + body`
 *     using `websearch_to_tsquery('simple', …)`.
 *  2. Queries the concepts table against the `search_tsv` tsvector column
 *     (maintained by a GENERATED ALWAYS AS STORED expression).
 *  3. Returns results with `mode: 'fts'` and normalised ts_rank relevance
 *     scores. Every result row explicitly reports `mode: 'fts'` so the
 *     degradation is observable (§5.5).
 *
 * **Scope enforcement** (red line §5.5):
 *  - `project` scope → queries within `team_id + project_id`.
 *  - `allProjects` scope → returns `[]` immediately (no concrete project to
 *    scope to — a project‑level vector/FTS search is meaningless without
 *    a project).
 *  - Cross-team probes return empty — indistinguishable from "no similar
 *    concepts exist" (anti-enumeration).
 *
 * **Limit**:
 *  - Default 5, max 20 (hard-coded cap for candidate recall — the merge
 *    decider prompt has limited context window).
 *
 * @throws {@link CandidateRecallError} when embedding generation fails in
 *         vector mode (the caller must treat this as a compilation failure).
 * @throws {@link import('../../db/repositories/concepts-vector-search.js').InvalidVectorSearchError}
 *         when the embedding dimension is wrong (should never happen if the
 *         embedding client is correctly configured).
 */
export async function recallCandidates(
  deps: RecallCandidatesDeps,
  params: RecallCandidatesParams,
): Promise<CandidateRecallResult[]> {
  const { db, embeddingClient, capability } = deps;
  const { scope, newConcept } = params;
  const limit = Math.max(1, Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT));

  // Require concrete project scope — allProjects has no projectId and
  // therefore cannot produce meaningful vector-search or FTS results,
  // because both are inherently project-scoped.
  if (!isProjectScope(scope)) {
    return [];
  }

  // ── Vector mode ────────────────────────────────────────────────────────
  if (capability.mode === 'vector') {
    // 1. Obtain the query embedding: use caller-provided pre-computed
    //    vector when available (avoids duplicate API call); otherwise
    //    generate it from title + body.
    let queryEmbedding: number[];
    if (params.queryEmbedding) {
      // Validate dimension of caller-provided embedding.
      if (params.queryEmbedding.length !== EMBEDDING_DIMENSION) {
        throw new CandidateRecallError(
          `Provided query embedding has ${params.queryEmbedding.length} dimensions, expected ${EMBEDDING_DIMENSION}`,
        );
      }
      queryEmbedding = params.queryEmbedding;
    } else {
      if (!embeddingClient) {
        throw new CandidateRecallError(
          'Semantic capability is "vector" but no embedding client is available. ' +
            'This is a server misconfiguration.',
        );
      }

      const embeddingText = `${newConcept.title}\n\n${newConcept.body}`;
      try {
        const vectors = await embeddingClient.generate([embeddingText]);
        const first = vectors[0];
        if (!first || first.length === 0) {
          throw new Error('Embedding API returned an empty result');
        }
        if (first.length !== EMBEDDING_DIMENSION) {
          throw new Error(
            `Embedding API returned ${first.length}-dimensional vectors, expected ${EMBEDDING_DIMENSION}`,
          );
        }
        queryEmbedding = first;
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : 'Embedding generation failed';
        throw new CandidateRecallError(
          `Failed to generate query embedding for candidate recall: ${message}`,
        );
      }
    }

    // 2. Query pgvector via RET-01 shared repository.
    const rows = await findSimilarConcepts(db, {
      scope,
      queryEmbedding,
      limit,
    });

    // 3. Map to CandidateRecallResult.
    return rows.map((r) => ({
      uuid: r.uuid,
      path: r.path,
      type: r.type,
      status: r.status,
      title: r.title,
      tags: r.tags,
      similarity: r.similarity,
      mode: 'vector' as const,
      bodySnippet: r.bodySnippet,
    }));
  }

  // ── FTS-only mode ──────────────────────────────────────────────────────
  // Build a FTS query string from the new concept's title + body.
  const ftsQuery = sanitizeFtsInput(`${newConcept.title} ${newConcept.body}`);

  if (ftsQuery.length === 0) {
    return [];
  }

  const { teamId, projectId } = scope;

  const tsQuery = sql`websearch_to_tsquery('simple', ${ftsQuery})`;
  const relevanceExpr = sql<number>`ts_rank(${schema.concepts.searchTsv}, ${tsQuery})`;

  const rows = await db
    .select({
      uuid: schema.concepts.uuid,
      type: schema.concepts.type,
      status: schema.concepts.status,
      title: schema.concepts.title,
      tags: schema.concepts.tags,
      body: schema.concepts.body,
      relevance: relevanceExpr,
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
        sql`${schema.concepts.searchTsv} @@ ${tsQuery}`,
      ),
    )
    .orderBy(desc(relevanceExpr))
    .limit(limit);

  return rows.map((r) => ({
    uuid: r.uuid,
    path: r.path ?? '',
    type: r.type,
    status: r.status,
    title: r.title,
    tags: r.tags,
    // Normalise ts_rank to a [0, 1] range for similarity-compatible display.
    // ts_rank with default normalization mode (0) typically returns values
    // in [0, 1] for most queries. We clamp to [0, 1] to guard against
    // edge-case values outside this range.
    similarity: Math.min(
      1,
      Math.max(0, Number(((r.relevance as number) ?? 0).toFixed(6))),
    ),
    mode: 'fts' as const,
    bodySnippet: extractBodySnippet(r.body),
  }));
}
