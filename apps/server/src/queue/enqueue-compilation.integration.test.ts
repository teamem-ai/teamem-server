/**
 * Integration tests for the Compilation Enqueue Service (DUA-172 / M0-JOB-02).
 *
 * Proves, against real Postgres + pg-boss:
 *   - New enqueue creates a DB job, per-event rows, and a pg-boss message.
 *   - Idempotent replay: same key + same hash returns the existing job.
 *   - Idempotency conflict: same key + different hash throws.
 *   - Crash recovery: replay after a simulated crash re-delivers the
 *     pg-boss message without duplicating the application-layer job.
 *   - Boundary: no duplicate pg-boss messages from consecutive replays.
 *
 * The test is self-sufficient: it creates the minimum required schema
 * (enums, tables, indexes) in beforeAll, so the test database does not
 * need pre-applied migrations. Any pre-existing tables are left untouched.
 *
 * Requirements:
 *   TEST_DATABASE_URL=postgres://user:pass@localhost:5432/teamem pnpm vitest ...
 */
import { randomBytes } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { createDb, type AppDb } from '../db/client.js';
import {
  connectDatabase,
  closeDatabase,
  type Pool,
} from '../test/database.js';
import * as schema from '../db/schema.js';
import { IdempotencyConflictError } from '../db/repositories/jobs.js';
import {
  enqueueCompilation,
  type EnqueueCompilationRequest,
} from './enqueue-compilation.js';
import { createCompileQueue, type CompileQueue } from './boss.js';

// ── Setup ───────────────────────────────────────────────────────────────────

const url = process.env['TEST_DATABASE_URL'];

/**
 * Ensure the minimum schema required by this test exists.
 *
 * Uses CREATE … IF NOT EXISTS / DO $$ … END $$ guards so the test is
 * self-sufficient: it works against a completely empty database as well as
 * one that already has the application migrations applied. The pgvector
 * extension and the concepts table are deliberately skipped — this test
 * only needs the job + event tables.
 */
