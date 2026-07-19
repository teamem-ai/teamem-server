/**
 * POST /v1/events integration tests (M0-ING-03).
 *
 * Tests the full HTTP ingestion pipeline against real Postgres — validates the
 * frozen request/response DTOs and precise 200/202/400/401/403/409 semantics.
 *
 * Runs only when TEST_DATABASE_URL is set; honestly skipped otherwise.
 * No mocked database — per project red line.
 *
 *   POSTGRES_PASSWORD=x docker compose up -d postgres
 *   psql < apps/server/drizzle/0000_*.sql
 *   psql < apps/server/drizzle/0001_*.sql
 *   TEST_DATABASE_URL=postgres://teamem:x@localhost:5432/teamem pnpm test
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
import { PAYLOAD_SCHEMA_VERSION, EVENT_ENVELOPE_VERSION } from '@teamem/schema';

const url = process.env['TEST_DATABASE_URL'];

describe.skipIf(!url)('POST /v1/events (live Postgres)', () => {
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

    // Bootstrap: create team + project + API key with events:write scope
    const suffix = randomUUID().replace(/-/g, '').slice(0, 8);
    const result = await runBootstrap(db, {
      teamName: `Events Write Test ${suffix}`,
      projectName: `demo-${suffix}`,
      rotate: false,
    });

    teamId = result.team.id;
    projectId = result.project.id;
    apiKeyToken = result.key.token; // only printed on first creation

    // Build the Hono app with the real database
    const deps: AppDeps = { dbUrl: url, db };
    app = buildApp(deps);
  });

  afterAll(async () => {
    // Clean up in FK dependency order
    await db.execute(
      `DELETE FROM events WHERE project_id = '${projectId}'`,
    );
    await db.execute(
      `DELETE FROM jobs WHERE project_id = '${projectId}'`,
    );
    await db.execute(
      `DELETE FROM api_keys WHERE project_id = '${projectId}'`,
    );
    await db.execute(
      `DELETE FROM projects WHERE id = '${projectId}'`,
    );
    await db.execute(
      `DELETE FROM teams WHERE id = '${teamId}'`,
    );
    await closeDatabase(pool);
  });

  beforeEach(async () => {
    // Clean events before each test
    await db.execute(
      `DELETE FROM events WHERE project_id = '${projectId}'`,
    );
    await db.execute(
      `DELETE FROM jobs WHERE project_id = '${projectId}'`,
    );
  });

  // ── Helper: minimal valid request body ──────────────────────────────────
  const validBody = (overrides: Record<string, unknown> = {}) => ({
    projectId,
    source: {
      kind: 'cli_init',
      externalId: 'test/repo',
    },
    payload: {
      schemaVersion: PAYLOAD_SCHEMA_VERSION,
      repo: 'test/repo',
      commitSha: 'abc123def4567890123456789abcdef123456789',
      path: 'docs/decisions/001-use-postgres.md',
      content: 'We decided to use Postgres for the primary database.',
    },
    idempotencyKey: `key-${randomUUID().replace(/-/g, '')}`,
    options: { compile: false },
    ...overrides,
  });

  const authHeader = () => ({
    Authorization: `Bearer ${apiKeyToken}`,
    'Content-Type': 'application/json',
  });

  // ── Success: 202 first insert (compile=false) ───────────────────────────

  it('returns 202 with eventId and jobId:null on first insert (compile=false)', async () => {
    const body = validBody();
    const res = await app.request('/v1/events', {
      method: 'POST',
      headers: authHeader(),
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json).toMatchObject({
      eventId: expect.stringMatching(/^evt_[A-Za-z0-9]+$/),
      jobId: null,
      duplicate: false,
    });
    expect(json.requestId).toBeTruthy();
  });

  // ── Success: 200 duplicate replay ──────────────────────────────────────

  it('returns 200 with duplicate:true when same request is replayed', async () => {
    const body = validBody();
    const res1 = await app.request('/v1/events', {
      method: 'POST',
      headers: authHeader(),
      body: JSON.stringify(body),
    });
    expect(res1.status).toBe(202);
    const json1 = await res1.json();

    // Replay the exact same request
    const res2 = await app.request('/v1/events', {
      method: 'POST',
      headers: authHeader(),
      body: JSON.stringify(body),
    });
    expect(res2.status).toBe(200);
    const json2 = await res2.json();
    expect(json2).toMatchObject({
      requestId: expect.any(String),
      eventId: json1.eventId,
      jobId: null,
      duplicate: true,
    });
  });

  // ── Failure: 409 idempotency conflict ──────────────────────────────────

  it('returns 409 when same idempotency key has different payload', async () => {
    const body1 = validBody();
    const res1 = await app.request('/v1/events', {
      method: 'POST',
      headers: authHeader(),
      body: JSON.stringify(body1),
    });
    expect(res1.status).toBe(202);

    // Same idempotency key, but different content
    const body2 = validBody({
      idempotencyKey: body1.idempotencyKey,
      payload: {
        schemaVersion: PAYLOAD_SCHEMA_VERSION,
        repo: 'test/repo',
        commitSha: 'abc123def4567890123456789abcdef123456789',
        path: 'docs/decisions/001-use-postgres.md',
        content: 'DIFFERENT CONTENT — should trigger conflict',
      },
    });

    const res2 = await app.request('/v1/events', {
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
    const res = await app.request('/v1/events', {
      method: 'POST',
      headers: authHeader(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe('invalid_request');
  });

  it('returns 400 for invalid projectId format', async () => {
    const body = validBody({ projectId: 'not-a-valid-project-id' });
    const res = await app.request('/v1/events', {
      method: 'POST',
      headers: authHeader(),
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe('invalid_request');
  });

  it('returns 400 for invalid source.kind', async () => {
    const body = validBody({
      source: { kind: 'github_pr', externalId: 'test/repo#1' },
    });
    const res = await app.request('/v1/events', {
      method: 'POST',
      headers: authHeader(),
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe('invalid_request');
  });

  it('returns 400 for non-JSON body', async () => {
    const res = await app.request('/v1/events', {
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
    const body = validBody();
    const res = await app.request('/v1/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error.code).toBe('unauthorized');
  });

  it('returns 401 for malformed Authorization header', async () => {
    const body = validBody();
    const res = await app.request('/v1/events', {
      method: 'POST',
      headers: {
        Authorization: 'NotBearer tm_invalid',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error.code).toBe('unauthorized');
  });

  it('returns 401 for unknown/revoked API key', async () => {
    const body = validBody();
    const res = await app.request('/v1/events', {
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
    // We need a key without events:write. We can't directly create one
    // via bootstrap (it always adds events:write), so let's insert one
    // via raw SQL.
    const { generateApiKeyToken, hashToken } = await import(
      '../../auth/api-key.js'
    );
    const readOnlyToken = generateApiKeyToken();
    const readOnlyTokenHash = hashToken(readOnlyToken);

    // Insert a read-only key (no events:write scope)
    const keyId = `key_readonly_${randomUUID().replace(/-/g, '')}`;
    await db.execute(
      `INSERT INTO api_keys (id, team_id, project_id, name, token_hash, scopes, all_projects)
       VALUES ('${keyId}', '${teamId}', '${projectId}', 'Read-Only Key',
               '${readOnlyTokenHash}', ARRAY['read']::text[], false)`,
    );

    try {
      const body = validBody();
      const res = await app.request('/v1/events', {
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
      await db.execute(
        `DELETE FROM api_keys WHERE id = '${keyId}'`,
      );
    }
  });

  // ── Boundary: private-tag redaction ────────────────────────────────────

  it('strips <private> tags from payload before persistence', async () => {
    const body = validBody({
      payload: {
        schemaVersion: PAYLOAD_SCHEMA_VERSION,
        repo: 'test/repo',
        commitSha: 'abc123def4567890123456789abcdef123456789',
        path: 'docs/decisions/001-use-postgres.md',
        content: 'Public info <private>secret credentials here</private> more public',
      },
    });

    const res = await app.request('/v1/events', {
      method: 'POST',
      headers: authHeader(),
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(202);
    const json = await res.json();

    // Verify the stored payload has private tags stripped
    const { rows } = await db.execute(
      `SELECT payload FROM events WHERE id = '${json.eventId}'`,
    );
    const stored = (rows[0] as Record<string, unknown>)['payload'] as Record<string, unknown>;
    expect(stored.content).toBe('Public info  more public');
    // Redacted content should NOT contain the secret
    expect(JSON.stringify(stored)).not.toContain('secret credentials here');
  });

  // ── Boundary: scope enforcement ────────────────────────────────────────

  it('returns 403 when project-scoped key tries a different project', async () => {
    // Create a second project in the same team.
    // projectId regex is ^prj_[A-Za-z0-9]+$ — must start with prj_, then only alphanumeric.
    const project2 = `prj_${randomUUID().replace(/-/g, '')}`;
    await db.execute(
      `INSERT INTO projects (id, team_id, name) VALUES ('${project2}', '${teamId}', 'Other Project')`,
    );

    try {
      const body = validBody({ projectId: project2 });
      const res = await app.request('/v1/events', {
        method: 'POST',
        headers: authHeader(),
        body: JSON.stringify(body),
      });
      // The bootstrap key is project-scoped to projectId, not project2
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error.code).toBe('forbidden');
    } finally {
      await db.execute(`DELETE FROM projects WHERE id = '${project2}'`);
    }
  });

  // ── Boundary: idempotency across different projects ────────────────────

  it('same idempotency key in different projects are independent', async () => {
    // This test uses an all-projects key to write to two different projects
    const { generateApiKeyToken, hashToken } = await import(
      '../../auth/api-key.js'
    );
    const allProjToken = generateApiKeyToken();
    const allProjHash = hashToken(allProjToken);

    const keyId = `key_allproj_${randomUUID().replace(/-/g, '')}`;
    await db.execute(
      `INSERT INTO api_keys (id, team_id, project_id, name, token_hash, scopes, all_projects)
       VALUES ('${keyId}', '${teamId}', NULL, 'All-Projects Key',
               '${allProjHash}', ARRAY['events:write']::text[], true)`,
    );

    // projectId regex is ^prj_[A-Za-z0-9]+$ — must start with prj_
    const project2 = `prj_${randomUUID().replace(/-/g, '')}`;
    await db.execute(
      `INSERT INTO projects (id, team_id, name) VALUES ('${project2}', '${teamId}', 'Second Project')`,
    );

    try {
      const allProjHeaders = {
        Authorization: `Bearer ${allProjToken}`,
        'Content-Type': 'application/json',
      };

      const key = `shared-key-${randomUUID().replace(/-/g, '')}`;

      const res1 = await app.request('/v1/events', {
        method: 'POST',
        headers: allProjHeaders,
        body: JSON.stringify(validBody({ idempotencyKey: key })),
      });
      expect(res1.status).toBe(202);

      const res2 = await app.request('/v1/events', {
        method: 'POST',
        headers: allProjHeaders,
        body: JSON.stringify(
          validBody({ idempotencyKey: key, projectId: project2 }),
        ),
      });
      // Different project → new insert, not duplicate
      expect(res2.status).toBe(202);
      const json2 = await res2.json();
      expect(json2.eventId).not.toBe((await res1.json()).eventId);
    } finally {
      await db.execute(
        `DELETE FROM events WHERE project_id IN ('${projectId}', '${project2}')`,
      );
      await db.execute(`DELETE FROM api_keys WHERE id = '${keyId}'`);
      await db.execute(`DELETE FROM projects WHERE id = '${project2}'`);
    }
  });

  // ── Payload fields preserved correctly ─────────────────────────────────

  it('preserves payload fields as stored in the database', async () => {
    const body = validBody();
    const res = await app.request('/v1/events', {
      method: 'POST',
      headers: authHeader(),
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(202);
    const json = await res.json();

    const { rows } = await db.execute(
      `SELECT channel, kind, connector_kind, delivery_id, item_key,
              external_id, actor_provenance, occurred_at_provenance,
              ingested_by_credential_id, payload_schema_version, envelope_version
       FROM events WHERE id = '${json.eventId}'`,
    );
    const row = rows[0] as Record<string, unknown>;
    expect(row['channel']).toBe('cli');
    expect(row['kind']).toBe('cli_init');
    expect(row['connector_kind']).toBe('cli');
    expect(row['delivery_id']).toBe(body.idempotencyKey);
    expect(row['item_key']).toBe('root');
    expect(row['external_id']).toBe('test/repo');
    expect(row['actor_provenance']).toBe('unknown');
    expect(row['occurred_at_provenance']).toBe('server');
    expect(row['ingested_by_credential_id']).toBeTruthy();
    expect(row['payload_schema_version']).toBe(PAYLOAD_SCHEMA_VERSION);
    expect(row['envelope_version']).toBe(EVENT_ENVELOPE_VERSION);
  });

  // ── Compile=true creates a job ─────────────────────────────────────────

  it('creates a compile job when options.compile=true', async () => {
    const body = validBody({ options: { compile: true } });
    const res = await app.request('/v1/events', {
      method: 'POST',
      headers: authHeader(),
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json.eventId).toMatch(/^evt_/);
    expect(json.jobId).toBeTruthy();
    expect(json.jobId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(json.duplicate).toBe(false);

    // Verify the job row exists
    const { rows: jobRows } = await db.execute(
      `SELECT id, kind, status, event_count, project_id
       FROM jobs WHERE id = '${json.jobId}'`,
    );
    expect(jobRows).toHaveLength(1);
    const jobRow = jobRows[0] as Record<string, unknown>;
    expect(jobRow['kind']).toBe('ingest_event');
    expect(jobRow['status']).toBe('queued');
    expect(jobRow['event_count']).toBe(1);
    expect(jobRow['project_id']).toBe(projectId);
  });
});
