/**
 * MCP Timeline Tool integration tests (DUA-209 M1-MCP-04).
 *
 * Tests the full MCP tools/call timeline pipeline against real Postgres:
 * - Success path: events ordered by occurred_at DESC
 * - Cursor-based pagination
 * - Scope enforcement (project-scoped key, cross-team anti-enumeration)
 * - Compact entry shape (no payload)
 * - Cursor invalidation
 * - Limit enforcement
 * - Audit record written
 *
 * Runs only when TEST_DATABASE_URL is set; honestly skipped otherwise.
 *
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
import { generateApiKeyToken, hashToken } from '../../auth/api-key.js';

const url = process.env['TEST_DATABASE_URL'];

describe.skipIf(!url)('MCP timeline tool (live Postgres)', () => {
  let pool: Pool;
  let db: AppDb;
  let app: ReturnType<typeof buildApp>;

  let teamId: string;
  let projectId: string;
  let readKeyToken: string | undefined;

  beforeAll(async () => {
    ({ pool } = connectDatabase());
    db = createDb(url!, { pool: pool as unknown as import('pg').Pool });

    // Bootstrap: create team + project + API key
    const suffix = randomUUID().replace(/-/g, '').slice(0, 8);
    const result = await runBootstrap(db, {
      teamName: `Timeline Test ${suffix}`,
      projectName: `demo-${suffix}`,
      rotate: false,
    });

    teamId = result.team.id;
    projectId = result.project.id;
    readKeyToken = result.key.token;

    // Seed a second team for cross-tenant isolation tests.
    // Note: project IDs must match prj_[A-Za-z0-9]+ (no underscores).
    await db.execute(
      `INSERT INTO teams (id, name) VALUES ('team_other_tl', 'Other Team TL') ON CONFLICT (id) DO NOTHING`,
    );
    await db.execute(
      `INSERT INTO projects (id, team_id, name) VALUES ('prj_othertl', 'team_other_tl', 'Other Project TL') ON CONFLICT (id) DO NOTHING`,
    );

    // Build the Hono app with the real database
    const deps: AppDeps = { dbUrl: url!, db };
    app = buildApp(deps);
  });

  afterAll(async () => {
    await db.execute(`DELETE FROM events WHERE project_id = '${projectId}'`);
    await db.execute(`DELETE FROM events WHERE project_id = 'prj_othertl'`);
    await db.execute(`DELETE FROM api_keys WHERE project_id = '${projectId}'`);
    await db.execute(`DELETE FROM api_keys WHERE project_id = 'prj_othertl'`);
    await db.execute(`DELETE FROM projects WHERE id = '${projectId}'`);
    await db.execute(`DELETE FROM projects WHERE id = 'prj_othertl'`);
    await db.execute(`DELETE FROM teams WHERE id = '${teamId}'`);
    await db.execute(`DELETE FROM teams WHERE id = 'team_other_tl'`);
    await closeDatabase(pool);
  });

  beforeEach(async () => {
    await db.execute(`DELETE FROM events WHERE team_id = '${teamId}'`);
    await db.execute(`DELETE FROM events WHERE team_id = 'team_other_tl'`);
    // Also clean audit records for the timeline action
    await db.execute(`DELETE FROM audit_log WHERE team_id = '${teamId}'`);
  });

  // ── Helpers ──────────────────────────────────────────────────────────────

  const authHeader = () => ({
    Authorization: `Bearer ${readKeyToken}`,
  });

  function makeTimelineRpcRequest(
    projectId: string,
    cursor?: string,
    limit?: number,
  ) {
    const args: Record<string, unknown> = { projectId };
    if (cursor !== undefined) args.cursor = cursor;
    if (limit !== undefined) args.limit = limit;

    return {
      jsonrpc: '2.0' as const,
      id: 1,
      method: 'tools/call',
      params: {
        name: 'timeline',
        arguments: args,
      },
    };
  }

  function makePayload(index: number) {
    return {
      schemaVersion: PAYLOAD_SCHEMA_VERSION,
      repo: 'test/repo',
      commitSha: `abc123def4567890123456789abcdef123${String(index).padStart(2, '0')}`,
      path: `docs/decisions/${String(index).padStart(3, '0')}-note.md`,
      content: `Test content for event ${index}`,
    };
  }

  function makeInsertRequest(
    index: number,
    overrides: Partial<EventInsertRequest> = {},
  ): EventInsertRequest {
    const p = makePayload(index);
    const day = 15 + (index % 15);
    return {
      teamId,
      projectId,
      channel: 'cli',
      kind: 'cli_init',
      connectorKind: 'cli',
      deliveryId: `del_timeline_${String(index).padStart(3, '0')}`,
      itemKey: 'root',
      externalId: `test/repo#${index}`,
      actor: { login: `user${index}`, displayName: `User ${index}` },
      actorProvenance: 'client_claimed',
      actorPrincipalId: null,
      occurredAt: new Date(`2026-07-${String(day).padStart(2, '0')}T${String(10 + (index % 12)).padStart(2, '0')}:00:00.000Z`),
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
   * Insert N events with different occurredAt times (spread across months
   * so we get a clear ordering). Also small delay for created_at uniqueness.
   */
  async function seedTimelineEvents(count: number) {
    for (let i = 1; i <= count; i++) {
      // Spread events across months: 2026-01 through 2026-12
      const month = String(((i - 1) % 12) + 1).padStart(2, '0');
      const day = String(((i - 1) % 28) + 1).padStart(2, '0');
      await insertEvent(
        db,
        makeInsertRequest(i, {
          occurredAt: new Date(`2026-${month}-${day}T12:00:00.000Z`),
        }),
      );
      await new Promise((r) => setTimeout(r, 3));
    }
  }

  // ── Success path ─────────────────────────────────────────────────────────

  describe('timeline tool — success', () => {
    it('returns empty list when no events exist', async () => {
      const res = await app.request('/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeader() },
        body: JSON.stringify(makeTimelineRpcRequest(projectId)),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.jsonrpc).toBe('2.0');
      expect(json.id).toBe(1);
      expect(json.result.content).toHaveLength(1);
      expect(json.result.content[0].type).toBe('text');

      const parsed = JSON.parse(json.result.content[0].text);
      expect(parsed.data).toEqual([]);
      expect(parsed.nextCursor).toBeNull();
    });

    it('returns events ordered by occurred_at DESC', async () => {
      await seedTimelineEvents(5);

      const res = await app.request('/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeader() },
        body: JSON.stringify(makeTimelineRpcRequest(projectId, undefined, 20)),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      const parsed = JSON.parse(json.result.content[0].text);
      expect(parsed.data).toHaveLength(5);

      // Verify DESC order: latest occurred_at first
      for (let i = 0; i < parsed.data.length - 1; i++) {
        const a = new Date(parsed.data[i].occurredAt).getTime();
        const b = new Date(parsed.data[i + 1].occurredAt).getTime();
        expect(a).toBeGreaterThanOrEqual(b);
      }
    });

    it('returns compact entries without payload', async () => {
      await seedTimelineEvents(2);

      const res = await app.request('/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeader() },
        body: JSON.stringify(makeTimelineRpcRequest(projectId)),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      const parsed = JSON.parse(json.result.content[0].text);
      expect(parsed.data).toHaveLength(2);

      for (const entry of parsed.data) {
        // Must have timeline fields
        expect(entry.id).toBeTruthy();
        expect(entry.id).toMatch(/^evt_/);
        expect(entry.occurredAt).toBeTruthy();
        expect(entry.kind).toBeTruthy();
        expect(entry.externalId).toBeTruthy();
        expect(entry.title).toBeTruthy();
        expect(entry.url).toBeDefined();
        expect(entry.actor).toBeDefined();

        // Must NOT have payload
        expect(entry.payload).toBeUndefined();
        expect('payload' in entry).toBe(false);
        // Must NOT have full event detail fields
        expect(entry.payloadHash).toBeUndefined();
        expect(entry.payloadBytes).toBeUndefined();
      }
    });

    it('derives title from sourceEvent and sourceAction', async () => {
      await insertEvent(
        db,
        makeInsertRequest(1, {
          channel: 'github',
          kind: 'github_pr',
          connectorKind: 'github',
          deliveryId: 'del_pr_0042',
          externalId: 'owner/repo#42',
          sourceEvent: 'pull_request',
          sourceAction: 'opened',
        }),
      );
      await new Promise((r) => setTimeout(r, 3));

      const res = await app.request('/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeader() },
        body: JSON.stringify(makeTimelineRpcRequest(projectId)),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      const parsed = JSON.parse(json.result.content[0].text);
      expect(parsed.data).toHaveLength(1);
      expect(parsed.data[0].title).toBe('pull_request owner/repo#42 opened');
    });
  });

  // ── Pagination ────────────────────────────────────────────────────────────

  describe('timeline tool — pagination', () => {
    it('paginates with cursor', async () => {
      await seedTimelineEvents(25);

      // First page: limit 20
      const res1 = await app.request('/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeader() },
        body: JSON.stringify(makeTimelineRpcRequest(projectId, undefined, 20)),
      });

      expect(res1.status).toBe(200);
      const page1 = JSON.parse((await res1.json()).result.content[0].text);
      expect(page1.data).toHaveLength(20);
      expect(page1.nextCursor).toBeTruthy();
      expect(page1.nextCursor).not.toBeNull();

      // Second page: follow cursor
      const res2 = await app.request('/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeader() },
        body: JSON.stringify(
          makeTimelineRpcRequest(projectId, page1.nextCursor, 20),
        ),
      });

      expect(res2.status).toBe(200);
      const page2 = JSON.parse((await res2.json()).result.content[0].text);
      expect(page2.data).toHaveLength(5);
      expect(page2.nextCursor).toBeNull();

      // Verify no duplicates
      const ids1 = new Set(page1.data.map((e: { id: string }) => e.id));
      const ids2 = new Set(page2.data.map((e: { id: string }) => e.id));
      for (const id of ids2) {
        expect(ids1.has(id)).toBe(false);
      }
      expect(ids1.size + ids2.size).toBe(25);
    });

    it('handles limit parameter', async () => {
      await seedTimelineEvents(5);

      // limit = 2
      const res = await app.request('/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeader() },
        body: JSON.stringify(makeTimelineRpcRequest(projectId, undefined, 2)),
      });

      expect(res.status).toBe(200);
      const parsed = JSON.parse((await res.json()).result.content[0].text);
      expect(parsed.data).toHaveLength(2);
      expect(parsed.nextCursor).toBeTruthy();
    });

    it('returns cursor_invalid for tampered cursor', async () => {
      await seedTimelineEvents(10);

      // Send a garbled cursor string
      const res = await app.request('/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeader() },
        body: JSON.stringify(
          makeTimelineRpcRequest(projectId, 'not-a-valid-cursor'),
        ),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.error).toBeDefined();
      expect(json.error.message).toBe('cursor_invalid');
    });
  });

  // ── Scope enforcement ─────────────────────────────────────────────────────

  describe('timeline tool — scope enforcement', () => {
    it('returns empty for cross-team project (anti-enumeration)', async () => {
      // Insert an event in the other team
      const otherPayload = makePayload(999);
      await insertEvent(db, {
        teamId: 'team_other_tl',
        projectId: 'prj_othertl',
        channel: 'cli',
        kind: 'cli_init',
        connectorKind: 'cli',
        deliveryId: 'del_other_tl_999',
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

      // Query with our team's key but the other team's project
      const res = await app.request('/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeader() },
        body: JSON.stringify(makeTimelineRpcRequest('prj_othertl')),
      });

      // Cross-team: should return empty data (anti-enumeration)
      expect(res.status).toBe(200);
      const json = await res.json();
      const parsed = JSON.parse(json.result.content[0].text);
      expect(parsed.data).toEqual([]);
      expect(parsed.nextCursor).toBeNull();
    });

    it('project-scoped key on different project returns empty', async () => {
      // Create a second project in the same team (must match prj_[A-Za-z0-9]+)
      const project2 = `prj_tl2${randomUUID().replace(/-/g, '').slice(0, 8)}`;
      await db.execute(
        `INSERT INTO projects (id, team_id, name) VALUES ('${project2}', '${teamId}', 'Second Project')`,
      );

      // Create a project-scoped key for project2 (must match key_[A-Za-z0-9]+)
      const p2Token = generateApiKeyToken();
      const p2Hash = hashToken(p2Token);
      const p2KeyId = `key_tl2${randomUUID().replace(/-/g, '').slice(0, 8)}`;
      await db.execute(
        `INSERT INTO api_keys (id, team_id, project_id, name, token_hash, scopes, all_projects)
         VALUES ('${p2KeyId}', '${teamId}', '${project2}', 'P2 Key',
                 '${p2Hash}', ARRAY['read']::text[], false)`,
      );

      try {
        // Seed an event in the first project
        await insertEvent(db, makeInsertRequest(1));

        // Use the project2 key to query the first project
        const res = await app.request('/mcp', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            Authorization: `Bearer ${p2Token}`,
          },
          body: JSON.stringify(makeTimelineRpcRequest(projectId)),
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        const parsed = JSON.parse(json.result.content[0].text);
        // Returns empty because the key is scoped to project2, not projectId
        expect(parsed.data).toEqual([]);
        expect(parsed.nextCursor).toBeNull();
      } finally {
        await db.execute(`DELETE FROM api_keys WHERE id = '${p2KeyId}'`);
        await db.execute(`DELETE FROM projects WHERE id = '${project2}'`);
      }
    });
  });

  // ── Audit ─────────────────────────────────────────────────────────────────

  describe('timeline tool — audit', () => {
    it('writes an audit record on timeline query', async () => {
      await seedTimelineEvents(3);

      // Count audit records before
      const { rows: beforeRows } = await db.execute(
        `SELECT COUNT(*) as cnt FROM audit_log WHERE action = 'mcp.timeline' AND team_id = '${teamId}'`,
      );
      const beforeCount = Number((beforeRows[0] as Record<string, unknown>)['cnt']);

      const res = await app.request('/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeader() },
        body: JSON.stringify(makeTimelineRpcRequest(projectId)),
      });

      expect(res.status).toBe(200);

      // Count audit records after
      const { rows: afterRows } = await db.execute(
        `SELECT COUNT(*) as cnt FROM audit_log WHERE action = 'mcp.timeline' AND team_id = '${teamId}'`,
      );
      const afterCount = Number((afterRows[0] as Record<string, unknown>)['cnt']);
      expect(afterCount).toBeGreaterThan(beforeCount);

      // Verify the audit record details
      const { rows: auditRows } = await db.execute(
        `SELECT action, resource_type, outcome, project_id FROM audit_log
         WHERE action = 'mcp.timeline' AND team_id = '${teamId}'
         ORDER BY created_at DESC LIMIT 1`,
      );
      const audit = auditRows[0] as Record<string, unknown>;
      expect(audit['action']).toBe('mcp.timeline');
      expect(audit['resource_type']).toBe('event');
      expect(audit['outcome']).toBe('success');
      expect(audit['project_id']).toBe(projectId);
    });
  });

  // ── Error handling ────────────────────────────────────────────────────────

  describe('timeline tool — errors', () => {
    it('returns error for limit > 100', async () => {
      const res = await app.request('/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeader() },
        body: JSON.stringify(makeTimelineRpcRequest(projectId, undefined, 101)),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.error).toBeDefined();
      expect(json.error.message).toContain('Too big');
    });

    it('returns tool not found for unknown tool', async () => {
      const res = await app.request('/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeader() },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'nonexistent_tool', arguments: {} },
        }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.error).toBeDefined();
      expect(json.error.message).toBe('Tool not found: nonexistent_tool');
    });

    it('returns invalid request when name is missing', async () => {
      const res = await app.request('/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeader() },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { arguments: {} },
        }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.error).toBeDefined();
      expect(json.error.code).toBe(-32600);
    });
  });

  // ── Unauthorized ──────────────────────────────────────────────────────────

  describe('timeline tool — auth', () => {
    it('returns 401 without auth header', async () => {
      const res = await app.request('/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(makeTimelineRpcRequest(projectId)),
      });

      expect(res.status).toBe(401);
    });
  });
});