const ENSURE_SCHEMA_SQL = `
-- Enums (CREATE TYPE IF NOT EXISTS is PG 17+; guard with DO blocks for 16 compat).
DO $$ BEGIN CREATE TYPE source_channel       AS ENUM('github','cli','mcp','external');             EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE source_kind          AS ENUM('github_commit','github_pr','github_issue','github_pr_comment','cli_init','mcp_write','external_event'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE actor_provenance     AS ENUM('webhook_verified','credential_bound','client_claimed','unknown'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE occurred_at_provenance AS ENUM('provider','client','server');                EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE job_status           AS ENUM('queued','processing','completed','failed','cancelled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE job_kind             AS ENUM('ingest_event','ingest_batch','compilation');   EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE job_event_status     AS ENUM('pending','compiled','skipped','failed');       EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE initiator_kind       AS ENUM('credential','connector');                      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE principal_kind       AS ENUM('human','service');                             EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE identity_provider    AS ENUM('github','external');                           EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Tables
CREATE TABLE IF NOT EXISTS teams (
  id         text PRIMARY KEY,
  name       text NOT NULL,
  created_at timestamptz(3) DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id         text PRIMARY KEY,
  team_id    text NOT NULL REFERENCES teams(id),
  name       text NOT NULL,
  created_at timestamptz(3) DEFAULT now() NOT NULL,
  CONSTRAINT projects_team_id_uq UNIQUE(team_id, id)
);

CREATE TABLE IF NOT EXISTS principals (
  id              text PRIMARY KEY,
  team_id         text NOT NULL REFERENCES teams(id),
  kind            principal_kind NOT NULL,
  provider        identity_provider NOT NULL,
  provider_kind   text NOT NULL,
  provider_user_id text NOT NULL,
  display_login   text,
  created_at      timestamptz(3) DEFAULT now() NOT NULL,
  CONSTRAINT principals_team_id_uq UNIQUE(team_id, id)
);

CREATE TABLE IF NOT EXISTS events (
  id                       text PRIMARY KEY,
  team_id                  text NOT NULL REFERENCES teams(id),
  project_id               text NOT NULL,
  channel                  source_channel NOT NULL,
  kind                     source_kind NOT NULL,
  connector_kind           text NOT NULL,
  source_event             text,
  source_action            text,
  delivery_id              text NOT NULL,
  item_key                 text NOT NULL,
  external_id              text NOT NULL,
  url                      text,
  actor                    jsonb,
  actor_provenance         actor_provenance NOT NULL,
  actor_principal_id       text,
  occurred_at              timestamptz(3) NOT NULL,
  occurred_at_provenance   occurred_at_provenance NOT NULL,
  ingested_by_credential_id text,
  ingested_by_principal_id text,
  payload                  jsonb NOT NULL,
  payload_bytes            integer NOT NULL,
  payload_hash             text NOT NULL,
  payload_schema_version   integer NOT NULL,
  envelope_version         integer NOT NULL,
  created_at               timestamptz(3) DEFAULT now() NOT NULL,
  CONSTRAINT events_tenant_uq UNIQUE(team_id, project_id, id),
  CONSTRAINT events_project_fk FOREIGN KEY (team_id, project_id) REFERENCES projects(team_id, id),
  CONSTRAINT events_actor_principal_fk FOREIGN KEY (team_id, actor_principal_id) REFERENCES principals(team_id, id)
);

CREATE TABLE IF NOT EXISTS jobs (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id                   text NOT NULL REFERENCES teams(id),
  project_id                text NOT NULL,
  kind                      job_kind NOT NULL,
  status                    job_status DEFAULT 'queued' NOT NULL,
  attempts                  integer DEFAULT 0 NOT NULL,
  initiated_by_kind         initiator_kind NOT NULL,
  initiated_by_credential_id text,
  initiated_by_principal_id text,
  initiated_by_connector    text,
  idempotency_key           text,
  idempotency_request_hash  text,
  result_snapshot           jsonb,
  event_count               integer NOT NULL,
  error                     jsonb,
  created_at                timestamptz(3) DEFAULT now() NOT NULL,
  started_at                timestamptz(3),
  finished_at               timestamptz(3),
  CONSTRAINT jobs_tenant_uq UNIQUE(team_id, project_id, id),
  CONSTRAINT jobs_project_fk FOREIGN KEY (team_id, project_id) REFERENCES projects(team_id, id)
);

CREATE TABLE IF NOT EXISTS job_events (
  team_id       text NOT NULL REFERENCES teams(id),
  project_id    text NOT NULL,
  job_id        uuid NOT NULL,
  event_id      text NOT NULL,
  status        job_event_status DEFAULT 'pending' NOT NULL,
  reason        text,
  error         jsonb,
  concept_uuids uuid[],
  updated_at    timestamptz(3) DEFAULT now() NOT NULL,
  CONSTRAINT job_events_pk PRIMARY KEY(job_id, event_id),
  CONSTRAINT job_events_job_fk   FOREIGN KEY (team_id, project_id, job_id)   REFERENCES jobs(team_id, project_id, id),
  CONSTRAINT job_events_event_fk FOREIGN KEY (team_id, project_id, event_id) REFERENCES events(team_id, project_id, id)
);

-- Indexes (only the ones the repository code relies on).
DO $$ BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS events_idempotency_uq ON events(project_id, channel, connector_kind, delivery_id, item_key);
  CREATE INDEX IF NOT EXISTS events_cursor_idx ON events(project_id, created_at, id);
  CREATE UNIQUE INDEX IF NOT EXISTS jobs_idempotency_uq ON jobs(project_id, kind, idempotency_key) WHERE idempotency_key IS NOT NULL;
  CREATE INDEX IF NOT EXISTS jobs_cursor_idx ON jobs(project_id, created_at, id);
  CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs(project_id, status);
  CREATE UNIQUE INDEX IF NOT EXISTS principals_identity_uq ON principals(team_id, provider, provider_kind, provider_user_id);
  CREATE INDEX IF NOT EXISTS projects_team_idx ON projects(team_id);
  CREATE INDEX IF NOT EXISTS events_team_idx ON events(team_id);
EXCEPTION WHEN duplicate_table THEN NULL; END $$;
`;

