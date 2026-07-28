/**
 * Embedded compile worker (AGPL-3.0-only).
 *
 * The in-process consumer the server starts when `TEAMEM_ALL_IN_ONE=true`. It
 * is the same consumer the standalone worker process will run in the
 * 3-container topology; only the composition root differs.
 *
 * When no LLM provider is configured there is nothing to compile, and the
 * handler must say so in the job row rather than leaving it untouched — see
 * {@link createNoProviderHandler}.
 */
import type { AppDb } from '../db/client.js';
import { claimJob, updateJobStatus } from '../db/repositories/jobs.js';
import type {
  CompileJob,
  CompileJobHandler,
  CompileJobMessage,
  CompileQueue,
} from '../queue/boss.js';

/**
 * Handler used when the deployment has no LLM provider.
 *
 * Compilation genuinely cannot run, so the job is claimed and moved to a
 * TERMINAL state with an explicit reason. Previously this only logged, which
 * left the row in `queued` forever: pg-boss considered its own message
 * complete, nothing would ever pick the row up again, and an operator reading
 * the jobs table saw work that appeared to be pending indefinitely.
 *
 * `failed` rather than `completed`, because nothing was compiled and reporting
 * success for work that never happened is exactly the kind of silent fallback
 * the engineering red lines forbid (§5.1). The frozen job-status union is
 * `queued | processing | completed | failed | cancelled` — there is no
 * `skipped`, and adding one would be a v0.3 contract change plus a migration,
 * which a missing-provider deployment does not justify.
 *
 * The error payload is a fixed string: it names the missing configuration and
 * carries no payload, prompt, or credential (§5.3).
 */
export function createNoProviderHandler(db: AppDb): CompileJobHandler {
  return async (job: CompileJob): Promise<void> => {
    const msg = job.data as CompileJobMessage;

    if (!msg?.jobId || !msg?.teamId || !msg?.projectId) {
      console.error(
        `[worker] malformed pg-boss message for job ${job.id}: missing required fields`,
      );
      return;
    }

    const { jobId, teamId, projectId } = msg;

    const claimed = await claimJob(db, teamId, projectId, jobId);
    if (!claimed) {
      // Another consumer claimed it first — its outcome stands.
      return;
    }

    await updateJobStatus(db, teamId, projectId, jobId, 'failed', {
      error: {
        code: 'no_llm_provider',
        message:
          'No LLM provider is configured, so this job could not be compiled. ' +
          'Set TEAMEM_ANTHROPIC_API_KEY, TEAMEM_OPENAI_API_KEY, ' +
          'TEAMEM_OPENROUTER_API_KEY, or the OpenAI-compatible pair, then ' +
          're-submit the events.',
      },
    });

    console.warn(
      JSON.stringify({
        event: 'compile_job_no_provider',
        jobId,
        message: 'job failed: no LLM provider configured',
      }),
    );
  };
}

/**
 * Log-only handler retained for tests and for callers that deliberately want a
 * no-op consumer. Production wiring uses {@link createNoProviderHandler}, which
 * needs a database handle to reach a terminal state.
 */
export const acknowledgeCompileJob: CompileJobHandler = async (job: CompileJob) => {
  console.log(`[worker] compile job received: ${job.id} (no handler configured)`);
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
