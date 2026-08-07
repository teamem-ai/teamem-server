/**
 * POST /v1/jobs/:id/retry integration tests.
 *
 * Covers:
 *   - Admin/owner can retry a failed job — job resets to queued, per-event
 *     rows reset to pending, a fresh pg-boss message is sent.
 *   - Counterexamples: non-failed job (409), cross-team job (404), missing
 *     job (404), member/viewer role (403), API-key auth (403 — retry is
 *     session-only), no session (401).
 *
 * Runs only when TEST_DATABASE_URL is set; honestly skipped otherwise.
 * No mocked database — per project red line.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp, type AppDeps } from '../../app.js';
import { createDb, type AppDb } from '../../db/client.js';
import {
  connectDatabase,
  closeDatabase,
  type Pool,
} from '../../test/database.js';
import { runBootstrap } from '../../commands/bootstrap.js';
import * as schema from '../../db/schema.js';
import { createTestSession, deleteTestSession } from '../../test/session.js';
import type { CompileQueue, CompileJobMessage } from '../../queue/boss.js';

const url = process.env['TEST_DATABASE_URL'];

describe.skipIf(!url)('POST /v1/jobs/:id/retry (live Postgres)', () => {
  let pool: Pool;
  let db: AppDb;

  let teamId: string;
  let projectId: string;
  let apiKeyToken: string | undefined;

  const sendSpy = vi.fn<CompileQueue['send']>();
  const fakeQueue: CompileQueue = {
    start: async () => {},
    stop: async () => {},
    send: (data: CompileJobMessage, options?: { id?: string }) =>
      sendSpy(data, options),
    work: async () => 'sub',
    offWork: async () => {},
  };

  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    ({ pool } = connectDatabase());
    db = createDb(url!, { pool: pool as unknown as import('pg').Pool });

    const suffix = randomUUID().replace(/-/g, '').slice(0, 8);
    const result = await runBootstrap(db, {
      teamName: `Job Retry Test ${suffix}`,
      projectName: `demo-${suffix}`,
      rotate: false,
    });

    teamId = result.team.id;
    projectId = result.project.id;
    apiKeyToken = result.key.token;

    const deps: AppDeps = { dbUrl: url!, db, queue: fakeQueue };
    app = buildApp(deps);
  });

  afterAll(async () => {
    await db.execute(`DELETE FROM job_events WHERE project_id = '${projectId}'`);
    await db.execute(`DELETE FROM jobs WHERE project_id = '${projectId}'`);
    await db.execute(`DELETE FROM events WHERE project_id = '${projectId}'`);
    await db.execute(`DELETE FROM api_keys WHERE project_id = '${projectId}'`);
    await db.execute(
      `DELETE FROM jobs WHERE project_id IN (SELECT id FROM projects WHERE team_id = '${teamId}')`,
    );
    await db.execute(
      `DELETE FROM job_events WHERE project_id IN (SELECT id FROM projects WHERE team_id = '${teamId}')`,
    );
    await db.execute(`DELETE FROM web_sessions`);
    await db.execute(`DELETE FROM memberships WHERE team_id = '${teamId}'`);
    await db.execute(`DELETE FROM users`);
    await db.execute(`DELETE FROM projects WHERE team_id = '${teamId}'`);
    await db.execute(`DELETE FROM teams WHERE id = '${teamId}'`);
    await closeDatabase(pool);
  });

  beforeEach(async () => {
    await db.delete(schema.jobEvents);
    await db.delete(schema.jobs);
    await db.delete(schema.events);
    sendSpy.mockReset();
    sendSpy.mockResolvedValue('msg-id');
  });

  afterEach(async () => {
    await db.execute(`DELETE FROM web_sessions`);
    await db.execute(`DELETE FROM memberships WHERE team_id = '${teamId}'`);
    await db.execute(`DELETE FROM users`);
  });

  // ── Helpers ───────────────────────────────────────────────────────────

  async function seedJob(
    overrides: Partial<{ status: string; error: { code: string; message: string } }> = {},
  ): Promise<string> {
    const jobId = randomUUID();
    await db.insert(schema.jobs).values({
      id: jobId,
      teamId,
      projectId,
      kind: 'compilation',
      status: (overrides.status ?? 'failed') as 'failed',
      attempts: 1,
      initiatedByKind: 'credential',
      initiatedByCredentialId: 'key_test',
      initiatedByPrincipalId: null,
      initiatedByConnector: null,
      eventCount: 1,
      error: overrides.error ?? { code: 'f1_http_error', message: 'boom' },
      createdAt: new Date(),
      startedAt: new Date(),
      finishedAt: new Date(),
    });
    return jobId;
  }

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

  async function seedJobEvent(
    jobId: string,
    eventId: string,
    status: 'failed' | 'pending' | 'compiled' | 'skipped' = 'failed',
  ): Promise<void> {
    await db.insert(schema.jobEvents).values({
      teamId,
      projectId,
      jobId,
      eventId,
      status,
      reason: null,
      error: status === 'failed' ? { code: 'f1_http_error', message: 'boom' } : null,
      conceptUuids: null,
      updatedAt: new Date(),
    });
  }

  // ── Success ──────────────────────────────────────────────────────────

  it('admin retries a failed job: resets status/events and sends a fresh pg-boss message', async () => {
    const session = await createTestSession(db, { teamId, role: 'admin' });
    const jobId = await seedJob({ status: 'failed' });
    const eventId = `evt_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    await seedEvent(eventId);
    await seedJobEvent(jobId, eventId, 'failed');

    try {
      const res = await app.request(`/v1/jobs/${jobId}/retry`, {
        method: 'POST',
        headers: { Cookie: session.cookieHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data).toEqual({ id: jobId, status: 'queued' });

      const jobRows = await db.execute(
        `SELECT status, error, started_at, finished_at FROM jobs WHERE id = '${jobId}'`,
      );
      const jobRow = jobRows.rows[0] as Record<string, unknown>;
      expect(jobRow['status']).toBe('queued');
      expect(jobRow['error']).toBeNull();
      expect(jobRow['started_at']).toBeNull();
      expect(jobRow['finished_at']).toBeNull();

      const eventRows = await db.execute(
        `SELECT status, error FROM job_events WHERE job_id = '${jobId}'`,
      );
      expect(eventRows.rows).toHaveLength(1);
      expect((eventRows.rows[0] as Record<string, unknown>)['status']).toBe('pending');
      expect((eventRows.rows[0] as Record<string, unknown>)['error']).toBeNull();

      expect(sendSpy).toHaveBeenCalledTimes(1);
      const [sentData] = sendSpy.mock.calls[0]!;
      expect(sentData).toEqual({ jobId, teamId, projectId, kind: 'compilation' });
    } finally {
      await deleteTestSession(db, session.sessionId);
    }
  });

  it('owner can also retry (role ladder — admin is the floor, not the ceiling)', async () => {
    const session = await createTestSession(db, { teamId, role: 'owner' });
    const jobId = await seedJob({ status: 'failed' });

    try {
      const res = await app.request(`/v1/jobs/${jobId}/retry`, {
        method: 'POST',
        headers: { Cookie: session.cookieHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId }),
      });
      expect(res.status).toBe(200);
    } finally {
      await deleteTestSession(db, session.sessionId);
    }
  });

  // ── Counterexamples ──────────────────────────────────────────────────

  it('rejects a non-failed job with 409 and does not touch it', async () => {
    const session = await createTestSession(db, { teamId, role: 'admin' });
    const jobId = await seedJob({ status: 'queued' });

    try {
      const res = await app.request(`/v1/jobs/${jobId}/retry`, {
        method: 'POST',
        headers: { Cookie: session.cookieHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId }),
      });
      expect(res.status).toBe(409);
      expect(sendSpy).not.toHaveBeenCalled();

      const jobRows = await db.execute(`SELECT status FROM jobs WHERE id = '${jobId}'`);
      expect((jobRows.rows[0] as Record<string, unknown>)['status']).toBe('queued');
    } finally {
      await deleteTestSession(db, session.sessionId);
    }
  });

  it('returns 404 for a job belonging to another team (cross-team isolation)', async () => {
    const suffix = randomUUID().replace(/-/g, '').slice(0, 8);
    const otherTeam = await runBootstrap(db, {
      teamName: `Other Team ${suffix}`,
      projectName: `other-${suffix}`,
      rotate: false,
    });

    const session = await createTestSession(db, { teamId, role: 'admin' });
    const otherJobId = randomUUID();
    await db.insert(schema.jobs).values({
      id: otherJobId,
      teamId: otherTeam.team.id,
      projectId: otherTeam.project.id,
      kind: 'compilation',
      status: 'failed',
      attempts: 1,
      initiatedByKind: 'credential',
      initiatedByCredentialId: 'key_other',
      initiatedByPrincipalId: null,
      initiatedByConnector: null,
      eventCount: 1,
      error: { code: 'f1_http_error', message: 'boom' },
      createdAt: new Date(),
    });

    try {
      const res = await app.request(`/v1/jobs/${otherJobId}/retry`, {
        method: 'POST',
        headers: { Cookie: session.cookieHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId }),
      });
      expect(res.status).toBe(404);
      expect(sendSpy).not.toHaveBeenCalled();
    } finally {
      await deleteTestSession(db, session.sessionId);
      await db.execute(`DELETE FROM jobs WHERE id = '${otherJobId}'`);
      await db.execute(`DELETE FROM api_keys WHERE project_id = '${otherTeam.project.id}'`);
      await db.execute(`DELETE FROM projects WHERE team_id = '${otherTeam.team.id}'`);
      await db.execute(`DELETE FROM teams WHERE id = '${otherTeam.team.id}'`);
    }
  });

  it('returns 404 for a non-existent job id', async () => {
    const session = await createTestSession(db, { teamId, role: 'admin' });
    try {
      const res = await app.request(`/v1/jobs/${randomUUID()}/retry`, {
        method: 'POST',
        headers: { Cookie: session.cookieHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId }),
      });
      expect(res.status).toBe(404);
    } finally {
      await deleteTestSession(db, session.sessionId);
    }
  });

  it('rejects a member role with 403', async () => {
    const session = await createTestSession(db, { teamId, role: 'member' });
    const jobId = await seedJob({ status: 'failed' });

    try {
      const res = await app.request(`/v1/jobs/${jobId}/retry`, {
        method: 'POST',
        headers: { Cookie: session.cookieHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId }),
      });
      expect(res.status).toBe(403);
      expect(sendSpy).not.toHaveBeenCalled();
    } finally {
      await deleteTestSession(db, session.sessionId);
    }
  });

  it('rejects a viewer role with 403', async () => {
    const session = await createTestSession(db, { teamId, role: 'viewer' });
    const jobId = await seedJob({ status: 'failed' });

    try {
      const res = await app.request(`/v1/jobs/${jobId}/retry`, {
        method: 'POST',
        headers: { Cookie: session.cookieHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId }),
      });
      expect(res.status).toBe(403);
    } finally {
      await deleteTestSession(db, session.sessionId);
    }
  });

  it('rejects API-key (Bearer) authentication — retry is session-only', async () => {
    const jobId = await seedJob({ status: 'failed' });

    const res = await app.request(`/v1/jobs/${jobId}/retry`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKeyToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ projectId }),
    });
    expect(res.status).toBe(403);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('returns 401 without a session or API key', async () => {
    const jobId = await seedJob({ status: 'failed' });

    const res = await app.request(`/v1/jobs/${jobId}/retry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId }),
    });
    expect(res.status).toBe(401);
  });
});
