/**
 * Two-Machine Sharing Integration Test (DUA-218 M1-QA-03).
 *
 * Verifies that knowledge written by one machine (API key) is visible to
 * another machine in the same project, private-tag redaction works, and
 * cross-team access is denied (anti-enumeration).
 *
 * CLI Acceptance Steps:
 *   1. A writes, B reads → hits the same event
 *   2. <private> content not stored / not retrievable
 *   3. Cross-team counterexample: other team's key cannot retrieve
 *
 * Test Plan:
 *   - Event-level: A writes via MCP memory_write → B reads via REST API
 *     GET /v1/events and GET /v1/events/:id
 *   - Redaction: stored payload and event detail response must not contain
 *     <private> content
 *   - Cross-team: other team's key gets 404/empty on event queries
 *   - Concept search: after concepts are seeded (stand-in for compilation),
 *     both keys can search them; cross-team key returns empty
 *
 * Runs only when TEST_DATABASE_URL is set; honestly skipped otherwise.
 * No mocked database — per project red line.
 *
 *   TEST_DATABASE_URL=postgres://teamem:x@localhost:5432/teamem pnpm test
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type AppDeps } from '../../app.js';
import { createDb, type AppDb } from '../../db/client.js';
import {
  connectDatabase,
  closeDatabase,
  type Pool,
} from '../../test/database.js';
import { runBootstrap } from '../../commands/bootstrap.js';
import { createConcept, type CreateConceptInput } from '../../db/repositories/concepts-write.js';
import { generateApiKeyToken, hashToken } from '../../auth/api-key.js';
import * as dbSchema from '../../db/schema.js';

const url = process.env['TEST_DATABASE_URL'];

// ── MCP JSON-RPC helpers ────────────────────────────────────────────────────

function mcpRequest(method: string, params?: Record<string, unknown>, id?: number) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: id ?? 1,
      method,
      ...(params ? { params } : {}),
    }),
  };
}

function toolsCall(name: string, args: Record<string, unknown>, id?: number) {
  return mcpRequest('tools/call', { name, arguments: args }, id);
}

function authHeaders(token: string | undefined) {
  return { Authorization: `Bearer ${token ?? ''}` };
}

// ── Concept seeding helper ──────────────────────────────────────────────────

function conceptInput(
  teamId: string,
  projectId: string,
  overrides?: Partial<CreateConceptInput>,
): CreateConceptInput {
  return {
    teamId,
    projectId,
    schemaVersion: 1,
    type: 'gotcha',
    status: 'active',
    confidence: 'high',
    title: 'Seeded Gotcha for Two-Machine Test',
    body: 'This is a gotcha discovered during two-machine share testing. Production deployments fail when the app starts before migrations complete.',
    firstSeen: new Date('2025-06-01T00:00:00.000Z'),
    lastConfirmed: new Date('2025-06-02T00:00:00.000Z'),
    path: `gotchas/two-machine-test-${randomUUID().replace(/-/g, '').slice(0, 6)}`,
    evidence: [
      {
        kind: 'mcp_write',
        ref: 'mcp:memory_write:test',
        at: new Date('2025-06-01T00:00:00.000Z'),
      },
    ],
    contributors: [],
    tags: ['testing', 'two-machine'],
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════

describe.skipIf(!url)('Two-Machine Share (live Postgres)', () => {
  let pool: Pool;
  let db: AppDb;
  let app: ReturnType<typeof buildApp>;

  // Primary team — two machines (A and B) share the same project.
  let teamId: string;
  let projectId: string;
  let keyAToken: string | undefined; // Machine A's token (bootstrap default)
  let keyBToken: string | undefined; // Machine B's token (extra key, same project)

  // Other team for cross-tenant isolation tests.
  let otherTeamId: string;
  let otherProjectId: string;
  let otherKeyToken: string | undefined;

  // Seeded concept UUID for search tests.
  let seededConceptUuid: string;
  let seededConceptTitle: string;

  beforeAll(async () => {
    ({ pool } = connectDatabase());
    db = createDb(url!, { pool: pool as unknown as import('pg').Pool });

    // ── Team 1: primary team ────────────────────────────────────────────
    const suffix = randomUUID().replace(/-/g, '').slice(0, 8);
    const result = await runBootstrap(db, {
      teamName: `Two-Machine Test ${suffix}`,
      projectName: `demo-${suffix}`,
      rotate: false,
    });

    teamId = result.team.id;
    projectId = result.project.id;
    keyAToken = result.key.token;

    // ── Create a second API key (Machine B) in the same project ────────
    const keyBTokenPlain = generateApiKeyToken();
    const keyBTokenHash = hashToken(keyBTokenPlain);
    const keyBId = `key_B${randomUUID().replace(/-/g, '').slice(0, 20)}`;

    await db.insert(dbSchema.apiKeys).values({
      id: keyBId,
      teamId,
      projectId,
      principalId: result.principal?.id ?? null,
      name: 'Machine B Key',
      tokenHash: keyBTokenHash,
      scopes: ['read', 'read:payload', 'events:write'],
      allProjects: false,
    });
    keyBToken = keyBTokenPlain;

    // ── Team 2: other team (cross-tenant isolation) ─────────────────────
    const otherSuffix = randomUUID().replace(/-/g, '').slice(0, 8);
    const otherResult = await runBootstrap(db, {
      teamName: `Two-Machine Other ${otherSuffix}`,
      projectName: `other-${otherSuffix}`,
      rotate: false,
    });
    otherTeamId = otherResult.team.id;
    otherProjectId = otherResult.project.id;
    otherKeyToken = otherResult.key.token;

    // ── Seed a concept for search tests ─────────────────────────────────
    seededConceptTitle = `Two-Machine Gotcha ${randomUUID().replace(/-/g, '').slice(0, 6)}`;
    const concept = await createConcept(
      db,
      conceptInput(teamId, projectId, {
        title: seededConceptTitle,
        body: 'This gotcha was discovered: Docker Compose depends_on with condition: service_healthy only waits for container health, NOT application readiness.',
        tags: ['deployment', 'gotcha'],
      }),
    );
    seededConceptUuid = concept.uuid;

    // ── Build the Hono app ──────────────────────────────────────────────
    const deps: AppDeps = { dbUrl: url, db };
    app = buildApp(deps);
  });

  afterAll(async () => {
    // Clean up in FK dependency order.
    const ids = [projectId, otherProjectId];
    for (const pid of ids) {
      await db.execute(`DELETE FROM concept_contributors WHERE project_id = '${pid}'`);
      await db.execute(`DELETE FROM concept_evidence      WHERE project_id = '${pid}'`);
      await db.execute(`DELETE FROM concept_paths         WHERE project_id = '${pid}'`);
      await db.execute(`DELETE FROM concepts              WHERE project_id = '${pid}'`);
      await db.execute(`DELETE FROM job_events            WHERE project_id = '${pid}'`);
      await db.execute(`DELETE FROM events                WHERE project_id = '${pid}'`);
      await db.execute(`DELETE FROM jobs                  WHERE project_id = '${pid}'`);
      await db.execute(`DELETE FROM api_keys              WHERE project_id = '${pid}'`);
      await db.execute(`DELETE FROM projects              WHERE id = '${pid}'`);
    }
    await db.execute(`DELETE FROM api_keys              WHERE team_id = '${teamId}' AND project_id IS NULL`);
    await db.execute(`DELETE FROM principals            WHERE team_id = '${teamId}'`);
    await db.execute(`DELETE FROM teams                 WHERE id = '${teamId}'`);
    await db.execute(`DELETE FROM principals            WHERE team_id = '${otherTeamId}'`);
    await db.execute(`DELETE FROM teams                 WHERE id = '${otherTeamId}'`);

    // Clean audit log
    await db.execute(`DELETE FROM audit_log WHERE team_id IN ('${teamId}', '${otherTeamId}')`);

    await closeDatabase(pool);
  });

  // ── Helpers ─────────────────────────────────────────────────────────

  function makeMcpRequest(token: string | undefined, method: string, params?: Record<string, unknown>) {
    return app.request('/mcp', {
      ...mcpRequest(method, params),
      headers: {
        ...mcpRequest(method, params).headers,
        ...authHeaders(token),
      },
    });
  }

  function makeToolsCall(token: string | undefined, name: string, args: Record<string, unknown>) {
    return makeMcpRequest(token, 'tools/call', { name, arguments: args });
  }

  /**
   * Call the REST GET /v1/events endpoint.
   */
  async function getEventsList(
    token: string | undefined,
    pid: string,
    extraParams: Record<string, string> = {},
  ) {
    const params = new URLSearchParams({ projectId: pid, ...extraParams });
    return app.request(`/v1/events?${params.toString()}`, {
      headers: authHeaders(token),
    });
  }

  /**
   * Call the REST GET /v1/events/:id endpoint.
   */
  async function getEventDetail(
    token: string | undefined,
    pid: string,
    eventId: string,
  ) {
    const params = new URLSearchParams({ projectId: pid });
    return app.request(`/v1/events/${eventId}?${params.toString()}`, {
      headers: authHeaders(token),
    });
  }

  /**
   * Execute memory_write via MCP tools/call and return the parsed result.
   */
  async function memoryWrite(
    token: string | undefined,
    args: { content: string; title?: string; suggestedType?: string; tags?: string[]; projectId?: string },
  ) {
    const res = await makeToolsCall(token, 'memory_write', args as Record<string, unknown>);
    const json = await res.json();
    return { res, json };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CLI Acceptance Step 1: A writes, B reads → same event
  // ═══════════════════════════════════════════════════════════════════════

  describe('CLI 验收步骤 1 — A writes, B reads the same event', () => {
    let eventIdFromA: string;

    it('Machine A writes a gotcha via MCP memory_write', async () => {
      const { res, json } = await memoryWrite(keyAToken, {
        content:
          'Gotcha: Docker depends_on only waits for container health, not app readiness. ' +
          '<private>API_KEY=sk-secret-12345</private> ' +
          'Always add an init container for migrations.',
        title: 'Docker Compose Gotcha',
        suggestedType: 'gotcha',
        tags: ['docker', 'deployment', 'gotcha'],
      });

      expect(res.status).toBe(200);
      expect(json.result).toBeDefined();
      expect(json.result.isError).toBeUndefined();

      const text = json.result.content[0].text as string;
      expect(text).toContain('Memory stored successfully');

      // Extract event ID
      const match = /Event: (evt_[A-Za-z0-9]+)/.exec(text);
      expect(match).not.toBeNull();
      eventIdFromA = match![1]!;
    });

    it('Machine B can list the event via GET /v1/events', async () => {
      const res = await getEventsList(keyBToken, projectId);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data).toBeDefined();
      expect(Array.isArray(body.data)).toBe(true);

      const found = body.data.find((e: { id: string }) => e.id === eventIdFromA);
      expect(found).toBeDefined();
      expect(found.id).toBe(eventIdFromA);

      // Source should reflect the MCP channel
      expect(found.source.channel).toBe('mcp');
      expect(found.source.kind).toBe('mcp_write');
    });

    it('Machine B can read the event detail via GET /v1/events/:id', async () => {
      const res = await getEventDetail(keyBToken, projectId, eventIdFromA);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data).toBeDefined();
      expect(body.data.id).toBe(eventIdFromA);

      // Machine B should see the redacted payload
      expect(body.data.payload).toBeDefined();
      expect(body.data.payload.text).toBeDefined();
    });

    it('Machine A can also list and read its own event', async () => {
      // List
      const listRes = await getEventsList(keyAToken, projectId);
      const listBody = await listRes.json();
      const found = listBody.data.find((e: { id: string }) => e.id === eventIdFromA);
      expect(found).toBeDefined();

      // Detail
      const detailRes = await getEventDetail(keyAToken, projectId, eventIdFromA);
      const detailBody = await detailRes.json();
      expect(detailBody.data.id).toBe(eventIdFromA);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // CLI Acceptance Step 2: <private> content not stored / not retrievable
  // ═══════════════════════════════════════════════════════════════════════

  describe('CLI 验收步骤 2 — <private> content not stored or retrievable', () => {
    it('<private> tags are stripped from the stored event payload', async () => {
      // Write a fresh event with private content
      const { json } = await memoryWrite(keyAToken, {
        content: 'Public info <private>TOKEN=secret_value_42</private> after secret.',
        title: 'Redaction Test',
      });
      const text = json.result.content[0].text as string;
      const match = /Event: (evt_[A-Za-z0-9]+)/.exec(text);
      expect(match).not.toBeNull();
      const eventId = match![1]!;

      // Read via Machine B to verify redacted content
      const res = await getEventDetail(keyBToken, projectId, eventId);
      expect(res.status).toBe(200);
      const body = await res.json();

      const payloadText = body.data.payload.text as string;
      // Must NOT contain the secret
      expect(payloadText).not.toContain('TOKEN=secret_value_42');
      expect(payloadText).not.toContain('secret_value_42');
      // Must contain only the redacted public part
      expect(payloadText).toContain('Public info');
      expect(payloadText).toContain('after secret');
      // Should not contain the <private> tags or content between them
      expect(payloadText).not.toContain('<private>');
      expect(payloadText).not.toContain('</private>');
    });

    it('no stored event payload in the project contains private content', async () => {
      // Query all events in the project directly from DB to ensure
      // no <private> content leaked anywhere.
      const { rows } = await db.execute(
        `SELECT payload::text as p FROM events WHERE project_id = '${projectId}'`,
      );
      for (const row of rows) {
        const p = (row as Record<string, unknown>)['p'] as string;
        expect(p).not.toContain('secret_value_42');
        expect(p).not.toContain('TOKEN=secret_value_42');
        expect(p).not.toContain('sk-secret-12345');
      }
    });

    it('event list response (no payload) confirms event visible without leaking', async () => {
      const res = await getEventsList(keyBToken, projectId);
      const body = await res.json();

      // Event list summaries must NOT contain payload
      for (const event of body.data) {
        expect(event.payload).toBeUndefined();
      }
    });

    it('private content is not retrievable via REST API response text', async () => {
      // Verify that the API response body text never contains the secret
      const res = await getEventsList(keyBToken, projectId);
      const resText = await res.text();

      expect(resText).not.toContain('secret_value_42');
      expect(resText).not.toContain('TOKEN=secret_value_42');
      expect(resText).not.toContain('sk-secret-12345');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // CLI Acceptance Step 3: Cross-team key cannot retrieve
  // ═══════════════════════════════════════════════════════════════════════

  describe('CLI 验收步骤 3 — cross-team key cannot retrieve', () => {
    it('other-team key gets 403 on GET /v1/events for our project', async () => {
      const res = await getEventsList(otherKeyToken, projectId);
      // Project-scoped key from a different team should be denied.
      // The API returns 403 ForbiddenError when projectId doesn't match
      // the key's scoped project.
      expect(res.status).toBe(403);
    });

    it('other-team key gets 403 on GET /v1/events for its own project (not ours)', async () => {
      // Other team's key CAN list its own project's events
      const res = await getEventsList(otherKeyToken, otherProjectId);
      expect(res.status).toBe(200);
      const body = await res.json();

      // Our events must NOT appear in their project
      const ourEventIds = new Set<string>();
      // Get our project's event IDs
      const ourRes = await getEventsList(keyAToken, projectId);
      const ourBody = await ourRes.json();
      for (const e of ourBody.data) {
        ourEventIds.add(e.id);
      }

      // Ensure none of our events are in their response
      for (const e of body.data) {
        expect(ourEventIds.has(e.id)).toBe(false);
      }
    });

    it('other-team key cannot read event detail by ID (anti-enumeration 404)', async () => {
      // First get an event ID from our project
      const ourRes = await getEventsList(keyAToken, projectId);
      const ourBody = await ourRes.json();
      if (ourBody.data.length > 0) {
        const ourEventId = ourBody.data[0].id;

        // Other team's key tries to read it (with their own projectId — should be 403)
        const res = await getEventDetail(otherKeyToken, otherProjectId, ourEventId);
        // Either 403 (project mismatch) or 404 (not found in their project)
        expect([403, 404]).toContain(res.status);
      }
    });

    it('our key cannot see other-team events', async () => {
      // Machine A's key trying to list other team's project
      const res = await getEventsList(keyAToken, otherProjectId);
      expect(res.status).toBe(403);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Concept Search Sharing (stand-in for post-compilation behaviour)
  // ═══════════════════════════════════════════════════════════════════════

  describe('concept search — cross-machine visibility', () => {
    it('both keys (A and B) can search and find the same concept', async () => {
      // Key A searches
      const resA = await makeToolsCall(keyAToken, 'search', {
        projectId,
        query: seededConceptTitle,
      });
      expect(resA.status).toBe(200);
      const jsonA = await resA.json();
      const bodyA = JSON.parse(jsonA.result.content[0].text);
      expect(bodyA.results.length).toBeGreaterThanOrEqual(1);
      const foundA = bodyA.results.find((r: { uuid: string }) => r.uuid === seededConceptUuid);
      expect(foundA).toBeDefined();
      expect(foundA.title).toBe(seededConceptTitle);
      expect(foundA.type).toBe('gotcha');

      // Key B searches — must find the same concept
      const resB = await makeToolsCall(keyBToken, 'search', {
        projectId,
        query: seededConceptTitle,
      });
      expect(resB.status).toBe(200);
      const jsonB = await resB.json();
      const bodyB = JSON.parse(jsonB.result.content[0].text);
      expect(bodyB.results.length).toBeGreaterThanOrEqual(1);
      const foundB = bodyB.results.find((r: { uuid: string }) => r.uuid === seededConceptUuid);
      expect(foundB).toBeDefined();
      expect(foundB.title).toBe(seededConceptTitle);
      expect(foundB.uuid).toBe(seededConceptUuid);

      // Both keys see the same UUID
      expect(foundB.uuid).toBe(foundA.uuid);
    });

    it('other-team key cannot search our concepts (returns empty)', async () => {
      const res = await makeToolsCall(otherKeyToken, 'search', {
        projectId: otherProjectId,
        query: seededConceptTitle,
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      const body = JSON.parse(json.result.content[0].text);

      // Must not find our seeded concept
      const found = body.results.find((r: { uuid: string }) => r.uuid === seededConceptUuid);
      expect(found).toBeUndefined();
    });

    it('other-team key searching our project returns empty (MCP scope enforcement)', async () => {
      // Use other-team key to search our project — must return empty
      const res = await makeToolsCall(otherKeyToken, 'search', {
        projectId,
        query: seededConceptTitle,
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      const body = JSON.parse(json.result.content[0].text);

      // Must return empty — indistinguishable from "no matches in this project"
      expect(body.results).toEqual([]);
      expect(body.nextCursor).toBeNull();
    });

    it('both keys can use get_page on the concept', async () => {
      // Key A reads the concept page
      const resA = await makeToolsCall(keyAToken, 'get_page', {
        projectId,
        uuid: seededConceptUuid,
      });
      expect(resA.status).toBe(200);
      const jsonA = await resA.json();
      expect(jsonA.result.isError).toBeUndefined();
      const textA = jsonA.result.content[0].text;
      expect(textA).toContain(seededConceptTitle);

      // Key B reads the same concept page
      const resB = await makeToolsCall(keyBToken, 'get_page', {
        projectId,
        uuid: seededConceptUuid,
      });
      expect(resB.status).toBe(200);
      const jsonB = await resB.json();
      expect(jsonB.result.isError).toBeUndefined();
      const textB = jsonB.result.content[0].text;
      expect(textB).toContain(seededConceptTitle);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Boundary: multiple writes visible to both keys
  // ═══════════════════════════════════════════════════════════════════════

  describe('boundary — multiple writes visible to both keys', () => {
    it('Machine B sees all events Machine A writes', async () => {
      // Machine A writes two more events
      const { json: j1 } = await memoryWrite(keyAToken, {
        content: 'Observation 1: Redis caching improved latency by 40%.',
        title: 'Caching Observation',
        suggestedType: 'convention',
      });
      const t1 = j1.result.content[0].text as string;
      const id1 = /Event: (evt_[A-Za-z0-9]+)/.exec(t1)![1]!;

      const { json: j2 } = await memoryWrite(keyAToken, {
        content: 'Observation 2: Use connection pooling for all DB access.',
        title: 'Connection Pooling Rule',
        suggestedType: 'convention',
      });
      const t2 = j2.result.content[0].text as string;
      const id2 = /Event: (evt_[A-Za-z0-9]+)/.exec(t2)![1]!;

      // Machine B lists events and finds both
      const res = await getEventsList(keyBToken, projectId);
      const body = await res.json();
      const ids = body.data.map((e: { id: string }) => e.id);

      expect(ids).toContain(id1);
      expect(ids).toContain(id2);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Boundary: auth failures
  // ═══════════════════════════════════════════════════════════════════════

  describe('boundary — auth failures', () => {
    it('MCP memory_write returns 401 without auth', async () => {
      const res = await app.request('/mcp', {
        ...toolsCall('memory_write', { content: 'test' }),
      });
      expect(res.status).toBe(401);
    });

    it('MCP search returns 401 without auth', async () => {
      const res = await app.request('/mcp', {
        ...toolsCall('search', { projectId, query: 'test' }),
      });
      expect(res.status).toBe(401);
    });

    it('MCP get_page returns 401 without auth', async () => {
      const res = await app.request('/mcp', {
        ...toolsCall('get_page', { projectId, uuid: seededConceptUuid }),
      });
      expect(res.status).toBe(401);
    });

    it('GET /v1/events returns 401 without auth', async () => {
      const res = await app.request(`/v1/events?projectId=${projectId}`);
      expect(res.status).toBe(401);
    });
  });
});
