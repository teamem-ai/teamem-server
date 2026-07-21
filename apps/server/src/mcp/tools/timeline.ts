/**
 * MCP Timeline Tool (DUA-209 M1-MCP-04).
 *
 * Provides a `timeline` tool that returns project events ordered by
 * `occurred_at` DESC (source-event time), giving agents a progressive-
 * disclosure view of "what happened recently".
 *
 * Design:
 * - Scope-enforced: every query carries both team_id and project_id
 * - Sorted by occurred_at (NOT the event-list default created_at)
 * - Composite cursor pagination (occurred_at + id)
 * - Returns compact timeline entries (no payload)
 * - Writes an audit record on every invocation
 * - Cross-team access returns empty (anti-enumeration)
 */
import { createHash } from 'node:crypto';
import { and, eq, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  projectId as projectIdSchema,
  sourceKind,
  listLimit,
  encodeCursor,
  decodeCursor,
  type CursorPayload,
} from '@teamem/schema';
import { actor as actorSchema } from '@teamem/schema';
import * as schema from '../../db/schema.js';
import type { AppDb } from '../../db/client.js';
import type { AuthContext } from '../../db/repositories/api-keys.js';
import {
  getTeamId,
  getProjectId,
  isProjectScope,
  type ScopeContext,
} from '../../auth/scope.js';
import { writeAuditRecord } from '../../db/repositories/audit.js';
import { isoDateTime } from '@teamem/schema';

// ── Tool definition ─────────────────────────────────────────────────────────

export const TIMELINE_TOOL_NAME = 'timeline';

export const TIMELINE_TOOL_DESCRIPTION =
  'Return project events in a compact timeline ordered by occurred_at (source-event time). ' +
  'Use this to answer "what happened recently" questions. Returns id, occurredAt, kind, ' +
  'externalId, title, actor, and url for each entry. Supports cursor-based pagination.';

export const timelineInputSchema = z.object({
  projectId: projectIdSchema.describe('The project ID to query (required)'),
  cursor: z
    .string()
    .optional()
    .describe('Opaque cursor for pagination; omit for the first page'),
  limit: listLimit.describe('Maximum entries per page (default 20, max 100)'),
});

export type TimelineInput = z.infer<typeof timelineInputSchema>;

// ── Timeline entry shape ────────────────────────────────────────────────────

export const timelineEntrySchema = z.object({
  id: z.string(),
  occurredAt: isoDateTime,
  kind: sourceKind,
  externalId: z.string(),
  title: z.string(),
  actor: actorSchema.nullable(),
  url: z.string().nullable(),
});

export type TimelineEntry = z.infer<typeof timelineEntrySchema>;

export const timelineResponseSchema = z.object({
  data: z.array(timelineEntrySchema),
  nextCursor: z.string().nullable(),
});

export type TimelineResponse = z.infer<typeof timelineResponseSchema>;

// ── Title derivation ────────────────────────────────────────────────────────

/**
 * Derive a human-readable title for a timeline entry from the event's
 * source fields.
 *
 * For GitHub-derived events:
 *   - "PR owner/repo#42 opened"
 *   - "Issue owner/repo#99 created"
 *   - "Commit abc1234 pushed to main"
 * For other channels, falls back to "{kind} {externalId}".
 */
function deriveTitle(row: {
  kind: string;
  externalId: string;
  sourceEvent: string | null;
  sourceAction: string | null;
}): string {
  if (row.sourceEvent && row.sourceAction) {
    // e.g. "pull_request owner/repo#42 opened"
    return `${row.sourceEvent} ${row.externalId} ${row.sourceAction}`;
  }
  if (row.sourceEvent) {
    // e.g. "push owner/repo (abc1234)"
    return `${row.sourceEvent} ${row.externalId}`;
  }
  // Fallback: kind + externalId
  return `${row.kind} ${row.externalId}`;
}

// ── Database query ──────────────────────────────────────────────────────────

/**
 * Compact row returned by the timeline query.
 */
interface TimelineRow {
  id: string;
  occurredAt: Date;
  kind: string;
  externalId: string;
  sourceEvent: string | null;
  sourceAction: string | null;
  actor: Record<string, unknown> | null;
  url: string | null;
}

const TIMELINE_COLUMNS = {
  id: schema.events.id,
  occurredAt: schema.events.occurredAt,
  kind: schema.events.kind,
  externalId: schema.events.externalId,
  sourceEvent: schema.events.sourceEvent,
  sourceAction: schema.events.sourceAction,
  actor: schema.events.actor,
  url: schema.events.url,
};

/** Compute a stable filter hash for cursor validation. */
function computeTimelineFilterHash(): string {
  return createHash('sha256').update('timeline', 'utf8').digest('hex').slice(0, 16);
}

/**
 * Query events for the timeline, scoped to team + project, ordered by
 * `occurred_at DESC, id DESC`.
 *
 * Returns compact rows suitable for timeline display plus a nextCursor.
 */
