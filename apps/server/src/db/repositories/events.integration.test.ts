/**
 * Idempotent Event Repository — real-Postgres integration tests (DUA-177).
 *
 * Runs only when TEST_DATABASE_URL points at a Postgres with migrations
 * 0000+0001 applied; honestly skipped otherwise — no mocked database, per
 * project red line.
 *
 *   POSTGRES_PASSWORD=x docker compose up -d postgres
 *   psql < apps/server/drizzle/0000_*.sql
 *   psql < apps/server/drizzle/0001_*.sql
 *   TEST_DATABASE_URL=postgres://teamem:x@localhost:5432/teamem pnpm test
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type AppDb } from '../client.js';
import {
  connectDatabase,
  closeDatabase,
  type Pool,
} from '../../test/database.js';
import {
  insertEvent,
  IdempotencyConflictError,
  type EventInsertRequest,
} from './events.js';
import { payloadHash } from '../../security/payload-hash.js';

// ── Setup ───────────────────────────────────────────────────────────────────

const url = process.env['TEST_DATABASE_URL'];

describe.skipIf(!url)('events repository (live Postgres)', () => {
  let pool: Pool;
  let db: AppDb;

  // Stable team and project identifiers for all tests in this suite.
  const teamId = `team_evt_${randomUUID().replace(/-/g, '')}`;
  const projectId = `prj_evt_${randomUUID().replace(/-/g, '')}`;

  beforeAll(async () => {
    ({ pool } = connectDatabase());
    db = createDb(url!, { pool: pool as unknown as import('pg').Pool });

    // Seed: team and project
    await db.execute(
      `INSERT INTO teams (id, name) VALUES ('${teamId}', 'Events Test Team') ON CONFLICT (id) DO NOTHING`,
    );
    await db.execute(
      `INSERT INTO projects (id, team_id, name) VALUES ('${projectId}', '${teamId}', 'Events Test Project') ON CONFLICT (id) DO NOTHING`,
    );

    // Seed: a second team for cross-tenant isolation tests
    await db.execute(
      `INSERT INTO teams (id, name) VALUES ('team_other_evt', 'Other Team') ON CONFLICT (id) DO NOTHING`,
    );
    await db.execute(
      `INSERT INTO projects (id, team_id, name) VALUES ('prj_other_evt', 'team_other_evt', 'Other Project') ON CONFLICT (id) DO NOTHING`,
    );
  });

  afterAll(async () => {
    // Clean up in dependency order
    await db.execute(`DELETE FROM events WHERE team_id = '${teamId}'`);
    await db.execute(`DELETE FROM events WHERE team_id = 'team_other_evt'`);
    await db.execute(`DELETE FROM projects WHERE id = '${projectId}'`);
    await db.execute(`DELETE FROM projects WHERE id = 'prj_other_evt'`);
    await db.execute(`DELETE FROM teams WHERE id = '${teamId}'`);
    await db.execute(`DELETE FROM teams WHERE id = 'team_other_evt'`);
    await closeDatabase(pool);
  });

  beforeEach(async () => {
    // Clean events for this team before each test
    await db.execute(`DELETE FROM events WHERE team_id = '${teamId}'`);
  });

  // ── Helper: build a minimal valid insert request ──────────────────────────

  const payloadA = { text: 'we decided to use Postgres' };
  const payloadB = { text: 'we decided to use MySQL' };

  const baseRequest = (
    overrides: Partial<EventInsertRequest> = {},
  ): EventInsertRequest => ({
    teamId,
    projectId,
    channel: 'cli',
    kind: 'cli_init',
    connectorKind: 'cli',
    deliveryId: 'del_001',
    itemKey: 'root',
    externalId: 'test/repo#1',
    actor: {
      kind: 'human',
      provider: 'github',
      providerUserId: '12345',
      displayLogin: 'testuser',
    },
    actorProvenance: 'client_claimed',
    actorPrincipalId: null,
    occurredAt: new Date('2026-07-17T00:00:00.000Z'),
    occurredAtProvenance: 'client',
    ingestedByCredentialId: null,
    ingestedByPrincipalId: null,
    payload: payloadA,
    payloadHash: payloadHash(payloadA),
    payloadBytes: Buffer.byteLength(JSON.stringify(payloadA), 'utf8'),
    payloadSchemaVersion: 1,
    envelopeVersion: 1,
    ...overrides,
  });

  // ── Success path: insert ──────────────────────────────────────────────────

  describe('success path — insert', () => {
    it('inserts a new event and returns inserted status', async () => {
      const result = await insertEvent(db, baseRequest());

      expect(result.status).toBe('inserted');
      expect(result.eventId).toMatch(/^evt_[A-Za-z0-9]+$/);

      // Verify the row actually exists in the database
      const { rows } = await db.execute(
        `SELECT id, team_id, project_id, channel, kind, connector_kind,
                delivery_id, item_key, external_id, url,
                actor, actor_provenance, actor_principal_id,
                occurred_at, occurred_at_provenance,
                ingested_by_credential_id, ingested_by_principal_id,
                payload, payload_bytes, payload_hash,
                payload_schema_version, envelope_version
         FROM events WHERE id = '${result.eventId}'`,
      );
      expect(rows).toHaveLength(1);
      const row = rows[0] as Record<string, unknown>;
      expect(row['team_id']).toBe(teamId);
      expect(row['project_id']).toBe(projectId);
      expect(row['channel']).toBe('cli');
      expect(row['kind']).toBe('cli_init');
      expect(row['connector_kind']).toBe('cli');
      expect(row['delivery_id']).toBe('del_001');
      expect(row['item_key']).toBe('root');
      expect(row['external_id']).toBe('test/repo#1');
      expect(row['actor_provenance']).toBe('client_claimed');
      expect(row['occurred_at_provenance']).toBe('client');
      expect(row['payload']).toEqual(payloadA);
      expect(row['payload_hash']).toBe(payloadHash(payloadA));
      expect(row['payload_bytes']).toBeTypeOf('number');
    });

    it('stores the full redacted payload verbatim', async () => {
      const payload = { key: 'value', nested: { arr: [1, 2, 3] } };
      const req = baseRequest({
        payload,
        payloadHash: payloadHash(payload),
        payloadBytes: Buffer.byteLength(JSON.stringify(payload), 'utf8'),
      });

      const result = await insertEvent(db, req);
      expect(result.status).toBe('inserted');

      const { rows } = await db.execute(
        `SELECT payload FROM events WHERE id = '${result.eventId}'`,
      );
      expect(rows[0]).toBeDefined();
      const stored = (rows[0] as Record<string, unknown>)['payload'];
      expect(stored).toEqual(payload);
    });

    it('generates unique event IDs for different insertions', async () => {
      const r1 = await insertEvent(
        db,
        baseRequest({ deliveryId: 'del_r1' }),
      );
      const r2 = await insertEvent(
        db,
        baseRequest({ deliveryId: 'del_r2' }),
      );

      expect(r1.status).toBe('inserted');
      expect(r2.status).toBe('inserted');
      expect(r1.eventId).not.toBe(r2.eventId);
    });

    it('preserves actor claim and both provenance values', async () => {
      const actor = {
        kind: 'service',
        provider: 'github',
        providerUserId: 'bot-42',
        displayLogin: 'mybot',
      };
      const req = baseRequest({
        deliveryId: 'del_prov',
        actor,
        actorProvenance: 'webhook_verified',
        actorPrincipalId: null,
        occurredAt: new Date('2026-06-01T12:00:00.000Z'),
        occurredAtProvenance: 'provider',
        ingestedByCredentialId: 'key_abc',
        ingestedByPrincipalId: null,
      });

      const result = await insertEvent(db, req);
      const { rows } = await db.execute(
        `SELECT actor, actor_provenance, occurred_at_provenance,
                ingested_by_credential_id, ingested_by_principal_id
         FROM events WHERE id = '${result.eventId}'`,
      );
      const row = rows[0] as Record<string, unknown>;
      expect(row['actor']).toEqual(actor);
      expect(row['actor_provenance']).toBe('webhook_verified');
      expect(row['occurred_at_provenance']).toBe('provider');
      expect(row['ingested_by_credential_id']).toBe('key_abc');
    });

    it('stores all source facts including optional URL', async () => {
      const req = baseRequest({
        deliveryId: 'del_src',
        sourceEvent: 'push',
        sourceAction: 'created',
        url: 'https://github.com/test/repo/pull/1',
      });

      const result = await insertEvent(db, req);
      const { rows } = await db.execute(
        `SELECT source_event, source_action, url
         FROM events WHERE id = '${result.eventId}'`,
      );
      const r0 = rows[0] as Record<string, unknown>;
      expect(r0['source_event']).toBe('push');
      expect(r0['source_action']).toBe('created');
      expect(r0['url']).toBe('https://github.com/test/repo/pull/1');
    });
  });

  // ── Success path: duplicate (same identity + same hash) ───────────────────

  describe('success path — duplicate', () => {
    it('returns duplicate when same identity and hash are replayed', async () => {
      const req = baseRequest();

      const first = await insertEvent(db, req);
      expect(first.status).toBe('inserted');

      const second = await insertEvent(db, req);
      expect(second.status).toBe('duplicate');
      expect(second.eventId).toBe(first.eventId);

      // Verify only one row exists
      const { rows: countRows } = await db.execute(
        `SELECT COUNT(*) as cnt FROM events
         WHERE team_id = '${teamId}'
           AND project_id = '${projectId}'
           AND delivery_id = 'del_001'`,
      );
      expect(Number((countRows[0] as Record<string, unknown>)['cnt'])).toBe(1);
    });

    it('returns duplicate across different payload object references with same content', async () => {
      const payload1 = { text: 'hello', num: 42, flag: true, arr: [1, 2] };
      // Same content, different object identity, different key order
      const payload2 = { flag: true, num: 42, text: 'hello', arr: [1, 2] };

      const req1 = baseRequest({
        deliveryId: 'del_ref',
        payload: payload1,
        payloadHash: payloadHash(payload1),
        payloadBytes: Buffer.byteLength(JSON.stringify(payload1), 'utf8'),
      });

      const req2 = baseRequest({
        deliveryId: 'del_ref',
        payload: payload2,
        payloadHash: payloadHash(payload2),
        payloadBytes: Buffer.byteLength(JSON.stringify(payload2), 'utf8'),
      });

      const first = await insertEvent(db, req1);
      expect(first.status).toBe('inserted');

      // req1.hash and req2.hash must be the same (canonical JSON normalizes key order)
      expect(req1.payloadHash).toBe(req2.payloadHash);

      const second = await insertEvent(db, req2);
      expect(second.status).toBe('duplicate');
      expect(second.eventId).toBe(first.eventId);
    });
  });

  // ── Failure path: idempotency conflict ────────────────────────────────────

  describe('failure path — idempotency conflict', () => {
    it('throws IdempotencyConflictError when same identity has different hash', async () => {
      const req1 = baseRequest({ payload: payloadA, payloadHash: payloadHash(payloadA) });
      const req2 = baseRequest({ payload: payloadB, payloadHash: payloadHash(payloadB) });

      const first = await insertEvent(db, req1);
      expect(first.status).toBe('inserted');

      await expect(insertEvent(db, req2)).rejects.toThrow(IdempotencyConflictError);
    });

    it('does not create a second row on conflict', async () => {
      const req1 = baseRequest({ payload: payloadA, payloadHash: payloadHash(payloadA) });
      const req2 = baseRequest({ payload: payloadB, payloadHash: payloadHash(payloadB) });

      await insertEvent(db, req1);

      try {
        await insertEvent(db, req2);
        expect.fail('expected IdempotencyConflictError');
      } catch (err) {
        expect(err).toBeInstanceOf(IdempotencyConflictError);
      }

      // Verify only one row exists
      const { rows: countRows } = await db.execute(
        `SELECT COUNT(*) as cnt FROM events
         WHERE team_id = '${teamId}' AND delivery_id = 'del_001'`,
      );
      expect(Number((countRows[0] as Record<string, unknown>)['cnt'])).toBe(1);
    });
  });

  // ── Tenancy and scope enforcement ─────────────────────────────────────────

  describe('scope enforcement', () => {
    it('rejects cross-tenant project reference (team_b + project_a)', async () => {
      const badReq = baseRequest({
        teamId: 'team_other_evt',
        projectId, // belongs to teamId, not team_other_evt
      });

      await expect(insertEvent(db, badReq)).rejects.toThrow();
    });

    it('requires correct team_id to match project_id', async () => {
      const badReq = baseRequest({
        teamId: 'nonexistent_team',
        projectId,
      });

      await expect(insertEvent(db, badReq)).rejects.toThrow();
    });

    it('stores events with explicit team_id', async () => {
      const req = baseRequest();
      const result = await insertEvent(db, req);

      const { rows } = await db.execute(
        `SELECT team_id FROM events WHERE id = '${result.eventId}'`,
      );
      expect((rows[0] as Record<string, unknown>)['team_id']).toBe(teamId);
    });
  });

  // ── Boundary: idempotency identity components ─────────────────────────────

  describe('boundary — idempotency identity', () => {
    it('different deliveryId → independent events (both insert)', async () => {
      const r1 = await insertEvent(db, baseRequest({ deliveryId: 'del_a' }));
      const r2 = await insertEvent(db, baseRequest({ deliveryId: 'del_b' }));

      expect(r1.status).toBe('inserted');
      expect(r2.status).toBe('inserted');
      expect(r1.eventId).not.toBe(r2.eventId);

      const { rows: countRows } = await db.execute(
        `SELECT COUNT(*) as cnt FROM events WHERE team_id = '${teamId}'`,
      );
      expect(Number((countRows[0] as Record<string, unknown>)['cnt'])).toBe(2);
    });

    it('different itemKey → independent events', async () => {
      const r1 = await insertEvent(db, baseRequest({ itemKey: 'commit_a' }));
      const r2 = await insertEvent(db, baseRequest({ itemKey: 'commit_b' }));

      expect(r1.status).toBe('inserted');
      expect(r2.status).toBe('inserted');
      expect(r1.eventId).not.toBe(r2.eventId);
    });

    it('different connectorKind → independent events', async () => {
      const r1 = await insertEvent(db, baseRequest({ connectorKind: 'cli' }));
      const r2 = await insertEvent(
        db,
        baseRequest({
          channel: 'external',
          kind: 'external_event',
          connectorKind: 'slack',
        }),
      );

      expect(r1.status).toBe('inserted');
      expect(r2.status).toBe('inserted');
    });

    it('same identity in different projects → independent events', async () => {
      // Create a second project for the same team
      const project2 = `prj_evt_2_${randomUUID().replace(/-/g, '')}`;
      await db.execute(
        `INSERT INTO projects (id, team_id, name) VALUES ('${project2}', '${teamId}', 'Second Project')`,
      );

      try {
        const r1 = await insertEvent(db, baseRequest());
        expect(r1.status).toBe('inserted');

        const r2 = await insertEvent(
          db,
          baseRequest({ projectId: project2 }),
        );
        expect(r2.status).toBe('inserted');
        expect(r1.eventId).not.toBe(r2.eventId);
      } finally {
        await db.execute(`DELETE FROM events WHERE project_id = '${project2}'`);
        await db.execute(`DELETE FROM projects WHERE id = '${project2}'`);
      }
    });
  });

  // ── Boundary: optional fields ─────────────────────────────────────────────

  describe('boundary — optional fields', () => {
    it('handles null actor (unknown subject)', async () => {
      const req = baseRequest({
        deliveryId: 'del_null_actor',
        actor: null,
        actorProvenance: 'unknown',
        actorPrincipalId: null,
      });

      const result = await insertEvent(db, req);
      expect(result.status).toBe('inserted');

      const { rows } = await db.execute(
        `SELECT actor, actor_provenance FROM events WHERE id = '${result.eventId}'`,
      );
      const row = rows[0] as Record<string, unknown>;
      expect(row['actor']).toBeNull();
      expect(row['actor_provenance']).toBe('unknown');
    });

    it('handles missing optional source fields', async () => {
      const req = baseRequest({
        deliveryId: 'del_opt',
        sourceEvent: null,
        sourceAction: null,
        url: null,
        ingestedByCredentialId: null,
        ingestedByPrincipalId: null,
      });

      const result = await insertEvent(db, req);
      const { rows } = await db.execute(
        `SELECT source_event, source_action, url,
                ingested_by_credential_id, ingested_by_principal_id
         FROM events WHERE id = '${result.eventId}'`,
      );
      const row = rows[0] as Record<string, unknown>;
      expect(row['source_event']).toBeNull();
      expect(row['source_action']).toBeNull();
      expect(row['url']).toBeNull();
      expect(row['ingested_by_credential_id']).toBeNull();
      expect(row['ingested_by_principal_id']).toBeNull();
    });
  });

  // ── Boundary: different payload schemas ───────────────────────────────────

  describe('boundary — payload schema versioning', () => {
    it('stores payload_schema_version and envelope_version independently', async () => {
      const req = baseRequest({
        deliveryId: 'del_ver',
        payloadSchemaVersion: 3,
        envelopeVersion: 2,
      });

      const result = await insertEvent(db, req);
      const { rows } = await db.execute(
        `SELECT payload_schema_version, envelope_version
         FROM events WHERE id = '${result.eventId}'`,
      );
      const row = rows[0] as Record<string, unknown>;
      expect(row['payload_schema_version']).toBe(3);
      expect(row['envelope_version']).toBe(2);
    });
  });
});
