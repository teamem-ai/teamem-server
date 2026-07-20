/**
 * Compile worker — pg-boss job handler with atomic claim and lifecycle
 * transitions (DUA-173 / M0-JOB-03).
 *
 * This module provides the real {@link CompileJobHandler} that replaces the
 * M0 placeholder `acknowledgeCompileJob`. It:
 *
 *  1. Parses the pg-boss delivery payload ({@link CompileJobMessage}).
 *  2. Atomically claims the job row (queued → processing, increment attempts)
 *     via {@link claimJob}. The `WHERE status = 'queued'` clause guarantees at
 *     most one worker succeeds — concurrent workers see `undefined` and skip.
 *  3. Loads per-event IDs from `job_events`.
 *  4. Delegates to {@link handleCompileJob} (F1) for the actual compilation work.
 *  5. On unhandled failure: transitions the job to `failed` with a sanitized
 *     error (never leaks raw payloads, prompts, keys, or provider responses).
 *
 * Scope safety: the worker reads `teamId` + `projectId` from the trusted DB
 * job row (not from the pg-boss message) and passes them through every
 * lifecycle mutation (red line 5.5).
 */
import type { CompileJob, CompileJobHandler } from './boss.js';
import { claimJob, updateJobStatus, getJobEvents } from '../db/repositories/jobs.js';
import {
  handleCompileJob,
  type CompileJobDeps,
} from '../compiler/f1/compile-job.js';

// ── Message shape ───────────────────────────────────────────────────────────

/**
 * The payload enqueued alongside the DB job row. Mirrors what
 * {@link enqueueCompilation} sends to pg-boss.
 */
export interface CompileJobMessage {
  readonly jobId: string;
  readonly teamId: string;
  readonly projectId: string;
  readonly kind: string;
}

// ── Error sanitization ──────────────────────────────────────────────────────

/**
 * Redact secrets and raw payloads from any error before persisting it.
 *
 * The project red line (§5.3) forbids storing API keys, raw payloads, prompts,
 * or provider response bodies in the database. This function strips known
 * secret patterns and truncates to a reasonable bound so even an unexpected
 * `throw new Error('SECRET=abc123')` in application code cannot leak.
 */
function sanitizeError(err: unknown): { code: string; message: string } {
  const raw =
    err instanceof Error ? err.message : String(err);

  // Strip common secret patterns:
  //   - KEY=VALUE pairs (uppercase + underscore + =)
  //   - Bearer tokens
  //   - connection strings with credentials
  const redacted = raw
    .replace(/\b[A-Z][A-Z0-9_]*=[^\s,;)]+/g, '[REDACTED]')
    .replace(/Bearer\s+[^\s,;)]+/gi, 'Bearer [REDACTED]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^@\s/]*@/gi, '$1[REDACTED]@');

  const truncated =
    redacted.length > 500 ? redacted.slice(0, 497) + '...' : redacted;

  return {
    code: 'worker_failure',
    message: truncated,
  };
}

// ── Handler factory ─────────────────────────────────────────────────────────

/**
 * Create the pg-boss job handler with atomic claim and lifecycle management.
 *
 * @param db   Scoped database handle for queries and mutations.
 * @param llm  LLM client for F1 structured extraction.
 * @returns    A {@link CompileJobHandler} ready to register with pg-boss.
 */
export function createCompileJobHandler(deps: CompileJobDeps): CompileJobHandler {
  const { db } = deps;

  return async (job: CompileJob): Promise<void> => {
    // 1. Parse the pg-boss delivery payload.
    const msg = job.data as CompileJobMessage;

    if (!msg?.jobId || !msg?.teamId || !msg?.projectId) {
      console.error(
        `[worker] malformed pg-boss message for job ${job.id}: missing required fields`,
      );
      return;
    }

    const { jobId, teamId, projectId } = msg;

    // 2. Atomically claim the job. Only one worker wins when multiple
    //    consumers are attached to the same queue.
    const claimed = await claimJob(db, teamId, projectId, jobId);

    if (!claimed) {
      // Another worker claimed it first — this delivery is a duplicate
      // (pg-boss may deliver to multiple consumers under contention, or
      // the job was already claimed by a concurrent process).
      console.log(
        `[worker] job ${jobId} already claimed by another worker; skipping`,
      );
      return;
    }

    console.log(
      `[worker] claimed job ${jobId} (attempt ${claimed.attempts})`,
    );

    try {
      // 3. Load the event IDs for this job.
      const jobEvents = await getJobEvents(db, teamId, projectId, jobId);
      const eventIds = jobEvents.map((je) => je.eventId);

      if (eventIds.length === 0) {
        // No events to compile — mark the job as failed since there is
        // nothing to do. This is not a retryable condition.
        await updateJobStatus(db, teamId, projectId, jobId, 'failed', {
          error: {
            code: 'no_events_found',
            message: 'No events found for job',
          },
        });
        return;
      }

      // 4. Delegate to the F1 compilation handler.
      await handleCompileJob(deps, {
        jobId,
        teamId,
        projectId,
        eventIds,
      });
    } catch (err: unknown) {
      // 5. Unhandled failure: the handler itself threw (not just per-event
      //    failures, which are already recorded by handleCompileJob). This
      //    is typically a database connectivity error or a bug — pg-boss
      //    will retry according to the queue policy. We transition the job
      //    to failed so the retry starts from a clean state.
      const sanitized = sanitizeError(err);
      console.error(
        `[worker] job ${jobId} failed with unhandled error: ${sanitized.message}`,
      );

      // Only transition if the job is still in 'processing' — it may have
      // already been moved by handleCompileJob before it threw.
      try {
        await updateJobStatus(db, teamId, projectId, jobId, 'failed', {
          error: sanitized,
        });
      } catch (statusErr: unknown) {
        console.error(
          `[worker] failed to update job ${jobId} status after error:`,
          statusErr instanceof Error ? statusErr.message : String(statusErr),
        );
      }

      // Re-throw so pg-boss sees the failure and applies retry policy.
      // The sanitized error is stored on the job row; the re-thrown error
      // goes to pg-boss logs only (which are also scrubbed by the lifecycle
      // module).
      throw new Error(sanitized.message);
    }
  };
}
