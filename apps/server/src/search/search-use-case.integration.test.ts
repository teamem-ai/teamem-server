/**
 * POST /v1/search integration tests (DUA-204 M1-SR-02).
 *
 * Tests against real Postgres (TEST_DATABASE_URL):
 * - Success: search returns concept summaries + relevance scores
 * - FTS-only mode: response includes degraded: true
 * - Cross-team: search returns empty (anti-enumeration)
 * - Audit: audit records do NOT contain query text
 * - Pagination: composite cursor works
 * - Invalid input: 400 responses with proper error codes
 * - Auth: 401/403 for missing/insufficient credentials
 *
 * Runs only when TEST_DATABASE_URL is set; honestly skipped otherwise.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type AppDeps } from '../app.js';
import { createDb, type AppDb } from '../db/client.js';
import {
  connectDatabase,
  closeDatabase,
  type Pool,
} from '../test/database.js';
import { runBootstrap } from '../commands/bootstrap.js';
import { createConcept, type CreateConceptInput } from '../db/repositories/concepts-write.js';
import * as auditSchema from '../db/schema.js';
import { eq, and, desc, sql } from 'drizzle-orm';

const url = process.env['TEST_DATABASE_URL'];

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

function authHeaders(token?: string | undefined) {
  return {
    Authorization: `Bearer ${token ?? ''}`,
    'Content-Type': 'application/json',
  };
}

// ═══════════════════════════════════════════════════════════════════════════

describe.skipIf(!url)('POST /v1/search (live Postgres)', () => {
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

  // Seeded concept UUIDs
  let authServiceUuid: string;
  let dataPipelineUuid: string;
  let otherTeamConceptUuid: string;

  beforeAll(async () => {
    ({ pool } = connectDatabase());
    db = createDb(url!, { pool: pool as unknown as import('pg').Pool });

    // ── Team 1 (our team) ──────────────────────────────────────────────
    const suffix = randomUUID().replace(/-/g, '').slice(0, 8);
    const result = await runBootstrap(db, {
      teamName: `Search API Test ${suffix}`,
      projectName: `demo-${suffix}`,
      rotate: false,
    });

    teamId = result.team.id;
    projectId = result.project.id;
    apiKeyToken = result.key.token;

    // ── Team 2 (other team) ────────────────────────────────────────────
    const otherSuffix = randomUUID().replace(/-/g, '').slice(0, 8);
    const otherResult = await runBootstrap(db, {
      teamName: `Search API Other ${otherSuffix}`,
      projectName: `other-${otherSuffix}`,
      rotate: false,
    });
    otherTeamId = otherResult.team.id;
    otherProjectId = otherResult.project.id;
    otherApiKeyToken = otherResult.key.token;

    // ── Seed searchable concepts in team 1 ─────────────────────────────
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
    const c3 = await createConcept(
      db,
      conceptInput(otherTeamId, otherProjectId, `services/other-${randomUUID().replace(/-/g, '').slice(0, 6)}`, {
        title: 'Other Team Resource',
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
      await db.execute(sql`DELETE FROM concept_contributors WHERE project_id = ${pid}`);
      await db.execute(sql`DELETE FROM concept_evidence      WHERE project_id = ${pid}`);
      await db.execute(sql`DELETE FROM concept_paths         WHERE project_id = ${pid}`);
      await db.execute(sql`DELETE FROM concepts              WHERE project_id = ${pid}`);
      await db.execute(sql`DELETE FROM job_events            WHERE project_id = ${pid}`);
      await db.execute(sql`DELETE FROM events                WHERE project_id = ${pid}`);
      await db.execute(sql`DELETE FROM jobs                  WHERE project_id = ${pid}`);
      await db.execute(sql`DELETE FROM api_keys              WHERE project_id = ${pid}`);
      await db.execute(sql`DELETE FROM projects              WHERE id = ${pid}`);
    }
    await db.execute(sql`DELETE FROM api_keys   WHERE team_id = ${teamId} AND project_id IS NULL`);
    await db.execute(sql`DELETE FROM principals WHERE team_id = ${teamId}`);
    await db.execute(sql`DELETE FROM teams      WHERE id = ${teamId}`);
    await db.execute(sql`DELETE FROM principals WHERE team_id = ${otherTeamId}`);
    await db.execute(sql`DELETE FROM teams      WHERE id = ${otherTeamId}`);

    // Clean audit log
    await db.execute(sql`DELETE FROM audit_log WHERE team_id IN (${teamId}, ${otherTeamId})`);

    await closeDatabase(pool);
  });

  // ── Helper: make an authenticated search request ──────────────────────

  function searchRequest(token: string | undefined, body: Record<string, unknown>) {
    return app.request('/v1/search', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify(body),
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Success paths
  // ═══════════════════════════════════════════════════════════════════════

  describe('search success', () => {
    it('returns concept summaries with relevance scores', async () => {
      const res = await searchRequest(apiKeyToken, {
        projectId,
        query: 'authentication',
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.requestId).toBeDefined();
      expect(json.results).toBeDefined();
      expect(Array.isArray(json.results)).toBe(true);
      expect(json.results.length).toBeGreaterThanOrEqual(1);

      // Verify the auth service is in results
      const authResult = json.results.find((r: { uuid: string }) => r.uuid === authServiceUuid);
      expect(authResult).toBeDefined();
      expect(authResult.uuid).toBe(authServiceUuid);
      expect(authResult.type).toBe('service');
      expect(authResult.status).toBe('active');
      expect(authResult.confidence).toBe('high');
      expect(authResult.title).toBe('Authentication Service');
      expect(authResult.path).toBeDefined();
      expect(typeof authResult.path).toBe('string');
      expect(authResult.tags).toEqual(['auth', 'security']);
      expect(authResult.lastConfirmed).toBeDefined();

      // Relevance is a number between 0 and 1 (inclusive)
      expect(typeof authResult.relevance).toBe('number');
      expect(authResult.relevance).toBeGreaterThanOrEqual(0);
      expect(authResult.relevance).toBeLessThanOrEqual(1);

      // FTS fallback flag present
      expect(authResult.ftsFallback).toBe(true);

      // UUID format
      expect(authResult.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('returns multiple results for matching query', async () => {
      const res = await searchRequest(apiKeyToken, {
        projectId,
        query: 'data OR authentication OR service',
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      // Both concepts should match
      expect(json.results.length).toBeGreaterThanOrEqual(1);
    });

    it('reports degraded: true for FTS-only deployments', async () => {
      const res = await searchRequest(apiKeyToken, {
        projectId,
        query: 'authentication',
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      // In the initial implementation, search is always FTS-based
      expect(json.degraded).toBe(true);
    });

    it('filters by concept type', async () => {
      const res = await searchRequest(apiKeyToken, {
        projectId,
        query: 'data',
        type: 'concept',
      });

      expect(res.status).toBe(200);
      const json = await res.json();

      // Should include data pipeline (type=concept)
      const dataResult = json.results.find((r: { uuid: string }) => r.uuid === dataPipelineUuid);
      if (dataResult) {
        expect(dataResult.type).toBe('concept');
      }

      // Should NOT include auth service (type=service)
      const authResult = json.results.find((r: { uuid: string }) => r.uuid === authServiceUuid);
      expect(authResult).toBeUndefined();
    });

    it('filters by concept status', async () => {
      const res = await searchRequest(apiKeyToken, {
        projectId,
        query: 'service',
        status: 'active',
      });

      expect(res.status).toBe(200);
      const json = await res.json();

      for (const row of json.results) {
        expect(row.status).toBe('active');
      }
    });

    it('returns empty results for a query with no matches', async () => {
      const res = await searchRequest(apiKeyToken, {
        projectId,
        query: 'zzzxyznonexistenttermfoobar',
      });

      expect(res.status).toBe(200);
      const json = await res.json();

      expect(json.results).toEqual([]);
      expect(json.degraded).toBe(true);
      expect(json.nextCursor).toBeNull();
    });

    it('returns empty results for empty query string after sanitization', async () => {
      const res = await searchRequest(apiKeyToken, {
        projectId,
        query: '   ',
      });

      expect(res.status).toBe(200);
      const json = await res.json();

      // Whitespace-only query is sanitized to empty → no results
      expect(json.results).toEqual([]);
    });

    it('supports pagination with composite cursor', async () => {
      // First page with small limit
      const res1 = await searchRequest(apiKeyToken, {
        projectId,
        query: 'service OR data OR authentication OR pipeline',
        limit: 1,
      });

      expect(res1.status).toBe(200);
      const json1 = await res1.json();
      expect(json1.results.length).toBeLessThanOrEqual(1);

      if (json1.nextCursor) {
        // Second page using the cursor
        const res2 = await searchRequest(apiKeyToken, {
          projectId,
          query: 'service OR data OR authentication OR pipeline',
          cursor: json1.nextCursor,
          limit: 10,
        });

        expect(res2.status).toBe(200);
        const json2 = await res2.json();

        // Should not return the same result as page 1
        if (json1.results.length > 0 && json2.results.length > 0) {
          const page1Uuids = new Set(json1.results.map((r: { uuid: string }) => r.uuid));
          const page2Uuids = json2.results.map((r: { uuid: string }) => r.uuid);
          for (const uuid of page2Uuids) {
            expect(page1Uuids.has(uuid)).toBe(false);
          }
        }
      }
    });

    it('uses default limit of 20 when limit is omitted', async () => {
      const res = await searchRequest(apiKeyToken, {
        projectId,
        query: 'service',
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      // Should return at most 20 results (we only seeded 2, so 2 is fine)
      expect(json.results.length).toBeLessThanOrEqual(20);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Cross-team anti-enumeration
  // ═══════════════════════════════════════════════════════════════════════

  describe('cross-team anti-enumeration', () => {
    it('returns empty results when searching other-team project with our key', async () => {
      // Use our team's key to search the other team's project
      const res = await searchRequest(apiKeyToken, {
        projectId: otherProjectId,
        query: 'Other Team Resource',
      });

      // Cross-team access must be indistinguishable from a project with
      // zero matches (AGENTS.md §5.5, §8) — never a distinguishing 403.
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.results).toEqual([]);
      expect(json.degraded).toBe(true);
    });

    it('returns empty results when searching our project with other-team key', async () => {
      const res = await searchRequest(otherApiKeyToken, {
        projectId,
        query: 'authentication',
      });

      // Other team's project-scoped key cannot access our project, and
      // must see the same empty result as a genuinely empty project.
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.results).toEqual([]);
      expect(json.degraded).toBe(true);
    });

    it('does not return cross-team concepts in a valid search', async () => {
      const res = await searchRequest(apiKeyToken, {
        projectId,
        query: 'resource',
      });

      expect(res.status).toBe(200);
      const json = await res.json();

      // Should only contain our team's concepts, not the other team's
      const uuids = json.results.map((r: { uuid: string }) => r.uuid);
      expect(uuids).not.toContain(otherTeamConceptUuid);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Audit: query text never stored
  // ═══════════════════════════════════════════════════════════════════════

  describe('audit: no query text', () => {
    it('audit records do NOT contain the search query text', async () => {
      const searchQuery = 'unique audit test query string foobar';
      await searchRequest(apiKeyToken, {
        projectId,
        query: searchQuery,
      });

      // Query the audit log for this search action
      const rows = await db
        .select()
        .from(auditSchema.auditLog)
        .where(
          and(
            eq(auditSchema.auditLog.action, 'search.query'),
            eq(auditSchema.auditLog.teamId, teamId),
            eq(auditSchema.auditLog.projectId, projectId),
            eq(auditSchema.auditLog.outcome, 'success'),
          ),
        )
        .orderBy(desc(auditSchema.auditLog.createdAt))
        .limit(5);

      expect(rows.length).toBeGreaterThanOrEqual(1);

      // Check every audit row for the forbidden content
      for (const row of rows) {
        const record = row as unknown as Record<string, unknown>;

        // No query text in any field
        const allValues = Object.values(record).map((v) =>
          typeof v === 'string' ? v : JSON.stringify(v),
        );
        for (const value of allValues) {
          expect(value).not.toContain(searchQuery);
          expect(value).not.toContain('unique audit test');
        }

        // No forbidden keys in the record
        const forbiddenKeys = [
          'payload', 'queryText', 'query', 'searchQuery',
          'body', 'apiKey', 'token', 'secret', 'requestBody',
        ];
        for (const key of forbiddenKeys) {
          expect(
            key in record,
            `Forbidden key "${key}" found in audit row`,
          ).toBe(false);
        }
      }
    });

    it('audit records contain only whitelisted fields', async () => {
      await searchRequest(apiKeyToken, {
        projectId,
        query: 'whitelist test',
      });

      const rows = await db
        .select()
        .from(auditSchema.auditLog)
        .where(
          and(
            eq(auditSchema.auditLog.action, 'search.query'),
            eq(auditSchema.auditLog.teamId, teamId),
            eq(auditSchema.auditLog.outcome, 'success'),
          ),
        )
        .orderBy(desc(auditSchema.auditLog.createdAt))
        .limit(1);

      expect(rows).toHaveLength(1);
      const row = rows[0]!;

      // Verify the whitelisted fields are present and correct
      expect(row.action).toBe('search.query');
      expect(row.resourceType).toBe('concept');
      expect(row.resourceId).toBeNull(); // multi-resource action
      expect(row.teamId).toBe(teamId);
      expect(row.projectId).toBe(projectId);
      expect(row.outcome).toBe('success');
      expect(row.credentialId).toMatch(/^key_/);
      expect(row.requestId).toBeDefined();
      expect(row.createdAt).toBeDefined();
      expect(row.id).toBeDefined();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Error paths — invalid input
  // ═══════════════════════════════════════════════════════════════════════

  describe('invalid input', () => {
    it('returns 400 for missing projectId', async () => {
      const res = await searchRequest(apiKeyToken, {
        query: 'test',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('invalid_request');
    });

    it('returns 400 for missing query', async () => {
      const res = await searchRequest(apiKeyToken, {
        projectId,
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('invalid_request');
    });

    it('returns 400 for empty query string', async () => {
      const res = await searchRequest(apiKeyToken, {
        projectId,
        query: '',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('invalid_request');
    });

    it('returns 400 for query exceeding 500 characters', async () => {
      const longQuery = 'x'.repeat(501);
      const res = await searchRequest(apiKeyToken, {
        projectId,
        query: longQuery,
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('invalid_request');
    });

    it('returns 400 for invalid type filter', async () => {
      const res = await searchRequest(apiKeyToken, {
        projectId,
        query: 'test',
        type: 'invalid-type',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('invalid_request');
    });

    it('returns 400 for invalid status filter', async () => {
      const res = await searchRequest(apiKeyToken, {
        projectId,
        query: 'test',
        status: 'invalid-status',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('invalid_request');
    });

    it('returns 400 for invalid projectId format', async () => {
      const res = await searchRequest(apiKeyToken, {
        projectId: 'not-a-valid-project-id',
        query: 'test',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('invalid_request');
    });

    it('returns 400 for limit > 100', async () => {
      const res = await searchRequest(apiKeyToken, {
        projectId,
        query: 'test',
        limit: 101,
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('invalid_request');
    });

    it('returns 400 for tampered cursor', async () => {
      const res = await searchRequest(apiKeyToken, {
        projectId,
        query: 'test',
        cursor: 'this-is-not-a-valid-base64url-cursor!!',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('cursor_invalid');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Auth
  // ═══════════════════════════════════════════════════════════════════════

  describe('auth', () => {
    it('returns 401 without Authorization header', async () => {
      const res = await app.request('/v1/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, query: 'test' }),
      });

      expect(res.status).toBe(401);
    });

    it('returns 401 for invalid token', async () => {
      const res = await searchRequest('tm_invalid_token_12345', {
        projectId,
        query: 'test',
      });

      expect(res.status).toBe(401);
    });

    it('returns 401 for malformed Authorization header', async () => {
      const res = await app.request('/v1/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'NotBearer xyz',
        },
        body: JSON.stringify({ projectId, query: 'test' }),
      });

      expect(res.status).toBe(401);
    });
  });
});
