/**
 * Single-event ingestion pipeline — real-Postgres integration tests (M0-ING-02).
 *
 * Tests the full ingestOne pipeline against real Postgres — validates:
 *   - DTO validation (via the frozen IngestEventRequest type)
 *   - CLI channel/delivery/item fact derivation
 *   - actor → client_claimed provenance
 *   - ingested-by derivation from auth context
 *   - private-tag redaction before hashing & persistence
 *   - idempotent insert (replay → duplicate; different hash → conflict)
 *   - compile=true → job created; compile=false → no job
 *   - replay never enqueues again
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
import { createDb, type AppDb } from '../db/client.js';
import {
  connectDatabase,
  closeDatabase,
  type Pool,
} from '../test/database.js';
import { ingestOne, IngestOneError, type IngestOneAuth } from './ingest-one.js';
import { stripPrivateTags } from '../security/private-tags.js';
import { payloadHash } from '../security/payload-hash.js';
import { PAYLOAD_SCHEMA_VERSION, type IngestEventRequest } from '@teamem/schema';

// ── Setup ───────────────────────────────────────────────────────────────────

const url = process.env['TEST_DATABASE_URL'];

describe.skipIf(!url)('ingestOne pipeline (live Postgres)', () => {
  let pool: Pool;
  let db: AppDb;

  // Per-test-suite stable team and project identifiers.
  const teamId = `team_ing1_${randomUUID().replace(/-/g, '')}`;
  const projectId = `prj_ing1_${randomUUID().replace(/-/g, '')}`;
  const credentialId = `key_ing1_${randomUUID().replace(/-/g, '')}`;

  beforeAll(async () => {
    ({ pool } = connectDatabase());
    db = createDb(url!, { pool: pool as unknown as import('pg').Pool });

    // Seed: team and project
    await db.execute(
      `INSERT INTO teams (id, name) VALUES ('${teamId}', 'IngestOne Test Team') ON CONFLICT (id) DO NOTHING`,
    );
    await db.execute(
      `INSERT INTO projects (id, team_id, name) VALUES ('${projectId}', '${teamId}', 'IngestOne Test Project') ON CONFLICT (id) DO NOTHING`,
    );

    // Seed: second team for cross-tenant isolation tests
    await db.execute(
      `INSERT INTO teams (id, name) VALUES ('team_other_ing1', 'Other Team') ON CONFLICT (id) DO NOTHING`,
    );
    await db.execute(
      `INSERT INTO projects (id, team_id, name) VALUES ('prj_other_ing1', 'team_other_ing1', 'Other Project') ON CONFLICT (id) DO NOTHING`,
    );
  });

  afterAll(async () => {
    // Clean up in dependency order
    await db.execute(`DELETE FROM job_events WHERE team_id = '${teamId}'`);
    await db.execute(`DELETE FROM events WHERE team_id = '${teamId}'`);
    await db.execute(`DELETE FROM jobs WHERE team_id = '${teamId}'`);
    await db.execute(`DELETE FROM events WHERE team_id = 'team_other_ing1'`);
    await db.execute(`DELETE FROM projects WHERE id = '${projectId}'`);
    await db.execute(`DELETE FROM projects WHERE id = 'prj_other_ing1'`);
    await db.execute(`DELETE FROM teams WHERE id = '${teamId}'`);
    await db.execute(`DELETE FROM teams WHERE id = 'team_other_ing1'`);
    await closeDatabase(pool);
  });

  beforeEach(async () => {
    // Clean in FK dependency order: job_events → events → jobs
    await db.execute(
      `DELETE FROM job_events WHERE team_id = '${teamId}'`,
    );
    await db.execute(
      `DELETE FROM events WHERE team_id = '${teamId}'`,
    );
    await db.execute(
      `DELETE FROM jobs WHERE team_id = '${teamId}'`,
    );
  });

  // ── Helpers ───────────────────────────────────────────────────────────────

  const auth: IngestOneAuth = {
    teamId,
    projectId,
    credentialId,
    principalId: null,
  };

  function makeRequest(overrides: Partial<IngestEventRequest> = {}): IngestEventRequest {
    return {
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
      options: { compile: false, wait: false },
      ...overrides,
    } as IngestEventRequest;
  }

  /**
   * Determine the expected redacted content by running stripPrivateTags
   * on the payload. Useful for comparing stored content against what the
   * pipeline should have stored.
   */
  function redactedContent(payload: Record<string, unknown>): Record<string, unknown> {
    return stripPrivateTags(payload) as Record<string, unknown>;
  }

  // ── Success path: first insert (compile=false) ────────────────────────────

  describe('success path — first insert with compile=false', () => {
    it('inserts an event and returns status inserted with jobId:null', async () => {
      const req = makeRequest({ options: { compile: false, wait: false } });
      const result = await ingestOne({ db }, req, auth);

      expect(result.status).toBe('inserted');
      expect(result.eventId).toMatch(/^evt_[A-Za-z0-9]+$/);
      expect(result.jobId).toBeNull();

      // Verify the event row exists
      const { rows } = await db.execute(
        `SELECT id, team_id, project_id, channel, kind, connector_kind,
                delivery_id, item_key, external_id, payload, payload_hash
         FROM events WHERE id = '${result.eventId}'`,
      );
      expect(rows).toHaveLength(1);
      const row = rows[0] as Record<string, unknown>;
      expect(row['channel']).toBe('cli');
      expect(row['kind']).toBe('cli_init');
      expect(row['connector_kind']).toBe('cli');
      expect(row['delivery_id']).toBe(req.idempotencyKey);
      expect(row['item_key']).toBe('root');
      expect(row['external_id']).toBe('test/repo');
    });

    it('stores the redacted payload', async () => {
      const payload = {
        schemaVersion: PAYLOAD_SCHEMA_VERSION,
        repo: 'test/repo',
        commitSha: 'abc123def4567890123456789abcdef123456789',
        path: 'docs/decisions/001-use-postgres.md',
        content: 'Public info <private>secret here</private> after',
      };
      const req = makeRequest({ payload });

      const result = await ingestOne({ db }, req, auth);
      expect(result.status).toBe('inserted');

      const { rows } = await db.execute(
        `SELECT payload FROM events WHERE id = '${result.eventId}'`,
      );
      const stored = (rows[0] as Record<string, unknown>)['payload'] as Record<string, unknown>;
      // Redacted content must NOT contain the private section
      expect(stored.content).toBe('Public info  after');
      expect(JSON.stringify(stored)).not.toContain('secret here');

      // Hash should be computed on the REDACTED content
      const expectedHash = payloadHash(redactedContent(payload));
      const { rows: hashRows } = await db.execute(
        `SELECT payload_hash FROM events WHERE id = '${result.eventId}'`,
      );
      expect((hashRows[0] as Record<string, unknown>)['payload_hash']).toBe(expectedHash);
    });

    it('marks actor as client_claimed when provided', async () => {
      const actor = {
        kind: 'human' as const,
        provider: 'github' as const,
        providerUserId: '12345',
        displayLogin: 'testuser',
      };
      const req = makeRequest({ actor });

      const result = await ingestOne({ db }, req, auth);
      expect(result.status).toBe('inserted');

      const { rows } = await db.execute(
        `SELECT actor, actor_provenance, actor_principal_id
         FROM events WHERE id = '${result.eventId}'`,
      );
      const row = rows[0] as Record<string, unknown>;
      expect(row['actor']).toEqual(actor);
      expect(row['actor_provenance']).toBe('client_claimed');
      expect(row['actor_principal_id']).toBeNull(); // client_claimed never creates contributor
    });

    it('marks actor provenance as unknown when no actor is provided', async () => {
      const req = makeRequest(); // no actor

      const result = await ingestOne({ db }, req, auth);
      expect(result.status).toBe('inserted');

      const { rows } = await db.execute(
        `SELECT actor, actor_provenance FROM events WHERE id = '${result.eventId}'`,
      );
      const row = rows[0] as Record<string, unknown>;
      expect(row['actor']).toBeNull();
      expect(row['actor_provenance']).toBe('unknown');
    });

    it('derives ingested-by from auth context', async () => {
      const req = makeRequest();
      const authWithPrincipal: IngestOneAuth = {
        ...auth,
        credentialId: 'key_specific_cred',
        principalId: 'pri_test_user',
      };

      const result = await ingestOne({ db }, req, authWithPrincipal);
      expect(result.status).toBe('inserted');

      const { rows } = await db.execute(
        `SELECT ingested_by_credential_id, ingested_by_principal_id
         FROM events WHERE id = '${result.eventId}'`,
      );
      const row = rows[0] as Record<string, unknown>;
      expect(row['ingested_by_credential_id']).toBe('key_specific_cred');
      expect(row['ingested_by_principal_id']).toBe('pri_test_user');
    });

    it('sets occurred_at provenance to client when timestamp is provided', async () => {
      const req = makeRequest({
        occurredAt: '2026-07-17T12:00:00.000Z',
      });

      const result = await ingestOne({ db }, req, auth);
      const { rows } = await db.execute(
        `SELECT occurred_at, occurred_at_provenance
         FROM events WHERE id = '${result.eventId}'`,
      );
      const row = rows[0] as Record<string, unknown>;
      expect(row['occurred_at_provenance']).toBe('client');
      expect(row['occurred_at']).toBeDefined();
    });

    it('sets occurred_at provenance to server when no timestamp provided', async () => {
      const req = makeRequest(); // no occurredAt

      const result = await ingestOne({ db }, req, auth);
      const { rows } = await db.execute(
        `SELECT occurred_at_provenance FROM events WHERE id = '${result.eventId}'`,
      );
      const row = rows[0] as Record<string, unknown>;
      expect(row['occurred_at_provenance']).toBe('server');
    });
  });

  // ── Success path: first insert (compile=true) ─────────────────────────────

  describe('success path — first insert with compile=true', () => {
    it('inserts an event and creates a compile job', async () => {
      const req = makeRequest({ options: { compile: true, wait: false } });
      const result = await ingestOne({ db }, req, auth);

      expect(result.status).toBe('inserted');
      expect(result.eventId).toMatch(/^evt_/);
      expect(result.jobId).toBeTruthy();
      expect(result.jobId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );

      // Verify the job row exists
      const { rows: jobRows } = await db.execute(
        `SELECT id, kind, status, event_count, project_id, idempotency_key
         FROM jobs WHERE id = '${result.jobId}'`,
      );
      expect(jobRows).toHaveLength(1);
      const jobRow = jobRows[0] as Record<string, unknown>;
      expect(jobRow['kind']).toBe('ingest_event');
      expect(jobRow['status']).toBe('queued');
      expect(jobRow['event_count']).toBe(1);
      expect(jobRow['project_id']).toBe(projectId);
      expect(jobRow['idempotency_key']).toBe(`compile:${result.eventId}`);
    });

    it('does NOT create a job when compile=false', async () => {
      const req = makeRequest({ options: { compile: false, wait: false } });
      const result = await ingestOne({ db }, req, auth);

      expect(result.status).toBe('inserted');
      expect(result.jobId).toBeNull();

      // Verify no job rows for this event
      const { rows: jobRows } = await db.execute(
        `SELECT COUNT(*) as cnt FROM jobs WHERE project_id = '${projectId}'`,
      );
      expect(Number((jobRows[0] as Record<string, unknown>)['cnt'])).toBe(0);
    });
  });

  // ── Success path: duplicate replay ────────────────────────────────────────

  describe('success path — duplicate replay', () => {
    it('returns duplicate with same eventId when replayed with same payload', async () => {
      const req = makeRequest({ options: { compile: false, wait: false } });

      const first = await ingestOne({ db }, req, auth);
      expect(first.status).toBe('inserted');

      const second = await ingestOne({ db }, req, auth);
      expect(second.status).toBe('duplicate');
      expect(second.eventId).toBe(first.eventId);
      expect(second.jobId).toBeNull(); // compile=false on both

      // Verify only one event row exists
      const { rows } = await db.execute(
        `SELECT COUNT(*) as cnt FROM events WHERE id = '${first.eventId}'`,
      );
      expect(Number((rows[0] as Record<string, unknown>)['cnt'])).toBe(1);
    });

    it('duplicate with compile=true returns the original jobId', async () => {
      const req = makeRequest({ options: { compile: true, wait: false } });

      const first = await ingestOne({ db }, req, auth);
      expect(first.status).toBe('inserted');
      expect(first.jobId).toBeTruthy();

      // Replay the exact same request
      const second = await ingestOne({ db }, req, auth);
      expect(second.status).toBe('duplicate');
      expect(second.eventId).toBe(first.eventId);
      expect(second.jobId).toBe(first.jobId); // Original jobId preserved

      // Verify only ONE job was created (no duplicate job on replay)
      const { rows: jobRows } = await db.execute(
        `SELECT COUNT(*) as cnt FROM jobs WHERE project_id = '${projectId}'`,
      );
      expect(Number((jobRows[0] as Record<string, unknown>)['cnt'])).toBe(1);
    });

    it('replay with compile=false after original with compile=true returns original jobId', async () => {
      const reqWithCompile = makeRequest({ options: { compile: true, wait: false } });
      const first = await ingestOne({ db }, reqWithCompile, auth);
      expect(first.jobId).toBeTruthy();

      // Replay with compile=false — should still return the original jobId
      const reqNoCompile = { ...reqWithCompile, options: { compile: false, wait: false } };
      const second = await ingestOne({ db }, reqNoCompile, auth);
      expect(second.status).toBe('duplicate');
      expect(second.eventId).toBe(first.eventId);
      expect(second.jobId).toBe(first.jobId);
    });
  });

  // ── Failure path: idempotency conflict ────────────────────────────────────

  describe('failure path — idempotency conflict', () => {
    it('throws IngestOneError when same key has different payload', async () => {
      const key = `fixed-key-${randomUUID().replace(/-/g, '')}`;

      const req1 = makeRequest({
        idempotencyKey: key,
        payload: {
          schemaVersion: PAYLOAD_SCHEMA_VERSION,
          repo: 'test/repo',
          commitSha: 'abc123def4567890123456789abcdef123456789',
          path: 'docs/decisions/001-use-postgres.md',
          content: 'Original content',
        },
      });

      const first = await ingestOne({ db }, req1, auth);
      expect(first.status).toBe('inserted');

      // Same key, different payload content
      const req2 = makeRequest({
        idempotencyKey: key,
        payload: {
          schemaVersion: PAYLOAD_SCHEMA_VERSION,
          repo: 'test/repo',
          commitSha: 'abc123def4567890123456789abcdef123456789',
          path: 'docs/decisions/001-use-postgres.md',
          content: 'DIFFERENT content — should trigger conflict',
        },
      });

      await expect(ingestOne({ db }, req2, auth)).rejects.toThrow(IngestOneError);

      try {
        await ingestOne({ db }, req2, auth);
        expect.fail('expected IngestOneError');
      } catch (err) {
        expect(err).toBeInstanceOf(IngestOneError);
        expect((err as IngestOneError).code).toBe('idempotency_conflict');
      }
    });

    it('does not create a second event row on conflict', async () => {
      const key = `conflict-key-${randomUUID().replace(/-/g, '')}`;

      const req1 = makeRequest({
        idempotencyKey: key,
        payload: {
          schemaVersion: PAYLOAD_SCHEMA_VERSION,
          repo: 'test/repo',
          commitSha: 'abc123def4567890123456789abcdef123456789',
          path: 'docs/decisions/001-use-postgres.md',
          content: 'Content A',
        },
      });

      await ingestOne({ db }, req1, auth);

      const req2 = makeRequest({
        idempotencyKey: key,
        payload: {
          schemaVersion: PAYLOAD_SCHEMA_VERSION,
          repo: 'test/repo',
          commitSha: 'abc123def4567890123456789abcdef123456789',
          path: 'docs/decisions/001-use-postgres.md',
          content: 'Content B — different',
        },
      });

      try {
        await ingestOne({ db }, req2, auth);
        expect.fail('expected IngestOneError');
      } catch {
        // Expected
      }

      // Verify only one event row
      const { rows } = await db.execute(
        `SELECT COUNT(*) as cnt FROM events WHERE project_id = '${projectId}' AND delivery_id = '${key}'`,
      );
      expect(Number((rows[0] as Record<string, unknown>)['cnt'])).toBe(1);
    });
  });

  // ── Boundary: private-tag redaction ───────────────────────────────────────

  describe('boundary — private-tag redaction', () => {
    it('strips <private> tags from all string fields in payload', async () => {
      const payload = {
        schemaVersion: PAYLOAD_SCHEMA_VERSION,
        repo: '<private>secret-org/secret-repo</private>',
        commitSha: 'abc123def4567890123456789abcdef123456789',
        path: 'docs/decisions/001-use-postgres.md',
        content: 'Public part <private>secret credentials here</private> public tail',
      };

      const req = makeRequest({ payload });
      const result = await ingestOne({ db }, req, auth);

      const { rows } = await db.execute(
        `SELECT payload FROM events WHERE id = '${result.eventId}'`,
      );
      const stored = (rows[0] as Record<string, unknown>)['payload'] as Record<string, unknown>;
      expect(stored.repo).toBe(''); // Entire value was in <private> tags
      expect(stored.content).toBe('Public part  public tail');
      expect(JSON.stringify(stored)).not.toContain('secret-org');
      expect(JSON.stringify(stored)).not.toContain('secret credentials');
    });

    it('computes payload hash on REDACTED content, not original', async () => {
      const payload = {
        schemaVersion: PAYLOAD_SCHEMA_VERSION,
        repo: 'test/repo',
        commitSha: 'abc123def4567890123456789abcdef123456789',
        path: 'docs/decisions/001-use-postgres.md',
        content: 'Visible <private>invisible</private>',
      };

      const req = makeRequest({ payload });
      const result = await ingestOne({ db }, req, auth);

      const redacted = redactedContent(payload);
      const expectedHash = payloadHash(redacted);

      const { rows } = await db.execute(
        `SELECT payload_hash FROM events WHERE id = '${result.eventId}'`,
      );
      expect((rows[0] as Record<string, unknown>)['payload_hash']).toBe(expectedHash);
    });

    it('original content with private tags never reaches the database', async () => {
      const secret = `super-secret-token-${randomUUID()}`;
      const payload = {
        schemaVersion: PAYLOAD_SCHEMA_VERSION,
        repo: 'test/repo',
        commitSha: 'abc123def4567890123456789abcdef123456789',
        path: 'docs/decisions/001-use-postgres.md',
        content: `Before <private>${secret}</private> After`,
      };

      const req = makeRequest({ payload });
      const result = await ingestOne({ db }, req, auth);
      expect(result.status).toBe('inserted');

      // Query all events for this project — the secret must not appear anywhere
      const { rows } = await db.execute(
        `SELECT payload::text as p FROM events WHERE project_id = '${projectId}'`,
      );
      for (const row of rows) {
        expect((row as Record<string, unknown>)['p']).not.toContain(secret);
      }
    });
  });

  // ── Boundary: different projects ──────────────────────────────────────────

  describe('boundary — project isolation', () => {
    it('same idempotency key in different projects creates independent events', async () => {
      // Create a second project for the same team
      const project2 = `prj_ing1_2_${randomUUID().replace(/-/g, '')}`;
      await db.execute(
        `INSERT INTO projects (id, team_id, name) VALUES ('${project2}', '${teamId}', 'Second Project')`,
      );

      try {
        const key = `shared-key-${randomUUID().replace(/-/g, '')}`;
        const req1 = makeRequest({ idempotencyKey: key, projectId });
        const req2 = makeRequest({ idempotencyKey: key, projectId: project2 });

        const r1 = await ingestOne({ db }, req1, { ...auth, projectId });
        const r2 = await ingestOne({ db }, req2, { ...auth, projectId: project2 });

        expect(r1.status).toBe('inserted');
        expect(r2.status).toBe('inserted');
        expect(r1.eventId).not.toBe(r2.eventId);
      } finally {
        await db.execute(`DELETE FROM events WHERE project_id = '${project2}'`);
        await db.execute(`DELETE FROM jobs WHERE project_id = '${project2}'`);
        await db.execute(`DELETE FROM projects WHERE id = '${project2}'`);
      }
    });
  });

  // ── Boundary: cross-tenant isolation ──────────────────────────────────────

  describe('boundary — cross-tenant isolation', () => {
    it('rejects cross-tenant project reference', async () => {
      // projectId belongs to teamId, not team_other_ing1
      const req = makeRequest();
      const crossTenantAuth: IngestOneAuth = {
        teamId: 'team_other_ing1',
        projectId,
        credentialId,
        principalId: null,
      };

      await expect(ingestOne({ db }, req, crossTenantAuth)).rejects.toThrow();
    });
  });

  // ── Boundary: payload schema versioning ───────────────────────────────────

  describe('boundary — payload schema versioning', () => {
    it('stores the current PAYLOAD_SCHEMA_VERSION and EVENT_ENVELOPE_VERSION', async () => {
      const req = makeRequest();
      const result = await ingestOne({ db }, req, auth);

      const { rows } = await db.execute(
        `SELECT payload_schema_version, envelope_version
         FROM events WHERE id = '${result.eventId}'`,
      );
      const row = rows[0] as Record<string, unknown>;
      expect(row['payload_schema_version']).toBe(PAYLOAD_SCHEMA_VERSION);
      expect(row['envelope_version']).toBe(1);
    });
  });

  // ── Boundary: source fields preserved ─────────────────────────────────────

  describe('boundary — source fields', () => {
    it('preserves source.externalId and optional source.url', async () => {
      const req = makeRequest({
        source: {
          kind: 'cli_init',
          externalId: 'my-org/my-repo',
          url: 'https://github.com/my-org/my-repo/blob/main/README.md',
        },
      });

      const result = await ingestOne({ db }, req, auth);
      const { rows } = await db.execute(
        `SELECT external_id, url FROM events WHERE id = '${result.eventId}'`,
      );
      const row = rows[0] as Record<string, unknown>;
      expect(row['external_id']).toBe('my-org/my-repo');
      expect(row['url']).toBe('https://github.com/my-org/my-repo/blob/main/README.md');
    });
  });
});