async function queryTimeline(
  db: AppDb,
  scope: ScopeContext,
  projectId: string,
  cursor: string | undefined,
  limit: number,
): Promise<{ rows: TimelineRow[]; nextCursor: string | null }> {
  const teamId = getTeamId(scope);

  // For project-scoped keys, verify the key's project matches.
  if (isProjectScope(scope)) {
    const scopeProjectId = getProjectId(scope);
    if (projectId !== scopeProjectId) {
      return { rows: [], nextCursor: null };
    }
  }

  const currentFilterHash = computeTimelineFilterHash();

  // Build WHERE conditions
  const conditions = [
    eq(schema.events.teamId, teamId),
    eq(schema.events.projectId, projectId),
  ];

  // Cursor: decode and apply position + validate filter hash
  if (cursor) {
    const decoded = decodeCursor(cursor);
    if (
      decoded === null ||
      decoded.resource !== 'timeline' ||
      decoded.projectId !== projectId ||
      decoded.filterHash !== currentFilterHash
    ) {
      throw new Error('cursor_invalid');
    }

    // occurred_at < sortValue, OR (occurred_at = sortValue AND id < cursorId)
    const cursorSortValue = decoded.position.sortValue;
    const cursorId = decoded.position.id;

    conditions.push(
      or(
        lt(schema.events.occurredAt, new Date(cursorSortValue)),
        and(
          eq(schema.events.occurredAt, new Date(cursorSortValue)),
          lt(schema.events.id, cursorId),
        ),
      )!,
    );
  }

  // Fetch limit + 1 to detect hasMore
  const rows = await db
    .select(TIMELINE_COLUMNS)
    .from(schema.events)
    .where(and(...conditions))
    .orderBy(
      sql`${schema.events.occurredAt} DESC`,
      sql`${schema.events.id} DESC`,
    )
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const resultRows = (hasMore ? rows.slice(0, limit) : rows) as unknown as TimelineRow[];

  let nextCursor: string | null = null;
  if (hasMore && resultRows.length > 0) {
    const lastRow = resultRows[resultRows.length - 1]!;
    const nextPayload: CursorPayload = {
      resource: 'timeline',
      sort: 'occurred_at',
      v: 1,
      projectId,
      position: {
        sortValue: lastRow.occurredAt.toISOString(),
        id: lastRow.id,
      },
      filterHash: currentFilterHash,
    };
    nextCursor = encodeCursor(nextPayload);
  }

  return { rows: resultRows, nextCursor };
}

// ── Tool handler ────────────────────────────────────────────────────────────

export interface TimelineToolContext {
  db: AppDb;
  auth: AuthContext;
  requestId: string;
}

/**
 * Execute the timeline tool.
 *
 * 1. Validates input against the Zod schema
 * 2. Enforces scope (project-scoped key can only query its own project)
 * 3. Queries events ordered by occurred_at DESC
 * 4. Returns compact timeline entries with cursor pagination
 * 5. Writes an audit record
 */
export async function timelineHandler(
  rawInput: unknown,
  ctx: TimelineToolContext,
): Promise<TimelineResponse> {
  const { db, auth, requestId } = ctx;

  // 1. Validate input
  const parsed = timelineInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new TimelineValidationError(
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  }

  const { projectId, cursor, limit } = parsed.data;

  // 2. Scope enforcement
  if (isProjectScope(auth.scope)) {
    const scopeProjectId = getProjectId(auth.scope);
    if (projectId !== scopeProjectId) {
      // Return empty — don't leak project existence
      return { data: [], nextCursor: null };
    }
  }

  // 3. Query
  let result: { rows: TimelineRow[]; nextCursor: string | null };
  try {
    result = await queryTimeline(db, auth.scope, projectId, cursor, limit);
  } catch (err) {
    if (err instanceof Error && err.message === 'cursor_invalid') {
      throw new TimelineCursorInvalidError();
    }
    throw new TimelineInternalError('timeline query failed', {
      cause: err,
    });
  }

  // 4. Map to timeline entries
  const data: TimelineEntry[] = result.rows.map((row) => ({
    id: row.id,
    occurredAt: row.occurredAt.toISOString(),
    kind: row.kind as TimelineEntry['kind'],
    externalId: row.externalId,
    title: deriveTitle(row),
    actor: row.actor as TimelineEntry['actor'],
    url: row.url,
  }));

  // 5. Write audit record (best-effort — timeline is non-sensitive read,
  //    so we log but don't deny the response if audit write fails)
  try {
    await writeAuditRecord(db, {
      requestId,
      principalId: auth.principal?.id ?? null,
      credentialId: auth.credentialId,
      action: 'mcp.timeline',
      resourceType: 'event',
      resourceId: null,
      teamId: getTeamId(auth.scope),
      projectId,
      outcome: 'success',
    });
  } catch {
    // Audit write failure on a non-sensitive read — log but do not deny.
    console.error(
      JSON.stringify({
        event: 'mcp_timeline_audit_write_failed',
        requestId,
        projectId,
      }),
    );
  }

  return { data, nextCursor: result.nextCursor };
}

// ── Error types ─────────────────────────────────────────────────────────────

export class TimelineValidationError extends Error {
  readonly name = 'TimelineValidationError';
}

export class TimelineCursorInvalidError extends Error {
  readonly name = 'TimelineCursorInvalidError';
  constructor() {
    super('cursor_invalid');
  }
}

export class TimelineInternalError extends Error {
  readonly name = 'TimelineInternalError';
}
