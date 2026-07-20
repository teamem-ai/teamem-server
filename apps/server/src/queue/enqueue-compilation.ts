/**
 * Compilation Enqueue Service (DUA-172 / M0-JOB-02).
 *
 * Creates a persistent application-layer job record, per-event outcome rows,
 * AND a pg-boss message — atomically from the caller's perspective. Handles
 * idempotent replay and safe crash recovery between DB operations.
 *
 * ## Order of operations
 *
 * 1. Create (or replay) the job row via {@link createJob} — idempotency key
 *    prevents duplicates.
 * 2. Upsert per-event rows via {@link upsertJobEvent} — each (job_id, event_id)
 *    starts as `pending`.
 * 3. Send the pg-boss message with the job UUID as the pg-boss-level id so the
 *    worker can correlate the delivery with our application-layer row.
 *
 * ## Crash-recovery guarantee
 *
 * If the process dies between steps 2 and 3, a retry with the same
 * idempotency key will replay the existing job (created=false) and re-attempt
 * the pg-boss send.  The pg-boss-level unique constraint on the custom `id`
 * ensures the same message is never inserted twice.
 *
 * If the pg-boss INSERT succeeds but the process dies before the send promise
 * resolves, the retry will catch the unique-constraint error and treat it as
 * success — the message was delivered.
 */
import type { AppDb } from '../db/client.js';
import { createJob, upsertJobEvent } from '../db/repositories/jobs.js';
import type { CompileQueue } from './boss.js';

// ── Request / result types ──────────────────────────────────────────────────

export interface EnqueueCompilationRequest {
  readonly teamId: string;
  readonly projectId: string;
  /** Job kind — scopes idempotency (N1: different kinds don't collide). */
  readonly kind: 'ingest_event' | 'ingest_batch' | 'compilation';
  /** At least one event id; used to populate per-event status rows. */
  readonly eventIds: readonly string[];
  /** Initiator kind — preserved for N6 worker attribution. */
  readonly initiatedByKind: 'credential' | 'connector';
  readonly initiatedByCredentialId?: string | null;
  readonly initiatedByPrincipalId?: string | null;
  readonly initiatedByConnector?: string | null;
  /**
   * Idempotency key — the same key with the same hash replays the existing
   * job; the same key with a different hash is a conflict (N1).
   */
  readonly idempotencyKey?: string | null;
  readonly idempotencyRequestHash?: string | null;
  /** Optional result snapshot stored on the job for idempotent replay. */
  readonly resultSnapshot?: unknown | null;
}

export interface EnqueueCompilationResult {
  /** The job's UUID — the primary key in both the DB and pg-boss. */
  readonly jobId: string;
  /** true when a new row was inserted; false for an idempotent replay. */
  readonly created: boolean;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Detect a Postgres unique-constraint violation (23505) from any error
 * wrapped by pg-boss. pg-boss 12.x wraps adapter-level errors in a generic
 * Error whose message contains the constraint name, not always the code.
 * We check both the raw message and a nested `cause` so we reliably detect
 * the case where a job with the given id already exists.
 */
function isIdConflict(err: unknown): boolean {
  if (err instanceof Error) {
    // pg-boss wraps the constraint message; the job table's PK is 'id'.
    if (err.message.includes('duplicate key') && err.message.includes('job')) {
      return true;
    }
    const cause = (err as { cause?: { code?: string; constraint?: string } })
      .cause;
    if (
      cause &&
      cause.code === '23505' &&
      cause.constraint &&
      /job.*pkey|job_pk/.test(cause.constraint)
    ) {
      return true;
    }
  }
  return false;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Enqueue a compilation job: create the DB job + per-event rows + pg-boss
 * message. All three components share the same UUID so the worker can look
 * up the application-layer job from the delivery.
 *
 * ## Idempotency & crash recovery
 *
 * - First call with a given idempotencyKey → new job + new pg-boss message.
 * - Second call with same key + same hash → replay: returns the existing job,
 *   ensures per-event rows are present, and re-attempts the pg-boss send
 *   (harmless no-op when the message already exists).
 * - Second call with same key + different hash → throws IdempotencyConflictError.
 *
 * Per-event rows are always upserted so a retry after a partial crash
 * fills in any rows that were missed.
 */
export async function enqueueCompilation(
  db: AppDb,
  compileQueue: CompileQueue,
  req: EnqueueCompilationRequest,
): Promise<EnqueueCompilationResult> {
  // 1. Create (or replay) the application-layer job row.
  const { job, created } = await createJob(db, {
    teamId: req.teamId,
    projectId: req.projectId,
    kind: req.kind,
    initiatedByKind: req.initiatedByKind,
    initiatedByCredentialId: req.initiatedByCredentialId ?? null,
    initiatedByPrincipalId: req.initiatedByPrincipalId ?? null,
    initiatedByConnector: req.initiatedByConnector ?? null,
    idempotencyKey: req.idempotencyKey ?? null,
    idempotencyRequestHash: req.idempotencyRequestHash ?? null,
    resultSnapshot: req.resultSnapshot ?? null,
    eventCount: req.eventIds.length,
  });

  // 2. Upsert per-event outcome rows — always run so a retry after a
  //    partial crash fills in any missing rows (idempotent by PK).
  for (const eventId of req.eventIds) {
    await upsertJobEvent(db, {
      teamId: req.teamId,
      projectId: req.projectId,
      jobId: job.id,
      eventId,
      status: 'pending',
    });
  }

  // 3. Ensure the pg-boss message exists.
  //
  //    Send with the job UUID as the pg-boss-level id so:
  //    a) The worker can correlate the delivery with our DB row.
  //    b) A duplicate send (from crash recovery) triggers a unique-constraint
  //       error, which we catch and treat as success.
  try {
    await compileQueue.send(
      { jobId: job.id, teamId: job.teamId, projectId: job.projectId, kind: job.kind },
      { id: job.id },
    );
  } catch (err: unknown) {
    if (isIdConflict(err)) {
      // The pg-boss message was already delivered (crash-recovery path).
      // This is a successful outcome — the worker will process the job.
    } else {
      throw err;
    }
  }

  return { jobId: job.id, created };
}
