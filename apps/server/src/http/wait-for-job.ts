/**
 * waitForJob — poll a compile job until it reaches a terminal state, the
 * deadline expires, or the caller aborts (e.g. client disconnect).
 *
 * All DB access is scoped (red line 5.5). The function never blocks the
 * event loop: every poll iteration yields via setTimeout before re-checking.
 *
 * Contract behaviour (Q8 / DUA-154):
 * - completed → { outcome: 'completed', conceptIds }
 * - failed/cancelled → { outcome: 'failed' }
 * - deadline exceeded → { outcome: 'timed_out' }
 * - signal aborted → { outcome: 'aborted' }
 */
import type { AppDb } from '../db/client.js';
import type { ScopeContext } from '../auth/scope.js';
import { getJob, getJobEvents } from '../db/repositories/jobs.js';

// ── Outcome discriminated union ─────────────────────────────────────────────

export type WaitOutcome =
  | { readonly outcome: 'completed'; readonly conceptIds: string[] }
  | { readonly outcome: 'failed' }
  | { readonly outcome: 'timed_out' }
  | { readonly outcome: 'aborted' };

// ── Options ─────────────────────────────────────────────────────────────────

export interface WaitForJobOptions {
  readonly db: AppDb;
  readonly scope: ScopeContext;
  readonly jobId: string;
  /** AbortSignal from the incoming HTTP request — when aborted the function
   *  stops waiting (but the server-side job keeps processing). */
  readonly signal?: AbortSignal;
  /** Maximum time to wait in milliseconds (default 30 000). */
  readonly timeoutMs?: number;
  /** Delay between poll attempts in milliseconds (default 500). */
  readonly pollIntervalMs?: number;
}

// ── Implementation ──────────────────────────────────────────────────────────

/**
 * Poll `getJob` until the job reaches a terminal state, the deadline
 * expires, or `signal` is aborted.
 *
 * The function is intentionally async and yields the event loop between
 * polls — it will never block the process for `timeoutMs`.
 *
 * Polling errors (transient DB glitches) are silently retried so a single
 * blip does not abort the wait.
 */
export async function waitForJob(
  options: WaitForJobOptions,
): Promise<WaitOutcome> {
  const {
    db,
    scope,
    jobId,
    signal,
    timeoutMs = 30_000,
    pollIntervalMs = 500,
  } = options;

  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    // ── Client disconnect check ──────────────────────────────────────────
    if (signal?.aborted) {
      return { outcome: 'aborted' };
    }

    // ── Poll the job row ─────────────────────────────────────────────────
    try {
      const job = await getJob(db, scope, jobId);

      if (job) {
        if (job.status === 'completed') {
          // Fetch per-event concept UUIDs so the caller can link to pages.
          const events = await getJobEvents(
            db,
            job.teamId,
            job.projectId,
            jobId,
          );
          const conceptIds = events
            .filter((e) => e.conceptUuids && e.conceptUuids.length > 0)
            .flatMap((e) => e.conceptUuids as string[]);
          return { outcome: 'completed', conceptIds };
        }

        if (job.status === 'failed' || job.status === 'cancelled') {
          return { outcome: 'failed' };
        }
      }
    } catch {
      // Transient polling error — ignore and retry on the next tick.
    }

    // ── Yield the event loop ─────────────────────────────────────────────
    await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  return { outcome: 'timed_out' };
}
