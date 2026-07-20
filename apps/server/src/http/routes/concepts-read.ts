/**
 * Concept read routes — GET /v1/concepts, /v1/concepts/:uuid,
 * and /v1/concepts/by-path (M0-READ-03 + M0-READ-04).
 *
 * List (M0-READ-03): scoped, cursor-paginated concept summaries with
 *   type/status/tag/contributor filters.
 * Detail (M0-READ-04): full concept by canonical UUID or by path
 *   (current or historical alias).
 *
 * All endpoints require a valid Bearer token with at least the `read` scope.
 * Every query carries team_id + project_id. Cross-team and missing resources
 * both return 404 with identical bodies (anti-enumeration).
 */
import { createHash } from 'node:crypto';
import { Hono, type Context } from 'hono';
import {
  conceptUuid,
  conceptPath,
  conceptDetailResponse,
  conceptListQuery,
  conceptListResponse,
  encodeCursor,
  decodeCursor,
  type ConceptSummary,
  type CursorPayload,
} from '@teamem/schema';
import { and, eq } from 'drizzle-orm';
import type { AppDb } from '../../db/client.js';
import * as schema from '../../db/schema.js';
import {
  getConceptByUuid,
  getConceptByPath,
  listConcepts,
  type ConceptRow,
} from '../../db/repositories/concepts-read.js';
import { requireAuth, requireScope, getAuth } from '../auth.js';
import { isProjectScope, getTeamId, getProjectId } from '../../auth/scope.js';
import {
  NotFoundError,
  InvalidRequestError,
  ForbiddenError,
  CursorInvalidError,
  REQUEST_ID_KEY,
} from '../errors.js';

// ── Dependencies ────────────────────────────────────────────────────────────

