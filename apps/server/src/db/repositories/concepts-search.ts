/**
 * Concept search repository (DUA-207 M1-MCP-02).
 *
 * Provides scoped full-text search (FTS) against the concepts table using
 * PostgreSQL's `websearch_to_tsquery('simple', query)` against the
 * `concepts_search_fts_gin` GIN index on `search_tsv`.
 *
 * Vector/semantic search (pgvector HNSW) is a future wiring path — the
 * API is designed to accept an optional embedding client, but the initial
 * implementation uses FTS exclusively and reports `ftsFallback: true` /
 * `degraded: true` transparently per the red line (§5.5).
 *
 * Every query carries both team_id and project_id. Cross-team access returns
 * empty results — never a distinguishable error (anti-enumeration).
 */
import { and, eq, or, desc, sql } from 'drizzle-orm';
import * as schema from '../schema.js';
import type { AppDb } from '../client.js';

// ── Result shape (subset of SearchResult from @teamem/schema) ──────────────

export interface SearchResultRow {
  readonly uuid: string;
  readonly path: string;
  readonly type: string;
  readonly status: string;
  readonly confidence: string;
  readonly title: string;
  readonly tags: string[];
  readonly lastConfirmed: Date;
  /** Relevance score [0, 1] — higher is more relevant. */
  readonly relevance: number;
  /** True when this result was produced by FTS rather than semantic vector search. */
  readonly ftsFallback: boolean;
  /** First ~200 chars of body for the index-row summary (progressive disclosure L1). */
  readonly bodySnippet: string;
}

// ── Search params ──────────────────────────────────────────────────────────

export interface SearchConceptsParams {
  readonly teamId: string;
  readonly projectId: string;
  readonly query: string;
  readonly type?: string;
  readonly status?: string;
  readonly limit: number;
  /** Cursor: relevance score of the last result on the previous page. */
  readonly cursorRelevance?: number;
  /** Cursor: UUID of the last result on the previous page (tiebreaker). */
  readonly cursorId?: string;
}

export interface SearchConceptsResult {
  readonly rows: SearchResultRow[];
  /** True when semantic search was unavailable and the entire query fell back to FTS. */
  readonly degraded: boolean;
  readonly hasMore: boolean;
}

// ── Query sanitization ─────────────────────────────────────────────────────

/**
 * Sanitize raw user input for `websearch_to_tsquery`. PostgreSQL's
 * `websearch_to_tsquery` is already designed for user input, but we apply
 * additional guards: trim, collapse whitespace, strip control characters,
 * and enforce a max length.
 */
function sanitizeQuery(raw: string): string {
  return raw
    .replace(/[\x00-\x1f\x7f]/g, ' ') // strip control chars
    .replace(/\s+/g, ' ')              // collapse whitespace
    .trim()
    .slice(0, 500);
}

// ── Body snippet extraction ────────────────────────────────────────────────

/**
 * Extract a one-line summary from concept body markdown for progressive
 * disclosure L1 indexing.  Strips markdown formatting and truncates to
 * ~200 characters at a word boundary.
 */
