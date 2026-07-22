/**
 * MCP search tool — Progressive Disclosure L1 (DUA-207).
 *
 * Registers the `search` tool that calls the concept search repository and
 * returns **index row summaries** (~100 tokens each: uuid + title + type +
 * one-line body snippet + relevance score).  This is the first layer of
 * progressive disclosure — the agent sees a catalog of results and then
 * uses `get_page` with a UUID to drill into full concept detail.
 *
 * Design:
 * - Scope-enforced: every query carries both team_id and project_id
 * - Uses FTS (full-text search) against concepts.search_tsv
 * - Reports explicit degradation when vector search is unavailable (§5.5)
 * - Returns compact index rows (no full body)
 * - Writes an audit record on every invocation
 * - Cross-team access returns empty (anti-enumeration)
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  projectId as projectIdSchema,
  listLimit,
  conceptType,
  conceptStatus,
  encodeCursor,
  decodeCursor,
  type CursorPayload,
} from '@teamem/schema';
import {
  getTeamId,
  getProjectId,
  isProjectScope,
} from '../../auth/scope.js';
import { searchConcepts } from '../../db/repositories/concepts-search.js';
import { writeAuditRecord } from '../../db/repositories/audit.js';
import type { McpTool, ToolHandler, ToolResult } from '../registry.js';

// ── Tool metadata ───────────────────────────────────────────────────────────

export const SEARCH_TOOL_NAME = 'search';

const SEARCH_TOOL_DESCRIPTION =
  'Search concept pages by keyword (full-text search).  Returns index-level ' +
  'summaries (uuid, title, type, status, one-line body snippet, relevance score) ' +
  'so the agent can scan results before drilling into a specific page with get_page.';

export const searchTool: McpTool = {
  name: SEARCH_TOOL_NAME,
  description: SEARCH_TOOL_DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'The project ID to search within',
      },
      query: {
        type: 'string',
        description: 'Search query (keywords, natural language).  Max 500 characters.',
      },
      type: {
        type: 'string',
        enum: ['service', 'concept', 'decision', 'gotcha', 'convention', 'runbook'],
        description: 'Optional: filter by concept type',
      },
      status: {
        type: 'string',
        enum: ['active', 'superseded', 'disputed', 'needs-review'],
        description: 'Optional: filter by concept status',
      },
      cursor: {
        type: 'string',
        description: 'Opaque cursor for pagination; omit for the first page',
      },
      limit: {
        type: 'number',
        description: 'Maximum results per page (default 20, max 100)',
      },
    },
    required: ['projectId', 'query'],
  },
};

// ── Input schema ────────────────────────────────────────────────────────────

const searchInputSchema = z.object({
  projectId: projectIdSchema.describe('The project ID to search within'),
  query: z.string().min(1).max(500).describe('Search query'),
  type: conceptType.optional().describe('Filter by concept type'),
  status: conceptStatus.optional().describe('Filter by concept status'),
  cursor: z.string().optional().describe('Opaque pagination cursor'),
  limit: listLimit.describe('Maximum results per page (default 20, max 100)'),
});

// ── Search result item (index-row shape) ───────────────────────────────────

/**
 * Compact index-row entry returned to the MCP client.
 *
 * Designed to be ~100 tokens: uuid + title + type + snippet + relevance.
 * The UUID is the key for progressive-disclosure L2 via `get_page`.
 */
interface SearchIndexRow {
  uuid: string;
  path: string;
  type: string;
  status: string;
  title: string;
  /** One-line body snippet (~200 chars, markdown stripped). */
  snippet: string;
  /** Relevance score [0, 1]. */
  relevance: number;
}

// ── Filter hash for cursor validation ──────────────────────────────────────

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

// ── Handler ─────────────────────────────────────────────────────────────────

/**
 * search tool handler.
 *
 * 1. Validates input arguments against the Zod schema.
 * 2. Enforces scope: project-scoped keys can only search their own project;
 *    cross-project access returns empty results (anti-enumeration).
 * 3. Calls the search repository (FTS) with scoped team_id + project_id.
 * 4. Returns compact index rows — no full body content.
 * 5. Writes an audit record (best-effort for non-sensitive reads).
 */
export const searchHandler: ToolHandler = async (
  args,
  ctx,
): Promise<ToolResult> => {
  const { db, auth, requestId } = ctx;

  // ── Validate input ──────────────────────────────────────────────────
  const parsed = searchInputSchema.safeParse(args);
  if (!parsed.success) {
    return {
      content: [
        {
          type: 'text',
          text: `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        },
      ],
      isError: true,
    };
  }

  const { projectId, query, type, status, cursor, limit } = parsed.data;
  const teamId = getTeamId(auth.scope);

  // ── Scope enforcement ───────────────────────────────────────────────
  // Project-scoped keys: silently return empty if querying a different project.
  if (isProjectScope(auth.scope)) {
    const scopeProjectId = getProjectId(auth.scope);
    if (projectId !== scopeProjectId) {
      // Anti-enumeration: identical empty response as a project with no matching concepts.
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              results: [],
              degraded: true,
              nextCursor: null,
            }),
          },
        ],
      };
    }
  }
  // allProjects keys: projectId is validated by the caller (the DB query is
  // still scoped to teamId + projectId — if the project doesn't exist or
  // belongs to another team, the DB returns 0 rows naturally).

  // ── Decode & validate cursor ────────────────────────────────────────
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
      return {
        content: [{ type: 'text', text: 'cursor_invalid' }],
        isError: true,
      };
    }

    cursorRelevance = parseFloat(decoded.position.sortValue);
    cursorId = decoded.position.id;
  }

  // ── Execute search ──────────────────────────────────────────────────
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

  // ── Map to index rows ───────────────────────────────────────────────
  const results: SearchIndexRow[] = result.rows.map((r) => ({
    uuid: r.uuid,
    path: r.path,
    type: r.type,
    status: r.status,
    title: r.title,
    snippet: r.bodySnippet,
    relevance: Math.round(r.relevance * 1000) / 1000, // round to 3 decimal places
  }));

  // ── Build next cursor ───────────────────────────────────────────────
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

  // ── Write audit record (best-effort) ────────────────────────────────
  try {
    await writeAuditRecord(db, {
      requestId,
      principalId: auth.principal?.id ?? null,
      credentialId: auth.credentialId,
      action: 'mcp.search',
      resourceType: 'concept',
      resourceId: null, // search is a multi-resource action
      teamId,
      projectId,
      outcome: 'success',
    });
  } catch {
    console.error(
      JSON.stringify({
        event: 'mcp_search_audit_write_failed',
        requestId,
        projectId,
      }),
    );
  }

  // ── Return index rows ───────────────────────────────────────────────
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          results,
          degraded: result.degraded,
          nextCursor,
        }),
      },
    ],
  };
};