export interface ConceptsReadDeps {
  db: AppDb;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Compute a deterministic SHA-256 hash of the active filter parameters. */
function computeFilterHash(filters: {
  type?: string;
  status?: string;
  tag?: string;
  contributor?: string;
}): string {
  const normalized: Record<string, string> = {};
  if (filters.type) normalized['type'] = filters.type;
  if (filters.status) normalized['status'] = filters.status;
  if (filters.tag) normalized['tag'] = filters.tag;
  if (filters.contributor) normalized['contributor'] = filters.contributor;

  return createHash('sha256')
    .update(JSON.stringify(normalized, Object.keys(normalized).sort()))
    .digest('hex');
}

/** Map a raw DB row to the frozen ConceptSummary DTO. */
function toConceptSummary(row: ConceptRow): ConceptSummary {
  return {
    uuid: row.uuid,
    path: row.path ?? '',
    type: row.type as ConceptSummary['type'],
    status: row.status as ConceptSummary['status'],
    confidence: row.confidence as ConceptSummary['confidence'],
    title: row.title,
    tags: row.tags,
    lastConfirmed: row.lastConfirmed.toISOString(),
  };
}

/** Build the next-cursor payload from the last visible row and current filters. */
function buildNextCursor(
  projectId: string,
  lastRow: ConceptRow,
  filters: {
    type?: string;
    status?: string;
    tag?: string;
    contributor?: string;
  },
): string {
  const payload: CursorPayload = {
    resource: 'concepts',
    sort: 'last_confirmed',
    v: 1,
    projectId,
    position: {
      sortValue: lastRow.lastConfirmed.toISOString(),
      id: lastRow.uuid,
    },
    filterHash: computeFilterHash(filters),
  };
  return encodeCursor(payload);
}

// ── Handlers: detail (M0-READ-04) ──────────────────────────────────────────

/**
 * GET /v1/concepts/:uuid — detail by canonical UUID.
 */
async function getConceptByUuidHandler(c: Context, deps: ConceptsReadDeps): Promise<Response> {
  const auth = getAuth(c);
  const teamId = getTeamId(auth.scope);
  const requestId = c.get(REQUEST_ID_KEY) as string;

  const rawUuid = c.req.param('uuid');

  const parsed = conceptUuid.safeParse(rawUuid);
  if (!parsed.success) {
    throw new InvalidRequestError('Invalid concept UUID format', {
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    } as unknown as Record<string, unknown>);
  }

  let projectId: string;
  if (isProjectScope(auth.scope)) {
    projectId = getProjectId(auth.scope);
  } else {
    const rawProjectId = c.req.query('projectId');
    if (!rawProjectId) {
      throw new InvalidRequestError(
        'projectId query parameter is required for team-wide API keys',
      );
    }
    if (!/^prj_[A-Za-z0-9]+$/.test(rawProjectId)) {
      throw new InvalidRequestError('Invalid projectId format');
    }
    projectId = rawProjectId;
  }

  const concept = await getConceptByUuid(deps.db, teamId, projectId, parsed.data);

  if (!concept) {
    throw new NotFoundError('Concept not found');
  }

  const body = conceptDetailResponse.safeParse({ requestId, data: concept });
  if (!body.success) {
    console.error(
      JSON.stringify({
        event: 'concept_detail_response_validation_failed',
        requestId,
        uuid: parsed.data,
        issues: body.error.issues,
      }),
    );
    throw new NotFoundError('Concept not found');
  }

  return c.json(body.data, 200);
}

/**
 * GET /v1/concepts/by-path — detail by current or historical path.
 */
async function getConceptByPathHandler(c: Context, deps: ConceptsReadDeps): Promise<Response> {
  const auth = getAuth(c);
  const teamId = getTeamId(auth.scope);
  const requestId = c.get(REQUEST_ID_KEY) as string;

  const rawPath = c.req.query('path');

  if (!rawPath) {
    throw new InvalidRequestError('path query parameter is required');
  }

  const parsed = conceptPath.safeParse(rawPath);
  if (!parsed.success) {
    throw new InvalidRequestError('Invalid concept path format', {
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    } as unknown as Record<string, unknown>);
  }

  let projectId: string;
  if (isProjectScope(auth.scope)) {
    projectId = getProjectId(auth.scope);
  } else {
    const rawProjectId = c.req.query('projectId');
    if (!rawProjectId) {
      throw new InvalidRequestError(
        'projectId query parameter is required for team-wide API keys',
      );
    }
    if (!/^prj_[A-Za-z0-9]+$/.test(rawProjectId)) {
      throw new InvalidRequestError('Invalid projectId format');
    }
    projectId = rawProjectId;
  }

  const concept = await getConceptByPath(deps.db, teamId, projectId, parsed.data);

  if (!concept) {
    throw new NotFoundError('Concept not found');
  }

  const body = conceptDetailResponse.safeParse({ requestId, data: concept });
  if (!body.success) {
    console.error(
      JSON.stringify({
        event: 'concept_detail_response_validation_failed',
        requestId,
        path: parsed.data,
        issues: body.error.issues,
      }),
    );
    throw new NotFoundError('Concept not found');
  }

  return c.json(body.data, 200);
}

// ── Handler: list (M0-READ-03) ─────────────────────────────────────────────

/**
 * GET /v1/concepts — scoped, cursor-paginated concept summary list.
 */
async function getConceptsListHandler(
  c: Context,
  deps: ConceptsReadDeps,
): Promise<Response> {
  const { db } = deps;
  const auth = getAuth(c);
  const teamId = getTeamId(auth.scope);

  // Collect ALL query params to detect unknown keys (like q=).
  const validKeys = new Set([
    'projectId', 'type', 'status', 'tag', 'contributor', 'cursor', 'limit',
  ]);

  const rawQuery: Record<string, string | string[] | undefined> = {};
  const unknownKeys: string[] = [];
  const allQuery = c.req.queries();
  for (const [key, values] of Object.entries(allQuery)) {
    if (validKeys.has(key)) {
      rawQuery[key] = values?.[0];
    } else {
      unknownKeys.push(key);
    }
  }

  if (unknownKeys.length > 0) {
    throw new InvalidRequestError(
      `Unrecognized query parameter(s): ${unknownKeys.join(', ')} — M0 does not support text search`,
    );
  }

  const parsed = conceptListQuery.safeParse(rawQuery);
  if (!parsed.success) {
    throw new InvalidRequestError('Query parameter validation failed', {
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    } as unknown as Record<string, unknown>);
  }

  const query = parsed.data;

  // Scope check: projectId must be within key's scope.
  if (isProjectScope(auth.scope)) {
    const keyProjectId = getProjectId(auth.scope);
    if (query.projectId !== keyProjectId) {
      throw new ForbiddenError(
        `API key does not have access to project ${query.projectId}`,
      );
    }
  } else {
    // allProjects key — verify the project exists AND belongs to the team.
    const projectRows = await db
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(
        and(
          eq(schema.projects.teamId, teamId),
          eq(schema.projects.id, query.projectId),
        ),
      )
      .limit(1);
    if (projectRows.length === 0) {
      throw new NotFoundError(`Project ${query.projectId} not found`);
    }
  }

  // Decode & validate cursor.
  let cursorSortValue: string | undefined;
  let cursorId: string | undefined;

  if (query.cursor) {
    const decoded = decodeCursor(query.cursor);
    if (!decoded) {
      throw new CursorInvalidError('Cursor is malformed or invalid', {
        provided: query.cursor,
      } as unknown as Record<string, unknown>);
    }

    if (decoded.resource !== 'concepts' || decoded.sort !== 'last_confirmed') {
      throw new CursorInvalidError('Cursor does not match this endpoint', {
        resource: decoded.resource,
        sort: decoded.sort,
      } as unknown as Record<string, unknown>);
    }

    if (decoded.projectId !== query.projectId) {
      throw new CursorInvalidError('Cursor project does not match request project', {
        cursorProject: decoded.projectId,
        requestProject: query.projectId,
      } as unknown as Record<string, unknown>);
    }

    const currentFilterHash = computeFilterHash({
      type: query.type,
      status: query.status,
      tag: query.tag,
      contributor: query.contributor,
    });

    if (decoded.filterHash !== currentFilterHash) {
      throw new CursorInvalidError(
        'Cursor was issued with different filters — re-request without cursor',
        {
          cursorHash: decoded.filterHash,
          requestHash: currentFilterHash,
        } as unknown as Record<string, unknown>,
      );
    }

    cursorSortValue = decoded.position.sortValue;
    cursorId = decoded.position.id;
  }

  // Query repository.
  const result = await listConcepts(db, {
    teamId,
    projectId: query.projectId,
    type: query.type,
    status: query.status,
    tag: query.tag,
    contributor: query.contributor,
    cursorSortValue,
    cursorId,
    limit: query.limit,
  });

  // Map rows & build next cursor.
  const data = result.rows.map(toConceptSummary);

  let nextCursor: string | null = null;
  if (result.hasMore && result.rows.length > 0) {
    const lastRow = result.rows[result.rows.length - 1]!;
    nextCursor = buildNextCursor(query.projectId, lastRow, {
      type: query.type,
      status: query.status,
      tag: query.tag,
      contributor: query.contributor,
    });
  }

  const response = conceptListResponse.parse({
    requestId: c.get(REQUEST_ID_KEY) as string,
    data,
    nextCursor,
  });

  return c.json(response, 200);
}

// ── Route registration ──────────────────────────────────────────────────────

/**
 * Build the concept read routes with auth and scope middleware.
 *
 * Usage in app.ts:
 *   app.route('/', buildConceptsReadRoutes({ db }));
 */
export function buildConceptsReadRoutes(deps: ConceptsReadDeps): Hono {
  const routes = new Hono();

  // List endpoint: GET /v1/concepts (M0-READ-03).
  routes.use('/v1/concepts', requireAuth(deps.db));
  routes.use('/v1/concepts', requireScope('read'));
  routes.get('/v1/concepts', async (c) => {
    return getConceptsListHandler(c, deps);
  });

  // Detail endpoints: GET /v1/concepts/by-path and GET /v1/concepts/:uuid (M0-READ-04).
  routes.use('/v1/concepts/*', requireAuth(deps.db));
  routes.use('/v1/concepts/*', requireScope('read'));

  // by-path MUST be registered before :uuid so the literal "by-path" is not
  // captured as a UUID parameter.
  routes.get('/v1/concepts/by-path', async (c) => {
    return getConceptByPathHandler(c, deps);
  });

  routes.get('/v1/concepts/:uuid', async (c) => {
    return getConceptByUuidHandler(c, deps);
  });

  return routes;
}