function extractBodySnippet(body: string): string {
  // Strip markdown formatting: headers, bold, italic, links, code
  const cleaned = body
    .replace(/^#{1,6}\s+/gm, '')          // ATX headers
    .replace(/\*\*([^*]+)\*\*/g, '$1')    // bold
    .replace(/__([^_]+)__/g, '$1')        // bold (underscore)
    .replace(/\*([^*]+)\*/g, '$1')        // italic
    .replace(/_([^_]+)_/g, '$1')          // italic (underscore)
    .replace(/`{1,3}[^`]*`{1,3}/g, '')   // inline code / code blocks
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links [text](url)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // images ![alt](url)
    .replace(/^>\s?/gm, '')               // blockquotes
    .replace(/^[-*+]\s+/gm, '')           // unordered list markers
    .replace(/^\d+\.\s+/gm, '')           // ordered list markers
    .replace(/---+/g, '')                 // horizontal rules
    .replace(/\n+/g, ' ')                 // newlines → spaces
    .replace(/\s+/g, ' ')                 // collapse whitespace
    .trim();

  if (cleaned.length <= 200) return cleaned;
  // Truncate at word boundary
  const truncated = cleaned.slice(0, 200);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > 100 ? truncated.slice(0, lastSpace) : truncated) + '…';
}

// ── Core search function ───────────────────────────────────────────────────

/**
 * Search concepts scoped to a team + project using PostgreSQL full-text search.
 *
 * Uses `websearch_to_tsquery('simple', query)` with the `simple` text search
 * config for multi-language compatibility (incl. CJK — DUA-190). Results are
 * ranked with `ts_rank` and sorted by relevance DESC, then UUID ASC as tiebreaker.
 *
 * Semantic (vector) search is NOT attempted in this initial implementation.
 * The `degraded` flag is always `true` and `ftsFallback` is `true` on every
 * result row, satisfying the explicit degradation red line (§5.5).
 *
 * When an embedding client is wired in the future, this function will:
 *   1. Generate a query vector
 *   2. Combine cosine similarity with FTS rank via a weighted hybrid score
 *   3. Report `degraded: false` and `ftsFallback: false`
 */
export async function searchConcepts(
  db: AppDb,
  params: SearchConceptsParams,
): Promise<SearchConceptsResult> {
  const { teamId, projectId, limit } = params;
  const sanitized = sanitizeQuery(params.query);

  if (sanitized.length === 0) {
    return { rows: [], degraded: true, hasMore: false };
  }

  // ── Build WHERE conditions ────────────────────────────────────────────
  const conditions: ReturnType<typeof eq | typeof and | typeof or | typeof sql>[] = [
    eq(schema.concepts.teamId, teamId),
    eq(schema.concepts.projectId, projectId),
  ];

  // FTS: match against the generated tsvector column
  conditions.push(
    sql`${schema.concepts.searchTsv} @@ websearch_to_tsquery('simple', ${sanitized})`,
  );

  if (params.type) {
    conditions.push(
      eq(schema.concepts.type, params.type as typeof schema.concepts.type.enumValues[number]),
    );
  }
  if (params.status) {
    conditions.push(
      eq(schema.concepts.status, params.status as typeof schema.concepts.status.enumValues[number]),
    );
  }

  // Cursor pagination: (relevance < cursorValue) OR (relevance = cursorValue AND uuid > cursorId)
  if (params.cursorRelevance !== undefined && params.cursorId) {
    conditions.push(
      or(
        sql`ts_rank(${schema.concepts.searchTsv}, websearch_to_tsquery('simple', ${sanitized})) < ${params.cursorRelevance}`,
        and(
          sql`ts_rank(${schema.concepts.searchTsv}, websearch_to_tsquery('simple', ${sanitized})) = ${params.cursorRelevance}`,
          sql`${schema.concepts.uuid} > ${params.cursorId}`,
        ),
      )!,
    );
  }

  // ── Build relevance expression ────────────────────────────────────────
  const relevanceExpr = sql<number>`ts_rank(${schema.concepts.searchTsv}, websearch_to_tsquery('simple', ${sanitized}))`.as('relevance');

  // ── Execute query ─────────────────────────────────────────────────────
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
      relevance: relevanceExpr,
      // Current path from concept_paths
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
    .where(and(...conditions) as ReturnType<typeof and>)
    .orderBy(
      desc(sql`ts_rank(${schema.concepts.searchTsv}, websearch_to_tsquery('simple', ${sanitized}))`),
      sql`${schema.concepts.uuid} ASC`,
    )
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const resultRows = hasMore ? rows.slice(0, limit) : rows;

  // ── Map to SearchResultRow ────────────────────────────────────────────
  const mapped: SearchResultRow[] = resultRows.map((r) => ({
    uuid: r.uuid,
    path: r.path ?? '',
    type: r.type,
    status: r.status,
    confidence: r.confidence,
    title: r.title,
    tags: r.tags,
    lastConfirmed: r.lastConfirmed,
    relevance: typeof r.relevance === 'number' ? r.relevance : 0,
    ftsFallback: true, // Always FTS in initial implementation
    bodySnippet: extractBodySnippet(r.body),
  }));

  return {
    rows: mapped,
    degraded: true, // Always degraded in initial FTS-only implementation
    hasMore,
  };
}
