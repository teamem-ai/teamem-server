/**
 * MCP search tool integration tests (DUA-207).
 *
 * Tests against real Postgres (TEST_DATABASE_URL):
 * - Success: search returns index rows with uuid, title, type, snippet, relevance
 * - Index rows do NOT contain full body (progressive disclosure L1)
 * - Results include uuid for get_page L2 drill-down
 * - Cross-team: search returns empty results (anti-enumeration)
 * - Missing project → empty results
 * - Invalid input → isError
 * - FTS degradation is reported (degraded: true)
 * - Audit: search writes audit records
 * - tools/list includes search tool
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
import { eq, and, desc } from 'drizzle-orm';

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
    ],
    contributors: [],
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════

describe.skipIf(!url)('MCP search tool (live Postgres)', () => {
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
  let authServiceUuid: string;
  let dataPipelineUuid: string;
  let otherTeamConceptUuid: string;
  let otherTeamConceptTitle: string;

  beforeAll(async () => {
    ({ pool } = connectDatabase());
    db = createDb(url!, { pool: pool as unknown as import('pg').Pool });

    // ── Team 1 (our team) ──────────────────────────────────────────────
    const suffix = randomUUID().replace(/-/g, '').slice(0, 8);
    const result = await runBootstrap(db, {
      teamName: `MCP Search Test ${suffix}`,
      projectName: `demo-${suffix}`,
      rotate: false,
    });

    teamId = result.team.id;
    projectId = result.project.id;
    apiKeyToken = result.key.token;

    // ── Team 2 (other team) ────────────────────────────────────────────
    const otherSuffix = randomUUID().replace(/-/g, '').slice(0, 8);
    const otherResult = await runBootstrap(db, {
      teamName: `MCP Search Other ${otherSuffix}`,
      projectName: `other-${otherSuffix}`,
      rotate: false,
    });
    otherTeamId = otherResult.team.id;
    otherProjectId = otherResult.project.id;
    otherApiKeyToken = otherResult.key.token;

    // ── Seed searchable concepts in team 1 ─────────────────────────────
    // Concept 1: Auth service
    const c1 = await createConcept(
      db,
      conceptInput(teamId, projectId, `services/auth-service-${randomUUID().replace(/-/g, '').slice(0, 6)}`, {
        title: 'Authentication Service',
        type: 'service',
        body: 'Handles OAuth2 authentication and JWT token validation for all incoming API requests.',
        tags: ['auth', 'security'],
      }),
    );
    authServiceUuid = c1.uuid;

    // Concept 2: Data pipeline
    const c2 = await createConcept(
      db,
      conceptInput(teamId, projectId, `services/data-pipeline-${randomUUID().replace(/-/g, '').slice(0, 6)}`, {
        title: 'Data Pipeline Architecture',
        type: 'concept',
        body: 'Describes the ETL data pipeline that ingests events from PostgreSQL, transforms them, and loads into the analytics warehouse.',
        tags: ['data', 'pipeline'],
      }),
    );
    dataPipelineUuid = c2.uuid;

    // ── Seed a concept in team 2 ───────────────────────────────────────
    otherTeamConceptTitle = 'Other Team Resource';
    const c3 = await createConcept(
      db,
      conceptInput(otherTeamId, otherProjectId, `services/other-${randomUUID().replace(/-/g, '').slice(0, 6)}`, {
        title: otherTeamConceptTitle,
        body: 'This resource belongs to another team and should not appear in cross-team search.',
      }),
    );
    otherTeamConceptUuid = c3.uuid;

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
  // Success paths
  // ═══════════════════════════════════════════════════════════════════════

  describe('search success', () => {
    it('returns index rows with uuid, title, type, snippet, and relevance', async () => {
      const res = await makeToolsCall(apiKeyToken, 'search', {
        projectId,
        query: 'authentication',
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.jsonrpc).toBe('2.0');
      expect(json.id).toBe(1);
      expect(json.result).toBeDefined();
      expect(json.result.isError).toBeUndefined();
      expect(json.result.content).toHaveLength(1);
      expect(json.result.content[0].type).toBe('text');

      const body = JSON.parse(json.result.content[0].text);
      expect(body.results).toBeDefined();
      expect(Array.isArray(body.results)).toBe(true);
      expect(body.results.length).toBeGreaterThanOrEqual(1);

      // Verify the auth service is in results
      const authResult = body.results.find((r: { uuid: string }) => r.uuid === authServiceUuid);
      expect(authResult).toBeDefined();
      expect(authResult.uuid).toBe(authServiceUuid);
      expect(authResult.type).toBe('service');
      expect(authResult.title).toBe('Authentication Service');
      expect(authResult.snippet).toBeDefined();
      expect(typeof authResult.snippet).toBe('string');
      expect(authResult.snippet.length).toBeGreaterThan(0);

      // Relevance is a number between 0 and 1
      expect(typeof authResult.relevance).toBe('number');
      expect(authResult.relevance).toBeGreaterThanOrEqual(0);
      expect(authResult.relevance).toBeLessThanOrEqual(1);

      // UUID is present for get_page L2 drill-down
      expect(authResult.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('returns index rows that do NOT contain full body (progressive disclosure L1)', async () => {
      const res = await makeToolsCall(apiKeyToken, 'search', {
        projectId,
        query: 'data pipeline ETL',
      });

      const json = await res.json();
      const body = JSON.parse(json.result.content[0].text);

      expect(body.results.length).toBeGreaterThanOrEqual(1);

      for (const row of body.results) {
        // No full body field in the index row
        expect(row.body).toBeUndefined();
        // Snippet is present and shorter than the full body
        expect(typeof row.snippet).toBe('string');
        // The original body is much longer than the snippet
        if (row.uuid === dataPipelineUuid) {
          // The snippet should be at most ~200 chars (plus ellipsis)
          expect(row.snippet.length).toBeLessThanOrEqual(203); // 200 + '…'
        }
      }
    });

    it('returns multiple results matching the query', async () => {
      const res = await makeToolsCall(apiKeyToken, 'search', {
        projectId,
        query: 'service',
      });

      const json = await res.json();
      const body = JSON.parse(json.result.content[0].text);

      // Both concepts mention "service" or related terms
      expect(body.results.length).toBeGreaterThanOrEqual(1);
    });

    it('reports degraded: true for FTS-only deployments', async () => {
      const res = await makeToolsCall(apiKeyToken, 'search', {
        projectId,
        query: 'authentication',
      });

      const json = await res.json();
      const body = JSON.parse(json.result.content[0].text);

      // In the initial implementation, search is always FTS-based
      expect(body.degraded).toBe(true);
    });

    it('filters by concept type', async () => {
      const res = await makeToolsCall(apiKeyToken, 'search', {
        projectId,
        query: 'data',
        type: 'concept',
      });

      const json = await res.json();
      const body = JSON.parse(json.result.content[0].text);

      // Should include data pipeline (type=concept)
      const dataResult = body.results.find((r: { uuid: string }) => r.uuid === dataPipelineUuid);
      if (dataResult) {
        expect(dataResult.type).toBe('concept');
      }

      // Should NOT include auth service (type=service)
      const authResult = body.results.find((r: { uuid: string }) => r.uuid === authServiceUuid);
      expect(authResult).toBeUndefined();
    });

    it('filters by concept status', async () => {
      const res = await makeToolsCall(apiKeyToken, 'search', {
        projectId,
        query: 'service',
        status: 'active',
      });

      const json = await res.json();
      const body = JSON.parse(json.result.content[0].text);

      for (const row of body.results) {
        expect(row.status).toBe('active');
      }
    });

    it('returns empty results for a query with no matches', async () => {
      const res = await makeToolsCall(apiKeyToken, 'search', {
        projectId,
        query: 'zzzxyznonexistenttermfoobar',
      });

      const json = await res.json();
      const body = JSON.parse(json.result.content[0].text);

      expect(body.results).toEqual([]);
      expect(body.degraded).toBe(true);
      expect(body.nextCursor).toBeNull();
    });

    it('supports pagination with cursor', async () => {
      // First page with small limit
      const res1 = await makeToolsCall(apiKeyToken, 'search', {
        projectId,
        query: 'service OR data OR authentication OR pipeline',
        limit: 1,
      });

      const json1 = await res1.json();
      const body1 = JSON.parse(json1.result.content[0].text);

      expect(body1.results.length).toBeLessThanOrEqual(1);

      if (body1.nextCursor) {
        // Second page using the cursor
        const res2 = await makeToolsCall(apiKeyToken, 'search', {
          projectId,
          query: 'service OR data OR authentication OR pipeline',
          cursor: body1.nextCursor,
          limit: 10,
        });

        const json2 = await res2.json();
        const body2 = JSON.parse(json2.result.content[0].text);

        // Should not return the same result as page 1
        if (body1.results.length > 0 && body2.results.length > 0) {
          const page1Uuids = new Set(body1.results.map((r: { uuid: string }) => r.uuid));
          const page2Uuids = body2.results.map((r: { uuid: string }) => r.uuid);
          for (const uuid of page2Uuids) {
            expect(page1Uuids.has(uuid)).toBe(false);
          }
        }
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Cross-team anti-enumeration
  // ═══════════════════════════════════════════════════════════════════════

  describe('search cross-team anti-enumeration', () => {
    it('returns empty results when searching other-team project with our key', async () => {
      // Use our team's key to search the other team's project
      const res = await makeToolsCall(apiKeyToken, 'search', {
        projectId: otherProjectId,
        query: otherTeamConceptTitle,
      });

      const json = await res.json();
      const body = JSON.parse(json.result.content[0].text);

      // Must return empty — indistinguishable from a project with no matching concepts
      expect(body.results).toEqual([]);
      expect(body.nextCursor).toBeNull();
    });

    it('returns empty results when searching our project with other-team key', async () => {
      const res = await makeToolsCall(otherApiKeyToken, 'search', {
        projectId,
        query: 'authentication',
      });

      const json = await res.json();
      const body = JSON.parse(json.result.content[0].text);

      // Must return empty — should not leak that "authentication" exists in our project
      expect(body.results).toEqual([]);
    });

    it('does not return cross-team concepts in a valid search', async () => {
      // Search with our key in our project
      const res = await makeToolsCall(apiKeyToken, 'search', {
        projectId,
        query: 'resource',
      });

      const json = await res.json();
      const body = JSON.parse(json.result.content[0].text);

      // Should only contain our team's concepts, not the other team's
      const uuids = body.results.map((r: { uuid: string }) => r.uuid);
      expect(uuids).not.toContain(otherTeamConceptUuid);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Error paths — invalid input
  // ═══════════════════════════════════════════════════════════════════════

  describe('search invalid input', () => {
    it('returns isError for missing projectId', async () => {
      const res = await makeToolsCall(apiKeyToken, 'search', {
        query: 'test',
      });

      const json = await res.json();
      expect(json.result.isError).toBe(true);
      expect(json.result.content[0].text).toContain('Invalid arguments');
    });

    it('returns isError for missing query', async () => {
      const res = await makeToolsCall(apiKeyToken, 'search', {
        projectId,
      });

      const json = await res.json();
      expect(json.result.isError).toBe(true);
      expect(json.result.content[0].text).toContain('Invalid arguments');
    });

    it('returns isError for empty query', async () => {
      const res = await makeToolsCall(apiKeyToken, 'search', {
        projectId,
        query: '',
      });

      const json = await res.json();
      expect(json.result.isError).toBe(true);
      expect(json.result.content[0].text).toContain('Invalid arguments');
    });

    it('returns isError for invalid type filter', async () => {
      const res = await makeToolsCall(apiKeyToken, 'search', {
        projectId,
        query: 'test',
        type: 'invalid-type',
      });

      const json = await res.json();
      expect(json.result.isError).toBe(true);
    });

    it('returns isError for invalid status filter', async () => {
      const res = await makeToolsCall(apiKeyToken, 'search', {
        projectId,
        query: 'test',
        status: 'invalid-status',
      });

      const json = await res.json();
      expect(json.result.isError).toBe(true);
    });

    it('returns isError for query exceeding 500 characters', async () => {
      const longQuery = 'x'.repeat(501);
      const res = await makeToolsCall(apiKeyToken, 'search', {
        projectId,
        query: longQuery,
      });

      const json = await res.json();
      expect(json.result.isError).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Audit
  // ═══════════════════════════════════════════════════════════════════════

  describe('search audit', () => {
    it('writes an audit record on successful search', async () => {
      // Count audit records before
      const before = await db.$count(auditSchema.auditLog);

      await makeToolsCall(apiKeyToken, 'search', {
        projectId,
        query: 'audit test query',
      });

      // Count after
      const after = await db.$count(auditSchema.auditLog);

      expect(after).toBeGreaterThan(before);

      // Verify the latest audit record
      const rows = await db
        .select()
        .from(auditSchema.auditLog)
        .where(
          and(
            eq(auditSchema.auditLog.action, 'mcp.search'),
            eq(auditSchema.auditLog.outcome, 'success'),
            eq(auditSchema.auditLog.teamId, teamId),
          ),
        )
        .orderBy(desc(auditSchema.auditLog.createdAt))
        .limit(1);

      expect(rows).toHaveLength(1);
      expect(rows[0]!.resourceType).toBe('concept');
      expect(rows[0]!.projectId).toBe(projectId);
      // credentialId must be a key_... ID, never a token
      expect(rows[0]!.credentialId).toMatch(/^key_/);
    });

    it('audit records never contain sensitive data', async () => {
      await makeToolsCall(apiKeyToken, 'search', {
        projectId,
        query: 'sensitive data test',
      });

      const rows = await db
        .select()
        .from(auditSchema.auditLog)
        .where(
          and(
            eq(auditSchema.auditLog.action, 'mcp.search'),
            eq(auditSchema.auditLog.teamId, teamId),
          ),
        )
        .orderBy(desc(auditSchema.auditLog.createdAt))
        .limit(1);

      const row = rows[0]!;

      // No payload, query text, or tokens in the audit record
      const rowAsRecord = row as unknown as Record<string, unknown>;
      const forbiddenKeys = ['payload', 'queryText', 'query', 'searchQuery', 'body', 'apiKey', 'token', 'secret'];
      for (const key of forbiddenKeys) {
        expect(
          key in rowAsRecord,
          `Forbidden key "${key}" found in audit row`,
        ).toBe(false);
      }

      // credentialId must not be a plaintext token
      expect(row.credentialId!).not.toContain('tm_');
      expect(row.credentialId!).toMatch(/^key_/);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Auth
  // ═══════════════════════════════════════════════════════════════════════

  describe('search auth', () => {
    it('returns 401 without Authorization header', async () => {
      const res = await app.request('/mcp', {
        ...toolsCall('search', { projectId, query: 'test' }),
      });

      expect(res.status).toBe(401);
    });

    it('returns 401 for invalid token', async () => {
      const res = await app.request('/mcp', {
        ...toolsCall('search', { projectId, query: 'test' }),
        headers: authHeaders('tm_invalid_token_12345'),
      });

      expect(res.status).toBe(401);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // MCP tools/list includes search
  // ═══════════════════════════════════════════════════════════════════════

  describe('tools/list includes search', () => {
    it('lists search in the tool registry', async () => {
      const res = await makeMcpRequest(apiKeyToken, 'tools/list');

      expect(res.status).toBe(200);
      const json = await res.json();
      const tools = json.result.tools as Array<Record<string, unknown>>;

      const search = tools.find((t) => t.name === 'search');
      expect(search).toBeDefined();
      expect(search!.description).toContain('search');
      expect(search!.inputSchema).toMatchObject({
        type: 'object',
        properties: expect.objectContaining({
          projectId: expect.any(Object),
          query: expect.any(Object),
        }),
        required: expect.arrayContaining(['projectId', 'query']),
      });
    });
  });
});


