/**
 * POST /v1/jobs/:id/retry — re-run a failed compilation job.
 *
 * Resets the job (and its per-event outcomes) back to `queued` and re-sends
 * the pg-boss message so the worker's normal claim path picks it up again —
 * a retry of the SAME job row, not a new one, so its original
 * `initiated_by_*` provenance is preserved rather than fabricated (§5.4).
 *
 * Session-only, admin+: retrying re-runs real LLM calls (real cost), so
 * it's a governance action gated by team role — the same bucket as
 * key/connector/LLM management in AGENTS.md §8 — not a data-plane
 * capability exposed to API keys. AuthContext.teamRole is only set for
 * session authentication, so a Bearer-token caller is rejected outright.
 *
 * Security:
 * - Cross-team job IDs are indistinguishable from missing (404).
 * - A job whose status isn't currently 'failed' is rejected (409) — this
 *   button only ever appears for a failed job in the UI, but the server
 *   enforces the same rule regardless of what the client sends.
 */
import { Hono, type Context } from 'hono';
import { randomUUID } from 'node:crypto';
import type { AppDb } from '../../db/client.js';
import { getJob, resetJobForRetry } from '../../db/repositories/jobs.js';
import { requireAuthOrWebSession, requireScope, getAuth } from '../auth.js';
import { checkRole } from '../../auth/rbac.js';
import type { CompileQueue } from '../../queue/boss.js';
import {
  ForbiddenError,
  NotFoundError,
  ConflictError,
  REQUEST_ID_KEY,
} from '../errors.js';
import { getTeamId } from '../../auth/scope.js';

export interface JobRetryDeps {
  db: AppDb;
  /** Optional so tests/dev without a live queue can still exercise the DB reset. */
  queue?: CompileQueue;
}

export function buildJobRetryRoutes(deps: JobRetryDeps): Hono {
  const routes = new Hono();

  routes.use('/v1/jobs/:id/retry', requireAuthOrWebSession(deps.db));
  routes.use('/v1/jobs/:id/retry', requireScope('read'));

  routes.post('/v1/jobs/:id/retry', async (c: Context) => {
    const requestId = c.get(REQUEST_ID_KEY) as string;
    const auth = getAuth(c);

    if (!auth.teamRole || !checkRole(auth.teamRole, 'admin')) {
      throw new ForbiddenError('Retrying a job requires an admin or owner role');
    }

    const jobId = c.req.param('id');
    if (!jobId) {
      throw new NotFoundError();
    }

    const jobRow = await getJob(deps.db, auth.scope, jobId);
    if (!jobRow) {
      // Same 404 whether the job doesn't exist or belongs to another team.
      throw new NotFoundError();
    }

    if (jobRow.status !== 'failed') {
      throw new ConflictError(
        `Job is '${jobRow.status}', not 'failed' — only a failed job can be retried`,
      );
    }

    const teamId = getTeamId(auth.scope);
    const reset = await resetJobForRetry(deps.db, teamId, jobRow.projectId, jobId);
    if (!reset) {
      // Lost a race with another retry click, or the worker already picked
      // it back up — same user-facing meaning as "not failed anymore".
      throw new ConflictError(
        "Job is no longer 'failed' — only a failed job can be retried",
      );
    }

    if (deps.queue) {
      await deps.queue.send(
        {
          jobId: reset.id,
          teamId: reset.teamId,
          projectId: reset.projectId,
          kind: reset.kind,
        },
        // A fresh id — the ORIGINAL job.id was already used as the pg-boss
        // message id for the first attempt, and pg-boss's own id-uniqueness
        // would otherwise silently drop this send as a duplicate.
        { id: randomUUID() },
      );
    }

    return c.json(
      { requestId, data: { id: reset.id, status: reset.status } },
      200,
    );
  });

  return routes;
}
