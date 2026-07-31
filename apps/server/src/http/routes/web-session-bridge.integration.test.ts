/**
 * Web Session Bridge integration tests — DUA-247 M2-AUTH-06.
 *
 * Verifies that concepts, search, and context data-plane read endpoints
 * accept web session cookies (not just Bearer API keys), with correct
 * role-based access control:
 *
 *   - viewer: concepts OK (200), search → 403, context → 403
 *   - member+: all three OK (200)
 *   - cross-team: indistinguishable from not-found (404 / empty 200)
 *   - no credentials → 401
 *   - API key with only 'read' scope → search still 200
 *
 * Tests against real PostgreSQL (TEST_DATABASE_URL). Skipped honestly
 * when TEST_DATABASE_URL is not set.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type AppDeps } from '../../app.js';
import { createDb, type AppDb } from '../../db/client.js';
import {
  connectDatabase,
  closeDatabase,
  type Pool,
} from '../../test/database.js';
import { runBootstrap } from '../../commands/bootstrap.js';
import {
  generateSessionToken,
  SESSION_COOKIE_NAME,
} from '../../auth/oauth-github.js';
import { generateApiKeyToken, hashToken } from '../../auth/api-key.js';
import type { TeamRole, ApiScope } from '@teamem/schema';
import { createConcept, type CreateConceptInput } from '../../db/repositories/concepts-write.js';

const url = process.env['TEST_DATABASE_URL'];

describe.skipIf(!url)('Web Session Bridge — concepts/search/context (live Postgres)', () => {
  let pool: Pool;
  let db: AppDb;
  let app: ReturnType<typeof buildApp>;

  // Primary team + project
  let teamId: string;
  let projectId: string;
  let apiKeyToken: string | undefined;

  // Users
  let viewerUserId: string;
  let memberUserId: string;
  let adminUserId: string;

  // Web sessions
  let viewerSession: { plaintext: string; sessionId: string };
  let memberSession: { plaintext: string; sessionId: string };
  let adminSession: { plaintext: string; sessionId: string };

  // Cross-team
  let otherTeamId: string;
  let otherProjectId: string;
  let outsiderUserId: string;
  let outsiderSession: { plaintext: string; sessionId: string };

  // API key with only 'read' scope (no read:payload)
  let readOnlyApiKey: string;

  // Seeded concept for detail tests
  let conceptUuid: string;
  let conceptPath: string;

  // ── Helpers ──────────────────────────────────────────────────────────

  function sessionCookie(plaintext: string): string {
    return `${SESSION_COOKIE_NAME}=${plaintext}`;
  }

  function authHeaders(token?: string) {
    return { Authorization: `Bearer ${token ?? apiKeyToken}` };
  }

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

  // ── Setup ────────────────────────────────────────────────────────────

  beforeAll(async () => {
    ({ pool } = connectDatabase());
    db = createDb(url!, { pool: pool as unknown as import('pg').Pool });

    // ── Bootstrap primary team + project ───────────────────────────
    const suffix = randomUUID().replace(/-/g, '').slice(0, 8);
    const result = await runBootstrap(db, {
      teamName: `WS Bridge Test ${suffix}`,
      projectName: `demo-${suffix}`,
      rotate: false,
    });
    teamId = result.team.id;
    projectId = result.project.id;
    apiKeyToken = result.key.token;

    // ── Bootstrap cross-team ───────────────────────────────────────
    const otherSuffix = randomUUID().replace(/-/g, '').slice(0, 8);
    const otherResult = await runBootstrap(db, {
      teamName: `WS Bridge Other ${otherSuffix}`,
      projectName: `other-${otherSuffix}`,
      rotate: false,
    });
    otherTeamId = otherResult.team.id;
    otherProjectId = otherResult.project.id;

    // ── Seed a concept for detail tests ────────────────────────────
    conceptPath = `services/bridge-test-${randomUUID().replace(/-/g, '').slice(0, 6)}`;
    const c = await createConcept(db, conceptInput(teamId, projectId, conceptPath, {
      title: 'Bridge Test Service',
      type: 'service',
      body: 'Used for web session bridge integration tests.',
      tags: ['test'],
    }));
    conceptUuid = c.uuid;

    // ── Create users ───────────────────────────────────────────────
    viewerUserId = await createUser(20001, 'viewer-bridge');
    memberUserId = await createUser(20002, 'member-bridge');
    adminUserId = await createUser(20003, 'admin-bridge');
    outsiderUserId = await createUser(20004, 'outsider-bridge');

    // ── Create memberships ─────────────────────────────────────────
    await createMembership(viewerUserId, teamId, 'viewer');
    await createMembership(memberUserId, teamId, 'member');
    await createMembership(adminUserId, teamId, 'admin');
    // outsider has membership only in the OTHER team
    await createMembership(outsiderUserId, otherTeamId, 'member');

    // ── Create web sessions ────────────────────────────────────────
    viewerSession = await createSession(viewerUserId);
    memberSession = await createSession(memberUserId);
    adminSession = await createSession(adminUserId);
    outsiderSession = await createSession(outsiderUserId);

    // ── Create read-only API key ───────────────────────────────────
    readOnlyApiKey = await createScopedApiKey(teamId, projectId, ['read']);

    // ── Build the app with real middleware ─────────────────────────
    const deps: AppDeps = { dbUrl: url, db };
    app = buildApp(deps);
  });

  afterAll(async () => {
    // Clean up in FK dependency order.
    for (const uid of [viewerUserId, memberUserId, adminUserId, outsiderUserId]) {
      await db.execute(`DELETE FROM web_sessions WHERE user_id = '${uid}'`);
    }
    for (const uid of [viewerUserId, memberUserId, adminUserId, outsiderUserId]) {
      await db.execute(`DELETE FROM memberships WHERE user_id = '${uid}'`);
    }
    for (const uid of [viewerUserId, memberUserId, adminUserId, outsiderUserId]) {
      await db.execute(`DELETE FROM users WHERE id = '${uid}'`);
    }
    for (const pid of [projectId, otherProjectId]) {
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
    await db.execute(`DELETE FROM api_keys WHERE team_id = '${teamId}' AND project_id IS NULL`);
    await db.execute(`DELETE FROM api_keys WHERE team_id = '${otherTeamId}' AND project_id IS NULL`);
    await db.execute(`DELETE FROM principals WHERE team_id = '${teamId}'`);
    await db.execute(`DELETE FROM teams WHERE id = '${teamId}'`);
    await db.execute(`DELETE FROM principals WHERE team_id = '${otherTeamId}'`);
    await db.execute(`DELETE FROM teams WHERE id = '${otherTeamId}'`);
    await closeDatabase(pool);
  });

  // ── DB helpers ─────────────────────────────────────────────────────────

  async function createUser(githubId: number, login: string): Promise<string> {
    const id = `usr_${randomBytes(8).toString('hex')}`;
    await db.execute(
      `INSERT INTO users (id, github_id, github_login) VALUES ('${id}', ${githubId}, '${login}')`,
    );
    return id;
  }

  async function createMembership(userId: string, tId: string, role: TeamRole): Promise<void> {
    await db.execute(
      `INSERT INTO memberships (user_id, team_id, role) VALUES ('${userId}', '${tId}', '${role}') ON CONFLICT (user_id, team_id) DO UPDATE SET role = '${role}'`,
    );
  }

  async function createSession(userId: string): Promise<{ plaintext: string; sessionId: string }> {
    const { plaintext, hash } = generateSessionToken();
    const sessionId = `ses_${randomBytes(8).toString('hex')}`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 7 * 24 * 3600_000);
    await db.execute(
      `INSERT INTO web_sessions (id, user_id, token_hash, issued_at, expires_at) VALUES ('${sessionId}', '${userId}', '${hash}', '${now.toISOString()}', '${expiresAt.toISOString()}')`,
    );
    return { plaintext, sessionId };
  }

  async function createScopedApiKey(
    tId: string,
    pId: string,
    scopes: ApiScope[],
  ): Promise<string> {
    const keyId = `key_${randomBytes(8).toString('hex')}`;
    const plaintext = generateApiKeyToken();
    const tokenHash = hashToken(plaintext);
    await db.execute(
      `INSERT INTO api_keys (id, team_id, project_id, name, token_hash, scopes, all_projects)
       VALUES ('${keyId}', '${tId}', '${pId}', 'Read-Only Key', '${tokenHash}', ARRAY[${scopes.map(s => `'${s}'`).join(',')}], false)`,
    );
    return plaintext;
  }

  // ══════════════════════════════════════════════════════════════════════
  // 1. No credentials → 401
  // ══════════════════════════════════════════════════════════════════════

  describe('no credentials', () => {
    it('GET /v1/concepts returns 401 without Bearer or cookie', async () => {
      const res = await app.request(`/v1/concepts?projectId=${projectId}`, { method: 'GET' });
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error.code).toBe('unauthorized');
    });

    it('POST /v1/search returns 401 without Bearer or cookie', async () => {
      const res = await app.request('/v1/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, query: 'test' }),
      });
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error.code).toBe('unauthorized');
    });

    it('GET /v1/context returns 401 without Bearer or cookie', async () => {
      const res = await app.request(`/v1/context?projectId=${projectId}`, { method: 'GET' });
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error.code).toBe('unauthorized');
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // 2. Invalid session → 401
  // ══════════════════════════════════════════════════════════════════════

  describe('invalid session', () => {
    it('GET /v1/concepts returns 401 with a garbage session cookie', async () => {
      const res = await app.request(`/v1/concepts?projectId=${projectId}`, {
        method: 'GET',
        headers: { Cookie: sessionCookie('not-a-real-session-token') },
      });
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error.code).toBe('unauthorized');
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // 3. Viewer role: concepts → 200, search → 403, context → 403
  // ══════════════════════════════════════════════════════════════════════

  describe('viewer web session', () => {
    it('GET /v1/concepts returns 200 with concept list', async () => {
      const res = await app.request(`/v1/concepts?projectId=${projectId}`, {
        method: 'GET',
        headers: { Cookie: sessionCookie(viewerSession.plaintext) },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data).toBeInstanceOf(Array);
      expect(json.data.length).toBeGreaterThanOrEqual(1);
      // Verify real data — our seeded concept
      const found = json.data.find((c: { uuid: string; path: string }) => c.uuid === conceptUuid);
      expect(found).toBeDefined();
      expect(found.path).toBe(conceptPath);
    });

    it('GET /v1/concepts/:uuid returns 200 with concept detail', async () => {
      const res = await app.request(`/v1/concepts/${conceptUuid}?projectId=${projectId}`, {
        method: 'GET',
        headers: { Cookie: sessionCookie(viewerSession.plaintext) },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.uuid).toBe(conceptUuid);
      expect(json.data.path).toBe(conceptPath);
    });

    it('POST /v1/search returns 403 for viewer', async () => {
      const res = await app.request('/v1/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: sessionCookie(viewerSession.plaintext),
        },
        body: JSON.stringify({ projectId, query: 'test' }),
      });
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error.code).toBe('forbidden');
    });

    it('GET /v1/context returns 403 for viewer', async () => {
      const res = await app.request(`/v1/context?projectId=${projectId}`, {
        method: 'GET',
        headers: { Cookie: sessionCookie(viewerSession.plaintext) },
      });
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error.code).toBe('forbidden');
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // 4. Member role: all three → 200
  // ══════════════════════════════════════════════════════════════════════

  describe('member web session', () => {
    it('GET /v1/concepts returns 200 with real data', async () => {
      const res = await app.request(`/v1/concepts?projectId=${projectId}`, {
        method: 'GET',
        headers: { Cookie: sessionCookie(memberSession.plaintext) },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.length).toBeGreaterThanOrEqual(1);
      const found = json.data.find((c: { uuid: string }) => c.uuid === conceptUuid);
      expect(found).toBeDefined();
    });

    it('POST /v1/search returns 200 for member', async () => {
      const res = await app.request('/v1/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: sessionCookie(memberSession.plaintext),
        },
        body: JSON.stringify({ projectId, query: 'bridge test' }),
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.requestId).toBeDefined();
      expect(json.results).toBeInstanceOf(Array);
      // May be degraded (no embedding client), but must not be a 403
    });

    it('GET /v1/context returns 200 for member', async () => {
      const res = await app.request(`/v1/context?projectId=${projectId}`, {
        method: 'GET',
        headers: { Cookie: sessionCookie(memberSession.plaintext) },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.markdown).toBeDefined();
      expect(typeof json.data.markdown).toBe('string');
      expect(json.data.conceptsAvailable).toBeGreaterThanOrEqual(1);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // 5. Admin role: all three → 200 (admin inherits member capabilities)
  // ══════════════════════════════════════════════════════════════════════

  describe('admin web session', () => {
    it('GET /v1/concepts returns 200 for admin', async () => {
      const res = await app.request(`/v1/concepts?projectId=${projectId}`, {
        method: 'GET',
        headers: { Cookie: sessionCookie(adminSession.plaintext) },
      });
      expect(res.status).toBe(200);
    });

    it('POST /v1/search returns 200 for admin', async () => {
      const res = await app.request('/v1/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: sessionCookie(adminSession.plaintext),
        },
        body: JSON.stringify({ projectId, query: 'test' }),
      });
      expect(res.status).toBe(200);
    });

    it('GET /v1/context returns 200 for admin', async () => {
      const res = await app.request(`/v1/context?projectId=${projectId}`, {
        method: 'GET',
        headers: { Cookie: sessionCookie(adminSession.plaintext) },
      });
      expect(res.status).toBe(200);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // 6. Cross-team: indistinguishable from not-found / empty
  // ══════════════════════════════════════════════════════════════════════

  describe('cross-team web session', () => {
    it('GET /v1/concepts returns 404 when user is not in the project team', async () => {
      // outsider is in otherTeamId, but we query teamId's project
      const res = await app.request(`/v1/concepts?projectId=${projectId}`, {
        method: 'GET',
        headers: { Cookie: sessionCookie(outsiderSession.plaintext) },
      });
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error.code).toBe('not_found');
    });

    it('POST /v1/search returns 404 when user is not in the project team (anti-enumeration)', async () => {
      // outsider's session is valid, but the projectId belongs to teamId,
      // not otherTeamId. The middleware resolves the project → other team,
      // finds no membership → 404.
      const res = await app.request('/v1/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: sessionCookie(outsiderSession.plaintext),
        },
        body: JSON.stringify({ projectId, query: 'test' }),
      });
      // Cross-team: membership check fails → 404 (anti-enumeration)
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error.code).toBe('not_found');
    });

    it('GET /v1/context returns 404 when user is not in the project team', async () => {
      const res = await app.request(`/v1/context?projectId=${projectId}`, {
        method: 'GET',
        headers: { Cookie: sessionCookie(outsiderSession.plaintext) },
      });
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error.code).toBe('not_found');
    });

    it('GET /v1/concepts returns 404 for non-existent project (identical to cross-team)', async () => {
      const res = await app.request('/v1/concepts?projectId=prj_nonexistent', {
        method: 'GET',
        headers: { Cookie: sessionCookie(memberSession.plaintext) },
      });
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error.code).toBe('not_found');
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // 7. API key regression: read-only key can still call search
  // ══════════════════════════════════════════════════════════════════════

  describe('API key regression', () => {
    it('read-only API key (no read:payload) can still call POST /v1/search', async () => {
      const res = await app.request('/v1/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders(readOnlyApiKey),
        },
        body: JSON.stringify({ projectId, query: 'bridge' }),
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.results).toBeInstanceOf(Array);
    });

    it('read-only API key can still call GET /v1/context', async () => {
      const res = await app.request(`/v1/context?projectId=${projectId}`, {
        method: 'GET',
        headers: authHeaders(readOnlyApiKey),
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.markdown).toBeDefined();
    });

    it('API key auth does not set teamRole (not in response, internal only)', async () => {
      // Just verifying the API key path still works end-to-end
      const res = await app.request(`/v1/concepts?projectId=${projectId}`, {
        method: 'GET',
        headers: authHeaders(readOnlyApiKey),
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data).toBeInstanceOf(Array);
    });

    it('existing bootstrap API key can still list concepts', async () => {
      const res = await app.request(`/v1/concepts?projectId=${projectId}`, {
        method: 'GET',
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // 8. POST body projectId extraction (search-specific)
  // ══════════════════════════════════════════════════════════════════════

  describe('POST body projectId extraction', () => {
    it('search finds projectId from POST body for web session', async () => {
      // This verifies the cloned-body extraction path in the middleware.
      // The request has no query param — only the JSON body carries projectId.
      const res = await app.request('/v1/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: sessionCookie(memberSession.plaintext),
        },
        body: JSON.stringify({ projectId, query: 'bridge' }),
      });
      expect(res.status).toBe(200);
    });

    it('search with projectId in both query string and body still works (query wins)', async () => {
      const res = await app.request(`/v1/search?projectId=${projectId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: sessionCookie(memberSession.plaintext),
        },
        body: JSON.stringify({ projectId: 'prj_ignored', query: 'bridge' }),
      });
      // Query param projectId takes precedence, body ignored
      expect(res.status).toBe(200);
    });
  });
});
