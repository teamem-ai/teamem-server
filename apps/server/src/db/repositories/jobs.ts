/**
 * Job Repository (DUA-179).
 *
 * Create/replay jobs by project + kind + idempotency key; compare request
 * hashes; persist initiator/scope, lifecycle timestamps, per-event status,
 * sanitized errors, concept page IDs, and result snapshots.
 *
 * Idempotency semantics (N1):
 * - Same (project, kind, key) + same request hash → return existing job (replay).
 * - Same (project, kind, key) + different request hash → 409 idempotency_conflict.
 * - Different kind → no collision (same key re-used for batch vs compilation).
 *
 * All business queries carry team_id (red line 5.5). Error payloads are
 * sanitized to {code, message} — never expose raw payloads, prompts, or
 * provider responses (N3/N7).
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import * as schema from '../../db/schema.js';
import type { AppDb } from '../../db/client.js';
import type { ScopeContext } from '../../auth/scope.js';
import { isProjectScope, getTeamId, getProjectId } from '../../auth/scope.js';

// ── Error types ─────────────────────────────────────────────────────────────

/**
 * Thrown when an idempotency key collision is detected with a different
 * request hash — the caller must not retry the same key with changed data.
 */
export class IdempotencyConflictError extends Error {
  readonly name = 'IdempotencyConflictError';

  /** The existing job ID — the caller may use it to redirect. */
  readonly existingJobId: string;

  constructor(existingJobId: string) {
    super('idempotency_conflict: same key, different payload hash');
    this.existingJobId = existingJobId;
  }
}

// ── DTOs (storage-layer types, mirrors the Drizzle schema row shapes) ───────

export interface JobRow {
  readonly id: string;
  readonly teamId: string;
  readonly projectId: string;
  readonly kind: string;
  readonly status: string;
  readonly attempts: number;
  readonly initiatedByKind: string;
  readonly initiatedByCredentialId: string | null;
  readonly initiatedByPrincipalId: string | null;
  readonly initiatedByConnector: string | null;
  readonly idempotencyKey: string | null;
  readonly idempotencyRequestHash: string | null;
  readonly resultSnapshot: unknown | null;
  readonly eventCount: number;
  readonly error: unknown | null;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
}

export interface JobEventRow {
  readonly teamId: string;
  readonly projectId: string;
  readonly jobId: string;
  readonly eventId: string;
  readonly status: string;
  readonly reason: string | null;
  readonly error: unknown | null;
  readonly conceptUuids: string[] | null;
  readonly updatedAt: Date;
}

// ── Request types ───────────────────────────────────────────────────────────

export interface CreateJobRequest {
  readonly teamId: string;
  readonly projectId: string;
  readonly kind: 'ingest_event' | 'ingest_batch' | 'compilation';
  readonly initiatedByKind: 'credential' | 'connector';
  readonly initiatedByCredentialId?: string | null;
  readonly initiatedByPrincipalId?: string | null;
  readonly initiatedByConnector?: string | null;
  readonly idempotencyKey?: string | null;
  readonly idempotencyRequestHash?: string | null;
  readonly resultSnapshot?: unknown | null;
  readonly eventCount: number;
}

export interface UpsertJobEventRequest {
  readonly teamId: string;
  readonly projectId: string;
  readonly jobId: string;
  readonly eventId: string;
  readonly status: 'pending' | 'compiled' | 'skipped' | 'failed';
  readonly reason?: string | null;
  /** Sanitized error — callers must strip payloads/prompts/provider data (N3). */
  readonly error?: { code: string; message: string } | null;
  readonly conceptUuids?: string[] | null;
}

// ── Column sets for SELECT (reused between functions) ───────────────────────

const JOB_COLUMNS = {
  id: schema.jobs.id,
  teamId: schema.jobs.teamId,
  projectId: schema.jobs.projectId,
  kind: schema.jobs.kind,
  status: schema.jobs.status,
  attempts: schema.jobs.attempts,
  initiatedByKind: schema.jobs.initiatedByKind,
  initiatedByCredentialId: schema.jobs.initiatedByCredentialId,
  initiatedByPrincipalId: schema.jobs.initiatedByPrincipalId,
  initiatedByConnector: schema.jobs.initiatedByConnector,
  idempotencyKey: schema.jobs.idempotencyKey,
  idempotencyRequestHash: schema.jobs.idempotencyRequestHash,
  resultSnapshot: schema.jobs.resultSnapshot,
  eventCount: schema.jobs.eventCount,
  error: schema.jobs.error,
  createdAt: schema.jobs.createdAt,
  startedAt: schema.jobs.startedAt,
  finishedAt: schema.jobs.finishedAt,
};

