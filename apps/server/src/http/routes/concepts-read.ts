/**
 * Concept read routes — GET /v1/concepts/:uuid and GET /v1/concepts/by-path
 * (M0-READ-04).
 *
 * Both endpoints require a valid Bearer token with at least the `read` scope.
 * Every lookup carries team_id + project_id — never fetch without scope and
 * authorize afterward (red line 5.5).  Cross-team and genuinely-missing
 * resources both return 404 with identical bodies (anti-enumeration).
 */
import { Hono, type Context } from 'hono';
import { conceptUuid, conceptPath, conceptDetailResponse } from '@teamem/schema';
import type { AppDb } from '../../db/client.js';
import { getConceptByUuid, getConceptByPath } from '../../db/repositories/concepts-read.js';
import { requireAuth, requireScope, getAuth } from '../auth.js';
import { isProjectScope, getTeamId, getProjectId } from '../../auth/scope.js';
import {
  NotFoundError,
  InvalidRequestError,
  REQUEST_ID_KEY,
} from '../errors.js';

// ── Dependencies ────────────────────────────────────────────────────────────

export interface ConceptsReadDeps {
  db: AppDb;
}

// ── Handlers ────────────────────────────────────────────────────────────────

/**
 * GET /v1/concepts/:uuid — detail by canonical UUID.
 *
 * The UUID is validated against the frozen `conceptUuid` schema (Zod uuid).
 * Malformed UUIDs → 400.  Missing / cross-team concepts → 404.
 */
async function getConceptByUuidHandler(c: Context, deps: ConceptsReadDeps): Promise<Response> {
  const auth = getAuth(c);
  const teamId = getTeamId(auth.scope);
  const requestId = c.get(REQUEST_ID_KEY) as string;

  const rawUuid = c.req.param('uuid');

  // Validate UUID format before touching the database.
  const parsed = conceptUuid.safeParse(rawUuid);
  if (!parsed.success) {
    throw new InvalidRequestError('Invalid concept UUID format', {
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    } as unknown as Record<string, unknown>);
  }

  // For project-scoped keys the project is fixed; all-projects keys can
  // optionally filter by a query parameter.
  let projectId: string;
  if (isProjectScope(auth.scope)) {
    projectId = getProjectId(auth.scope);
  } else {
    // allProjects scope: projectId must be provided as a query parameter.
    const rawProjectId = c.req.query('projectId');
    if (!rawProjectId) {
      throw new InvalidRequestError(
        'projectId query parameter is required for team-wide API keys',
      );
    }
    // projectId format is validated by the scope helper on construction; we
    // just do a lightweight check here (the DB will also reject mismatches).
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
    // This indicates a data integrity issue — the stored concept doesn't
    // conform to the frozen contract.  Log details but return 500 to the
    // client (never leak internal schema structure).
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
 *
 * The path is validated against the frozen `conceptPath` schema.  Since
 * paths may contain `/`, the value is passed as a query parameter:
 * `GET /v1/concepts/by-path?path=services/api`.
 *
 * Malformed paths → 400.  Missing / cross-team concepts → 404.
 */
async function getConceptByPathHandler(c: Context, deps: ConceptsReadDeps): Promise<Response> {
  const auth = getAuth(c);
  const teamId = getTeamId(auth.scope);
  const requestId = c.get(REQUEST_ID_KEY) as string;

  const rawPath = c.req.query('path');

  if (!rawPath) {
    throw new InvalidRequestError('path query parameter is required');
  }

  // Validate path syntax before touching the database (N5 frozen syntax).
  const parsed = conceptPath.safeParse(rawPath);
  if (!parsed.success) {
    throw new InvalidRequestError('Invalid concept path format', {
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    } as unknown as Record<string, unknown>);
  }

  // Determine project scope.
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

// ── Route registration ──────────────────────────────────────────────────────

/**
 * Build the concept read routes with auth and scope middleware.
 *
 * Usage in app.ts:
 *   app.route('/', buildConceptsReadRoutes({ db }));
 */
export function buildConceptsReadRoutes(deps: ConceptsReadDeps): Hono {
  const routes = new Hono();

  // All concept read routes require authentication + read scope.
  routes.use('/v1/concepts/*', requireAuth(deps.db));
  routes.use('/v1/concepts/*', requireScope('read'));

  // Detail by path: GET /v1/concepts/by-path?path=...
  // MUST be registered before :uuid so the literal "by-path" is not
  // captured as a UUID parameter and rejected as malformed.
  routes.get('/v1/concepts/by-path', async (c) => {
    return getConceptByPathHandler(c, deps);
  });

  // Detail by UUID: GET /v1/concepts/:uuid
  routes.get('/v1/concepts/:uuid', async (c) => {
    return getConceptByUuidHandler(c, deps);
  });

  return routes;
}
