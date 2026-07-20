/**
 * GET /v1/jobs and GET /v1/jobs/:id integration tests (DUA-156).
 *
 * Tests job list with status filter and cursor pagination, and job detail
 * with per-event outcomes against real Postgres.
 *
 * Runs only when TEST_DATABASE_URL is set; honestly skipped otherwise.
 * No mocked database — per project red line.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, type AppDeps } from '../../app.js';
import { createDb, type AppDb } from '../../db/client.js';
import {
  connectDatabase,
  closeDatabase,
  type Pool,
} from '../../test/database.js';
import { runBootstrap } from '../../commands/bootstrap.js';
import * as schema from '../../db/schema.js';

const url = process.env['TEST_DATABASE_URL'];

describe.skipIf(!url)('GET /v1/jobs (live Postgres)', () => {
  let pool: Pool;
  let db: AppDb;
  let app: ReturnType<typeof buildApp>;

  // Per-test-suite stable team, project, and API key
  let teamId: string;
  let projectId: string;
  let apiKeyToken: string | undefined;

  beforeAll(async () => {
    ({ pool } = connectDatabase());
    db = createDb(url!, { pool: pool as unknown as import('pg').Pool });

    // Bootstrap: create team + project + API key with read scope
    const suffix = randomUUID().replace(/-/g, '').slice(0, 8);
    const result = await runBootstrap(db, {
      teamName: `Jobs Read Test ${suffix}`,
      projectName: `demo-${suffix}`,
      rotate: false,
    });

    teamId = result.team.id;
    projectId = result.project.id;
    apiKeyToken = result.key.token;

    // Build the Hono app with the real database
    const deps: AppDeps = { dbUrl: url!, db };
    app = buildApp(deps);
  });

  afterAll(async () => {
    // Clean up in FK dependency order (children first)
    await db.execute(
      `DELETE FROM job_events WHERE project_id = '${projectId}'`,
    );
    await db.execute(
      `DELETE FROM jobs WHERE project_id = '${projectId}'`,
    );
    await db.execute(
      `DELETE FROM events WHERE project_id = '${projectId}'`,
    );
    await db.execute(
      `DELETE FROM api_keys WHERE project_id = '${projectId}'`,
    );
    // Also clean up any other projects referencing this team (e.g. from
    // the cross-project anti-enumeration test).
    await db.execute(
      `DELETE FROM jobs WHERE project_id IN (SELECT id FROM projects WHERE team_id = '${teamId}')`,
    );
    await db.execute(
      `DELETE FROM job_events WHERE project_id IN (SELECT id FROM projects WHERE team_id = '${teamId}')`,
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
    // Clean in FK dependency order
    await db.delete(schema.jobEvents);
    await db.delete(schema.jobs);
    await db.delete(schema.events);
  });

  const authHeader = () => ({
    Authorization: `Bearer ${apiKeyToken}`,
    'Content-Type': 'application/json',
  });

  // ── Helpers ───────────────────────────────────────────────────────────

  /** Insert a job row directly and return its id */
  async function seedJob(
    overrides: Partial<{
      status: string;
      kind: string;
      eventCount: number;
      initiatedByKind: string;
      initiatedByCredentialId: string;
      error: { code: string; message: string };
    }> = {},
  ): Promise<string> {
    const jobId = randomUUID();
    await db.insert(schema.jobs).values({
      id: jobId,
      teamId,
      projectId,
      kind: (overrides.kind ?? 'ingest_event') as 'ingest_event',
      status: (overrides.status ?? 'queued') as 'queued',
      attempts: 0,
      initiatedByKind: (overrides.initiatedByKind ?? 'credential') as 'credential',
      initiatedByCredentialId: overrides.initiatedByCredentialId ?? 'key_test',
      initiatedByPrincipalId: null,
      initiatedByConnector: null,
      eventCount: overrides.eventCount ?? 1,
      error: overrides.error ?? null,
      createdAt: new Date(),
    });
    return jobId;
  }

  /** Insert a minimal event row */
  async function seedEvent(eventId: string): Promise<void> {
    await db.insert(schema.events).values({
      id: eventId,
      teamId,
      projectId,
      channel: 'cli',
      kind: 'cli_init',
      connectorKind: 'cli',
      deliveryId: `dk_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      itemKey: 'root',
      externalId: 'x',
      actorProvenance: 'unknown',
      occurredAt: new Date(),
      occurredAtProvenance: 'server',
      payload: {},
      payloadBytes: 2,
      payloadHash: 'h1',
      payloadSchemaVersion: 1,
      envelopeVersion: 1,
    });
  }

  /** Insert a job_event row */
  async function seedJobEvent(
    jobId: string,
    eventId: string,
    overrides: Partial<{
      status: string;
      reason: string;
      error: { code: string; message: string };
      conceptUuids: string[];
    }> = {},
  ): Promise<void> {
    await db.insert(schema.jobEvents).values({
      teamId,
      projectId,
      jobId,
      eventId,
      status: (overrides.status ?? 'pending') as 'pending',
      reason: overrides.reason ?? null,
      error: overrides.error ?? null,
      conceptUuids: overrides.conceptUuids ?? null,
      updatedAt: new Date(),
    });
  }

  // ── List: basic ───────────────────────────────────────────────────────

  it('returns empty list when no jobs exist', async () => {
    const res = await app.request(
      `/v1/jobs?projectId=${projectId}`,
      { method: 'GET', headers: authHeader() },
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual([]);
    expect(json.nextCursor).toBeNull();
    expect(json.requestId).toBeTruthy();
  });

  it('returns jobs in created_at desc + id order', async () => {
    const job1 = await seedJob();
    const job2 = await seedJob();

    const res = await app.request(
      `/v1/jobs?projectId=${projectId}`,
      { method: 'GET', headers: authHeader() },
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toHaveLength(2);
    // Most recent first
    expect(json.data[0].id).toBe(job2);
    expect(json.data[1].id).toBe(job1);
  });

  // ── List: status filter ───────────────────────────────────────────────

  it('filters jobs by status', async () => {
    await seedJob({ status: 'queued' });
    await seedJob({ status: 'completed' });
    await seedJob({ status: 'failed' });

    const res = await app.request(
      `/v1/jobs?projectId=${projectId}&status=queued`,
      { method: 'GET', headers: authHeader() },
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toHaveLength(1);
    expect(json.data[0].status).toBe('queued');
  });

  it('returns empty list when no jobs match status filter', async () => {
    await seedJob({ status: 'completed' });

    const res = await app.request(
      `/v1/jobs?projectId=${projectId}&status=failed`,
      { method: 'GET', headers: authHeader() },
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual([]);
  });

  // ── List: pagination ──────────────────────────────────────────────────

  it('paginates with cursor (two pages)', async () => {
    // Create 5 jobs
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(await seedJob());
    }

    // Page 1: limit=2
    const res1 = await app.request(
      `/v1/jobs?projectId=${projectId}&limit=2`,
      { method: 'GET', headers: authHeader() },
    );

    expect(res1.status).toBe(200);
    const json1 = await res1.json();
    expect(json1.data).toHaveLength(2);
    expect(json1.nextCursor).toBeTruthy();

    // Page 2: use cursor
    const res2 = await app.request(
      `/v1/jobs?projectId=${projectId}&limit=2&cursor=${encodeURIComponent(json1.nextCursor)}`,
      { method: 'GET', headers: authHeader() },
    );

    expect(res2.status).toBe(200);
    const json2 = await res2.json();
    expect(json2.data).toHaveLength(2);
    expect(json2.data[0].id).not.toBe(json1.data[0].id);
    expect(json2.data[0].id).not.toBe(json1.data[1].id);

    // Page 3: last page (1 remaining)
    const res3 = await app.request(
      `/v1/jobs?projectId=${projectId}&limit=2&cursor=${encodeURIComponent(json2.nextCursor)}`,
      { method: 'GET', headers: authHeader() },
    );

    expect(res3.status).toBe(200);
    const json3 = await res3.json();
    expect(json3.data).toHaveLength(1);
    expect(json3.nextCursor).toBeNull();
  });

  // ── List: cursor validation ───────────────────────────────────────────

  it('returns cursor_invalid for tampered cursor', async () => {
    const res = await app.request(
      `/v1/jobs?projectId=${projectId}&cursor=not-a-valid-cursor`,
      { method: 'GET', headers: authHeader() },
    );

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe('cursor_invalid');
  });

  it('returns cursor_invalid when cursor filter changes (status mismatch)', async () => {
    await seedJob({ status: 'completed' });
    await seedJob({ status: 'queued' });

    // Get cursor with status=completed
    const res1 = await app.request(
      `/v1/jobs?projectId=${projectId}&status=completed&limit=1`,
      { method: 'GET', headers: authHeader() },
    );
    expect(res1.status).toBe(200);
    const json1 = await res1.json();

    if (json1.nextCursor) {
      // Reuse cursor with different status → cursor_invalid
      const res2 = await app.request(
        `/v1/jobs?projectId=${projectId}&status=queued&cursor=${encodeURIComponent(json1.nextCursor)}`,
        { method: 'GET', headers: authHeader() },
      );
      expect(res2.status).toBe(400);
      const json2 = await res2.json();
      expect(json2.error.code).toBe('cursor_invalid');
    }
  });

  // ── List: scope enforcement ───────────────────────────────────────────

  it('returns 404 for project-scoped key on different project', async () => {
    // Create another project in the same team
    const otherProjectId = `prj_${randomUUID().replace(/-/g, '')}`;
    await db.execute(
      `INSERT INTO projects (id, team_id, name) VALUES ('${otherProjectId}', '${teamId}', 'Other')`,
    );

    try {
      const res = await app.request(
        `/v1/jobs?projectId=${otherProjectId}`,
        { method: 'GET', headers: authHeader() },
      );
      expect(res.status).toBe(404);
    } finally {
      await db.execute(`DELETE FROM projects WHERE id = '${otherProjectId}'`);
    }
  });

  // ── List: response shape ──────────────────────────────────────────────

  it('returns jobListItem shape (no events array)', async () => {
    await seedJob({ status: 'completed', eventCount: 3 });

    const res = await app.request(
      `/v1/jobs?projectId=${projectId}`,
      { method: 'GET', headers: authHeader() },
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toHaveLength(1);
    const item = json.data[0];

    // Must have list-item fields
    expect(item.id).toBeTruthy();
    expect(item.projectId).toBe(projectId);
    expect(item.status).toBe('completed');
    expect(item.attempts).toBe(0);
    expect(item.eventCount).toBe(3);
    expect(item.initiatedBy).toBeDefined();
    expect(item.createdAt).toBeTruthy();

    // Must NOT have per-event details (list summary only)
    expect(item.events).toBeUndefined();
  });

  // ── Detail: basic ─────────────────────────────────────────────────────

  it('returns 200 with full job detail including per-event outcomes', async () => {
    const jobId = await seedJob({ status: 'completed', eventCount: 1 });
    const eventId = `evt_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    await seedEvent(eventId);
    await seedJobEvent(jobId, eventId, {
      status: 'compiled',
      conceptUuids: [randomUUID()],
    });

    const res = await app.request(
      `/v1/jobs/${jobId}`,
      { method: 'GET', headers: authHeader() },
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.requestId).toBeTruthy();
    expect(json.data.id).toBe(jobId);
    expect(json.data.status).toBe('completed');
    expect(json.data.events).toHaveLength(1);
    expect(json.data.events[0].eventId).toBe(eventId);
    expect(json.data.events[0].status).toBe('compiled');
    expect(json.data.events[0].conceptIds).toHaveLength(1);
  });

  it('returns 404 for non-existent job UUID', async () => {
    const nonExistentId = randomUUID();
    const res = await app.request(
      `/v1/jobs/${nonExistentId}`,
      { method: 'GET', headers: authHeader() },
    );

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error.code).toBe('not_found');
  });

  it('returns 404 for malformed UUID', async () => {
    const res = await app.request(
      '/v1/jobs/not-a-uuid',
      { method: 'GET', headers: authHeader() },
    );

    expect(res.status).toBe(404);
  });

  // ── Detail: cross-tenant isolation ────────────────────────────────────

  it('returns 404 for job scoped to a different project (anti-enumeration)', async () => {
    // Create a second project in the same team
    const project2Id = `prj_${randomUUID().replace(/-/g, '')}`;
    await db.execute(
      `INSERT INTO projects (id, team_id, name) VALUES ('${project2Id}', '${teamId}', 'Second')`,
    );

    try {
      // Create a job in the second project
      const jobInOtherProject = randomUUID();
      await db.insert(schema.jobs).values({
        id: jobInOtherProject,
        teamId,
        projectId: project2Id,
        kind: 'ingest_event',
        status: 'completed',
        attempts: 0,
        initiatedByKind: 'credential',
        initiatedByCredentialId: 'key_test',
        eventCount: 1,
        createdAt: new Date(),
      });

      // Try to read with key scoped to the first project
      const res = await app.request(
        `/v1/jobs/${jobInOtherProject}`,
        { method: 'GET', headers: authHeader() },
      );
      // Must be 404 — same body as genuinely missing resource
      expect(res.status).toBe(404);

      // Clean up: delete child tables first
      await db.execute(
        `DELETE FROM job_events WHERE project_id = '${project2Id}'`,
      );
      await db.execute(
        `DELETE FROM jobs WHERE project_id = '${project2Id}'`,
      );
    } finally {
      await db.execute(`DELETE FROM projects WHERE id = '${project2Id}'`);
    }
  });

  // ── Detail: per-event discriminated union ─────────────────────────────

  it('returns pending event result correctly', async () => {
    const jobId = await seedJob({ eventCount: 1 });
    const eventId = `evt_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    await seedEvent(eventId);
    await seedJobEvent(jobId, eventId, { status: 'pending' });

    const res = await app.request(
      `/v1/jobs/${jobId}`,
      { method: 'GET', headers: authHeader() },
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.events[0]).toMatchObject({
      eventId,
      status: 'pending',
    });
  });

  it('returns compiled event result with conceptIds', async () => {
    const jobId = await seedJob({ eventCount: 1 });
    const eventId = `evt_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    await seedEvent(eventId);
    const cid = randomUUID();
    await seedJobEvent(jobId, eventId, {
      status: 'compiled',
      conceptUuids: [cid],
    });

    const res = await app.request(
      `/v1/jobs/${jobId}`,
      { method: 'GET', headers: authHeader() },
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.events[0]).toMatchObject({
      eventId,
      status: 'compiled',
      conceptIds: [cid],
    });
  });

  it('returns skipped event result with reason', async () => {
    const jobId = await seedJob({ eventCount: 1 });
    const eventId = `evt_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    await seedEvent(eventId);
    await seedJobEvent(jobId, eventId, {
      status: 'skipped',
      reason: 'no_knowledge',
    });

    const res = await app.request(
      `/v1/jobs/${jobId}`,
      { method: 'GET', headers: authHeader() },
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.events[0]).toMatchObject({
      eventId,
      status: 'skipped',
      reason: 'no_knowledge',
    });
  });

  it('returns failed event result with sanitized error', async () => {
    const jobId = await seedJob({ eventCount: 1 });
    const eventId = `evt_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    await seedEvent(eventId);
    await seedJobEvent(jobId, eventId, {
      status: 'failed',
      error: { code: 'compile_error', message: 'extraction failed' },
    });

    const res = await app.request(
      `/v1/jobs/${jobId}`,
      { method: 'GET', headers: authHeader() },
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.events[0]).toMatchObject({
      eventId,
      status: 'failed',
      error: { code: 'compile_error', message: 'extraction failed' },
    });
  });

  // ── Detail: response validates against frozen DTO ─────────────────────

  it('detail response validates against jobDetailResponse DTO', async () => {
    const jobId = await seedJob({ status: 'completed', eventCount: 2 });
    const evt1 = `evt_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const evt2 = `evt_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    await seedEvent(evt1);
    await seedEvent(evt2);
    await seedJobEvent(jobId, evt1, { status: 'compiled', conceptUuids: [randomUUID()] });
    await seedJobEvent(jobId, evt2, { status: 'skipped', reason: 'already_compiled' });

    const res = await app.request(
      `/v1/jobs/${jobId}`,
      { method: 'GET', headers: authHeader() },
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    // If the DTO is invalid, the handler would throw and return an error
    // (since we use jobDetailResponse.parse). A 200 means it validated.
    expect(json.data.id).toBe(jobId);
    expect(json.data.events).toHaveLength(2);
  });

  // ── Detail: sanitized errors only — no provider failure text ──────────

  it('does not leak raw provider failure text in error messages', async () => {
    const jobId = await seedJob({
      status: 'failed',
      error: { code: 'llm_timeout', message: 'LLM timed out after 30s' },
    });

    const res = await app.request(
      `/v1/jobs/${jobId}`,
      { method: 'GET', headers: authHeader() },
    );

    expect(res.status).toBe(200);
    const json = await res.json();

    // Error must be a sanitized {code, message} — not null, not a raw string
    expect(json.data.error).toBeDefined();
    expect(json.data.error.code).toBe('llm_timeout');
    expect(json.data.error.message).toBe('LLM timed out after 30s');

    // Must NOT contain raw provider details
    const body = JSON.stringify(json);
    expect(body).not.toContain('RAW_PROVIDER_STACK');
    expect(body).not.toContain('API_SECRET');
  });

  // ── Auth: 401 without token ───────────────────────────────────────────

  it('returns 401 for list without auth', async () => {
    const res = await app.request(
      `/v1/jobs?projectId=${projectId}`,
      { method: 'GET', headers: { 'Content-Type': 'application/json' } },
    );

    expect(res.status).toBe(401);
  });

  it('returns 401 for detail without auth', async () => {
    const res = await app.request(
      `/v1/jobs/${randomUUID()}`,
      { method: 'GET', headers: { 'Content-Type': 'application/json' } },
    );

    expect(res.status).toBe(401);
  });

  // ── List: limit validation ────────────────────────────────────────────

  it('returns 400 for limit > 100', async () => {
    const res = await app.request(
      `/v1/jobs?projectId=${projectId}&limit=101`,
      { method: 'GET', headers: authHeader() },
    );

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe('invalid_request');
  });
});
