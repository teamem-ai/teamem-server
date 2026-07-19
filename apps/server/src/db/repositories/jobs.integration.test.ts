/**
 * Integration tests for the Job Repository (DUA-179).
 *
 * Uses real Postgres via the test scaffolding — no mock databases (red line).
 * Tests the full create/replay/conflict cycle, lifecycle updates, per-event
 * outcomes, scope enforcement, and cross-tenant isolation.
 *
 * Requirements:
 *   POSTGRES_PASSWORD=x docker compose up -d postgres
 *   psql < apps/server/drizzle/0000_*.sql
 *   TEST_DATABASE_URL=postgres://teamem:x@localhost:5432/teamem pnpm vitest ...
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { createDb, type AppDb } from '../../db/client.js';
import {
  connectDatabase,
  closeDatabase,
  type Pool,
} from '../../test/database.js';
import { projectScope, allProjectsScope } from '../../auth/scope.js';
import * as schema from '../../db/schema.js';
import {
  createJob,
  getJob,
  updateJobStatus,
  upsertJobEvent,
  getJobEvents,
  findJobByIdempotencyKey,
  IdempotencyConflictError,
  type CreateJobRequest,
} from './jobs.js';
import { sql, eq } from 'drizzle-orm';

// ── Setup ───────────────────────────────────────────────────────────────────

const url = process.env['TEST_DATABASE_URL'];

describe.skipIf(!url)('jobs repository (live Postgres)', () => {
  let pool: Pool;
  let db: AppDb;

  beforeAll(() => {
    ({ pool } = connectDatabase());
    db = createDb(url!, { pool: pool as unknown as import('pg').Pool });
  });

  afterAll(async () => {
    await closeDatabase(pool);
  });

  // Clean data between tests: delete in dependency order (children first)
  beforeEach(async () => {
    await db.delete(schema.jobEvents);
    await db.delete(schema.jobs);
    await db.delete(schema.events); // events referenced by job_events FK
    await db.delete(schema.apiKeys);
    await db.delete(schema.principals);
    await db.delete(schema.projects);
    await db.delete(schema.teams);
  });

  // ── Helpers ──────────────────────────────────────────────────────────────

  function freshTeamId(): string {
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return `team_${suffix.replace(/[^A-Za-z0-9]/g, '')}`;
  }

  function freshProjectId(): string {
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return `prj_${suffix.replace(/[^A-Za-z0-9]/g, '')}`;
  }

  async function seedTeam(
    teamId: string,
    name = 'Test Team',
  ): Promise<void> {
    await db.execute(
      sql`INSERT INTO teams (id, name) VALUES (${teamId}, ${name}) ON CONFLICT (id) DO NOTHING`,
    );
  }

  async function seedProject(
    teamId: string,
    projectId: string,
    name = 'Test Project',
  ): Promise<void> {
    await db.execute(
      sql`INSERT INTO projects (id, team_id, name) VALUES (${projectId}, ${teamId}, ${name})`,
    );
  }

  /**
   * Seed a minimal event row so job_event FK constraints are satisfied.
   * Uses raw SQL to bypass the full event-repository dependency.
   */
  async function seedEvent(
    teamId: string,
    projectId: string,
    eventId: string,
  ): Promise<void> {
    await db.execute(sql`
      INSERT INTO events (id, team_id, project_id, channel, kind, connector_kind,
        delivery_id, item_key, external_id, actor_provenance, occurred_at,
        occurred_at_provenance, payload, payload_bytes, payload_hash,
        payload_schema_version, envelope_version)
      VALUES (${eventId}, ${teamId}, ${projectId}, 'cli', 'cli_init', 'cli',
        ${`dk_${randomUUID().replace(/-/g, '').slice(0, 12)}`},
        'root', 'x', 'unknown', now(), 'server', '{}'::jsonb, 2, 'h1', 1, 1)
    `);
  }

  function makeCreateJobRequest(
    teamId: string,
    projectId: string,
    overrides: Partial<CreateJobRequest> = {},
  ): CreateJobRequest {
    return {
      teamId,
      projectId,
      kind: 'ingest_event',
      initiatedByKind: 'credential',
      initiatedByCredentialId: 'key_test',
      initiatedByPrincipalId: null,
      initiatedByConnector: null,
      idempotencyKey: null,
      idempotencyRequestHash: null,
      eventCount: 1,
      ...overrides,
    };
  }

  // ── createJob: basic ─────────────────────────────────────────────────────

  it('creates a new job and returns the full row', async () => {
    const teamId = freshTeamId();
    const projectId = freshProjectId();
    await seedTeam(teamId);
    await seedProject(teamId, projectId);

    const req = makeCreateJobRequest(teamId, projectId);
    const { job, created } = await createJob(db, req);

    expect(created).toBe(true);
    expect(job.id).toBeDefined();
    expect(job.teamId).toBe(teamId);
    expect(job.projectId).toBe(projectId);
    expect(job.kind).toBe('ingest_event');
    expect(job.status).toBe('queued');
    expect(job.attempts).toBe(0);
    expect(job.initiatedByKind).toBe('credential');
    expect(job.initiatedByCredentialId).toBe('key_test');
    expect(job.eventCount).toBe(1);
    expect(job.error).toBeNull();
    expect(job.createdAt).toBeInstanceOf(Date);
    expect(job.startedAt).toBeNull();
    expect(job.finishedAt).toBeNull();
  });

  it('persists initiator fields correctly (credential variant)', async () => {
    const teamId = freshTeamId();
    const projectId = freshProjectId();
    await seedTeam(teamId);
    await seedProject(teamId, projectId);

    const req = makeCreateJobRequest(teamId, projectId, {
      initiatedByKind: 'credential',
      initiatedByCredentialId: 'key_abc123',
      initiatedByPrincipalId: 'pri_def456',
    });
    const { job } = await createJob(db, req);

    expect(job.initiatedByKind).toBe('credential');
    expect(job.initiatedByCredentialId).toBe('key_abc123');
    expect(job.initiatedByPrincipalId).toBe('pri_def456');
    expect(job.initiatedByConnector).toBeNull();
  });

  it('persists initiator fields correctly (connector variant)', async () => {
    const teamId = freshTeamId();
    const projectId = freshProjectId();
    await seedTeam(teamId);
    await seedProject(teamId, projectId);

    const req = makeCreateJobRequest(teamId, projectId, {
      initiatedByKind: 'connector',
      initiatedByCredentialId: null,
      initiatedByConnector: 'github',
    });
    const { job } = await createJob(db, req);

    expect(job.initiatedByKind).toBe('connector');
    expect(job.initiatedByCredentialId).toBeNull();
    expect(job.initiatedByConnector).toBe('github');
  });

  // ── createJob: idempotent replay (same key + same hash) ──────────────────

  it('replays an existing job when idempotency key and hash match', async () => {
    const teamId = freshTeamId();
    const projectId = freshProjectId();
    await seedTeam(teamId);
    await seedProject(teamId, projectId);

    const key = 'my-idempotency-key-001';
    const hash = 'sha256-abc123';
    const resultSnapshot = { results: ['a', 'b'] };

    // First call: creates a new job.
    const first = await createJob(
      db,
      makeCreateJobRequest(teamId, projectId, {
        idempotencyKey: key,
        idempotencyRequestHash: hash,
        resultSnapshot,
      }),
    );
    expect(first.created).toBe(true);

    // Second call with same key + hash: returns the SAME job.
    const second = await createJob(
      db,
      makeCreateJobRequest(teamId, projectId, {
        idempotencyKey: key,
        idempotencyRequestHash: hash,
        resultSnapshot,
      }),
    );
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);
    expect(second.job.idempotencyKey).toBe(key);
    expect(second.job.idempotencyRequestHash).toBe(hash);
    // The result snapshot from the original job is preserved.
    expect(second.job.resultSnapshot).toEqual(resultSnapshot);
  });

  // ── createJob: idempotency conflict (same key, different hash) ───────────

  it('throws IdempotencyConflictError when key matches but hash differs', async () => {
    const teamId = freshTeamId();
    const projectId = freshProjectId();
    await seedTeam(teamId);
    await seedProject(teamId, projectId);

    const key = 'my-idempotency-key-002';

    // Create first job.
    const first = await createJob(
      db,
      makeCreateJobRequest(teamId, projectId, {
        idempotencyKey: key,
        idempotencyRequestHash: 'hash-v1',
      }),
    );
    expect(first.created).toBe(true);

    // Attempt with same key, different hash → conflict.
    await expect(
      createJob(
        db,
        makeCreateJobRequest(teamId, projectId, {
          idempotencyKey: key,
          idempotencyRequestHash: 'hash-v2',
        }),
      ),
    ).rejects.toThrow(IdempotencyConflictError);

    // The error carries the existing job ID.
    try {
      await createJob(
        db,
        makeCreateJobRequest(teamId, projectId, {
          idempotencyKey: key,
          idempotencyRequestHash: 'hash-v2',
        }),
      );
    } catch (err) {
      expect(err).toBeInstanceOf(IdempotencyConflictError);
      expect((err as IdempotencyConflictError).existingJobId).toBe(
        first.job.id,
      );
    }
  });

  // ── createJob: same key, different kind → no collision ───────────────────

  it('allows the same idempotency key in different job kinds (N1)', async () => {
    const teamId = freshTeamId();
    const projectId = freshProjectId();
    await seedTeam(teamId);
    await seedProject(teamId, projectId);

    const key = 'shared-key-across-kinds';

    // Create an ingest_batch job.
    const batch = await createJob(
      db,
      makeCreateJobRequest(teamId, projectId, {
        kind: 'ingest_batch',
        idempotencyKey: key,
        idempotencyRequestHash: 'batch-hash',
      }),
    );
    expect(batch.created).toBe(true);

    // Same key, compilation kind → should NOT collide.
    const compilation = await createJob(
      db,
      makeCreateJobRequest(teamId, projectId, {
        kind: 'compilation',
        idempotencyKey: key,
        idempotencyRequestHash: 'comp-hash',
      }),
    );
    expect(compilation.created).toBe(true);
    expect(compilation.job.id).not.toBe(batch.job.id);
  });

  // ── createJob: no idempotency key ────────────────────────────────────────

  it('creates distinct jobs when no idempotency key is provided', async () => {
    const teamId = freshTeamId();
    const projectId = freshProjectId();
    await seedTeam(teamId);
    await seedProject(teamId, projectId);

    const first = await createJob(
      db,
      makeCreateJobRequest(teamId, projectId, { idempotencyKey: null }),
    );
    const second = await createJob(
      db,
      makeCreateJobRequest(teamId, projectId, { idempotencyKey: null }),
    );

    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(first.job.id).not.toBe(second.job.id);
  });

  // ── createJob: eventCount validation (frozen DTO: ≥1) ───────────────────

  it('rejects eventCount = 0', async () => {
    const teamId = freshTeamId();
    const projectId = freshProjectId();
    await seedTeam(teamId);
    await seedProject(teamId, projectId);

    await expect(
      createJob(
        db,
        makeCreateJobRequest(teamId, projectId, { eventCount: 0 }),
      ),
    ).rejects.toThrow(/eventCount/);
  });

  it('rejects negative eventCount', async () => {
    const teamId = freshTeamId();
    const projectId = freshProjectId();
    await seedTeam(teamId);
    await seedProject(teamId, projectId);

    await expect(
      createJob(
        db,
        makeCreateJobRequest(teamId, projectId, { eventCount: -1 }),
      ),
    ).rejects.toThrow(/eventCount/);
  });

  it('rejects non-integer eventCount', async () => {
    const teamId = freshTeamId();
    const projectId = freshProjectId();
    await seedTeam(teamId);
    await seedProject(teamId, projectId);

    await expect(
      createJob(
        db,
        makeCreateJobRequest(teamId, projectId, { eventCount: 1.5 }),
      ),
    ).rejects.toThrow(/eventCount/);
  });

  // ── findJobByIdempotencyKey ──────────────────────────────────────────────

  it('findJobByIdempotencyKey returns undefined for unknown key', async () => {
    const teamId = freshTeamId();
    const projectId = freshProjectId();
    await seedTeam(teamId);
    await seedProject(teamId, projectId);

    const result = await findJobByIdempotencyKey(
      db,
      teamId,
      projectId,
      'ingest_event',
      'nonexistent-key',
    );
    expect(result).toBeUndefined();
  });

  it('findJobByIdempotencyKey finds an existing job', async () => {
    const teamId = freshTeamId();
    const projectId = freshProjectId();
    await seedTeam(teamId);
    await seedProject(teamId, projectId);

    const key = 'lookup-key-001';
    const { job: created } = await createJob(
      db,
      makeCreateJobRequest(teamId, projectId, {
        idempotencyKey: key,
        idempotencyRequestHash: 'test-hash',
      }),
    );

    const found = await findJobByIdempotencyKey(
      db,
      teamId,
      projectId,
      'ingest_event',
      key,
    );
    expect(found).toBeDefined();
    expect(found!.id).toBe(created.id);
  });

  it('findJobByIdempotencyKey respects team_id (cross-tenant isolation)', async () => {
    const teamA = freshTeamId();
    const teamB = freshTeamId();
    const projectA = freshProjectId();
    const projectB = freshProjectId();
    await seedTeam(teamA, 'Team A');
    await seedTeam(teamB, 'Team B');
    await seedProject(teamA, projectA);
    await seedProject(teamB, projectB);

    const key = 'shared-key-cross-tenant';
    // Create job in team A.
    await createJob(
      db,
      makeCreateJobRequest(teamA, projectA, {
        idempotencyKey: key,
        idempotencyRequestHash: 'hash-a',
      }),
    );

    // Query with team B + project A → should NOT find it (wrong team).
    const wrongTeam = await findJobByIdempotencyKey(
      db,
      teamB,
      projectA,
      'ingest_event',
      key,
    );
    expect(wrongTeam).toBeUndefined();

    // Query with team A + project B → should NOT find it (wrong project).
    const wrongProj = await findJobByIdempotencyKey(
      db,
      teamA,
      projectB,
      'ingest_event',
      key,
    );
    expect(wrongProj).toBeUndefined();

    // Query with team A + project A → SHOULD find it.
    const correct = await findJobByIdempotencyKey(
      db,
      teamA,
      projectA,
      'ingest_event',
      key,
    );
    expect(correct).toBeDefined();
  });

  // ── updateJobStatus: lifecycle transitions ───────────────────────────────

  it('sets started_at when transitioning to processing', async () => {
    const teamId = freshTeamId();
    const projectId = freshProjectId();
    await seedTeam(teamId);
    await seedProject(teamId, projectId);

    const { job } = await createJob(db, makeCreateJobRequest(teamId, projectId));
    expect(job.startedAt).toBeNull();

    const updated = await updateJobStatus(db, teamId, projectId, job.id, 'processing');
    expect(updated).toBeDefined();
    expect(updated!.status).toBe('processing');
    expect(updated!.startedAt).toBeInstanceOf(Date);
    expect(updated!.startedAt!.getTime()).toBeGreaterThanOrEqual(
      job.createdAt.getTime(),
    );
    expect(updated!.finishedAt).toBeNull();
  });

  it('sets finished_at when transitioning to completed', async () => {
    const teamId = freshTeamId();
    const projectId = freshProjectId();
    await seedTeam(teamId);
    await seedProject(teamId, projectId);

    const { job } = await createJob(db, makeCreateJobRequest(teamId, projectId));

    // First: start processing.
    await updateJobStatus(db, teamId, projectId, job.id, 'processing');

    // Then: complete.
    const completed = await updateJobStatus(db, teamId, projectId, job.id, 'completed');
    expect(completed).toBeDefined();
    expect(completed!.status).toBe('completed');
    expect(completed!.finishedAt).toBeInstanceOf(Date);
  });

  it('sets finished_at and sanitized error when failing', async () => {
    const teamId = freshTeamId();
    const projectId = freshProjectId();
    await seedTeam(teamId);
    await seedProject(teamId, projectId);

    const { job } = await createJob(db, makeCreateJobRequest(teamId, projectId));
    await updateJobStatus(db, teamId, projectId, job.id, 'processing');

    const sanitizedError = {
      code: 'compilation_failed',
      message: 'F1 extraction produced no facts',
    };

    const failed = await updateJobStatus(db, teamId, projectId, job.id, 'failed', {
      error: sanitizedError,
    });
    expect(failed).toBeDefined();
    expect(failed!.status).toBe('failed');
    expect(failed!.error).toEqual(sanitizedError);
    expect(failed!.finishedAt).toBeInstanceOf(Date);
  });

  it('stores result snapshot on completion for idempotent replay', async () => {
    const teamId = freshTeamId();
    const projectId = freshProjectId();
    await seedTeam(teamId);
    await seedProject(teamId, projectId);

    const { job } = await createJob(db, makeCreateJobRequest(teamId, projectId));

    const snapshot = {
      batchJobId: job.id,
      results: [
        { index: 0, status: 'accepted', eventId: 'evt_abc' },
        { index: 1, status: 'rejected', error: { code: 'invalid', message: 'bad' } },
      ],
    };

    const completed = await updateJobStatus(db, teamId, projectId, job.id, 'completed', {
      resultSnapshot: snapshot,
    });
    expect(completed).toBeDefined();
    expect(completed!.resultSnapshot).toEqual(snapshot);
  });

  it('returns undefined when updating a non-existent job', async () => {
    const teamId = freshTeamId();
    const projectId = freshProjectId();
    await seedTeam(teamId);
    await seedProject(teamId, projectId);

    const result = await updateJobStatus(
      db,
      teamId,
      projectId,
      '00000000-0000-0000-0000-000000000000',
      'completed',
    );
    expect(result).toBeUndefined();
  });

  it('updateJobStatus ignores cross-team job (scope enforcement)', async () => {
    const teamA = freshTeamId();
    const teamB = freshTeamId();
    const projectA = freshProjectId();
    const projectB = freshProjectId();
    await seedTeam(teamA, 'Team A');
    await seedTeam(teamB, 'Team B');
    await seedProject(teamA, projectA);
    await seedProject(teamB, projectB);

    // Create job in team A.
    const { job } = await createJob(
      db,
      makeCreateJobRequest(teamA, projectA),
    );

    // Attempt to update using team B's scope — should return undefined (0 rows matched).
    const result = await updateJobStatus(
      db,
      teamB,
      projectB,
      job.id,
      'completed',
    );
    expect(result).toBeUndefined();
  });

  // ── upsertJobEvent: per-event outcomes ───────────────────────────────────

  it('inserts a new job_event row', async () => {
    const teamId = freshTeamId();
    const projectId = freshProjectId();
    await seedTeam(teamId);
    await seedProject(teamId, projectId);

    const { job } = await createJob(db, makeCreateJobRequest(teamId, projectId));
    const eventId = 'evt_test01';
    await seedEvent(teamId, projectId, eventId);

    const result = await upsertJobEvent(db, {
      teamId,
      projectId,
      jobId: job.id,
      eventId,
      status: 'compiled',
      conceptUuids: ['11111111-1111-4111-8111-111111111111'],
    });

    expect(result.jobId).toBe(job.id);
    expect(result.eventId).toBe(eventId);
    expect(result.status).toBe('compiled');
    expect(result.reason).toBeNull();
    expect(result.error).toBeNull();
    expect(result.conceptUuids).toEqual([
      '11111111-1111-4111-8111-111111111111',
    ]);
    expect(result.updatedAt).toBeInstanceOf(Date);
  });

  it('upserts: a second call with the same job+event updates the row', async () => {
    const teamId = freshTeamId();
    const projectId = freshProjectId();
    await seedTeam(teamId);
    await seedProject(teamId, projectId);

    const { job } = await createJob(db, makeCreateJobRequest(teamId, projectId));
    const eventId = 'evt_test02';
    await seedEvent(teamId, projectId, eventId);

    // First: pending.
    await upsertJobEvent(db, {
      teamId,
      projectId,
      jobId: job.id,
      eventId,
      status: 'pending',
    });

    // Second: update to compiled.
    const updated = await upsertJobEvent(db, {
      teamId,
      projectId,
      jobId: job.id,
      eventId,
      status: 'compiled',
      conceptUuids: ['22222222-2222-4222-8222-222222222222'],
    });

    expect(updated.status).toBe('compiled');
    expect(updated.conceptUuids).toEqual([
      '22222222-2222-4222-8222-222222222222',
    ]);

    // Verify only one row exists.
    const rows = await db
      .select({ count: schema.jobEvents.eventId })
      .from(schema.jobEvents)
      .where(eq(schema.jobEvents.jobId, job.id));

    expect(rows.length).toBe(1);
  });

  it('stores a sanitized error for failed events', async () => {
    const teamId = freshTeamId();
    const projectId = freshProjectId();
    await seedTeam(teamId);
    await seedProject(teamId, projectId);

    const { job } = await createJob(db, makeCreateJobRequest(teamId, projectId));
    const eventId = 'evt_test03';
    await seedEvent(teamId, projectId, eventId);

    const result = await upsertJobEvent(db, {
      teamId,
      projectId,
      jobId: job.id,
      eventId,
      status: 'failed',
      error: { code: 'f1_timeout', message: 'LLM call exceeded 30s' },
    });

    expect(result.status).toBe('failed');
    expect(result.error).toEqual({
      code: 'f1_timeout',
      message: 'LLM call exceeded 30s',
    });
  });

  it('stores skipped reason for skipped events', async () => {
    const teamId = freshTeamId();
    const projectId = freshProjectId();
    await seedTeam(teamId);
    await seedProject(teamId, projectId);

    const { job } = await createJob(db, makeCreateJobRequest(teamId, projectId));
    const eventId = 'evt_test04';
    await seedEvent(teamId, projectId, eventId);

    const result = await upsertJobEvent(db, {
      teamId,
      projectId,
      jobId: job.id,
      eventId,
      status: 'skipped',
      reason: 'no_knowledge',
    });

    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('no_knowledge');
  });

  // ── getJobEvents ─────────────────────────────────────────────────────────

  it('returns all per-event outcomes for a job, ordered by event_id', async () => {
    const teamId = freshTeamId();
    const projectId = freshProjectId();
    await seedTeam(teamId);
    await seedProject(teamId, projectId);

    const { job } = await createJob(
      db,
      makeCreateJobRequest(teamId, projectId, { eventCount: 3 }),
    );

    const eventIds = ['evt_a001', 'evt_a002', 'evt_a003'];
    for (const eventId of eventIds) {
      await seedEvent(teamId, projectId, eventId);
    }

    // Insert out of order to verify ordering.
    const [evA, evB, evC] = eventIds;
    await upsertJobEvent(db, {
      teamId,
      projectId,
      jobId: job.id,
      eventId: evC!,
      status: 'compiled',
    });
    await upsertJobEvent(db, {
      teamId,
      projectId,
      jobId: job.id,
      eventId: evA!,
      status: 'pending',
    });
    await upsertJobEvent(db, {
      teamId,
      projectId,
      jobId: job.id,
      eventId: evB!,
      status: 'skipped',
      reason: 'already_compiled',
    });

    const events = await getJobEvents(db, teamId, projectId, job.id);
    expect(events).toHaveLength(3);
    // Must be ordered by event_id.
    expect(events[0]!.eventId).toBe('evt_a001');
    expect(events[1]!.eventId).toBe('evt_a002');
    expect(events[2]!.eventId).toBe('evt_a003');
  });

  it('returns empty array for a job with no events', async () => {
    const teamId = freshTeamId();
    const projectId = freshProjectId();
    await seedTeam(teamId);
    await seedProject(teamId, projectId);

    const events = await getJobEvents(
      db,
      teamId,
      projectId,
      '00000000-0000-0000-0000-000000000000',
    );
    expect(events).toEqual([]);
  });

  it('getJobEvents ignores cross-team job (scope enforcement)', async () => {
    const teamA = freshTeamId();
    const teamB = freshTeamId();
    const projectA = freshProjectId();
    const projectB = freshProjectId();
    await seedTeam(teamA, 'Team A');
    await seedTeam(teamB, 'Team B');
    await seedProject(teamA, projectA);
    await seedProject(teamB, projectB);

    const { job } = await createJob(
      db,
      makeCreateJobRequest(teamA, projectA),
    );

    // Query with team B scope should return empty (0 rows matched).
    const events = await getJobEvents(db, teamB, projectB, job.id);
    expect(events).toEqual([]);
  });

  // ── getJob: scope enforcement ────────────────────────────────────────────

  it('returns a job when scoped to the correct project', async () => {
    const teamId = freshTeamId();
    const projectId = freshProjectId();
    await seedTeam(teamId);
    await seedProject(teamId, projectId);

    const { job } = await createJob(db, makeCreateJobRequest(teamId, projectId));

    const scope = projectScope(teamId, projectId);
    const found = await getJob(db, scope, job.id);
    expect(found).toBeDefined();
    expect(found!.id).toBe(job.id);
  });

  it('returns a job when scoped to allProjects (same team)', async () => {
    const teamId = freshTeamId();
    const projectId = freshProjectId();
    await seedTeam(teamId);
    await seedProject(teamId, projectId);

    const { job } = await createJob(db, makeCreateJobRequest(teamId, projectId));

    const scope = allProjectsScope(teamId);
    const found = await getJob(db, scope, job.id);
    expect(found).toBeDefined();
    expect(found!.id).toBe(job.id);
  });

  it('returns undefined when job does not exist', async () => {
    const teamId = freshTeamId();
    const projectId = freshProjectId();
    await seedTeam(teamId);
    await seedProject(teamId, projectId);

    const scope = projectScope(teamId, projectId);
    const found = await getJob(
      db,
      scope,
      '00000000-0000-0000-0000-000000000000',
    );
    expect(found).toBeUndefined();
  });

  it('returns undefined when scoped to a different project in the same team (anti-enumeration)', async () => {
    const teamId = freshTeamId();
    const projectA = freshProjectId();
    const projectB = freshProjectId();
    await seedTeam(teamId);
    await seedProject(teamId, projectA);
    await seedProject(teamId, projectB);

    const { job } = await createJob(
      db,
      makeCreateJobRequest(teamId, projectA),
    );

    // Scope to projectB — should NOT find projectA's job.
    const scope = projectScope(teamId, projectB);
    const found = await getJob(db, scope, job.id);
    expect(found).toBeUndefined();
  });

  // ── Cross-tenant isolation ───────────────────────────────────────────────

  it('SECURITY: team A job is not visible to team B scope', async () => {
    const teamA = freshTeamId();
    const teamB = freshTeamId();
    const projectA = freshProjectId();
    const projectB = freshProjectId();

    await seedTeam(teamA, 'Team A');
    await seedTeam(teamB, 'Team B');
    await seedProject(teamA, projectA, 'Project A');
    await seedProject(teamB, projectB, 'Project B');

    const { job } = await createJob(
      db,
      makeCreateJobRequest(teamA, projectA),
    );

    // Team B's all-projects scope should NOT find team A's job.
    const scopeB = allProjectsScope(teamB);
    const found = await getJob(db, scopeB, job.id);
    expect(found).toBeUndefined();

    // Team A's scope DOES find it.
    const scopeA = projectScope(teamA, projectA);
    const foundA = await getJob(db, scopeA, job.id);
    expect(foundA).toBeDefined();
  });

  // ── Database constraint enforcement ──────────────────────────────────────

  it('rejects a job referencing a non-existent project (FK)', async () => {
    const teamId = freshTeamId();
    await seedTeam(teamId);

    // No project seeded — FK should reject.
    // Drizzle wraps the Postgres error; the underlying PG code is 23503
    // (foreign_key_violation) with constraint name jobs_project_fk.
    // The Drizzle error message includes the table/constraint context
    // but not the raw PG constraint name. We verify it throws.
    const req = makeCreateJobRequest(teamId, 'prj_nonexistent');

    await expect(createJob(db, req)).rejects.toThrow();
  });

  it('rejects a job_event referencing a non-existent event (FK)', async () => {
    const teamId = freshTeamId();
    const projectId = freshProjectId();
    await seedTeam(teamId);
    await seedProject(teamId, projectId);

    const { job } = await createJob(db, makeCreateJobRequest(teamId, projectId));

    // event not seeded — FK should reject.
    // Drizzle wraps the Postgres error; the underlying PG code is 23503
    // (foreign_key_violation) with constraint name job_events_event_fk.
    // We verify it throws.
    await expect(
      upsertJobEvent(db, {
        teamId,
        projectId,
        jobId: job.id,
        eventId: 'evt_nonexistent',
        status: 'pending',
      }),
    ).rejects.toThrow();
  });
});