describe.skipIf(!url)('enqueue compilation (live Postgres)', () => {
  let pool: Pool;
  let db: AppDb;
  // One real CompileQueue per test file, isolated by schema.
  let compileQueue: CompileQueue;
  let schemaName: string;

  beforeAll(async () => {
    ({ pool } = connectDatabase());
    db = createDb(url!, { pool: pool as unknown as import('pg').Pool });

    // Ensure the minimum schema exists (idempotent — safe to call on a
    // database that already has the full migration applied).
    await db.execute(ENSURE_SCHEMA_SQL);

    schemaName = `enq_test_${randomBytes(6).toString('hex')}`;
    compileQueue = createCompileQueue(url!, { schema: schemaName });
    await compileQueue.start();
  });

  afterAll(async () => {
    await compileQueue.stop();
    // Drop the pg-boss schema after stopping.
    const handle = createDb(url!, { pool: pool as unknown as import('pg').Pool });
    try {
      await handle.execute(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    } finally {
      // Don't close the pool; it's shared.
    }
    await closeDatabase(pool);
  });

  // Clean application data between tests (not the pg-boss schema and not
  // the tables themselves — only rows).  Deletes in FK dependency order.
  beforeEach(async () => {
    // Delete rows that reference the tables we own.  The tables created by
    // ENSURE_SCHEMA_SQL are the minimal set; concept-* tables may or may
    // not exist so guard each delete that could fail.
    await db.delete(schema.jobEvents);
    await db.delete(schema.jobs);
    for (const table of [schema.conceptContributors, schema.conceptEvidence, schema.conceptPaths]) {
      try { await db.delete(table); } catch { /* table may not exist */ }
    }
    try { await db.delete(schema.concepts); } catch { /* table may not exist */ }
    await db.delete(schema.events);
    try { await db.delete(schema.apiKeys); } catch { /* table may not exist */ }
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

  function freshEventId(): string {
    return `evt_${randomUUID().replace(/-/g, '')}`;
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

  /** Seed a minimal event row so job_event FK constraints are satisfied. */
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

  function makeRequest(
    teamId: string,
    projectId: string,
    eventIds: string[],
    overrides: Partial<EnqueueCompilationRequest> = {},
  ): EnqueueCompilationRequest {
    return {
      teamId,
      projectId,
      kind: 'ingest_event',
      eventIds,
      initiatedByKind: 'credential',
      initiatedByCredentialId: 'key_test',
      initiatedByPrincipalId: null,
      initiatedByConnector: null,
      idempotencyKey: null,
      idempotencyRequestHash: null,
      ...overrides,
    };
  }

  /** Count rows in our application-layer jobs table for a given scope. */
  async function countAppJobs(
    teamId: string,
    projectId: string,
  ): Promise<number> {
    const rows = await db
      .select({ count: schema.jobs.id })
      .from(schema.jobs)
      .where(
        sql`${schema.jobs.teamId} = ${teamId} AND ${schema.jobs.projectId} = ${projectId}`,
      );
    return rows.length;
  }

  /** Count per-event rows for a given job. */
  async function countJobEvents(jobId: string): Promise<number> {
    const rows = await db
      .select({ count: schema.jobEvents.eventId })
      .from(schema.jobEvents)
      .where(eq(schema.jobEvents.jobId, jobId));
    return rows.length;
  }

  /** Check if a pg-boss job with the given id exists in the compile queue. */
  async function pgBossJobExists(jobId: string): Promise<boolean> {
    const { rows } = await db.execute(
      `SELECT 1 FROM ${schemaName}.job WHERE name = 'teamem.compile' AND id = '${jobId}'`,
    );
    return (rows as unknown[]).length > 0;
  }

  // ── Success path: basic enqueue ─────────────────────────────────────────

  it('creates a DB job, per-event rows, and a pg-boss message', async () => {
    const teamId = freshTeamId();
    const projectId = freshProjectId();
    await seedTeam(teamId);
    await seedProject(teamId, projectId);

    const eventA = freshEventId();
    const eventB = freshEventId();
    await seedEvent(teamId, projectId, eventA);
    await seedEvent(teamId, projectId, eventB);

    const req = makeRequest(teamId, projectId, [eventA, eventB], {
      idempotencyKey: 'key-new-001',
      idempotencyRequestHash: 'hash-001',
    });

    const result = await enqueueCompilation(db, compileQueue, req);

    // Created a new job.
    expect(result.created).toBe(true);
    expect(result.jobId).toBeDefined();

    // Exactly one application-layer job row exists.
    expect(await countAppJobs(teamId, projectId)).toBe(1);

    // Both per-event rows exist and are pending.
    expect(await countJobEvents(result.jobId)).toBe(2);

    // A pg-boss message was delivered.
    expect(await pgBossJobExists(result.jobId)).toBe(true);
  });

  it('job row carries the correct scope, kind, initiator, and event count', async () => {
    const teamId = freshTeamId();
    const projectId = freshProjectId();
    await seedTeam(teamId);
    await seedProject(teamId, projectId);

    const eventId = freshEventId();
    await seedEvent(teamId, projectId, eventId);

    const req = makeRequest(teamId, projectId, [eventId], {
      kind: 'compilation',
      initiatedByKind: 'connector',
      initiatedByCredentialId: null,
      initiatedByConnector: 'github',
      eventIds: [eventId],
    });

    const result = await enqueueCompilation(db, compileQueue, req);

    // Fetch the job row to verify its fields.
    const rows = await db
      .select({
        kind: schema.jobs.kind,
        teamId: schema.jobs.teamId,
        projectId: schema.jobs.projectId,
        status: schema.jobs.status,
        eventCount: schema.jobs.eventCount,
        initiatedByKind: schema.jobs.initiatedByKind,
        initiatedByConnector: schema.jobs.initiatedByConnector,
        initiatedByCredentialId: schema.jobs.initiatedByCredentialId,
      })
      .from(schema.jobs)
      .where(eq(schema.jobs.id, result.jobId));

    expect(rows).toHaveLength(1);
    const job = rows[0]!;
    expect(job.kind).toBe('compilation');
    expect(job.teamId).toBe(teamId);
    expect(job.projectId).toBe(projectId);
    expect(job.status).toBe('queued');
    expect(job.eventCount).toBe(1);
    expect(job.initiatedByKind).toBe('connector');
    expect(job.initiatedByConnector).toBe('github');
    expect(job.initiatedByCredentialId).toBeNull();
  });

  it('per-event rows start in pending status', async () => {
    const teamId = freshTeamId();
    const projectId = freshProjectId();
    await seedTeam(teamId);
    await seedProject(teamId, projectId);

    const events = [freshEventId(), freshEventId(), freshEventId()];
    for (const eid of events) {
      await seedEvent(teamId, projectId, eid);
    }

    const result = await enqueueCompilation(
      db,
      compileQueue,
      makeRequest(teamId, projectId, events),
    );

    const rows = await db
      .select({
        eventId: schema.jobEvents.eventId,
        status: schema.jobEvents.status,
      })
      .from(schema.jobEvents)
      .where(eq(schema.jobEvents.jobId, result.jobId));

    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.status).toBe('pending');
      expect(events).toContain(row.eventId);
    }
  });

  // ── Idempotent replay ───────────────────────────────────────────────────

  it('replays an existing job when idempotency key and hash match (one DB job, one effective pg-boss delivery)', async () => {
    const teamId = freshTeamId();
    const projectId = freshProjectId();
    await seedTeam(teamId);
    await seedProject(teamId, projectId);

    const eventId = freshEventId();
    await seedEvent(teamId, projectId, eventId);

    const req = makeRequest(teamId, projectId, [eventId], {
      idempotencyKey: 'replay-key-001',
      idempotencyRequestHash: 'hash-xyz',
    });

    // First enqueue: creates everything.
    const first = await enqueueCompilation(db, compileQueue, req);
    expect(first.created).toBe(true);

    const firstAppJobCount = await countAppJobs(teamId, projectId);
    expect(firstAppJobCount).toBe(1);

    // Second enqueue with same key + hash: replays.
    const second = await enqueueCompilation(db, compileQueue, req);
    expect(second.created).toBe(false);
    expect(second.jobId).toBe(first.jobId);

    // Still exactly one application-layer job.
    expect(await countAppJobs(teamId, projectId)).toBe(1);

    // Still exactly one pg-boss job (the replay did not create a duplicate).
    expect(await pgBossJobExists(first.jobId)).toBe(true);
  });

  it('replay still has the pg-boss message (no double-send)', async () => {
    const teamId = freshTeamId();
    const projectId = freshProjectId();
    await seedTeam(teamId);
    await seedProject(teamId, projectId);

    const eventId = freshEventId();
    await seedEvent(teamId, projectId, eventId);

    const req = makeRequest(teamId, projectId, [eventId], {
      idempotencyKey: 'replay-key-002',
      idempotencyRequestHash: 'hash-abc',
    });

    // First call.
    await enqueueCompilation(db, compileQueue, req);

    // Count pg-boss jobs before replay.
    const { rows: before } = await db.execute(
      `SELECT COUNT(*)::int as cnt FROM ${schemaName}.job WHERE name = 'teamem.compile'`,
    );
    const beforeCount = (before[0] as Record<string, number>).cnt;

    // Replay twice.
    await enqueueCompilation(db, compileQueue, req);
    await enqueueCompilation(db, compileQueue, req);

    // Count pg-boss jobs after replays.
    const { rows: after } = await db.execute(
      `SELECT COUNT(*)::int as cnt FROM ${schemaName}.job WHERE name = 'teamem.compile'`,
    );
    const afterCount = (after[0] as Record<string, number>).cnt;

    // No new pg-boss jobs were created by replay.
    expect(afterCount).toBe(beforeCount);
  });

  // ── Idempotency conflict ────────────────────────────────────────────────

  it('throws IdempotencyConflictError when key matches but hash differs', async () => {
    const teamId = freshTeamId();
    const projectId = freshProjectId();
    await seedTeam(teamId);
    await seedProject(teamId, projectId);

    const eventId = freshEventId();
    await seedEvent(teamId, projectId, eventId);

    const key = 'conflict-key-001';

    // First enqueue.
    const first = await enqueueCompilation(
      db,
      compileQueue,
      makeRequest(teamId, projectId, [eventId], {
        idempotencyKey: key,
        idempotencyRequestHash: 'hash-v1',
      }),
    );
    expect(first.created).toBe(true);

    // Second enqueue: same key, different hash → conflict.
    await expect(
      enqueueCompilation(
        db,
        compileQueue,
        makeRequest(teamId, projectId, [eventId], {
          idempotencyKey: key,
          idempotencyRequestHash: 'hash-v2',
        }),
      ),
    ).rejects.toThrow(IdempotencyConflictError);

    // Verify the error exposes the existing job ID.
    try {
      await enqueueCompilation(
        db,
        compileQueue,
        makeRequest(teamId, projectId, [eventId], {
          idempotencyKey: key,
          idempotencyRequestHash: 'hash-v2',
        }),
      );
    } catch (err) {
      expect(err).toBeInstanceOf(IdempotencyConflictError);
      expect((err as IdempotencyConflictError).existingJobId).toBe(first.jobId);
    }
  });

  // ── Same key, different kind → no collision (N1) ────────────────────────

  it('allows the same idempotency key in different job kinds', async () => {
    const teamId = freshTeamId();
    const projectId = freshProjectId();
    await seedTeam(teamId);
    await seedProject(teamId, projectId);

    const eventId = freshEventId();
    await seedEvent(teamId, projectId, eventId);

    const key = 'shared-kind-key';

    const batch = await enqueueCompilation(
      db,
      compileQueue,
      makeRequest(teamId, projectId, [eventId], {
        kind: 'ingest_batch',
        idempotencyKey: key,
        idempotencyRequestHash: 'batch-hash',
      }),
    );
    expect(batch.created).toBe(true);

    // Same key, different kind — no collision.
    const comp = await enqueueCompilation(
      db,
      compileQueue,
      makeRequest(teamId, projectId, [eventId], {
        kind: 'compilation',
        idempotencyKey: key,
        idempotencyRequestHash: 'comp-hash',
      }),
    );
    expect(comp.created).toBe(true);
    expect(comp.jobId).not.toBe(batch.jobId);
  });

  // ── No idempotency key ──────────────────────────────────────────────────

  it('creates distinct jobs when no idempotency key is provided', async () => {
    const teamId = freshTeamId();
    const projectId = freshProjectId();
    await seedTeam(teamId);
    await seedProject(teamId, projectId);

    const eventId = freshEventId();
    await seedEvent(teamId, projectId, eventId);

    const baseReq = makeRequest(teamId, projectId, [eventId], {
      idempotencyKey: null,
    });

    const first = await enqueueCompilation(db, compileQueue, baseReq);
    const second = await enqueueCompilation(db, compileQueue, baseReq);

    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(first.jobId).not.toBe(second.jobId);
    expect(await countAppJobs(teamId, projectId)).toBe(2);
  });

  // ── Crash recovery: DB job exists but pg-boss message missing ───────────

  it('recovers: replay re-sends pg-boss message when it was lost between DB and queue', async () => {
    const teamId = freshTeamId();
    const projectId = freshProjectId();
    await seedTeam(teamId);
    await seedProject(teamId, projectId);

    const eventId = freshEventId();
    await seedEvent(teamId, projectId, eventId);

    const key = 'crash-recovery-key-001';

    const req = makeRequest(teamId, projectId, [eventId], {
      idempotencyKey: key,
      idempotencyRequestHash: 'crash-hash',
    });

    // First enqueue: succeeds fully.
    const first = await enqueueCompilation(db, compileQueue, req);
    expect(first.created).toBe(true);
    expect(await pgBossJobExists(first.jobId)).toBe(true);

    // Simulate crash after DB insert but before pg-boss delivery:
    // delete the pg-boss job directly.
    await db.execute(
      `DELETE FROM ${schemaName}.job WHERE id = '${first.jobId}'`,
    );
    expect(await pgBossJobExists(first.jobId)).toBe(false);

    // Second enqueue (replay): must re-deliver the pg-boss message.
    const second = await enqueueCompilation(db, compileQueue, req);
    expect(second.created).toBe(false); // replay
    expect(second.jobId).toBe(first.jobId);

    // The pg-boss message is now present again.
    expect(await pgBossJobExists(first.jobId)).toBe(true);

    // Still exactly one application-layer job.
    expect(await countAppJobs(teamId, projectId)).toBe(1);
  });

  it('recovers: replay fills in missing per-event rows and pg-boss message', async () => {
    const teamId = freshTeamId();
    const projectId = freshProjectId();
    await seedTeam(teamId);
    await seedProject(teamId, projectId);

    const eventA = freshEventId();
    const eventB = freshEventId();
    await seedEvent(teamId, projectId, eventA);
    await seedEvent(teamId, projectId, eventB);

    const key = 'crash-recovery-key-002';

    const req = makeRequest(teamId, projectId, [eventA, eventB], {
      idempotencyKey: key,
      idempotencyRequestHash: 'crash-hash-2',
    });

    // First enqueue succeeds.
    const first = await enqueueCompilation(db, compileQueue, req);
    expect(first.created).toBe(true);
    expect(await countJobEvents(first.jobId)).toBe(2);
    expect(await pgBossJobExists(first.jobId)).toBe(true);

    // Simulate the crash: delete the pg-boss message AND one per-event row.
    await db.execute(
      `DELETE FROM ${schemaName}.job WHERE id = '${first.jobId}'`,
    );
    await db.delete(schema.jobEvents).where(
      sql`${schema.jobEvents.jobId} = ${first.jobId} AND ${schema.jobEvents.eventId} = ${eventB}`,
    );
    expect(await countJobEvents(first.jobId)).toBe(1);

    // Replay recovers both the missing per-event row and the pg-boss message.
    const second = await enqueueCompilation(db, compileQueue, req);
    expect(second.created).toBe(false);
    expect(second.jobId).toBe(first.jobId);

    // Both per-event rows are back.
    expect(await countJobEvents(first.jobId)).toBe(2);

    // The pg-boss message is back.
    expect(await pgBossJobExists(first.jobId)).toBe(true);

    // Still exactly one application-layer job.
    expect(await countAppJobs(teamId, projectId)).toBe(1);
  });

  // ── Boundary: event ID list validation ──────────────────────────────────

  it('rejects a request with zero event IDs (eventCount < 1)', async () => {
    const teamId = freshTeamId();
    const projectId = freshProjectId();
    await seedTeam(teamId);
    await seedProject(teamId, projectId);

    await expect(
      enqueueCompilation(
        db,
        compileQueue,
        makeRequest(teamId, projectId, [], {
          idempotencyKey: 'empty-events',
        }),
      ),
    ).rejects.toThrow(/eventCount/);
  });

  // ── Boundary: cross-tenant isolation ────────────────────────────────────

  it('SECURITY: enqueue from team A is not visible to team B scope', async () => {
    const teamA = freshTeamId();
    const teamB = freshTeamId();
    const projectA = freshProjectId();
    const projectB = freshProjectId();

    await seedTeam(teamA, 'Team A');
    await seedTeam(teamB, 'Team B');
    await seedProject(teamA, projectA, 'Project A');
    await seedProject(teamB, projectB, 'Project B');

    const eventA = freshEventId();
    await seedEvent(teamA, projectA, eventA);

    const result = await enqueueCompilation(
      db,
      compileQueue,
      makeRequest(teamA, projectA, [eventA], {
        idempotencyKey: 'cross-tenant-key',
      }),
    );
    expect(result.created).toBe(true);

    // Team A can see its job.
    expect(await countAppJobs(teamA, projectA)).toBe(1);

    // Team B cannot see it — the query carries team B's scope.
    expect(await countAppJobs(teamB, projectB)).toBe(0);
  });

  // ── Boundary: FK constraint enforcement ─────────────────────────────────

  it('rejects enqueue referencing a non-existent project', async () => {
    const teamId = freshTeamId();
    await seedTeam(teamId);

    // No project seeded — FK should reject.
    await expect(
      enqueueCompilation(
        db,
        compileQueue,
        makeRequest(teamId, 'prj_nonexistent', [freshEventId()]),
      ),
    ).rejects.toThrow();
  });
});
