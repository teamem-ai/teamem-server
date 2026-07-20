/**
 * POST /v1/compilations integration tests (M0-ING-05).
 *
 * Tests the explicit compilation endpoint against real Postgres — validates
 * the frozen request/response DTOs, per-event status classification,
 * idempotent replay, and 200/400/401/403/409 semantics.
 *
 * Runs only when TEST_DATABASE_URL is set; honestly skipped otherwise.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { buildApp, type AppDeps } from '../app.js';
import { createDb, type AppDb } from '../db/client.js';
import {
  connectDatabase,
  closeDatabase,
  type Pool,
} from '../test/database.js';
import { runBootstrap } from '../commands/bootstrap.js';
import { PAYLOAD_SCHEMA_VERSION, EVENT_ENVELOPE_VERSION } from '@teamem/schema';

const url = process.env['TEST_DATABASE_URL'];

describe.skipIf(!url)('POST /v1/compilations (live Postgres)', () => {
  let pool: Pool;
  let db: AppDb;
  let app: ReturnType<typeof buildApp>;

  let teamId: string;
  let projectId: string;
  let apiKeyToken: string | undefined;

  beforeAll(async () => {
    ({ pool } = connectDatabase());
    db = createDb(url!, { pool: pool as unknown as import('pg').Pool });

    const suffix = randomUUID().replace(/-/g, '').slice(0, 8);
    const result = await runBootstrap(db, {
      teamName: `Compilation Test ${suffix}`,
      projectName: `demo-${suffix}`,
      rotate: false,
    });

    teamId = result.team.id;
    projectId = result.project.id;
    apiKeyToken = result.key.token;

    const deps: AppDeps = { dbUrl: url!, db };
    app = buildApp(deps);
  });

  afterAll(async () => {
    // Delete in FK dependency order: child tables first.
    // job_events references both jobs and events.
    await db.execute(
      `DELETE FROM job_events WHERE project_id = '${projectId}'`,
    );
    await db.execute(
      `DELETE FROM job_events WHERE team_id = '${teamId}'`,
    );
    await db.execute(
      `DELETE FROM events WHERE team_id = '${teamId}'`,
    );
    await db.execute(
      `DELETE FROM jobs WHERE team_id = '${teamId}'`,
    );
    await db.execute(
      `DELETE FROM api_keys WHERE team_id = '${teamId}'`,
    );
    await db.execute(
      `DELETE FROM projects WHERE team_id = '${teamId}'`,
    );
    await db.execute(
      `DELETE FROM teams WHERE id = '${teamId}'`,
    );
    await closeDatabase(pool);
  });

  beforeEach(async () => {
    await db.execute(
      `DELETE FROM job_events WHERE project_id = '${projectId}'`,
    );
    await db.execute(
      `DELETE FROM events WHERE project_id = '${projectId}'`,
    );
    await db.execute(
      `DELETE FROM jobs WHERE project_id = '${projectId}'`,
    );
  });

  // ── Helpers ──────────────────────────────────────────────────────────────

  const authHeader = () => ({
    Authorization: `Bearer ${apiKeyToken}`,
    'Content-Type': 'application/json',
  });

  /** Seed an event row directly so we have events to compile. */
  async function seedEvent(): Promise<string> {
    const eventId = `evt_${randomUUID().replace(/-/g, '')}`;
    const now = new Date();
    const deliveryId = `dk_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const payloadHash = `hash_${randomUUID().replace(/-/g, '').slice(0, 8)}`;

    await db.execute(sql`
      INSERT INTO events (id, team_id, project_id, channel, kind, connector_kind,
        delivery_id, item_key, external_id, actor_provenance, occurred_at,
        occurred_at_provenance, payload, payload_bytes, payload_hash,
        payload_schema_version, envelope_version)
      VALUES (${eventId}, ${teamId}, ${projectId}, 'cli', 'cli_init', 'cli',
        ${deliveryId}, 'root', 'test/repo', 'unknown', ${now.toISOString()},
        'server', ${JSON.stringify({
          schemaVersion: PAYLOAD_SCHEMA_VERSION,
          repo: 'test/repo',
          commitSha: 'abc123def4567890123456789abcdef123456789',
          path: 'docs/test.md',
          content: 'test',
        })}::jsonb, 2, ${payloadHash},
        ${PAYLOAD_SCHEMA_VERSION}, ${EVENT_ENVELOPE_VERSION})
    `);
    return eventId;
  }

  /** Create a minimal valid compilation request body. */
  function validBody(eventIds: string[], overrides: Record<string, unknown> = {}) {
    return {
      projectId,
      eventIds,
      idempotencyKey: `comp-key-${randomUUID().replace(/-/g, '')}`,
      ...overrides,
    };
  }

  // ── Success: basic compilation with queued events ──────────────────────

  it('returns 200 with queued status for new events', async () => {
    const evtA = await seedEvent();
    const evtB = await seedEvent();

    const body = validBody([evtA, evtB]);
    const res = await app.request('/v1/compilations', {
      method: 'POST',
      headers: authHeader(),
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.requestId).toBeTruthy();
    expect(json.compilationJobId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(json.duplicate).toBe(false);
    expect(json.results).toHaveLength(2);
    expect(json.results).toContainEqual({ eventId: evtA, status: 'queued' });
    expect(json.results).toContainEqual({ eventId: evtB, status: 'queued' });

    // Verify a job row was created
    const { rows: jobRows } = await db.execute(
      `SELECT id, kind, status, event_count FROM jobs WHERE id = '${json.compilationJobId}'`,
    );
    expect(jobRows).toHaveLength(1);
    const jobRow = jobRows[0] as Record<string, unknown>;
    expect(jobRow['kind']).toBe('compilation');
    expect(jobRow['status']).toBe('queued');
    expect(jobRow['event_count']).toBe(2);
  });

  // ── Success: not_found for events that don't exist ─────────────────────

  it('returns not_found for event IDs that do not exist in the project', async () => {
    const evtA = await seedEvent();
    const fakeId = 'evt_nonexistent0000000000000000';

    const body = validBody([evtA, fakeId]);
    const res = await app.request('/v1/compilations', {
      method: 'POST',
      headers: authHeader(),
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.results).toHaveLength(2);
    expect(json.results).toContainEqual({ eventId: evtA, status: 'queued' });
    expect(json.results).toContainEqual({ eventId: fakeId, status: 'not_found' });
  });

  // ── Success: already_compiled for events with compiled outcome ─────────

  it('returns already_compiled for events that were previously compiled', async () => {
    const evtA = await seedEvent();

    // Simulate a prior completed compilation by inserting a job + job_event
    const priorJobId = randomUUID();
    const now = new Date();
    await db.execute(
      `INSERT INTO jobs (id, team_id, project_id, kind, status, attempts, initiated_by_kind, event_count, created_at, finished_at)
       VALUES ('${priorJobId}', '${teamId}', '${projectId}', 'compilation', 'completed', 1, 'credential', 1, '${now.toISOString()}', '${now.toISOString()}')`,
    );
    await db.execute(
      `INSERT INTO job_events (team_id, project_id, job_id, event_id, status, updated_at)
       VALUES ('${teamId}', '${projectId}', '${priorJobId}', '${evtA}', 'compiled', '${now.toISOString()}')`,
    );

    const body = validBody([evtA]);
    const res = await app.request('/v1/compilations', {
      method: 'POST',
      headers: authHeader(),
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.results).toHaveLength(1);
    expect(json.results[0]).toMatchObject({ eventId: evtA, status: 'already_compiled' });
  });

  // ── Success: already_active for events in queued/processing jobs ───────

  it('returns already_active for events currently in an active job', async () => {
    const evtA = await seedEvent();

    // Simulate an active (queued) job containing this event
    const activeJobId = randomUUID();
    const now = new Date();
    await db.execute(
      `INSERT INTO jobs (id, team_id, project_id, kind, status, attempts, initiated_by_kind, event_count, created_at)
       VALUES ('${activeJobId}', '${teamId}', '${projectId}', 'compilation', 'queued', 0, 'credential', 1, '${now.toISOString()}')`,
    );
    await db.execute(
      `INSERT INTO job_events (team_id, project_id, job_id, event_id, status, updated_at)
       VALUES ('${teamId}', '${projectId}', '${activeJobId}', '${evtA}', 'pending', '${now.toISOString()}')`,
    );

    const body = validBody([evtA]);
    const res = await app.request('/v1/compilations', {
      method: 'POST',
      headers: authHeader(),
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.results).toHaveLength(1);
    expect(json.results[0]).toMatchObject({ eventId: evtA, status: 'already_active' });
  });

  // ── Idempotent replay ──────────────────────────────────────────────────

  it('returns 200 with duplicate:true and same compilationJobId on replay', async () => {
    const evtA = await seedEvent();

    const body = validBody([evtA]);
    const res1 = await app.request('/v1/compilations', {
      method: 'POST',
      headers: authHeader(),
      body: JSON.stringify(body),
    });
    expect(res1.status).toBe(200);
    const json1 = await res1.json();
    expect(json1.duplicate).toBe(false);

    // Replay the exact same request
    const res2 = await app.request('/v1/compilations', {
      method: 'POST',
      headers: authHeader(),
      body: JSON.stringify(body),
    });
    expect(res2.status).toBe(200);
    const json2 = await res2.json();
    expect(json2.duplicate).toBe(true);
    expect(json2.compilationJobId).toBe(json1.compilationJobId);
    expect(json2.results).toEqual(json1.results);
  });

  // ── Failure: 409 idempotency conflict ──────────────────────────────────

  it('returns 409 when same idempotency key has different eventIds', async () => {
    const evtA = await seedEvent();
    const evtB = await seedEvent();
    const evtC = await seedEvent();

    const key = 'conflict-comp-key';
    const body1 = validBody([evtA, evtB], { idempotencyKey: key });
    const res1 = await app.request('/v1/compilations', {
      method: 'POST',
      headers: authHeader(),
      body: JSON.stringify(body1),
    });
    expect(res1.status).toBe(200);

    // Same key, different event IDs → conflict
    const body2 = validBody([evtA, evtC], { idempotencyKey: key });
    const res2 = await app.request('/v1/compilations', {
      method: 'POST',
      headers: authHeader(),
      body: JSON.stringify(body2),
    });
    expect(res2.status).toBe(409);
    const json2 = await res2.json();
    expect(json2.error.code).toBe('idempotency_conflict');
  });

  // ── Failure: 400 invalid request body ──────────────────────────────────

  it('returns 400 for missing required fields', async () => {
    const res = await app.request('/v1/compilations', {
      method: 'POST',
      headers: authHeader(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe('invalid_request');
  });

  it('returns 400 for empty eventIds array', async () => {
    const body = { projectId, eventIds: [], idempotencyKey: 'key12345678' };
    const res = await app.request('/v1/compilations', {
      method: 'POST',
      headers: authHeader(),
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe('invalid_request');
  });

  it('returns 400 for too many eventIds (>500)', async () => {
    const manyEvents = Array.from({ length: 501 }, (_, i) => `evt_${String(i).padStart(20, '0')}`);
    const body = { projectId, eventIds: manyEvents, idempotencyKey: 'key12345678' };
    const res = await app.request('/v1/compilations', {
      method: 'POST',
      headers: authHeader(),
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe('invalid_request');
  });

  it('returns 400 for non-JSON body', async () => {
    const res = await app.request('/v1/compilations', {
      method: 'POST',
      headers: { ...authHeader(), 'Content-Type': 'text/plain' },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe('invalid_request');
  });

  // ── Failure: 401 unauthorized ──────────────────────────────────────────

  it('returns 401 when no Authorization header is present', async () => {
    const body = validBody(['evt_nonexistent0000000000000000']);
    const res = await app.request('/v1/compilations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error.code).toBe('unauthorized');
  });

  it('returns 401 for unknown/revoked API key', async () => {
    const body = validBody(['evt_nonexistent0000000000000000']);
    const res = await app.request('/v1/compilations', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer tm_not_a_real_key_000000000000000000000000000000',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error.code).toBe('unauthorized');
  });

  // ── Failure: 403 forbidden ─────────────────────────────────────────────

  it('returns 403 when API key lacks events:write scope', async () => {
    const { generateApiKeyToken, hashToken } = await import(
      '../auth/api-key.js'
    );
    const readOnlyToken = generateApiKeyToken();
    const readOnlyTokenHash = hashToken(readOnlyToken);

    const keyId = `key_readonly_${randomUUID().replace(/-/g, '')}`;
    await db.execute(
      `INSERT INTO api_keys (id, team_id, project_id, name, token_hash, scopes, all_projects)
       VALUES ('${keyId}', '${teamId}', '${projectId}', 'Read-Only Key',
               '${readOnlyTokenHash}', ARRAY['read']::text[], false)`,
    );

    try {
      const body = validBody(['evt_nonexistent0000000000000000']);
      const res = await app.request('/v1/compilations', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${readOnlyToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error.code).toBe('forbidden');
    } finally {
      await db.execute(`DELETE FROM api_keys WHERE id = '${keyId}'`);
    }
  });

  // ── Boundary: mixed event statuses ─────────────────────────────────────

  it('correctly classifies a mix of queued, already_compiled, and not_found', async () => {
    const evtNew = await seedEvent();
    const evtCompiled = await seedEvent();
    const fakeId = 'evt_nonexistent0000000000000001';

    // Pre-mark evtCompiled as already compiled
    const priorJobId = randomUUID();
    const now = new Date();
    await db.execute(
      `INSERT INTO jobs (id, team_id, project_id, kind, status, attempts, initiated_by_kind, event_count, created_at, finished_at)
       VALUES ('${priorJobId}', '${teamId}', '${projectId}', 'compilation', 'completed', 1, 'credential', 1, '${now.toISOString()}', '${now.toISOString()}')`,
    );
    await db.execute(
      `INSERT INTO job_events (team_id, project_id, job_id, event_id, status, updated_at)
       VALUES ('${teamId}', '${projectId}', '${priorJobId}', '${evtCompiled}', 'compiled', '${now.toISOString()}')`,
    );

    const body = validBody([evtNew, evtCompiled, fakeId]);
    const res = await app.request('/v1/compilations', {
      method: 'POST',
      headers: authHeader(),
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.results).toHaveLength(3);
    expect(json.results).toContainEqual({ eventId: evtNew, status: 'queued' });
    expect(json.results).toContainEqual({ eventId: evtCompiled, status: 'already_compiled' });
    expect(json.results).toContainEqual({ eventId: fakeId, status: 'not_found' });

    // Verify a job was created for the one queued event
    expect(json.compilationJobId).toBeTruthy();
    const { rows: jobEventRows } = await db.execute(
      `SELECT event_id, status FROM job_events WHERE job_id = '${json.compilationJobId}'`,
    );
    expect(jobEventRows).toHaveLength(1);
    expect((jobEventRows[0] as Record<string, unknown>)['event_id']).toBe(evtNew);
  });

  // ── Boundary: all not_found — still returns a job ID ───────────────────

  it('returns 200 with a job ID even when all events are not_found', async () => {
    const fakeId1 = 'evt_nonexistent000000000000000a';
    const fakeId2 = 'evt_nonexistent000000000000000b';

    const body = validBody([fakeId1, fakeId2]);
    const res = await app.request('/v1/compilations', {
      method: 'POST',
      headers: authHeader(),
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.compilationJobId).toMatch(/^[0-9a-f-]{36}$/);
    expect(json.results).toHaveLength(2);
    expect(json.results).toContainEqual({ eventId: fakeId1, status: 'not_found' });
    expect(json.results).toContainEqual({ eventId: fakeId2, status: 'not_found' });
  });

  // ── Boundary: cross-project event isolation ────────────────────────────

  it('events from a different project are not_found', async () => {
    const evtA = await seedEvent();

    // Create a second project in the same team
    const project2 = `prj_${randomUUID().replace(/-/g, '')}`;
    await db.execute(
      `INSERT INTO projects (id, team_id, name) VALUES ('${project2}', '${teamId}', 'Other Project')`,
    );

    // Seed an event in the second project
    const evtB = `evt_${randomUUID().replace(/-/g, '')}`;
    const now = new Date();
    await db.execute(
      `INSERT INTO events (id, team_id, project_id, channel, kind, connector_kind, delivery_id, item_key, external_id, actor_provenance, occurred_at, occurred_at_provenance, payload, payload_bytes, payload_hash, payload_schema_version, envelope_version)
       VALUES ('${evtB}', '${teamId}', '${project2}', 'cli', 'cli_init', 'cli', 'dk_other', 'root', 'other/repo', 'unknown', '${now.toISOString()}', 'server', '{}', 2, 'h_other', ${PAYLOAD_SCHEMA_VERSION}, ${EVENT_ENVELOPE_VERSION})`,
    );

    // Create an all-projects key so we can query
    const { generateApiKeyToken, hashToken } = await import(
      '../auth/api-key.js'
    );
    const allProjToken = generateApiKeyToken();
    const allProjHash = hashToken(allProjToken);
    const keyId = `key_allproj_${randomUUID().replace(/-/g, '')}`;
    await db.execute(
      `INSERT INTO api_keys (id, team_id, project_id, name, token_hash, scopes, all_projects)
       VALUES ('${keyId}', '${teamId}', NULL, 'All-Projects Key',
               '${allProjHash}', ARRAY['events:write']::text[], true)`,
    );

    try {
      const allProjHeaders = {
        Authorization: `Bearer ${allProjToken}`,
        'Content-Type': 'application/json',
      };

      // Query compilation for project2 — evtA from project1 should be not_found
      const body = {
        projectId: project2,
        eventIds: [evtB, evtA],
        idempotencyKey: `cross-proj-${randomUUID().replace(/-/g, '')}`,
      };
      const res = await app.request('/v1/compilations', {
        method: 'POST',
        headers: allProjHeaders,
        body: JSON.stringify(body),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.results).toHaveLength(2);
      expect(json.results).toContainEqual({ eventId: evtB, status: 'queued' });
      // evtA is in a different project → not_found
      expect(json.results).toContainEqual({ eventId: evtA, status: 'not_found' });
    } finally {
      await db.execute(`DELETE FROM job_events WHERE project_id = '${project2}'`);
      await db.execute(`DELETE FROM events WHERE project_id = '${project2}'`);
      await db.execute(`DELETE FROM jobs WHERE project_id = '${project2}'`);
      await db.execute(`DELETE FROM api_keys WHERE id = '${keyId}'`);
      await db.execute(`DELETE FROM projects WHERE id = '${project2}'`);
    }
  });

  // ── Boundary: scope enforcement — project-scoped key cannot access other project ──

  it('returns 403 when project-scoped key tries a different project', async () => {
    const project2 = `prj_${randomUUID().replace(/-/g, '')}`;
    await db.execute(
      `INSERT INTO projects (id, team_id, name) VALUES ('${project2}', '${teamId}', 'Other Project')`,
    );

    try {
      const body = {
        projectId: project2,
        eventIds: ['evt_nonexistent0000000000000000'],
        idempotencyKey: `key-${randomUUID().replace(/-/g, '')}`,
      };
      const res = await app.request('/v1/compilations', {
        method: 'POST',
        headers: authHeader(),
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error.code).toBe('forbidden');
    } finally {
      await db.execute(`DELETE FROM projects WHERE id = '${project2}'`);
    }
  });

  // ── Boundary: cross-team anti-enumeration (all-projects key) ───────────

  it('returns 404 when all-projects key tries a project in a different team', async () => {
    // Create a second team with its own project
    const team2Id = `team_xt_${randomUUID().replace(/-/g, '')}`;
    const proj2Id = `prj_${randomUUID().replace(/-/g, '')}`;
    await db.execute(
      `INSERT INTO teams (id, name) VALUES ('${team2Id}', 'Other Team')`,
    );
    await db.execute(
      `INSERT INTO projects (id, team_id, name) VALUES ('${proj2Id}', '${team2Id}', 'Other Project')`,
    );

    // Create an all-projects key for our team
    const { generateApiKeyToken, hashToken } = await import(
      '../auth/api-key.js'
    );
    const allProjToken = generateApiKeyToken();
    const allProjHash = hashToken(allProjToken);
    const keyId = `key_xt_${randomUUID().replace(/-/g, '')}`;
    await db.execute(
      `INSERT INTO api_keys (id, team_id, project_id, name, token_hash, scopes, all_projects)
       VALUES ('${keyId}', '${teamId}', NULL, 'Cross-Team Test Key',
               '${allProjHash}', ARRAY['events:write']::text[], true)`,
    );

    try {
      const body = {
        projectId: proj2Id,
        eventIds: ['evt_nonexistent0000000000000000'],
        idempotencyKey: `key-${randomUUID().replace(/-/g, '')}`,
      };
      const res = await app.request('/v1/compilations', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${allProjToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      // Cross-team → 404, same body as genuinely missing resource
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error.code).toBe('not_found');
    } finally {
      await db.execute(`DELETE FROM api_keys WHERE id = '${keyId}'`);
      await db.execute(`DELETE FROM projects WHERE id = '${proj2Id}'`);
      await db.execute(`DELETE FROM teams WHERE id = '${team2Id}'`);
    }
  });
});