const JOB_EVENT_COLUMNS = {
  teamId: schema.jobEvents.teamId,
  projectId: schema.jobEvents.projectId,
  jobId: schema.jobEvents.jobId,
  eventId: schema.jobEvents.eventId,
  status: schema.jobEvents.status,
  reason: schema.jobEvents.reason,
  error: schema.jobEvents.error,
  conceptUuids: schema.jobEvents.conceptUuids,
  updatedAt: schema.jobEvents.updatedAt,
};

// ── Create / replay job ─────────────────────────────────────────────────────

/**
 * Create a job with idempotency enforcement (N1).
 *
 * If a job already exists with the same (projectId, kind, idempotencyKey):
 *   - Same idempotencyRequestHash → returns the existing job (idempotent replay).
 *   - Different hash → throws {@link IdempotencyConflictError}.
 *
 * If no existing job is found, inserts a new row. Handles the race where
 * two concurrent callers create the same key by catching the unique-constraint
 * violation and re-querying.
 *
 * @throws IdempotencyConflictError on hash mismatch
 */
export async function createJob(
  db: AppDb,
  req: CreateJobRequest,
): Promise<{ job: JobRow; created: boolean }> {
  // 0. Validate eventCount against the frozen DTO minimum (contract: ≥1).
  if (!Number.isInteger(req.eventCount) || req.eventCount < 1) {
    throw new Error(
      `eventCount must be >= 1, got ${req.eventCount}`,
    );
  }

  // 1. Check for an existing idempotent match (partial unique index cover).
  if (req.idempotencyKey) {
    const existing = await findJobByIdempotencyKey(
      db,
      req.teamId,
      req.projectId,
      req.kind,
      req.idempotencyKey,
    );

    if (existing) {
      // Same hash → idempotent replay.
      if (
        req.idempotencyRequestHash &&
        existing.idempotencyRequestHash === req.idempotencyRequestHash
      ) {
        return { job: existing, created: false };
      }
      // Different hash → conflict.
      throw new IdempotencyConflictError(existing.id);
    }
  }

  // 2. Insert. If a concurrent caller wins the race, the unique index
  //    will reject us; catch it, re-query, and re-apply the rules.
  const jobId = randomUUID();
  const now = new Date();

  try {
    const rows = await db
      .insert(schema.jobs)
      .values({
        id: jobId,
        teamId: req.teamId,
        projectId: req.projectId,
        kind: req.kind,
        status: 'queued',
        attempts: 0,
        initiatedByKind: req.initiatedByKind,
        initiatedByCredentialId: req.initiatedByCredentialId ?? null,
        initiatedByPrincipalId: req.initiatedByPrincipalId ?? null,
        initiatedByConnector: req.initiatedByConnector ?? null,
        idempotencyKey: req.idempotencyKey ?? null,
        idempotencyRequestHash: req.idempotencyRequestHash ?? null,
        resultSnapshot: req.resultSnapshot ?? null,
        eventCount: req.eventCount,
        error: null,
        createdAt: now,
      })
      .returning(JOB_COLUMNS);

    const job = rows[0];
    if (!job) {
      throw new Error('job insert returned no row');
    }

    return { job, created: true };
  } catch (err: unknown) {
    // If the unique constraint fired, another caller won the race —
    // re-query and apply the same replay/conflict rules.
    if (
      err instanceof Error &&
      err.message.includes('jobs_idempotency_uq')
    ) {
      if (!req.idempotencyKey) {
        throw err;
      }
      const existing = await findJobByIdempotencyKey(
        db,
        req.teamId,
        req.projectId,
        req.kind,
        req.idempotencyKey,
      );
      if (!existing) {
        throw new Error(
          'idempotency constraint violated but existing job not found — this should not happen',
        );
      }
      if (
        req.idempotencyRequestHash &&
        existing.idempotencyRequestHash === req.idempotencyRequestHash
      ) {
        return { job: existing, created: false };
      }
      throw new IdempotencyConflictError(existing.id);
    }
    throw err;
  }
}

// ── Query helpers ───────────────────────────────────────────────────────────

/**
 * Find a job by its idempotency identity (team, project, kind, key).
 * Returns undefined when no match exists.
 *
 * The team_id constraint satisfies red line 5.5 — every business query
 * must explicitly carry team identity, even with a project-level index.
 * The database partial unique index `jobs_idempotency_uq` guarantees at most
 * one row for a given (project, kind, key) where key IS NOT NULL.
 */
