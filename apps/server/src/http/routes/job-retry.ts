/**
 * POST /v1/jobs/:id/retry — re-run a compilation job's failed events (or,
 * on request, every event).
 *
 * Resets the job (and the targeted per-event outcomes) back to `queued` /
 * `pending` and re-sends the pg-boss message so the worker's normal claim
 * path picks it up again — a retry of the SAME job row, not a new one, so
 * its original `initiated_by_*` provenance is preserved rather than
 * fabricated (§5.4).
 *
 * Two modes, mirroring "Re-run failed jobs" / "Re-run all jobs" on GitHub
 * Actions (request body `{ mode?: 'failed' | 'all' }`, default `'failed'`):
 *   - `failed` — only job_events currently `failed` are reset to `pending`;
 *     already-`compiled`/`skipped` events are left untouched so a retry
 *     never redoes (or double-charges an LLM call for) work that already
 *     succeeded. This is why the worker (queue/worker.ts) only ever loads
 *     `pending` job_events for a job — a job created fresh has every event
 *     `pending` already, so this filter is a no-op there and only changes
 *     behavior for a partial retry.
 *   - `all` — every event for the job is reset, regardless of its current
 *     outcome. A deliberate full re-run; F2 is expected to handle an event
 *     it's already seen (confirms/extends against the same concept), so
 *     this isn't "safe" in the sense of being a no-op, but it's the same
 *     trade-off "re-run all jobs" makes in CI.
 *
 * A job does NOT have to currently be `status: 'failed'` to retry its
 * failed events: compile-job.ts only fails the job itself when EVERY event
 * fails — a job with some compiled, some skipped, and some failed events is
 * `status: 'completed'` with a nonzero failed count, and that's the more
 * common shape retry actually gets used on. Eligibility is job_events-count
 * based (retry 'failed' requires at least one failed event), not
 * job.status-based; only an already-active job (`queued`/`processing`) is
 * rejected outright.
 *
 * Session-only, admin+: retrying re-runs real LLM calls (real cost), so
 * it's a governance action gated by team role — the same bucket as
 * key/connector/LLM management in AGENTS.md §8 — not a data-plane
 * capability exposed to API keys. AuthContext.teamRole is only set for
 * session authentication, so a Bearer-token caller is rejected outright.
 *
 * Security:
 * - Cross-team job IDs are indistinguishable from missing (404).
 * - An already-active job (queued/processing) is rejected (409) — the
 *   server enforces this regardless of what the client sends, independent
 *   of whichever retry affordance the UI currently shows.
 */
import { Hono, type Context } from 'hono';
import { randomUUID } from 'node:crypto';
import type { AppDb } from '../../db/client.js';
import { getJob, getJobEvents, resetJobForRetry } from '../../db/repositories/jobs.js';
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

type RetryMode = 'failed' | 'all';

function parseRetryMode(body: unknown): RetryMode {
  if (
    typeof body === 'object' &&
    body !== null &&
    (body as Record<string, unknown>)['mode'] === 'all'
  ) {
    return 'all';
  }
  return 'failed';
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

    // The requireAuthOrWebSession middleware already cloned the request to
    // read `projectId` out of the body — the original stream is untouched,
    // so reading it again here for `mode` is safe.
    let body: unknown = {};
    try {
      body = await c.req.json();
    } catch {
      // No/invalid JSON body — mode defaults to 'failed'.
    }
    const mode = parseRetryMode(body);

    const jobRow = await getJob(deps.db, auth.scope, jobId);
    if (!jobRow) {
      // Same 404 whether the job doesn't exist or belongs to another team.
      throw new NotFoundError();
    }

    if (jobRow.status === 'queued' || jobRow.status === 'processing') {
      throw new ConflictError(
        `Job is '${jobRow.status}' — it's already running`,
      );
    }

    const teamId = getTeamId(auth.scope);

    if (mode === 'failed') {
      const events = await getJobEvents(deps.db, teamId, jobRow.projectId, jobId);
      const failedCount = events.filter((e) => e.status === 'failed').length;
      if (failedCount === 0) {
        throw new ConflictError(
          "Job has no failed events to retry — retry with mode 'all' to re-run every event",
        );
      }
    }

    const reset = await resetJobForRetry(deps.db, teamId, jobRow.projectId, jobId, mode);
    if (!reset) {
      // Lost a race with another retry click, or the worker already picked
      // it back up — same user-facing meaning as "not eligible anymore".
      throw new ConflictError('Job is no longer eligible for retry');
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
      { requestId, data: { id: reset.id, status: reset.status, mode } },
      200,
    );
  });

  return routes;
}
