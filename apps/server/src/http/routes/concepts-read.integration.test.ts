/**
 * Concept read integration tests — M0-READ-03 (list) + M0-READ-04 (detail).
 *
 * Tests against real Postgres (TEST_DATABASE_URL):
 *   List (M0-READ-03): scoped list, sorting, filtering, cursor pagination,
 *     cursor safety, query safety, auth/scope.
 *   Detail (M0-READ-04): by UUID, by path, cross-tenant 404, 400 validation,
 *     auth, response shape validation.
 *
 * Runs only when TEST_DATABASE_URL is set; honestly skipped otherwise.
 */
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
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

// ── Shared test app + data ──────────────────────────────────────────────────

describe.skipIf(!url)('Concepts Read (live Postgres)', () => {
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

  // For detail tests
  let conceptUuid1: string;
  let conceptPath1: string;
  let conceptUuid2: string;
  let conceptPath2: string;

  // For scope tests
  let otherProjectIdSameTeam: string;
  let allProjectsKey: string;

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

    // ── Another project in the same team (scope isolation) ─────────
    const apSuffix = randomUUID().replace(/-/g, '').slice(0, 8);
    otherProjectIdSameTeam = `prj_other${apSuffix}`;
    await db.execute(
      `INSERT INTO projects (id, team_id, name) VALUES ('${otherProjectIdSameTeam}', '${teamId}', 'Other Same-Team Project')`,
    );

    // ── All-projects key for scope tests ───────────────────────────
    allProjectsKey = await createAllProjectsKey(db, teamId);

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

    // Seed a concept in the other team (for cross-tenant tests).
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
    const ids = [projectId, otherProjectId, otherProjectIdSameTeam];
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

  // ═══════════════════════════════════════════════════════════════════════
  // Detail tests (M0-READ-04)
  // ═══════════════════════════════════════════════════════════════════════

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

      expect(json.data.evidence.length).toBeGreaterThanOrEqual(1);
      expect(json.data.evidence[0]).toMatchObject({
        kind: 'repo_file',
        repo: 'teamem-ai/teamem',
        commitSha: 'abc1234',
      });
      expect(json.data.schemaVersion).toBe(1);
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
  });

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

    it('returns the same canonical UUID via UUID and via path', async () => {
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
        expect(json.data.path).toBe(conceptPath1);
        expect(json.data.aliases).toContain(aliasPath);
      } finally {
        await db.execute(`DELETE FROM concept_paths WHERE path = '${aliasPath}'`);
      }
    });
  });

  describe('404 — anti-enumeration (detail)', () => {
    it('returns 404 for a non-existent UUID', async () => {
      const res = await app.request(`/v1/concepts/${randomUUID()}`, {
        headers: authHeaders(),
      });

      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe('not_found');
    });

    it('returns 404 for a non-existent path', async () => {
      const res = await app.request(
        `/v1/concepts/by-path?path=${encodeURIComponent('nonexistent/path')}`,
        { headers: authHeaders() },
      );

      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe('not_found');
    });

    it('returns 404 for a UUID in another team (cross-tenant)', async () => {
      const { rows } = await db.execute(
        `SELECT uuid FROM concepts WHERE team_id = '${otherTeamId}' LIMIT 1`,
      );
      const otherUuid = (rows[0] as Record<string, unknown>)['uuid'] as string;

      const res = await app.request(`/v1/concepts/${otherUuid}`, {
        headers: authHeaders(),
      });
      expect(res.status).toBe(404);

      // Verify identical body shape with genuinely missing resource.
      const missingRes = await app.request(`/v1/concepts/${randomUUID()}`, {
        headers: authHeaders(),
      });
      expect(missingRes.status).toBe(404);
      expect((await res.json()).error).toEqual((await missingRes.json()).error);
    });
  });

  describe('400 — invalid inputs (detail)', () => {
    it('returns 400 for a malformed UUID', async () => {
      const res = await app.request('/v1/concepts/not-a-uuid', { headers: authHeaders() });
      expect(res.status).toBe(400);
    });

    it('returns 400 when path query parameter is missing', async () => {
      const res = await app.request('/v1/concepts/by-path', { headers: authHeaders() });
      expect(res.status).toBe(400);
    });

    it('returns 400 for invalid path syntax (uppercase)', async () => {
      const res = await app.request('/v1/concepts/by-path?path=Services/API', { headers: authHeaders() });
      expect(res.status).toBe(400);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // List tests (M0-READ-03)
  // ═══════════════════════════════════════════════════════════════════════

  describe('GET /v1/concepts (list)', () => {
    it('returns concepts sorted by last_confirmed desc + uuid asc', async () => {
      const t1 = new Date('2025-03-01T00:00:00.000Z');
      const t2 = new Date('2025-03-02T00:00:00.000Z');
      const t3 = new Date('2025-03-03T00:00:00.000Z');

      const c1 = await seedConcept(db, teamId, projectId, { lastConfirmed: t1 });
      const c2 = await seedConcept(db, teamId, projectId, { lastConfirmed: t2 });
      const c3 = await seedConcept(db, teamId, projectId, { lastConfirmed: t3 });

      const res = await app.request(`/v1/concepts?projectId=${projectId}`, { headers: authHeaders() });
      expect(res.status).toBe(200);
      const data = (await res.json()).data as Array<Record<string, unknown>>;
      expect(data).toHaveLength(5); // 2 seeded + 3 new
      // The 3 new ones should be newest-first among themselves.
      const listUuids = data.map((d: Record<string, unknown>) => d.uuid as string);
      // c3 (newest) before c2 before c1
      const idx3 = listUuids.indexOf(c3.uuid);
      const idx2 = listUuids.indexOf(c2.uuid);
      const idx1 = listUuids.indexOf(c1.uuid);
      expect(idx3).toBeLessThan(idx2);
      expect(idx2).toBeLessThan(idx1);
    });

    it('returns concepts with the correct summary shape', async () => {
      const res = await app.request(`/v1/concepts?projectId=${projectId}`, { headers: authHeaders() });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.requestId).toBeTruthy();
      expect(Array.isArray(json.data)).toBe(true);
      expect(json.data.length).toBeGreaterThanOrEqual(2);
      const item = json.data[0];
      expect(typeof item.uuid).toBe('string');
      expect(typeof item.path).toBe('string');
      expect(['service', 'concept', 'decision', 'gotcha', 'convention', 'runbook']).toContain(item.type);
      expect(['active', 'superseded', 'disputed', 'needs-review']).toContain(item.status);
      expect(['high', 'medium', 'low']).toContain(item.confidence);
      expect(typeof item.title).toBe('string');
      expect(Array.isArray(item.tags)).toBe(true);
      expect(typeof item.lastConfirmed).toBe('string');
    });

    it('filters by type', async () => {
      const decision = await seedConcept(db, teamId, projectId, { type: 'decision' });
      await seedConcept(db, teamId, projectId, { type: 'service' });

      const res = await app.request(`/v1/concepts?projectId=${projectId}&type=decision`, { headers: authHeaders() });
      const data = (await res.json()).data as Array<Record<string, unknown>>;
      const uuids = data.map((d: Record<string, unknown>) => d.uuid as string);
      expect(uuids).toContain(decision.uuid);
      // All returned concepts should be type=decision.
      for (const d of data) {
        expect(d.type).toBe('decision');
      }
    });

    it('filters by status', async () => {
      const disputed = await seedConcept(db, teamId, projectId, { status: 'disputed' });
      await seedConcept(db, teamId, projectId, { status: 'active' });

      const res = await app.request(`/v1/concepts?projectId=${projectId}&status=disputed`, { headers: authHeaders() });
      const data = (await res.json()).data as Array<Record<string, unknown>>;
      const uuids = data.map((d: Record<string, unknown>) => d.uuid as string);
      expect(uuids).toContain(disputed.uuid);
      for (const d of data) {
        expect(d.status).toBe('disputed');
      }
    });

    it('filters by tag (GIN index)', async () => {
      const tagged = await seedConcept(db, teamId, projectId, { tags: ['production', 'critical'] });
      await seedConcept(db, teamId, projectId, { tags: ['development'] });

      const res = await app.request(`/v1/concepts?projectId=${projectId}&tag=critical`, { headers: authHeaders() });
      const data = (await res.json()).data as Array<Record<string, unknown>>;
      const uuids = data.map((d: Record<string, unknown>) => d.uuid as string);
      expect(uuids).toContain(tagged.uuid);
    });

    it('filters by contributor', async () => {
      const principalId = `pri_ctb${randomUUID().replace(/-/g, '').slice(0, 20)}`;
      await db.execute(
        `INSERT INTO principals (id, team_id, kind, provider, provider_kind, provider_user_id, display_login)
         VALUES ('${principalId}', '${teamId}', 'human', 'github', 'github', 'ctbuser${randomUUID().replace(/-/g, '').slice(0, 8)}', 'ctb_user')`,
      );

      const withContributor = await seedConcept(db, teamId, projectId, {
        contributors: [{ principalId, provenance: 'credential_bound' }],
      });
      await seedConcept(db, teamId, projectId, {});

      const res = await app.request(`/v1/concepts?projectId=${projectId}&contributor=${principalId}`, { headers: authHeaders() });
      expect(res.status).toBe(200);
      const data = (await res.json()).data as Array<Record<string, unknown>>;
      const uuids = data.map((d: Record<string, unknown>) => d.uuid as string);
      expect(uuids).toContain(withContributor.uuid);
    });

    it('paginates with composite cursor and stable sort', async () => {
      // Seed 5 concepts with distinct last_confirmed in a unique tag bucket.
      const bucket = `pagination-test-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
      const concepts = [];
      for (let i = 0; i < 5; i++) {
        concepts.push(await seedConcept(db, teamId, projectId, {
          lastConfirmed: new Date(`2026-01-0${i + 1}T00:00:00.000Z`),
          tags: [bucket],
        }));
      }

      // DESC: 5(i=4), 4(i=3), 3(i=2), 2(i=1), 1(i=0)
      const expected = [concepts[4]!, concepts[3]!, concepts[2]!, concepts[1]!, concepts[0]!];

      // Isolate with tag filter so we get exactly 5.
      const p1 = await app.request(`/v1/concepts?projectId=${projectId}&limit=2&tag=${bucket}`, { headers: authHeaders() });
      const j1 = await p1.json();
      expect(j1.data).toHaveLength(2);
      expect(j1.nextCursor).toBeTruthy();

      const p2 = await app.request(`/v1/concepts?projectId=${projectId}&limit=2&tag=${bucket}&cursor=${j1.nextCursor}`, { headers: authHeaders() });
      const j2 = await p2.json();
      expect(j2.data).toHaveLength(2);
      expect(j2.nextCursor).toBeTruthy();

      const p3 = await app.request(`/v1/concepts?projectId=${projectId}&limit=2&tag=${bucket}&cursor=${j2.nextCursor}`, { headers: authHeaders() });
      const j3 = await p3.json();
      expect(j3.data).toHaveLength(1);
      expect(j3.nextCursor).toBeNull();

      // Verify all 5 are covered across pages in correct order.
      const allUuids = [
        ...j1.data.map((d: Record<string, unknown>) => d.uuid),
        ...j2.data.map((d: Record<string, unknown>) => d.uuid),
        ...j3.data.map((d: Record<string, unknown>) => d.uuid),
      ];
      expect(allUuids).toHaveLength(5);
      expect(allUuids[0]).toBe(expected[0]!.uuid);
      expect(allUuids[1]).toBe(expected[1]!.uuid);
      expect(allUuids[2]).toBe(expected[2]!.uuid);
      expect(allUuids[3]).toBe(expected[3]!.uuid);
      expect(allUuids[4]).toBe(expected[4]!.uuid);
    });

    it('maintains stable order when concepts share last_confirmed (uuid tie-break)', async () => {
      const sameTime = new Date('2026-07-01T00:00:00.000Z');
      const bucket = `tiebreak-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
      await seedConcept(db, teamId, projectId, { lastConfirmed: sameTime, tags: [bucket] });
      await seedConcept(db, teamId, projectId, { lastConfirmed: sameTime, tags: [bucket] });
      await seedConcept(db, teamId, projectId, { lastConfirmed: sameTime, tags: [bucket] });

      // Isolate with tag filter to get exactly these 3.
      const res = await app.request(`/v1/concepts?projectId=${projectId}&tag=${bucket}&limit=10`, { headers: authHeaders() });
      const data = (await res.json()).data as Array<Record<string, unknown>>;
      expect(data).toHaveLength(3);
      // UUIDs should be in ascending order (tie-break).
      const uuids = data.map((d: Record<string, unknown>) => d.uuid as string);
      expect(uuids[0]! < uuids[1]!).toBe(true);
      expect(uuids[1]! < uuids[2]!).toBe(true);
    });

    it('rejects limit over 100 (contract Q11)', async () => {
      const res = await app.request(`/v1/concepts?projectId=${projectId}&limit=101`, { headers: authHeaders() });
      expect(res.status).toBe(400);
    });

    it('rejects unknown query parameter q= (no M0 text search)', async () => {
      const res = await app.request(`/v1/concepts?projectId=${projectId}&q=search`, { headers: authHeaders() });
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe('invalid_request');
    });

    it('rejects a tampered cursor', async () => {
      const res = await app.request(`/v1/concepts?projectId=${projectId}&cursor=not-valid!!!`, { headers: authHeaders() });
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe('cursor_invalid');
    });

    it('rejects cursor from different project', async () => {
      // Get cursor from project A using the allProjects key.
      const p1 = await app.request(`/v1/concepts?projectId=${projectId}&limit=1`, {
        headers: { Authorization: `Bearer ${allProjectsKey}` },
      });
      const cursor = (await p1.json()).nextCursor as string;
      expect(cursor).toBeTruthy();

      // Use on project B with same allProjects key — cursor project mismatch.
      const res = await app.request(`/v1/concepts?projectId=${otherProjectIdSameTeam}&cursor=${cursor}`, {
        headers: { Authorization: `Bearer ${allProjectsKey}` },
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe('cursor_invalid');
    });

    it('returns 401 without Authorization header', async () => {
      const res = await app.request(`/v1/concepts?projectId=${projectId}`);
      expect(res.status).toBe(401);
    });

    it('returns 403 for project-scoped key accessing different project', async () => {
      const res = await app.request(`/v1/concepts?projectId=${otherProjectIdSameTeam}`, { headers: authHeaders() });
      expect(res.status).toBe(403);
    });

    it('allows allProjects key to access any project in the team', async () => {
      const res = await app.request(`/v1/concepts?projectId=${projectId}`, {
        headers: { Authorization: `Bearer ${allProjectsKey}` },
      });
      expect(res.status).toBe(200);
    });

    it('returns 404 for cross-team project with allProjects key', async () => {
      const res = await app.request(`/v1/concepts?projectId=${otherProjectId}`, {
        headers: { Authorization: `Bearer ${allProjectsKey}` },
      });
      expect(res.status).toBe(404);
    });
  });

  describe('response shape validation', () => {
    it('list response matches the frozen conceptListResponse contract', async () => {
      const res = await app.request(`/v1/concepts?projectId=${projectId}`, { headers: authHeaders() });
      expect(res.status).toBe(200);

      const { conceptListResponse } = await import('@teamem/schema');
      const parsed = conceptListResponse.safeParse(await res.json());
      expect(parsed.success).toBe(true);
    });

    it('detail response matches the frozen conceptDetailResponse contract', async () => {
      const res = await app.request(`/v1/concepts/${conceptUuid1}`, { headers: authHeaders() });
      expect(res.status).toBe(200);

      const { conceptDetailResponse } = await import('@teamem/schema');
      const parsed = conceptDetailResponse.safeParse(await res.json());
      expect(parsed.success).toBe(true);
    });
  });
});

// ── Helpers outside describe for beforeEach cleanup isolation ──────────────

async function seedConcept(
  db: AppDb,
  teamId: string,
  projectId: string,
  overrides?: {
    type?: string;
    status?: string;
    confidence?: string;
    title?: string;
    tags?: string[];
    path?: string;
    lastConfirmed?: Date;
    contributors?: Array<{ principalId: string; provenance: 'webhook_verified' | 'credential_bound' | 'client_claimed' | 'unknown' }>;
  },
): Promise<{ uuid: string; path: string }> {
  const path = overrides?.path ?? `list-concept-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const input: CreateConceptInput = {
    teamId,
    projectId,
    schemaVersion: 1,
    type: (overrides?.type ?? 'concept') as CreateConceptInput['type'],
    status: (overrides?.status ?? 'active') as CreateConceptInput['status'],
    confidence: (overrides?.confidence ?? 'high') as CreateConceptInput['confidence'],
    title: overrides?.title ?? `Test Concept ${path}`,
    body: `Body for ${path}`,
    tags: overrides?.tags ?? [],
    firstSeen: new Date('2025-01-01T00:00:00.000Z'),
    lastConfirmed: overrides?.lastConfirmed ?? new Date('2025-01-01T00:00:00.000Z'),
    path,
    evidence: [
      {
        kind: 'mcp_write',
        ref: `evt_seed_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
        at: new Date('2025-01-01T00:00:00.000Z'),
      },
    ],
    contributors: overrides?.contributors ?? [],
  };

  const result = await createConcept(db, input);
  return { uuid: result.uuid, path };
}

function generateTestToken(): string {
  const bytes = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
  return `tm_${Buffer.from(bytes, 'utf8').toString('base64url').replace(/=/g, '').slice(0, 43)}`;
}

async function createAllProjectsKey(db: AppDb, teamId: string): Promise<string> {
  const plaintext = generateTestToken();
  const hash = createHash('sha256').update(plaintext, 'utf8').digest('hex');

  await db.execute(
    `INSERT INTO api_keys (id, team_id, project_id, name, token_hash, scopes, all_projects)
     VALUES ('key_all_${randomUUID().replace(/-/g, '').slice(0, 30)}', '${teamId}', NULL,
             'test-all-read-key', '${hash}', ARRAY['read'], true)`,
  );

  return plaintext;
}