export async function findJobByIdempotencyKey(
  db: AppDb,
  teamId: string,
  projectId: string,
  kind: string,
  idempotencyKey: string,
): Promise<JobRow | undefined> {
  const rows = await db
    .select(JOB_COLUMNS)
    .from(schema.jobs)
    .where(
      and(
        eq(schema.jobs.teamId, teamId),
        eq(schema.jobs.projectId, projectId),
        eq(schema.jobs.kind, kind as typeof schema.jobs.kind.enumValues[number]),
        eq(schema.jobs.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);

  return rows[0];
}

/**
 * Fetch a single job by ID, scoped to the caller's team (red line 5.5).
 * Returns undefined when the job does not exist or belongs to a different team.
 */
export async function getJob(
  db: AppDb,
  scope: ScopeContext,
  jobId: string,
): Promise<JobRow | undefined> {
  const teamId = getTeamId(scope);

  const conditions = [
    eq(schema.jobs.id, jobId),
    eq(schema.jobs.teamId, teamId),
  ];

  // For project scope, also filter by project_id.
  if (isProjectScope(scope)) {
    conditions.push(eq(schema.jobs.projectId, getProjectId(scope)));
  }

  const rows = await db
    .select(JOB_COLUMNS)
    .from(schema.jobs)
    .where(and(...conditions))
    .limit(1);

  return rows[0];
}

// ── Lifecycle updates ───────────────────────────────────────────────────────

/**
 * Transition a job's status and optionally set lifecycle timestamps.
 *
 * Requires team_id + project_id (red line 5.5): workers/retries inherit the
 * initiator's scope, so every status mutation carries the owning project.
 *
 * - queued → processing: sets started_at = now
 * - → completed / failed / cancelled: sets finished_at = now
 * - → failed: may also set a sanitized error (never raw payloads, N3).
 */
export async function updateJobStatus(
  db: AppDb,
  teamId: string,
  projectId: string,
  jobId: string,
  status: 'processing' | 'completed' | 'failed' | 'cancelled',
  opts?: {
    /** Sanitized error {code, message} — callers must strip payload/prompt data. */
    error?: { code: string; message: string } | null;
    /** Result snapshot for idempotent replay (e.g. batch response). */
    resultSnapshot?: unknown | null;
  },
): Promise<JobRow | undefined> {
  const now = new Date();
  const updates: Record<string, unknown> = {
    status,
    // When starting, record the start time.
    ...(status === 'processing' ? { startedAt: now } : {}),
    // When finishing, record the finish time.
    ...(status === 'completed' || status === 'failed' || status === 'cancelled'
      ? { finishedAt: now }
      : {}),
  };

  if (opts?.error !== undefined) {
    updates['error'] = opts.error;
  }
  if (opts?.resultSnapshot !== undefined) {
    updates['resultSnapshot'] = opts.resultSnapshot;
  }

  const rows = await db
    .update(schema.jobs)
    .set(updates)
    .where(
      and(
        eq(schema.jobs.id, jobId),
        eq(schema.jobs.teamId, teamId),
        eq(schema.jobs.projectId, projectId),
      ),
    )
    .returning(JOB_COLUMNS);

  return rows[0];
}

// ── Per-event results ───────────────────────────────────────────────────────

/**
 * Upsert a single per-event job outcome (N4 discriminated result).
 *
 * Each row tracks the compilation outcome for one event within a job.
 * The composite PK (job_id, event_id) ensures at most one row per event per job.
 * ON CONFLICT updates the status/reason/error/conceptUuids so a retried job
 * can overwrite its own per-event state.
 */
export async function upsertJobEvent(
  db: AppDb,
  req: UpsertJobEventRequest,
): Promise<JobEventRow> {
  const now = new Date();

  const rows = await db
    .insert(schema.jobEvents)
    .values({
      teamId: req.teamId,
      projectId: req.projectId,
      jobId: req.jobId,
      eventId: req.eventId,
      status: req.status,
      reason: req.reason ?? null,
      error: req.error ?? null,
      conceptUuids: req.conceptUuids ?? null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [schema.jobEvents.jobId, schema.jobEvents.eventId],
      set: {
        status: req.status,
        reason: req.reason ?? null,
        error: req.error ?? null,
        conceptUuids: req.conceptUuids ?? null,
        updatedAt: now,
      },
    })
    .returning(JOB_EVENT_COLUMNS);

  const row = rows[0];
  if (!row) {
    throw new Error('job_event upsert returned no row');
  }

  return row;
}

/**
 * Fetch all per-event outcomes for a job, scoped to team + project
 * (red line 5.5 — every business query must carry tenant identity).
 * Results are ordered by event_id for determinism.
 */
export async function getJobEvents(
  db: AppDb,
  teamId: string,
  projectId: string,
  jobId: string,
): Promise<JobEventRow[]> {
  const rows = await db
    .select(JOB_EVENT_COLUMNS)
    .from(schema.jobEvents)
    .where(
      and(
        eq(schema.jobEvents.teamId, teamId),
        eq(schema.jobEvents.projectId, projectId),
        eq(schema.jobEvents.jobId, jobId),
      ),
    )
    .orderBy(schema.jobEvents.eventId);

  return rows;
}
