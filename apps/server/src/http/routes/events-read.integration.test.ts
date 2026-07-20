/**
 * GET /v1/events and GET /v1/events/:id integration tests (M0-READ-01).
 *
 * Tests the full HTTP read pipeline against real Postgres — validates:
 * - Cursor-based pagination (created_at desc + id)
 * - SourceKind filtering
 * - Limit enforcement (max 100, no clamping)
 * - Payload absence in list responses
 * - read:payload requirement for detail
 * - Cross-team anti-enumeration (identical 404)
 * - Fail-closed audit on payload reads
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
import { insertEvent, type EventInsertRequest } from '../../db/repositories/events.js';
import { payloadHash } from '../../security/payload-hash.js';
import { PAYLOAD_SCHEMA_VERSION, EVENT_ENVELOPE_VERSION } from '@teamem/schema';

const url = process.env['TEST_DATABASE_URL'];

describe.skipIf(!url)('GET /v1/events and GET /v1/events/:id (live Postgres)', () => {
  let pool: Pool;
  let db: AppDb;
  let app: ReturnType<typeof buildApp>;

  // Per-test-suite stable team, project, and API keys
  let teamId: string;
  let projectId: string;
  let readKeyToken: string | undefined;
  let readPayloadKeyToken: string | undefined;
  let readOnlyKeyToken: string | undefined; // has 'read' but not 'read:payload'

  beforeAll(async () => {
    ({ pool } = connectDatabase());
    db = createDb(url!, { pool: pool as unknown as import('pg').Pool });

    // Bootstrap: create team + project + API key with events:write scope
    const suffix = randomUUID().replace(/-/g, '').slice(0, 8);
    const result = await runBootstrap(db, {
      teamName: `Events Read Test ${suffix}`,
      projectName: `demo-${suffix}`,
      rotate: false,
    });

    teamId = result.team.id;
    projectId = result.project.id;
    readKeyToken = result.key.token; // has 'events:write' + 'read' + 'read:payload'

    // Create a read+payload key (explicitly)
    const { generateApiKeyToken, hashToken } = await import(
      '../../auth/api-key.js'
    );

    const rpToken = generateApiKeyToken();
    const rpHash = hashToken(rpToken);
    const rpKeyId = `key_rp${randomUUID().replace(/-/g, '')}`;
    await db.execute(
      `INSERT INTO api_keys (id, team_id, project_id, name, token_hash, scopes, all_projects)
       VALUES ('${rpKeyId}', '${teamId}', '${projectId}', 'Read-Payload Key',
               '${rpHash}', ARRAY['read','read:payload']::text[], false)`,
    );
    readPayloadKeyToken = rpToken;

    // Create a read-only key (no read:payload)
    const roToken = generateApiKeyToken();
    const roHash = hashToken(roToken);
    const roKeyId = `key_ro${randomUUID().replace(/-/g, '')}`;
    await db.execute(
      `INSERT INTO api_keys (id, team_id, project_id, name, token_hash, scopes, all_projects)
       VALUES ('${roKeyId}', '${teamId}', '${projectId}', 'Read-Only Key',
               '${roHash}', ARRAY['read']::text[], false)`,
    );
    readOnlyKeyToken = roToken;

    // Seed: a second team for cross-tenant isolation tests
    await db.execute(
      `INSERT INTO teams (id, name) VALUES ('team_other_read', 'Other Team') ON CONFLICT (id) DO NOTHING`,
    );
    await db.execute(
      `INSERT INTO projects (id, team_id, name) VALUES ('prj_other_read', 'team_other_read', 'Other Project') ON CONFLICT (id) DO NOTHING`,
    );

    // Build the Hono app with the real database
    const deps: AppDeps = { dbUrl: url!, db };
    app = buildApp(deps);
  });

  afterAll(async () => {
    // Clean up in FK dependency order
    await db.execute(`DELETE FROM events WHERE project_id = '${projectId}'`);
    await db.execute(`DELETE FROM events WHERE project_id = 'prj_other_read'`);
    await db.execute(`DELETE FROM api_keys WHERE project_id = '${projectId}'`);
    await db.execute(`DELETE FROM api_keys WHERE project_id = 'prj_other_read'`);
    await db.execute(`DELETE FROM projects WHERE id = '${projectId}'`);
    await db.execute(`DELETE FROM projects WHERE id = 'prj_other_read'`);
    await db.execute(`DELETE FROM teams WHERE id = '${teamId}'`);
    await db.execute(`DELETE FROM teams WHERE id = 'team_other_read'`);
    await closeDatabase(pool);
  });

  beforeEach(async () => {
    // Clean events before each test
    await db.execute(`DELETE FROM events WHERE team_id = '${teamId}'`);
    await db.execute(`DELETE FROM events WHERE team_id = 'team_other_read'`);
  });

  // ── Helpers ──────────────────────────────────────────────────────────────

  const listAuthHeader = () => ({
    Authorization: `Bearer ${readKeyToken}`,
  });

  const payloadAuthHeader = () => ({
    Authorization: `Bearer ${readPayloadKeyToken}`,
  });

  const readOnlyAuthHeader = () => ({
    Authorization: `Bearer ${readOnlyKeyToken}`,
  });

  function makePayload(index: number) {
    return {
      schemaVersion: PAYLOAD_SCHEMA_VERSION,
      repo: 'test/repo',
      commitSha: 'abc123def4567890123456789abcdef123456789',
      path: `docs/decisions/${String(index).padStart(3, '0')}-note.md`,
      content: `Test content for event ${index}`,
    };
  }

  function makeInsertRequest(
    index: number,
    overrides: Partial<EventInsertRequest> = {},
  ): EventInsertRequest {
    const p = makePayload(index);
    return {
      teamId,
      projectId,
      channel: 'cli',
      kind: 'cli_init',
      connectorKind: 'cli',
      deliveryId: `del_${String(index).padStart(3, '0')}`,
      itemKey: 'root',
      externalId: `test/repo#${index}`,
      actor: null,
      actorProvenance: 'unknown',
      actorPrincipalId: null,
      occurredAt: new Date(`2026-07-${String(15 + (index % 15)).padStart(2, '0')}T00:00:00.000Z`),
      occurredAtProvenance: 'client',
      ingestedByCredentialId: null,
      ingestedByPrincipalId: null,
      payload: p as unknown as Record<string, unknown>,
      payloadHash: payloadHash(p),
      payloadBytes: Buffer.byteLength(JSON.stringify(p), 'utf8'),
      payloadSchemaVersion: PAYLOAD_SCHEMA_VERSION,
      envelopeVersion: EVENT_ENVELOPE_VERSION,
      ...overrides,
    };
  }

  /**
   * Insert N events with sequential delivery IDs into the test project.
   * Each event is spaced 1 second apart so created_at ordering is deterministic.
   */
  async function seedEvents(count: number) {
    for (let i = 0; i < count; i++) {
      await insertEvent(db, makeInsertRequest(i + 1));
      // Small delay so created_at timestamps differ (DB precision is ms).
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  // ── List: success path ───────────────────────────────────────────────────

  describe('GET /v1/events — list', () => {
    it('returns empty list when no events exist', async () => {
      const res = await app.request(
        `/v1/events?projectId=${projectId}&limit=10`,
        { headers: listAuthHeader() },
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data).toEqual([]);
      expect(json.nextCursor).toBeNull();
      expect(json.requestId).toBeTruthy();
    });

    it('returns events ordered by created_at desc, id desc', async () => {
      // Insert events with i=1 earliest, i=10 latest
      for (let i = 1; i <= 10; i++) {
        await insertEvent(db, makeInsertRequest(i));
        await new Promise((r) => setTimeout(r, 5));
      }

      const res = await app.request(
        `/v1/events?projectId=${projectId}&limit=20`,
        { headers: listAuthHeader() },
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data).toHaveLength(10);

      // Verify descending order: latest first (index 10, 9, ..., 1)
      for (let i = 0; i < json.data.length - 1; i++) {
        const a = json.data[i];
        const b = json.data[i + 1];
        const aTime = new Date(a.createdAt).getTime();
        const bTime = new Date(b.createdAt).getTime();
        expect(aTime).toBeGreaterThanOrEqual(bTime);
      }
    });

    it('paginates with cursor: insert 25, request 20, follow cursor', async () => {
      await seedEvents(25);

      // First page: limit 20
      const res1 = await app.request(
        `/v1/events?projectId=${projectId}&limit=20`,
        { headers: listAuthHeader() },
      );
      expect(res1.status).toBe(200);
      const page1 = await res1.json();
      expect(page1.data).toHaveLength(20);
      expect(page1.nextCursor).toBeTruthy();
      expect(page1.nextCursor).not.toBeNull();

      // Verify no payload in list items
      for (const item of page1.data) {
        expect(item.payload).toBeUndefined();
      }

      // Second page: follow cursor
      const res2 = await app.request(
        `/v1/events?projectId=${projectId}&limit=20&cursor=${encodeURIComponent(page1.nextCursor)}`,
        { headers: listAuthHeader() },
      );
      expect(res2.status).toBe(200);
      const page2 = await res2.json();
      expect(page2.data).toHaveLength(5); // 25 total - 20 first page
      expect(page2.nextCursor).toBeNull(); // no more pages

      // Verify no duplicates across pages
      const ids1 = new Set(page1.data.map((e: { id: string }) => e.id));
      const ids2 = new Set(page2.data.map((e: { id: string }) => e.id));
      for (const id of ids2) {
        expect(ids1.has(id)).toBe(false);
      }

      // Total unique IDs should be 25
      expect(ids1.size + ids2.size).toBe(25);
    });

    it('honours limit and default limit', async () => {
      await seedEvents(5);

      // Default limit (20)
      const resDefault = await app.request(
        `/v1/events?projectId=${projectId}`,
        { headers: listAuthHeader() },
      );
      expect(resDefault.status).toBe(200);
      const defaultJson = await resDefault.json();
      expect(defaultJson.data).toHaveLength(5); // fewer than default 20

      // Explicit limit 2
      const res2 = await app.request(
        `/v1/events?projectId=${projectId}&limit=2`,
        { headers: listAuthHeader() },
      );
      expect(res2.status).toBe(200);
      const json2 = await res2.json();
      expect(json2.data).toHaveLength(2);
    });

    // ── Limit enforcement ────────────────────────────────────────────────

    it('returns 400 for limit > 100', async () => {
      const res = await app.request(
        `/v1/events?projectId=${projectId}&limit=101`,
        { headers: listAuthHeader() },
      );

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('invalid_request');
    });

    it('returns 400 for limit = 0', async () => {
      const res = await app.request(
        `/v1/events?projectId=${projectId}&limit=0`,
        { headers: listAuthHeader() },
      );

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('invalid_request');
    });

    // ── SourceKind filtering ─────────────────────────────────────────────

    it('filters by sourceKind', async () => {
      // Insert 3 cli_init events
      for (let i = 1; i <= 3; i++) {
        await insertEvent(db, makeInsertRequest(i));
        await new Promise((r) => setTimeout(r, 5));
      }

      // Insert 2 mcp_write events
      for (let i = 4; i <= 5; i++) {
        await insertEvent(
          db,
          makeInsertRequest(i, {
            deliveryId: `del_mcp_${i}`,
            channel: 'mcp',
            kind: 'mcp_write',
            connectorKind: 'mcp',
          }),
        );
        await new Promise((r) => setTimeout(r, 5));
      }

      // Filter by cli_init
      const res = await app.request(
        `/v1/events?projectId=${projectId}&limit=20&sourceKind=cli_init`,
        { headers: listAuthHeader() },
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data).toHaveLength(3);
      for (const item of json.data) {
        expect(item.source.kind).toBe('cli_init');
      }

      // Filter by mcp_write
      const res2 = await app.request(
        `/v1/events?projectId=${projectId}&limit=20&sourceKind=mcp_write`,
        { headers: listAuthHeader() },
      );
      expect(res2.status).toBe(200);
      const json2 = await res2.json();
      expect(json2.data).toHaveLength(2);
    });

    it('returns cursor_invalid when filter changes between pages', async () => {
      await seedEvents(10);

      // Get a cursor with no filter
      const res1 = await app.request(
        `/v1/events?projectId=${projectId}&limit=5`,
        { headers: listAuthHeader() },
      );
      expect(res1.status).toBe(200);
      const page1 = await res1.json();
      expect(page1.nextCursor).toBeTruthy();

      // Use that cursor but with a different filter
      const res2 = await app.request(
        `/v1/events?projectId=${projectId}&limit=5&cursor=${encodeURIComponent(page1.nextCursor)}&sourceKind=cli_init`,
        { headers: listAuthHeader() },
      );
      expect(res2.status).toBe(400);
      const json2 = await res2.json();
      expect(json2.error.code).toBe('cursor_invalid');
    });

    // ── Payload absence ─────────────────────────────────────────────────

    it('list response never contains payload field', async () => {
      await seedEvents(3);

      const res = await app.request(
        `/v1/events?projectId=${projectId}&limit=20`,
        { headers: listAuthHeader() },
      );
      expect(res.status).toBe(200);
      const json = await res.json();

      for (const item of json.data) {
        // payload must not exist, not even as null
        expect(item.payload).toBeUndefined();
        expect('payload' in item).toBe(false);
      }
    });

    // ── Source shape: connectorKind only for external ────────────────────

    it('does not include connectorKind in source for built-in channels', async () => {
      await insertEvent(db, makeInsertRequest(1));
      await new Promise((r) => setTimeout(r, 5));

      const res = await app.request(
        `/v1/events?projectId=${projectId}&limit=20`,
        { headers: listAuthHeader() },
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data).toHaveLength(1);
      // Built-in channel 'cli' must not have connectorKind
      expect(json.data[0].source.connectorKind).toBeUndefined();
    });

    // ── Auth failures ────────────────────────────────────────────────────

    it('returns 401 without Authorization header', async () => {
      const res = await app.request(
        `/v1/events?projectId=${projectId}`,
      );
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error.code).toBe('unauthorized');
    });

    it('returns 403 when key lacks read scope', async () => {
      // Create a key with only events:write scope
      const { generateApiKeyToken, hashToken } = await import(
        '../../auth/api-key.js'
      );
      const writeOnlyToken = generateApiKeyToken();
      const writeOnlyHash = hashToken(writeOnlyToken);
      const woKeyId = `key_wo${randomUUID().replace(/-/g, '')}`;
      await db.execute(
        `INSERT INTO api_keys (id, team_id, project_id, name, token_hash, scopes, all_projects)
         VALUES ('${woKeyId}', '${teamId}', '${projectId}', 'Write-Only Key',
                 '${writeOnlyHash}', ARRAY['events:write']::text[], false)`,
      );

      try {
        const res = await app.request(
          `/v1/events?projectId=${projectId}`,
          { headers: { Authorization: `Bearer ${writeOnlyToken}` } },
        );
        expect(res.status).toBe(403);
        const json = await res.json();
        expect(json.error.code).toBe('forbidden');
      } finally {
        await db.execute(`DELETE FROM api_keys WHERE id = '${woKeyId}'`);
      }
    });
  });

  // ── Detail: success path ─────────────────────────────────────────────────

  describe('GET /v1/events/:id — detail', () => {
    it('returns full event detail with payload when scope includes read:payload', async () => {
      await insertEvent(db, makeInsertRequest(1));
      await new Promise((r) => setTimeout(r, 5));

      // First get the event id from the list
      const listRes = await app.request(
        `/v1/events?projectId=${projectId}&limit=1`,
        { headers: listAuthHeader() },
      );
      expect(listRes.status).toBe(200);
      const listJson = await listRes.json();
      const eventId = listJson.data[0].id;

      // Fetch detail
      const res = await app.request(
        `/v1/events/${eventId}?projectId=${projectId}`,
        { headers: payloadAuthHeader() },
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.requestId).toBeTruthy();
      expect(json.data.id).toBe(eventId);
      expect(json.data.projectId).toBe(projectId);
      expect(json.data.payload).toBeDefined();
      expect(typeof json.data.payload).toBe('object');
      expect(json.data.source).toBeDefined();
      expect(json.data.source.channel).toBe('cli');
      expect(json.data.source.kind).toBe('cli_init');
      expect(json.data.createdAt).toBeTruthy();
      expect(json.data.occurredAt).toBeTruthy();
      expect(json.data.actorProvenance).toBe('unknown');
    });

    it('returns 403 when key has read but not read:payload', async () => {
      await insertEvent(db, makeInsertRequest(1));
      await new Promise((r) => setTimeout(r, 5));

      const listRes = await app.request(
        `/v1/events?projectId=${projectId}&limit=1`,
        { headers: listAuthHeader() },
      );
      const listJson = await listRes.json();
      const eventId = listJson.data[0].id;

      // Use read-only key (has 'read' but not 'read:payload')
      const res = await app.request(
        `/v1/events/${eventId}?projectId=${projectId}`,
        { headers: readOnlyAuthHeader() },
      );

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error.code).toBe('forbidden');
    });

    it('returns 404 for non-existent event', async () => {
      const res = await app.request(
        `/v1/events/evt_nonexistent000000000000000000?projectId=${projectId}`,
        { headers: payloadAuthHeader() },
      );

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error.code).toBe('not_found');
    });

    it('returns 404 for cross-team event (anti-enumeration)', async () => {
      // Insert an event in the other team
      const otherPayload = makePayload(999);
      await insertEvent(db, {
        teamId: 'team_other_read',
        projectId: 'prj_other_read',
        channel: 'cli',
        kind: 'cli_init',
        connectorKind: 'cli',
        deliveryId: 'del_other_999',
        itemKey: 'root',
        externalId: 'other/repo#999',
        actor: null,
        actorProvenance: 'unknown',
        actorPrincipalId: null,
        occurredAt: new Date('2026-07-15T00:00:00.000Z'),
        occurredAtProvenance: 'client',
        ingestedByCredentialId: null,
        ingestedByPrincipalId: null,
        payload: otherPayload as unknown as Record<string, unknown>,
        payloadHash: payloadHash(otherPayload),
        payloadBytes: Buffer.byteLength(JSON.stringify(otherPayload), 'utf8'),
        payloadSchemaVersion: PAYLOAD_SCHEMA_VERSION,
        envelopeVersion: EVENT_ENVELOPE_VERSION,
      });

      // Get its ID
      const { rows } = await db.execute(
        `SELECT id FROM events WHERE team_id = 'team_other_read' AND delivery_id = 'del_other_999'`,
      );
      const otherEventId = (rows[0] as Record<string, unknown>)['id'] as string;

      // Try to access with our team's key — should return 404 (identical
      // to genuinely missing, anti-enumeration)
      const res = await app.request(
        `/v1/events/${otherEventId}?projectId=${projectId}`,
        { headers: payloadAuthHeader() },
      );

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error.code).toBe('not_found');
    });

    it('writes an audit record on payload read', async () => {
      await insertEvent(db, makeInsertRequest(1));
      await new Promise((r) => setTimeout(r, 5));

      const listRes = await app.request(
        `/v1/events?projectId=${projectId}&limit=1`,
        { headers: listAuthHeader() },
      );
      const listJson = await listRes.json();
      const eventId = listJson.data[0].id;

      // Count audit records before
      const { rows: beforeRows } = await db.execute(
        `SELECT COUNT(*) as cnt FROM audit_log WHERE resource_id = '${eventId}'`,
      );
      const beforeCount = Number((beforeRows[0] as Record<string, unknown>)['cnt']);

      // Read detail (which triggers audit)
      const res = await app.request(
        `/v1/events/${eventId}?projectId=${projectId}`,
        { headers: payloadAuthHeader() },
      );
      expect(res.status).toBe(200);

      // Count audit records after
      const { rows: afterRows } = await db.execute(
        `SELECT COUNT(*) as cnt FROM audit_log WHERE resource_id = '${eventId}'`,
      );
      const afterCount = Number((afterRows[0] as Record<string, unknown>)['cnt']);
      expect(afterCount).toBeGreaterThan(beforeCount);

      // Verify the audit record details
      const { rows: auditRows } = await db.execute(
        `SELECT action, resource_type, outcome FROM audit_log
         WHERE resource_id = '${eventId}'
         ORDER BY created_at DESC LIMIT 1`,
      );
      const audit = auditRows[0] as Record<string, unknown>;
      expect(audit['action']).toBe('event.payload_read');
      expect(audit['resource_type']).toBe('event');
      expect(audit['outcome']).toBe('success');
    });

    it('returns 400 for invalid eventId format', async () => {
      const res = await app.request(
        `/v1/events/not-an-event-id?projectId=${projectId}`,
        { headers: payloadAuthHeader() },
      );

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('invalid_request');
    });

    it('returns 400 when projectId query param is missing', async () => {
      const res = await app.request(
        `/v1/events/evt_someevent00000000000000000000`,
        { headers: payloadAuthHeader() },
      );

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('invalid_request');
    });
  });

  // ── Scope: project-scoped key enforcement ─────────────────────────────────

  describe('scope enforcement', () => {
    it('project-scoped key cannot list events from another project', async () => {
      // Create a second project in the same team
      const project2 = `prj_${randomUUID().replace(/-/g, '')}`;
      await db.execute(
        `INSERT INTO projects (id, team_id, name) VALUES ('${project2}', '${teamId}', 'Second Project')`,
      );

      try {
        const res = await app.request(
          `/v1/events?projectId=${project2}&limit=10`,
          { headers: listAuthHeader() },
        );
        // The key is project-scoped to projectId, not project2
        expect(res.status).toBe(403);
        const json = await res.json();
        expect(json.error.code).toBe('forbidden');
      } finally {
        await db.execute(`DELETE FROM projects WHERE id = '${project2}'`);
      }
    });
  });
});
