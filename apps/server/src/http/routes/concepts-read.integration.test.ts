/**
 * GET /v1/concepts/:uuid and GET /v1/concepts/by-path integration tests
 * (M0-READ-04).
 *
 * Tests the full HTTP read pipeline against real Postgres — validates
 * the frozen conceptDetailResponse DTO and 200/400/401/403/404 semantics.
 *
 * Runs only when TEST_DATABASE_URL is set; honestly skipped otherwise.
 * No mocked database — per project red line.
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

const url = process.env['TEST_DATABASE_URL'];

describe.skipIf(!url)('GET /v1/concepts (live Postgres)', () => {
  let pool: Pool;
  let db: AppDb;
  let app: ReturnType<typeof buildApp>;

  // Stable per-suite identity
  let teamId: string;
  let projectId: string;
  let apiKeyToken: string | undefined;

  // A second team + project for cross-tenant tests
  let otherTeamId: string;
  let otherProjectId: string;

  // Created concept UUIDs for detail tests
  let conceptUuid1: string;
  let conceptPath1: string;
  let conceptUuid2: string;
  let conceptPath2: string;

  beforeAll(async () => {
    ({ pool } = connectDatabase());
    db = createDb(url!, { pool: pool as unknown as import('pg').Pool });

    // ── Team 1 (our team) ──────────────────────────────────────────
    const suffix = randomUUID().replace(/-/g, '').slice(0, 8);
    const result = await runBootstrap(db, {
      teamName: `Concepts Read Test ${suffix}`,
      projectName: `demo-${suffix}`,
      rotate: false,
    });

    teamId = result.team.id;
    projectId = result.project.id;
    apiKeyToken = result.key.token;

    // ── Team 2 (other team — cross-tenant tests) ───────────────────
    const otherSuffix = randomUUID().replace(/-/g, '').slice(0, 8);
    const otherResult = await runBootstrap(db, {
      teamName: `Concepts Read Other ${otherSuffix}`,
      projectName: `other-${otherSuffix}`,
      rotate: false,
    });
    otherTeamId = otherResult.team.id;
    otherProjectId = otherResult.project.id;

    // ── Seed concept pages ─────────────────────────────────────────
    conceptPath1 = `services/auth-service-${randomUUID().replace(/-/g, '').slice(0, 6)}`;
    conceptPath2 = `decisions/use-postgres-${randomUUID().replace(/-/g, '').slice(0, 6)}`;

    const c1 = await createConcept(db, conceptInput(teamId, projectId, conceptPath1, {
      title: 'Auth Service',
      type: 'service',
      body: 'Handles authentication and authorization.',
      tags: ['auth', 'infra'],
    }));
    conceptUuid1 = c1.uuid;

    const c2 = await createConcept(db, conceptInput(teamId, projectId, conceptPath2, {
      title: 'Use Postgres',
      type: 'decision',
      body: 'We decided to use Postgres as the primary database.',
      tags: ['database', 'decision'],
    }));
    conceptUuid2 = c2.uuid;

    // ── Seed a concept in the other team (for cross-tenant tests) ─
    await createConcept(db, conceptInput(otherTeamId, otherProjectId,
      `services/other-service-${randomUUID().replace(/-/g, '').slice(0, 6)}`,
      { title: 'Other Team Service' },
    ));

    // ── Build the Hono app ─────────────────────────────────────────
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
      await db.execute(`DELETE FROM events                WHERE project_id = '${pid}'`);
      await db.execute(`DELETE FROM jobs                  WHERE project_id = '${pid}'`);
      await db.execute(`DELETE FROM api_keys              WHERE project_id = '${pid}'`);
      await db.execute(`DELETE FROM projects              WHERE id = '${pid}'`);
    }
    await db.execute(`DELETE FROM teams WHERE id = '${teamId}'`);
    await db.execute(`DELETE FROM teams WHERE id = '${otherTeamId}'`);
    await closeDatabase(pool);
  });

  // ── Helpers ──────────────────────────────────────────────────────────

  function conceptInput(
    tId: string,
    pId: string,
    path: string,
    overrides?: Partial<CreateConceptInput>,
  ): CreateConceptInput {
    return {
      teamId: tId,
      projectId: pId,
      schemaVersion: 1,
      type: 'service',
      status: 'active',
      confidence: 'high',
      title: 'Test Concept',
      body: 'Test body content.',
      firstSeen: new Date('2025-06-01T00:00:00.000Z'),
      lastConfirmed: new Date('2025-06-02T00:00:00.000Z'),
      path,
      evidence: [
        {
          kind: 'repo_file',
          repo: 'teamem-ai/teamem',
          commitSha: 'abc1234',
          path: 'src/index.ts',
          at: new Date('2025-06-01T00:00:00.000Z'),
        },
      ],
      contributors: [],
      ...overrides,
    };
  }

  function authHeaders(token?: string) {
    return {
      Authorization: `Bearer ${token ?? apiKeyToken}`,
    };
  }

  // ── Success: detail by UUID ──────────────────────────────────────────

  describe('GET /v1/concepts/:uuid', () => {
    it('returns 200 with full concept detail for a valid UUID', async () => {
      const res = await app.request(`/v1/concepts/${conceptUuid1}`, {
        headers: authHeaders(),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toMatchObject({
        requestId: expect.any(String),
        data: {
          uuid: conceptUuid1,
          path: conceptPath1,
          type: 'service',
          status: 'active',
          confidence: 'high',
          title: 'Auth Service',
          tags: ['auth', 'infra'],
          body: 'Handles authentication and authorization.',
          schemaVersion: 1,
          firstSeen: expect.any(String),
          lastConfirmed: expect.any(String),
          createdAt: expect.any(String),
          contributors: expect.any(Array),
          evidence: expect.any(Array),
          supersedes: null,
          aliases: expect.any(Array),
        },
      });

      // Verify evidence array is non-empty (red line: every page carries evidence)
      expect(json.data.evidence.length).toBeGreaterThanOrEqual(1);
      expect(json.data.evidence[0]).toMatchObject({
        kind: 'repo_file',
        repo: 'teamem-ai/teamem',
        commitSha: 'abc1234',
      });

      // Verify the response validates against conceptDetailResponse
      expect(json.data.schemaVersion).toBe(1);
      expect(json.data.uuid).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it('returns the same concept for a second valid UUID', async () => {
      const res = await app.request(`/v1/concepts/${conceptUuid2}`, {
        headers: authHeaders(),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.uuid).toBe(conceptUuid2);
      expect(json.data.path).toBe(conceptPath2);
      expect(json.data.type).toBe('decision');
    });

    it('returns current path and empty aliases for a new concept', async () => {
      const res = await app.request(`/v1/concepts/${conceptUuid1}`, {
        headers: authHeaders(),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.path).toBe(conceptPath1);
      expect(json.data.aliases).toEqual([]);
    });
  });

  // ── Success: detail by path ──────────────────────────────────────────

  describe('GET /v1/concepts/by-path', () => {
    it('returns 200 with concept detail for a current path', async () => {
      const res = await app.request(
        `/v1/concepts/by-path?path=${encodeURIComponent(conceptPath1)}`,
        { headers: authHeaders() },
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.uuid).toBe(conceptUuid1);
      expect(json.data.path).toBe(conceptPath1);
    });

    it('resolves the same canonical UUID via UUID and via path', async () => {
      const byUuid = await app.request(`/v1/concepts/${conceptUuid2}`, {
        headers: authHeaders(),
      });
      const byPath = await app.request(
        `/v1/concepts/by-path?path=${encodeURIComponent(conceptPath2)}`,
        { headers: authHeaders() },
      );

      expect(byUuid.status).toBe(200);
      expect(byPath.status).toBe(200);

      const uuidJson = await byUuid.json();
      const pathJson = await byPath.json();

      expect(uuidJson.data.uuid).toBe(conceptUuid2);
      expect(pathJson.data.uuid).toBe(conceptUuid2);
      expect(uuidJson.data.path).toBe(pathJson.data.path);
    });

    it('resolves a concept via a historical (alias) path', async () => {
      // Insert a non-current alias path directly into concept_paths.
      const aliasPath = `old-paths/former-name-${randomUUID().replace(/-/g, '').slice(0, 6)}`;
      await db.execute(
        `INSERT INTO concept_paths (team_id, project_id, concept_uuid, path, is_current)
         VALUES ('${teamId}', '${projectId}', '${conceptUuid1}', '${aliasPath}', false)`,
      );

      try {
        const res = await app.request(
          `/v1/concepts/by-path?path=${encodeURIComponent(aliasPath)}`,
          { headers: authHeaders() },
        );

        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.data.uuid).toBe(conceptUuid1);
        // The current path should still be the original one
        expect(json.data.path).toBe(conceptPath1);
        // The alias should appear in the aliases array
        expect(json.data.aliases).toContain(aliasPath);
      } finally {
        await db.execute(
          `DELETE FROM concept_paths WHERE path = '${aliasPath}'`,
        );
      }
    });
  });

  // ── Failure: 404 for missing / cross-team ────────────────────────────

  describe('404 — anti-enumeration', () => {
    it('returns 404 for a non-existent UUID', async () => {
      const nonExistent = randomUUID();
      const res = await app.request(`/v1/concepts/${nonExistent}`, {
        headers: authHeaders(),
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error.code).toBe('not_found');
    });

    it('returns 404 for a non-existent path', async () => {
      const res = await app.request(
        `/v1/concepts/by-path?path=${encodeURIComponent('nonexistent/path')}`,
        { headers: authHeaders() },
      );

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error.code).toBe('not_found');
    });

    it('returns 404 for a UUID that exists in another team (cross-tenant)', async () => {
      // Fetch the concept UUID from the other team
      const { rows } = await db.execute(
        `SELECT uuid FROM concepts WHERE team_id = '${otherTeamId}' LIMIT 1`,
      );
      const otherUuid = (rows[0] as Record<string, unknown>)['uuid'] as string;

      const res = await app.request(`/v1/concepts/${otherUuid}`, {
        headers: authHeaders(),
      });

      // Must be 404 — identical to genuinely missing, anti-enumeration
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error.code).toBe('not_found');

      // Verify the 404 body is the same shape as a genuinely missing resource
      const missingRes = await app.request(`/v1/concepts/${randomUUID()}`, {
        headers: authHeaders(),
      });
      expect(missingRes.status).toBe(404);
      const missingJson = await missingRes.json();
      expect(json.error).toEqual(missingJson.error);
    });

    it('returns 404 for a path that exists in another team (cross-tenant)', async () => {
      // Fetch a concept path from the other team
      const { rows } = await db.execute(
        `SELECT cp.path FROM concept_paths cp
         WHERE cp.team_id = '${otherTeamId}' LIMIT 1`,
      );
      const otherPath = (rows[0] as Record<string, unknown>)['path'] as string;

      const res = await app.request(
        `/v1/concepts/by-path?path=${encodeURIComponent(otherPath)}`,
        { headers: authHeaders() },
      );

      // Must be 404 — anti-enumeration
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error.code).toBe('not_found');
    });
  });

  // ── Failure: 400 for invalid inputs ──────────────────────────────────

  describe('400 — invalid inputs', () => {
    it('returns 400 for a malformed UUID', async () => {
      const res = await app.request('/v1/concepts/not-a-uuid', {
        headers: authHeaders(),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('invalid_request');
    });

    it('returns 400 when path query parameter is missing', async () => {
      const res = await app.request('/v1/concepts/by-path', {
        headers: authHeaders(),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('invalid_request');
    });

    it('returns 400 for invalid path syntax (uppercase)', async () => {
      const res = await app.request(
        '/v1/concepts/by-path?path=Services/API',
        { headers: authHeaders() },
      );

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('invalid_request');
    });

    it('returns 400 for invalid path syntax (leading slash)', async () => {
      const res = await app.request(
        '/v1/concepts/by-path?path=%2Fservices%2Fapi',
        { headers: authHeaders() },
      );

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('invalid_request');
    });

    it('returns 400 for path with .md suffix', async () => {
      const res = await app.request(
        '/v1/concepts/by-path?path=services/api.md',
        { headers: authHeaders() },
      );

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('invalid_request');
    });
  });

  // ── Failure: 401 / 403 ───────────────────────────────────────────────

  describe('401 / 403 — auth', () => {
    it('returns 401 when no Authorization header is present', async () => {
      const res = await app.request(`/v1/concepts/${conceptUuid1}`);

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error.code).toBe('unauthorized');
    });

    it('returns 401 for an unknown API key', async () => {
      const res = await app.request(`/v1/concepts/${conceptUuid1}`, {
        headers: {
          Authorization: 'Bearer tm_not_a_real_key_000000000000000000000000000000',
        },
      });

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error.code).toBe('unauthorized');
    });

    it('returns 403 when API key lacks read scope', async () => {
      // Create a key with only events:write (no read scope)
      const { generateApiKeyToken, hashToken } = await import(
        '../../auth/api-key.js'
      );
      const writeOnlyToken = generateApiKeyToken();
      const writeOnlyHash = hashToken(writeOnlyToken);

      const keyId = `key_writeonly_${randomUUID().replace(/-/g, '')}`;
      await db.execute(
        `INSERT INTO api_keys (id, team_id, project_id, name, token_hash, scopes, all_projects)
         VALUES ('${keyId}', '${teamId}', '${projectId}', 'Write-Only Key',
                 '${writeOnlyHash}', ARRAY['events:write']::text[], false)`,
      );

      try {
        const res = await app.request(`/v1/concepts/${conceptUuid1}`, {
          headers: { Authorization: `Bearer ${writeOnlyToken}` },
        });

        expect(res.status).toBe(403);
        const json = await res.json();
        expect(json.error.code).toBe('forbidden');
      } finally {
        await db.execute(`DELETE FROM api_keys WHERE id = '${keyId}'`);
      }
    });
  });

  // ── Response shape validation ────────────────────────────────────────

  describe('response shape (conceptDetailResponse)', () => {
    it('response matches the frozen conceptDetailResponse contract', async () => {
      const res = await app.request(`/v1/concepts/${conceptUuid1}`, {
        headers: authHeaders(),
      });

      expect(res.status).toBe(200);
      const json = await res.json();

      // Validate against the Zod schema from @teamem/schema
      const { conceptDetailResponse } = await import('@teamem/schema');
      const parsed = conceptDetailResponse.safeParse(json);
      expect(parsed.success).toBe(true);

      // Spot-check key fields match frozen contract
      const data = json.data;
      expect(typeof data.uuid).toBe('string');
      expect(typeof data.path).toBe('string');
      expect(['service', 'concept', 'decision', 'gotcha', 'convention', 'runbook']).toContain(data.type);
      expect(['active', 'superseded', 'disputed', 'needs-review']).toContain(data.status);
      expect(['high', 'medium', 'low']).toContain(data.confidence);
      expect(data.schemaVersion).toBe(1);
      expect(Array.isArray(data.evidence)).toBe(true);
      expect(data.evidence.length).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(data.contributors)).toBe(true);
      expect(Array.isArray(data.aliases)).toBe(true);
      expect(data.supersedes === null || typeof data.supersedes === 'string').toBe(true);
    });
  });
});
