/**
 * MCP get_page tool integration tests (DUA-208).
 *
 * Tests against real Postgres (TEST_DATABASE_URL):
 * - Success: get_page returns full concept with body + evidence links
 * - Cross-team: UUID from another team → indistinguishable "Concept not found"
 * - Missing UUID → identical "Concept not found"
 * - Audit: successful reads write audit records
 * - Invalid UUID format → isError
 * - Missing auth → 401
 *
 * Runs only when TEST_DATABASE_URL is set; honestly skipped otherwise.
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
import * as auditSchema from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';

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

function authHeaders(token?: string | undefined) {
  return {
    Authorization: `Bearer ${token ?? ''}`,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function conceptInput(
  teamId: string,
  projectId: string,
  path: string,
  overrides?: Partial<CreateConceptInput>,
): CreateConceptInput {
  return {
    teamId,
    projectId,
    schemaVersion: 1,
    type: 'service',
    status: 'active',
    confidence: 'high',
    title: 'Test Service',
    body: 'Handles key business logic with **markdown** support.',
    firstSeen: new Date('2025-06-01T00:00:00.000Z'),
    lastConfirmed: new Date('2025-06-02T00:00:00.000Z'),
    path,
    evidence: [
      {
        kind: 'pr',
        ref: 'https://github.com/teamem-ai/teamem/pull/42',
        at: new Date('2025-06-01T00:00:00.000Z'),
      },
      {
        kind: 'commit',
        ref: 'https://github.com/teamem-ai/teamem/commit/abc1234def5678',
        at: new Date('2025-06-01T12:00:00.000Z'),
      },
    ],
    contributors: [],
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════

describe.skipIf(!url)('MCP get_page tool (live Postgres)', () => {
  let pool: Pool;
  let db: AppDb;
  let app: ReturnType<typeof buildApp>;

  // Primary team
  let teamId: string;
  let projectId: string;
  let apiKeyToken: string | undefined;

  // Other team for cross-tenant tests
  let otherTeamId: string;
  let otherProjectId: string;
  let otherApiKeyToken: string | undefined;

  // Seeded concepts
  let conceptUuid: string;
  let conceptPath: string;
  let otherTeamConceptUuid: string;

  beforeAll(async () => {
    ({ pool } = connectDatabase());
    db = createDb(url!, { pool: pool as unknown as import('pg').Pool });

    // ── Team 1 (our team) ──────────────────────────────────────────────
    const suffix = randomUUID().replace(/-/g, '').slice(0, 8);
    const result = await runBootstrap(db, {
      teamName: `MCP get_page Test ${suffix}`,
      projectName: `demo-${suffix}`,
      rotate: false,
    });

    teamId = result.team.id;
    projectId = result.project.id;
    apiKeyToken = result.key.token;

    // ── Team 2 (other team) ────────────────────────────────────────────
    const otherSuffix = randomUUID().replace(/-/g, '').slice(0, 8);
    const otherResult = await runBootstrap(db, {
      teamName: `MCP get_page Other ${otherSuffix}`,
      projectName: `other-${otherSuffix}`,
      rotate: false,
    });
    otherTeamId = otherResult.team.id;
    otherProjectId = otherResult.project.id;
    otherApiKeyToken = otherResult.key.token;

    // ── Seed a concept in team 1 ───────────────────────────────────────
    conceptPath = `services/test-service-${randomUUID().replace(/-/g, '').slice(0, 6)}`;
    const c1 = await createConcept(
      db,
      conceptInput(teamId, projectId, conceptPath, {
        title: 'Test Service',
        type: 'service',
        body: 'Handles key business logic with **markdown** support.',
        tags: ['api', 'core'],
      }),
    );
    conceptUuid = c1.uuid;

    // ── Seed a concept in team 2 ───────────────────────────────────────
    const otherPath = `services/other-service-${randomUUID().replace(/-/g, '').slice(0, 6)}`;
    const c2 = await createConcept(
      db,
      conceptInput(otherTeamId, otherProjectId, otherPath, {
        title: 'Other Team Service',
        body: 'This belongs to another team.',
      }),
    );
    otherTeamConceptUuid = c2.uuid;

    // ── Build the Hono app ─────────────────────────────────────────────
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

  // ── Helper: make an authenticated MCP request ─────────────────────────

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

  // ═══════════════════════════════════════════════════════════════════════
  // Success path
  // ═══════════════════════════════════════════════════════════════════════

  describe('get_page success', () => {
    it('returns full concept detail with body + evidence for a valid UUID', async () => {
      const res = await makeToolsCall(apiKeyToken, 'get_page', { uuid: conceptUuid });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.jsonrpc).toBe('2.0');
      expect(json.id).toBe(1);
      expect(json.result).toBeDefined();
      expect(json.result.isError).toBeUndefined();
      expect(json.result.content).toHaveLength(1);
      expect(json.result.content[0].type).toBe('text');

      // Parse the JSON text to inspect structure
      const concept = JSON.parse(json.result.content[0].text);

      // Core fields
      expect(concept.uuid).toBe(conceptUuid);
      expect(concept.path).toBe(conceptPath);
      expect(concept.type).toBe('service');
      expect(concept.status).toBe('active');
      expect(concept.confidence).toBe('high');
      expect(concept.title).toBe('Test Service');
      expect(concept.tags).toEqual(['api', 'core']);

      // Body is present (this is the progressive disclosure value)
      expect(concept.body).toBe('Handles key business logic with **markdown** support.');

      // Evidence with permalinks
      expect(concept.evidence).toBeDefined();
      expect(concept.evidence.length).toBe(2);
      expect(concept.evidence[0].kind).toBe('pr');
      expect(concept.evidence[0].ref).toBe('https://github.com/teamem-ai/teamem/pull/42');
      expect(concept.evidence[1].kind).toBe('commit');
      expect(concept.evidence[1].ref).toBe('https://github.com/teamem-ai/teamem/commit/abc1234def5678');

      // Schema version
      expect(concept.schemaVersion).toBe(1);
    });

    it('returns evidence with repo_file kind correctly', async () => {
      // Create a concept with repo_file evidence
      const repoPath = `services/repo-file-test-${randomUUID().replace(/-/g, '').slice(0, 6)}`;
      const c = await createConcept(
        db,
        conceptInput(teamId, projectId, repoPath, {
          title: 'Repo File Test',
          evidence: [
            {
              kind: 'repo_file',
              repo: 'teamem-ai/teamem',
              commitSha: 'abc1234def5678',
              path: 'src/app.ts',
              at: new Date('2025-06-01T00:00:00.000Z'),
            },
          ],
        }),
      );

      try {
        const res = await makeToolsCall(apiKeyToken, 'get_page', { uuid: c.uuid });
        const json = await res.json();
        const concept = JSON.parse(json.result.content[0].text);

        expect(concept.evidence).toHaveLength(1);
        expect(concept.evidence[0].kind).toBe('repo_file');
        expect(concept.evidence[0].repo).toBe('teamem-ai/teamem');
        expect(concept.evidence[0].commitSha).toBe('abc1234def5678');
        expect(concept.evidence[0].path).toBe('src/app.ts');
      } finally {
        await db.execute(`DELETE FROM concept_evidence WHERE concept_uuid = '${c.uuid}'`);
        await db.execute(`DELETE FROM concept_paths WHERE concept_uuid = '${c.uuid}'`);
        await db.execute(`DELETE FROM concepts WHERE uuid = '${c.uuid}'`);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Error paths — anti-enumeration
  // ═══════════════════════════════════════════════════════════════════════

  describe('get_page not found — anti-enumeration', () => {
    it('returns "Concept not found" for a non-existent UUID', async () => {
      const res = await makeToolsCall(apiKeyToken, 'get_page', {
        uuid: '00000000-0000-0000-0000-000000000000',
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.result.isError).toBe(true);
      expect(json.result.content[0].text).toBe('Concept not found');
    });

    it('returns identical "Concept not found" for a cross-team UUID', async () => {
      // Use our team's key to fetch a concept belonging to the other team
      const res = await makeToolsCall(apiKeyToken, 'get_page', {
        uuid: otherTeamConceptUuid,
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.result.isError).toBe(true);
      expect(json.result.content[0].text).toBe('Concept not found');

      // Verify the same error as a genuinely missing UUID
      const missingRes = await makeToolsCall(apiKeyToken, 'get_page', {
        uuid: '00000000-0000-0000-0000-000000000000',
      });
      const missingJson = await missingRes.json();

      expect(json.result).toEqual(missingJson.result);
    });

    it('returns identical "Concept not found" for cross-team (other-team key accessing our UUID)', async () => {
      const res = await makeToolsCall(otherApiKeyToken, 'get_page', {
        uuid: conceptUuid,
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.result.isError).toBe(true);
      expect(json.result.content[0].text).toBe('Concept not found');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Error paths — invalid input
  // ═══════════════════════════════════════════════════════════════════════

  describe('get_page invalid input', () => {
    it('returns isError for non-UUID string', async () => {
      const res = await makeToolsCall(apiKeyToken, 'get_page', {
        uuid: 'not-a-uuid',
      });

      const json = await res.json();
      expect(json.result.isError).toBe(true);
      expect(json.result.content[0].text).toContain('Invalid arguments');
    });

    it('returns isError for missing uuid', async () => {
      const res = await makeToolsCall(apiKeyToken, 'get_page', {});

      const json = await res.json();
      expect(json.result.isError).toBe(true);
      expect(json.result.content[0].text).toContain('Invalid arguments');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Audit
  // ═══════════════════════════════════════════════════════════════════════

  describe('get_page audit', () => {
    it('writes an audit record on successful concept read', async () => {
      // Count audit records before
      const before = await db.$count(auditSchema.auditLog);

      await makeToolsCall(apiKeyToken, 'get_page', { uuid: conceptUuid });

      // Count after
      const after = await db.$count(auditSchema.auditLog);

      expect(after).toBeGreaterThan(before);

      // Verify the latest audit record is for concept.read
      const rows = await db
        .select()
        .from(auditSchema.auditLog)
        .where(
          and(
            eq(auditSchema.auditLog.resourceId, conceptUuid),
            eq(auditSchema.auditLog.action, 'concept.read'),
            eq(auditSchema.auditLog.outcome, 'success'),
          ),
        )
        .limit(1);

      expect(rows).toHaveLength(1);
      expect(rows[0]!.resourceType).toBe('concept');
      expect(rows[0]!.teamId).toBe(teamId);
      expect(rows[0]!.projectId).toBe(projectId);
      // credentialId must be a key_... ID, never a token
      expect(rows[0]!.credentialId).toMatch(/^key_/);
    });

    it('writes a denied audit record for cross-team access', async () => {
      // Use our key to access other team's concept
      await makeToolsCall(apiKeyToken, 'get_page', { uuid: otherTeamConceptUuid });

      // Audit row should have outcome=denied for our team's perspective
      const rows = await db
        .select()
        .from(auditSchema.auditLog)
        .where(
          and(
            eq(auditSchema.auditLog.resourceId, otherTeamConceptUuid),
            eq(auditSchema.auditLog.action, 'concept.read'),
            eq(auditSchema.auditLog.outcome, 'denied'),
          ),
        )
        .limit(1);

      expect(rows).toHaveLength(1);
      // The teamId in the audit record is OUR team (the requesting team),
      // not the team that owns the concept — so no cross-team info leak.
      expect(rows[0]!.teamId).toBe(teamId);
      expect(rows[0]!.projectId).toBe(projectId);
    });

    it('writes a denied audit record for non-existent UUID', async () => {
      // Use a valid UUID format that passes z.uuid() validation
      // (variant nibble must be 8-b, version nibble must be 1-5).
      const fakeUuid = '22222222-2222-4222-8222-222222222222';

      await makeToolsCall(apiKeyToken, 'get_page', { uuid: fakeUuid });

      const rows = await db
        .select()
        .from(auditSchema.auditLog)
        .where(
          and(
            eq(auditSchema.auditLog.resourceId, fakeUuid),
            eq(auditSchema.auditLog.action, 'concept.read'),
            eq(auditSchema.auditLog.outcome, 'denied'),
          ),
        )
        .limit(1);

      expect(rows).toHaveLength(1);
    });

    it('audit records never contain sensitive data', async () => {
      // Get the latest audit record for our successful read
      const rows = await db
        .select()
        .from(auditSchema.auditLog)
        .where(
          and(
            eq(auditSchema.auditLog.resourceId, conceptUuid),
            eq(auditSchema.auditLog.action, 'concept.read'),
            eq(auditSchema.auditLog.outcome, 'success'),
          ),
        )
        .limit(1);

      const row = rows[0]!;

      // No payload, body, concept content, or tokens in audit
      const rowAsRecord = row as unknown as Record<string, unknown>;
      const forbiddenKeys = ['payload', 'body', 'content', 'queryText', 'query', 'apiKey', 'token', 'secret'];
      for (const key of forbiddenKeys) {
        expect(key in rowAsRecord, `Forbidden key "${key}" found in audit row`).toBe(false);
      }

      // credentialId must not be a plaintext token
      expect(row.credentialId!).not.toContain('tm_');
      expect(row.credentialId!).toMatch(/^key_/);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Auth
  // ═══════════════════════════════════════════════════════════════════════

  describe('get_page auth', () => {
    it('returns 401 without Authorization header', async () => {
      const res = await app.request('/mcp', {
        ...toolsCall('get_page', { uuid: conceptUuid }),
      });

      expect(res.status).toBe(401);
    });

    it('returns 401 for invalid token', async () => {
      const res = await app.request('/mcp', {
        ...toolsCall('get_page', { uuid: conceptUuid }),
        headers: authHeaders('tm_invalid_token_12345'),
      });

      expect(res.status).toBe(401);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // MCP tools/list includes get_page
  // ═══════════════════════════════════════════════════════════════════════

  describe('tools/list includes get_page', () => {
    it('lists get_page in the tool registry', async () => {
      const res = await makeMcpRequest(apiKeyToken, 'tools/list');

      expect(res.status).toBe(200);
      const json = await res.json();
      const tools = json.result.tools as Array<Record<string, unknown>>;

      const getPage = tools.find((t) => t.name === 'get_page');
      expect(getPage).toBeDefined();
      expect(getPage!.description).toContain('concept page');
      expect(getPage!.inputSchema).toMatchObject({
        type: 'object',
        properties: {
          uuid: {
            type: 'string',
            description: expect.any(String),
          },
        },
        required: ['uuid'],
      });
    });
  });
});
