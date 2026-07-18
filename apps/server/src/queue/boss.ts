/**
 * pg-boss compile-queue lifecycle (AGPL-3.0-only).
 *
 * Minimal, injectable lifecycle over a single pg-boss instance: start/stop plus
 * the send/work/off-work primitives the composition root needs to embed a
 * compile worker (M0-PLAT-06). Queue-policy specifics — retention, retry, dead
 * letters, application-level job records — belong to the queue/F1 tasks
 * (M0-JOB-01/02/03) and are intentionally out of scope here.
 *
 * pg-boss lives inside Postgres, so no Redis/Valkey is introduced (fixed
 * technical direction). One PgBoss instance owns both the producer and the
 * embedded consumer, which lets shutdown close the worker before the queue.
 */
import { PgBoss } from 'pg-boss';

/** Stable, namespaced queue name. Must not drift between producer and worker. */
export const COMPILE_QUEUE = 'teamem.compile';

/** A single compile job as delivered to the worker handler. */
export interface CompileJob {
  readonly id: string;
  readonly data: unknown;
}

export type CompileJobHandler = (job: CompileJob) => Promise<void>;

export interface CompileQueue {
  /** Connect pg-boss and ensure the compile queue exists. */
  start(): Promise<void>;
  /** Gracefully stop pg-boss (drains in-flight work, then closes its pool). */
  stop(): Promise<void>;
  /** Enqueue a compile job; returns the job id (or null if deduplicated). */
  send(data: Record<string, unknown>): Promise<string | null>;
  /** Register a single consumer for the compile queue. */
  work(handler: CompileJobHandler): Promise<string>;
  /** Detach this instance's consumer without stopping the queue. */
  offWork(): Promise<void>;
}

export interface CreateCompileQueueOptions {
  /** Isolate pg-boss into a named schema (used by integration tests). */
  schema?: string;
  /** Surface async pg-boss errors instead of letting them go unobserved. */
  onError?: (err: Error) => void;
}

export function createCompileQueue(
  connectionString: string,
  opts: CreateCompileQueueOptions = {},
): CompileQueue {
  const boss = opts.schema
    ? new PgBoss({ connectionString, schema: opts.schema })
    : new PgBoss(connectionString);
  // pg-boss emits 'error' out-of-band; an unhandled listener would crash the
  // process. Route it to the injected sink (defaults to console.error).
  boss.on('error', (err) => (opts.onError ?? console.error)(err));

  return {
    async start() {
      await boss.start();
      await boss.createQueue(COMPILE_QUEUE);
    },
    async stop() {
      await boss.stop();
    },
    send(data) {
      return boss.send(COMPILE_QUEUE, data);
    },
    work(handler) {
      // pg-boss delivers a batch; fan it out one job at a time so a handler
      // failure only fails its own job.
      return boss.work(COMPILE_QUEUE, async (jobs) => {
        for (const job of jobs) {
          await handler({ id: job.id, data: job.data });
        }
      });
    },
    async offWork() {
      await boss.offWork(COMPILE_QUEUE);
    },
  };
}
