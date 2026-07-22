/**
 * POST /v1/search use case (DUA-204 M1-SR-02).
 *
 * Implements the search use case:
 *   1. Enforce scope: project-scoped keys can only search their own project;
 *      cross-project access returns empty results (anti-enumeration).
 *   2. For allProjects keys: verify the project exists and belongs to the team.
 *   3. Call RET-02 hybrid search (concepts-search.ts) with FTS.
 *   4. Assemble SR-01 response DTO (searchResponse from @teamem/schema).
 *   5. Write audit record per N7 whitelist — action, resource type, and hit
 *      resource IDs only; NO query text, payload, or request body.
 *   6. Pagination via composite cursor (relevance + uuid tiebreaker).
 *
 * Scope enforcement is done here, not in the caller — the use case is the
 * single entry point for all search operations (REST API, future MCP reuse).
 */
import { createHash } from 'node:crypto';
import {
  encodeCursor,
  decodeCursor,
  type SearchRequest,
  type SearchResponse,
  type SearchResult,
  type CursorPayload,
} from '@teamem/schema';
import type { AppDb } from '../db/client.js';
import {
  searchConcepts,
  type SearchResultRow,
} from '../db/repositories/concepts-search.js';
import { writeAuditRecord } from '../db/repositories/audit.js';
import type { ScopeContext } from '../auth/scope.js';
import {
  isProjectScope,
  getTeamId,
  getProjectId,
} from '../auth/scope.js';
import { and, eq } from 'drizzle-orm';
import * as schema from '../db/schema.js';

// ── Error types ─────────────────────────────────────────────────────────────

