/**
 * GET /v1/jobs and GET /v1/jobs/:id — job list and detail queries (DUA-156).
 *
 * List: scoped status filtering, created_at desc + id cursor, summary only
 *   (no per-event details).
 * Detail: full job row + per-event outcomes as a frozen discriminated union;
 *   sanitized errors only (no raw provider failure text).
 *
 * All queries carry team_id + project scope (red line 5.5). Every response
 * uses frozen DTOs from @teamem/schema.
 */
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  jobListQuery,
  jobListResponse,
  jobDetailResponse,
  jobListItem,
  job,
  type JobEventResult,
  type JobInitiator,
  type JobStatus,
} from '@teamem/schema';
import * as schema from '../../db/schema.js';
import type { AppDb } from '../../db/client.js';
import {
  getJob,
  getJobEvents,
  listJobs,
  validateJobsCursor,
  type JobRow,
  type JobEventRow,
} from '../../db/repositories/jobs.js';
import { isProjectScope, getTeamId, getProjectId } from '../../auth/scope.js';
import { requireAuth, requireScope, getAuth } from '../auth.js';
import {
  InvalidRequestError,
  NotFoundError,
  CursorInvalidError,
  REQUEST_ID_KEY,
} from '../errors.js';

// ── Handler dependencies ────────────────────────────────────────────────────

export interface JobsReadDeps {
  db: AppDb;
}

// ── Mapping helpers (DB row → frozen DTO) ──────────────────────────────────

function toJobListItem(row: JobRow): z.infer<typeof jobListItem> {
  return {
    id: row.id,
    projectId: row.projectId,
    status: row.status as JobStatus,
    attempts: row.attempts,
    initiatedBy: toJobInitiator(row),
    eventCount: row.eventCount,
    conceptIds: undefined, // not populated in list summary
    error: toSanitizedError(row.error),
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString(),
    finishedAt: row.finishedAt?.toISOString(),
  };
}

function toJobDetail(
  row: JobRow,
  events: JobEventRow[],
): z.infer<typeof job> {
  return {
    id: row.id,
    projectId: row.projectId,
    status: row.status as JobStatus,
    attempts: row.attempts,
    initiatedBy: toJobInitiator(row),
    eventCount: row.eventCount,
    events: events.map(toJobEventResult),
    conceptIds: extractConceptIds(events),
    error: toSanitizedError(row.error),
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString(),
    finishedAt: row.finishedAt?.toISOString(),
  };
}

function toJobInitiator(row: JobRow): JobInitiator {
  if (row.initiatedByKind === 'credential') {
    return {
      kind: 'credential' as const,
      credentialId: row.initiatedByCredentialId!,
      principalId: row.initiatedByPrincipalId,
    };
  }
  return {
    kind: 'connector' as const,
    connector: (row.initiatedByConnector ?? 'github') as 'github',
  };
}

function toSanitizedError(
  raw: unknown,
): { code: string; message: string } | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (
    typeof raw === 'object' &&
    raw !== null &&
    'code' in raw &&
    'message' in raw
  ) {
    const obj = raw as Record<string, unknown>;
    return {
      code: String(obj['code'] ?? 'unknown'),
      message: String(obj['message'] ?? ''),
    };
  }
  return undefined;
}

function toJobEventResult(row: JobEventRow): JobEventResult {
  switch (row.status) {
    case 'pending':
      return { eventId: row.eventId, status: 'pending' };
    case 'compiled':
      return {
        eventId: row.eventId,
        status: 'compiled',
        conceptIds: row.conceptUuids ?? [],
      };
    case 'skipped':
      return {
        eventId: row.eventId,
        status: 'skipped',
        reason: (row.reason as 'no_knowledge' | 'already_compiled') ??
          'no_knowledge',
      };
    case 'failed':
      return {
        eventId: row.eventId,
        status: 'failed',
        error: {
          code:
            typeof row.error === 'object' &&
            row.error !== null &&
            'code' in row.error
              ? String((row.error as Record<string, unknown>)['code'])
              : 'unknown',
          message:
            typeof row.error === 'object' &&
            row.error !== null &&
            'message' in row.error
              ? String((row.error as Record<string, unknown>)['message'])
              : '',
        },
      };
    default:
      return { eventId: row.eventId, status: 'pending' };
  }
}

