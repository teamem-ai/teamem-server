/**
 * Project Purge Route — POST /teams/:teamId/projects/:projectId/purge (DUA-228).
 *
 * Owner-only endpoint that deletes all project-scoped data (events, concepts,
 * jobs, and related child rows) in a single transaction, preserves audit
 * records and principals, returns deletion counts, and writes a purge audit
 * record.
 *
 * Security invariants:
 * - Web session required (no API key access — management capability is
 *   exclusive to web-session roles, N6).
 * - Team membership in the target team required (scope derived from
 *   membership, not from client input).
 * - Owner role required (viewer/member/admin → 403).
 * - Cross-team access returns 404 (indistinguishable from a genuinely
 *   missing project — anti-enumeration, N7).
 * - Purge runs in a single database transaction: partial failure rolls
 *   back, leaving the project data intact.
 * - The purge itself writes an audit record (action: 'project.purge')
 *   that survives the purge — the audit_log table has no FK constraints
 *   specifically so purge audit rows are never cascade-deleted.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppDb } from '../../db/client.js';
import { purgeProjectData, type PurgeCounts } from '../../db/repositories/purge.js';
import { writeAuditRecord } from '../../db/repositories/audit.js';
import { requireWebSession, requireTeamMembership, getWebSession } from '../session.js';
import { requireRole } from '../../auth/rbac.js';
import { projectId as projectIdSchema } from '@teamem/schema';
import { purgeResponse } from '@teamem/schema';
import {
  InvalidRequestError,
  NotFoundError,
  InternalError,
  REQUEST_ID_KEY,
} from '../errors.js';

// ── Handler ─────────────────────────────────────────────────────────────────

async function purgeProjectHandler(c: Context, db: AppDb): Promise<Response> {
  const requestId = c.get(REQUEST_ID_KEY) as string;

  const webSession = getWebSession(c);

  // Extract and validate the project ID from the URL
  const rawProjectId = c.req.param('projectId');
  if (!rawProjectId) {
    throw new InvalidRequestError('Missing projectId in URL path');
  }

  const projectIdParsed = projectIdSchema.safeParse(rawProjectId);
  if (!projectIdParsed.success) {
    throw new InvalidRequestError('Invalid projectId format');
  }
  const projectId = projectIdParsed.data;

  // Verify the project exists and belongs to the team.
  // If it doesn't exist (or belongs to another team), return 404 —
  // indistinguishable from a genuinely missing resource.
  const projectResult = await db.$client.query(
    `SELECT id FROM projects WHERE id = $1 AND team_id = $2 LIMIT 1`,
    [projectId, webSession.scope.teamId],
  );
  if (projectResult.rows.length === 0) {
    throw new NotFoundError();
  }

  // ── Run purge (single transaction, managed internally) ────────────────
  let counts: PurgeCounts;

  try {
    counts = await purgeProjectData(db, webSession.scope.teamId, projectId);
  } catch (err) {
    console.error(
      JSON.stringify({
        event: 'purge_transaction_failed',
        requestId,
        teamId: webSession.scope.teamId,
        projectId,
        error: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
      }),
    );
    throw new InternalError('Purge transaction failed', { cause: err });
  }

  // ── Write purge audit record (AFTER the purge — survives by design) ────
  // The audit record is written outside the purge transaction so that:
  //   a) If the audit write fails, we still have the data deleted (the
  //      purge already committed).
  //   b) The audit row is never inside the purge's DELETE scope.
  //   c) The audit_log table has no FKs, so this write can't fail on
  //      referential grounds.
  try {
    await writeAuditRecord(db, {
      requestId,
      principalId: null, // web sessions don't have a principal — the user context is the session
      credentialId: null,
      action: 'project.purge',
      resourceType: 'project',
      resourceId: projectId,
      teamId: webSession.scope.teamId,
      projectId,
      outcome: 'success',
    });
  } catch (err) {
    // The purge data deletion has already committed. Log the audit
    // failure but don't roll back the purge — the data is gone and
    // that's the primary goal. A missing audit record is a server
    // error condition that operations can detect and investigate.
    console.error(
      JSON.stringify({
        event: 'purge_audit_write_failed',
        requestId,
        teamId: webSession.scope.teamId,
        projectId,
        error: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
      }),
    );
    throw new InternalError('Purge completed but audit write failed', { cause: err });
  }

  // ── Build and validate the response ────────────────────────────────────
  const response = purgeResponse.parse({
    requestId,
    projectId,
    eventsDeleted: counts.eventsDeleted,
    conceptsDeleted: counts.conceptsDeleted,
    conceptPathsDeleted: counts.conceptPathsDeleted,
    conceptEvidenceDeleted: counts.conceptEvidenceDeleted,
    conceptContributorsDeleted: counts.conceptContributorsDeleted,
    jobsDeleted: counts.jobsDeleted,
    jobEventsDeleted: counts.jobEventsDeleted,
  });

  return c.json(response, 200);
}

// ── Route registration ──────────────────────────────────────────────────────

export interface PurgeRoutesDeps {
  db: AppDb;
}

/**
 * Build the purge routes Hono instance.
 *
 * Must be mounted AFTER the session middleware (requireWebSession,
 * requireTeamMembership). The returned instance contains its own
 * role-check middleware.
 *
 * Route: POST /teams/:teamId/projects/:projectId/purge
 *
 * Middleware chain:
 *   1. requireWebSession      — validates session cookie, extracts user
 *   2. requireTeamMembership   — looks up membership in :teamId, derives scope
 *   3. requireRole('owner')    — only owners can purge
 */
export function buildPurgeRoutes(deps: PurgeRoutesDeps): Hono {
  const routes = new Hono();

  routes.use(
    '/teams/:teamId/projects/:projectId/purge',
    requireWebSession(deps.db),
  );
  routes.use(
    '/teams/:teamId/projects/:projectId/purge',
    requireTeamMembership(deps.db),
  );
  routes.use(
    '/teams/:teamId/projects/:projectId/purge',
    requireRole('owner'),
  );

  routes.post(
    '/teams/:teamId/projects/:projectId/purge',
    async (c) => purgeProjectHandler(c, deps.db),
  );

  return routes;
}
