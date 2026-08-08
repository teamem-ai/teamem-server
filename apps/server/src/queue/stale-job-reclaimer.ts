/**
 * Periodic sweep that reclaims jobs orphaned at `processing` by a worker
 * crash/restart (AGPL-3.0-only).
 *
 * See {@link reclaimStaleProcessingJobs} for the full mechanism this papers
 * over: a worker killed mid-job leaves its job row stuck at `processing`
 * with no future pg-boss delivery ever revisiting it. Started by both
 * worker entrypoints — standalone (worker.ts) and embedded
 * (worker/embedded.ts via index.ts, TEAMEM_ALL_IN_ONE=true) — so recovery
 * doesn't depend on deployment topology.
 */
import type { AppDb } from '../db/client.js';
import { reclaimStaleProcessingJobs } from '../db/repositories/jobs.js';
import { DEFAULT_COMPILE_QUEUE_POLICY } from './boss.js';

export interface StaleJobReclaimerOptions {
  /** How often to sweep. Default: 60s. */
  readonly intervalMs?: number;
  /**
   * How old a `processing` job's `started_at` must be before it's reclaimed.
   * Default: the compile queue's own `expireInSeconds` — pg-boss will not
   * itself consider a delivery abandoned any sooner, so reclaiming earlier
   * risks racing a worker that is still legitimately working the job.
   */
  readonly staleAfterMs?: number;
  readonly onReclaim?: (jobIds: readonly string[]) => void;
  readonly onError?: (err: unknown) => void;
}

export interface StaleJobReclaimer {
  stop(): void;
}

export function startStaleJobReclaimer(
  db: AppDb,
  opts: StaleJobReclaimerOptions = {},
): StaleJobReclaimer {
  const intervalMs = opts.intervalMs ?? 60_000;
  const staleAfterMs =
    opts.staleAfterMs ?? (DEFAULT_COMPILE_QUEUE_POLICY.expireInSeconds ?? 600) * 1000;
  const onError = opts.onError ?? console.error;

  const sweep = async (): Promise<void> => {
    try {
      const reclaimed = await reclaimStaleProcessingJobs(db, staleAfterMs);
      if (reclaimed.length > 0) {
        const jobIds = reclaimed.map((job) => job.id);
        console.warn(
          JSON.stringify({
            event: 'stale_job_reclaimed',
            jobIds,
            message: `reclaimed ${jobIds.length} job(s) stuck in processing`,
          }),
        );
        opts.onReclaim?.(jobIds);
      }
    } catch (err) {
      onError(err);
    }
  };

  void sweep();
  const timer = setInterval(() => void sweep(), intervalMs);
  timer.unref();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
