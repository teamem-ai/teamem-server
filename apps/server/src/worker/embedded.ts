/**
 * Embedded compile worker (AGPL-3.0-only).
 *
 * The in-process consumer the server starts when `TEAMEM_ALL_IN_ONE=true`. It
 * is the same consumer the standalone worker process will run in the
 * 3-container topology; only the composition root differs.
 *
 * Honest M0 boundary: the default handler acknowledges receipt of a compile job
 * and nothing more. Real F1 typed extraction lands with the queue/F1 tasks —
 * this file must NOT fabricate a concept page or any compile result to look
 * complete. The handler is injectable precisely so that real work replaces the
 * placeholder without touching the wiring.
 */
import type { CompileJob, CompileJobHandler, CompileQueue } from '../queue/boss.js';

/**
 * Default handler: record that a compile job arrived. No compile output is
 * produced or persisted — F1 is not wired yet, and pretending otherwise is a
 * red-line violation.
 */
export const acknowledgeCompileJob: CompileJobHandler = async (job: CompileJob) => {
  console.log(`[worker] compile job received: ${job.id} (F1 extraction not wired yet)`);
};

export interface EmbeddedWorker {
  /** Detach the consumer from the queue. */
  stop(): Promise<void>;
}

/**
 * Attach exactly one consumer to the compile queue. Returns a handle whose
 * `stop()` detaches the consumer (the queue itself is stopped separately, and
 * after the worker, by the composition root).
 */
export async function startEmbeddedWorker(
  queue: CompileQueue,
  handler: CompileJobHandler = acknowledgeCompileJob,
): Promise<EmbeddedWorker> {
  await queue.work(handler);
  return {
    async stop() {
      await queue.offWork();
    },
  };
}