function extractConceptIds(events: JobEventRow[]): string[] | undefined {
  const ids = events
    .filter((e) => e.conceptUuids && e.conceptUuids.length > 0)
    .flatMap((e) => e.conceptUuids as string[]);
  return ids.length > 0 ? ids : undefined;
}

// ── Handlers ────────────────────────────────────────────────────────────────

/**
 * GET /v1/jobs — list jobs with optional status filter and cursor pagination.
 */
async function listJobsHandler(c: Context, deps: JobsReadDeps): Promise<Response> {
  const { db } = deps;
  const requestId = c.get(REQUEST_ID_KEY) as string;
  const auth = getAuth(c);

  // Parse and validate query params
  const rawQuery = {
    projectId: c.req.query('projectId'),
    status: c.req.query('status') || undefined,
    cursor: c.req.query('cursor') || undefined,
    limit: c.req.query('limit'),
  };

  const parsed = jobListQuery.safeParse(rawQuery);
  if (!parsed.success) {
    throw new InvalidRequestError('Invalid query parameters', {
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    } as unknown as Record<string, unknown>);
  }

  const { projectId, status, cursor, limit } = parsed.data;
  const teamId = getTeamId(auth.scope);

  // Scope enforcement: project-scoped keys can only list their own project
  if (isProjectScope(auth.scope)) {
    const keyProjectId = getProjectId(auth.scope);
    if (projectId !== keyProjectId) {
      throw new NotFoundError();
    }
  } else {
    // allProjects key — verify the project exists in the same team
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
      throw new NotFoundError();
    }
  }

  // Validate cursor early to return cursor_invalid for tampered/mismatched tokens
  if (cursor) {
    const decoded = validateJobsCursor(cursor, projectId, status);
    if (!decoded) {
      throw new CursorInvalidError();
    }
  }

  // Execute scoped query
  const result = await listJobs(db, {
    teamId,
    projectId,
    status,
    cursor,
    limit,
  });

  // Map and validate response through frozen DTO
  const items = result.jobs.map(toJobListItem);
  const response = jobListResponse.parse({
    requestId,
    data: items,
    nextCursor: result.nextCursor,
  });

  return c.json(response, 200);
}

/**
 * GET /v1/jobs/:id — job detail with per-event outcomes.
 */
async function getJobDetailHandler(
  c: Context,
  deps: JobsReadDeps,
): Promise<Response> {
  const { db } = deps;
  const requestId = c.get(REQUEST_ID_KEY) as string;
  const auth = getAuth(c);
  const jobId = c.req.param('id');

  // Basic UUID validation
  if (
    !jobId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      jobId,
    )
  ) {
    throw new NotFoundError();
  }

  // Fetch job with scope enforcement
  const jobRow = await getJob(db, auth.scope, jobId);
  if (!jobRow) {
    throw new NotFoundError();
  }

  // Fetch per-event outcomes for detail
  const eventRows = await getJobEvents(
    db,
    jobRow.teamId,
    jobRow.projectId,
    jobId,
  );

  // Map to frozen DTO and validate
  const detail = toJobDetail(jobRow, eventRows);
  const response = jobDetailResponse.parse({
    requestId,
    data: detail,
  });

  return c.json(response, 200);
}

// ── Route registration ──────────────────────────────────────────────────────

/**
 * Build the GET /v1/jobs and GET /v1/jobs/:id routes.
 */
export function buildJobsReadRoutes(deps: JobsReadDeps): Hono {
  const routes = new Hono();

  routes.use('/v1/jobs', requireAuth(deps.db));
  routes.use('/v1/jobs', requireScope('read'));
  routes.get('/v1/jobs', async (c) => listJobsHandler(c, deps));

  routes.use('/v1/jobs/:id', requireAuth(deps.db));
  routes.use('/v1/jobs/:id', requireScope('read'));
  routes.get('/v1/jobs/:id', async (c) => getJobDetailHandler(c, deps));

  return routes;
}
