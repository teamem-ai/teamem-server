/**
 * pg-boss compile-queue lifecycle (AGPL-3.0-only).
 *
 * Injectable lifecycle over a single pg-boss instance: start/stop plus the
 * send/work/off-work primitives the composition root needs to embed a compile
 * worker. Queue-policy — retention, retry, backoff — is explicit and
 * configurable; the defaults represent the compile queue's expected behaviour.
 *
 * pg-boss lives inside Postgres, so no Redis/Valkey is introduced (fixed
 * technical direction). One PgBoss instance owns both the producer and the
 * embedded consumer, which lets shutdown close the worker before the queue.
 */
import type { Queue, QueueOptions as PgBossQueueOptions } from 'pg-boss';
import { PgBoss } from 'pg-boss';

/** Stable, namespaced queue name. Must not drift between producer and worker. */
export const COMPILE_QUEUE = 'teamem.compile';

/**
 * Explicit queue-policy defaults applied when the compile queue is created.
 * These override pg-boss's own defaults so the compile queue's behaviour is
 * documented and stable across pg-boss upgrades.
 */
export const DEFAULT_COMPILE_QUEUE_POLICY: PgBossQueueOptions = {
  /** How long a job may be active before it is expired and retried. */
  expireInSeconds: 600, // 10 minutes
  /** How long a job in created/retry state lives before being deleted. */
  retentionSeconds: 14 * 86_400, // 14 days
  /** How long completed jobs are kept after completion. */
  deleteAfterSeconds: 7 * 86_400, // 7 days
  /** Maximum retry attempts before the job is marked failed. */
  retryLimit: 3,
  /** Delay between retries, in seconds. */
  retryDelay: 30,
  /** Enable exponential backoff so retries spread out under contention. */
  retryBackoff: true,
};

/**
 * The message every producer must enqueue, and the only shape the worker
 * accepts.
 *
 * This lives on the queue interface rather than next to the consumer on
 * purpose. It used to be documented only in a comment while `send` took a
 * bare `Record<string, unknown>`, so four of the five producers enqueued
 * `{ jobId }` or `{ jobId, eventId }` and compiled cleanly. The worker
 * rejected each of those deliveries as malformed and returned without
 * claiming, leaving the DB job row in `queued` forever — every ingest path
 * except `POST /v1/compilations` silently never compiled. Typing the payload
 * here is what makes that class of drift a compile error.
 *
 * `teamId` and `projectId` are mandatory because the worker inherits the
 * initiator's scope from them (§5.5); a delivery without them has no scope
 * to run under and must not be processed.
 */
export interface CompileJobMessage {
  readonly jobId: string;
  readonly teamId: string;
  readonly projectId: string;
  readonly kind: string;
}

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
  /**
   * Enqueue a compile job; returns the job id (or null if deduplicated).
   *
   * When `options.id` is set, pg-boss uses that value as the job's
   * primary key. If a job with that id already exists, the send is
   * rejected with the pg-boss-level unique-constraint error, which the
   * caller can catch to treat as an idempotent no-op.
   */
  send(
    data: CompileJobMessage,
    options?: { id?: string },
  ): Promise<string | null>;
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
  /**
   * Queue-policy overrides merged on top of {@link DEFAULT_COMPILE_QUEUE_POLICY}.
   * Omitted fields keep the compile-queue default; set a field to `undefined`
   * to fall back to pg-boss's own default for that field.
   */
  queuePolicy?: Partial<PgBossQueueOptions>;
}

/** Merge explicit overrides on top of the compile-queue defaults. */
function resolveQueuePolicy(
  overrides?: Partial<PgBossQueueOptions>,
): Omit<Queue, 'name'> {
  return { ...DEFAULT_COMPILE_QUEUE_POLICY, ...overrides };
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

  const queuePolicy = resolveQueuePolicy(opts.queuePolicy);

  return {
    async start() {
      await boss.start();
      await boss.createQueue(COMPILE_QUEUE, queuePolicy);
    },
    async stop() {
      await boss.stop();
    },
    send(data, options) {
      return boss.send(COMPILE_QUEUE, data, options);
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