export class SearchUseCaseError extends Error {
  readonly name = 'SearchUseCaseError';
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

// ── Context (injected by HTTP / MCP caller) ────────────────────────────────

export interface SearchContext {
  /** Request ID for audit trails and error envelopes. */
  requestId: string;
  /** Credential ID (key_...) that authenticated this request. */
  credentialId: string | null;
  /** Resolved principal ID (pri_...), or null when unresolved. */
  principalId: string | null;
}

// ── Filter hash (cursor validation) ────────────────────────────────────────

/**
 * Compute a deterministic SHA-256 hash of the active search filters
 * (query, type, status) for cursor validation. If filters change between
 * pages, the cursor is rejected as `cursor_invalid`.
 */
function computeSearchFilterHash(params: {
  query: string;
  type?: string;
  status?: string;
}): string {
  const normalized: Record<string, string> = {};
  normalized['query'] = params.query;
  if (params.type) normalized['type'] = params.type;
  if (params.status) normalized['status'] = params.status;

  return createHash('sha256')
    .update(JSON.stringify(normalized, Object.keys(normalized).sort()))
    .digest('hex');
}

// ── DTO mapping ─────────────────────────────────────────────────────────────

/** Map a repository SearchResultRow to the frozen SearchResult DTO. */
function toSearchResult(row: SearchResultRow): SearchResult {
  return {
    uuid: row.uuid,
    path: row.path,
    type: row.type as SearchResult['type'],
    status: row.status as SearchResult['status'],
    confidence: row.confidence as SearchResult['confidence'],
    title: row.title,
    tags: row.tags,
    lastConfirmed: row.lastConfirmed.toISOString(),
    relevance: Math.round(row.relevance * 1000) / 1000, // round to 3 decimal places
    ftsFallback: row.ftsFallback,
  };
}

// ── Core use case ───────────────────────────────────────────────────────────

/**
 * Execute a scoped search query.
 *
 * The caller MUST have already Zod-validated the request body against
 * {@link SearchRequest} (the frozen DTO from `@teamem/schema`).
 *
 * Scope enforcement is performed here — the caller does NOT need to
 * pre-validate the projectId against the key scope. This function will:
 * - For project-scoped keys: silently return empty results when the
 *   request projectId differs from the key scope (anti-enumeration).
 * - For allProjects keys: verify the project exists in the team;
 *   return empty if not.
 *
 * Audit is written on every invocation (success or denied). The audit
 * record contains the whitelisted fields only — NO query text, payload,
 * or request body is stored (N7).
 *
 * @param db - The Drizzle database instance
 * @param scope - The authenticated scope context (project or allProjects)
 * @param request - Validated search request from the HTTP body
 * @param context - Request metadata for audit/error envelopes
 * @returns The frozen SearchResponse DTO
 */
export async function search(
  db: AppDb,
  scope: ScopeContext,
  request: SearchRequest,
  context: SearchContext,
): Promise<SearchResponse> {
  const { projectId, query, type, status, cursor, limit } = request;
  const teamId = getTeamId(scope);

  // ── Scope enforcement ──────────────────────────────────────────────────
  // Project-scoped keys: silently return empty if querying a different project.
  if (isProjectScope(scope)) {
    const scopeProjectId = getProjectId(scope);
    if (projectId !== scopeProjectId) {
      // Anti-enumeration: identical empty response as a project with no matches.
      // Write denied audit record (best-effort — do not block the response).
      await writeAuditRecord(db, {
        requestId: context.requestId,
        principalId: context.principalId,
        credentialId: context.credentialId,
        action: 'search.query',
        resourceType: 'concept',
        resourceId: null,
        teamId,
        projectId,
        outcome: 'denied',
      }).catch(() => {});

      return {
        requestId: context.requestId,
        results: [],
        degraded: true,
        nextCursor: null,
      };
    }
  } else {
    // allProjects key — verify the project exists AND belongs to the team.
    const projectRows = await db
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(
        and(
          eq(schema.projects.teamId, teamId),
          eq(schema.projects.id, projectId),
        ),
      )
      .limit(1);

    if (projectRows.length === 0) {
      // Project does not exist or belongs to another team — return empty
      // (anti-enumeration: indistinguishable from a project with no matches).
      await writeAuditRecord(db, {
        requestId: context.requestId,
        principalId: context.principalId,
        credentialId: context.credentialId,
        action: 'search.query',
        resourceType: 'concept',
        resourceId: null,
        teamId,
        projectId,
        outcome: 'denied',
      }).catch(() => {});

      return {
        requestId: context.requestId,
        results: [],
        degraded: true,
        nextCursor: null,
      };
    }
  }

  // ── Decode & validate cursor ──────────────────────────────────────────
  let cursorRelevance: number | undefined;
  let cursorId: string | undefined;

  const currentFilterHash = computeSearchFilterHash({ query, type, status });

  if (cursor) {
    const decoded = decodeCursor(cursor);
    if (
      decoded === null ||
      decoded.resource !== 'search' ||
      decoded.sort !== 'relevance' ||
      decoded.projectId !== projectId ||
      decoded.filterHash !== currentFilterHash
    ) {
      throw new SearchUseCaseError(
        'Cursor is invalid or has expired',
        'cursor_invalid',
      );
    }

    cursorRelevance = parseFloat(decoded.position.sortValue);
    cursorId = decoded.position.id;
  }

  // ── Execute search (RET-02) ───────────────────────────────────────────
  const result = await searchConcepts(db, {
    teamId,
    projectId,
    query,
    type,
    status,
    limit,
    cursorRelevance,
    cursorId,
  });

  // ── Map to DTOs ───────────────────────────────────────────────────────
  const results: SearchResult[] = result.rows.map(toSearchResult);

  // ── Build next cursor ─────────────────────────────────────────────────
  let nextCursor: string | null = null;
  if (result.hasMore && result.rows.length > 0) {
    const lastRow = result.rows[result.rows.length - 1]!;
    const nextPayload: CursorPayload = {
      resource: 'search',
      sort: 'relevance',
      v: 1,
      projectId,
      position: {
        sortValue: String(lastRow.relevance),
        id: lastRow.uuid,
      },
      filterHash: currentFilterHash,
    };
    nextCursor = encodeCursor(nextPayload);
  }

  // ── Write audit record (best-effort for read operations) ──────────────
  // N7: audit whitelist — action + resource type + resource IDs only.
  // NO query text, payload, or request body is stored.
  try {
    await writeAuditRecord(db, {
      requestId: context.requestId,
      principalId: context.principalId,
      credentialId: context.credentialId,
      action: 'search.query',
      resourceType: 'concept',
      resourceId: null, // search is a multi-resource action
      teamId,
      projectId,
      outcome: 'success',
    });
  } catch {
    console.error(
      JSON.stringify({
        event: 'api_search_audit_write_failed',
        requestId: context.requestId,
        projectId,
      }),
    );
  }

  // ── Return response ───────────────────────────────────────────────────
  return {
    requestId: context.requestId,
    results,
    degraded: result.degraded,
    nextCursor,
  };
}
