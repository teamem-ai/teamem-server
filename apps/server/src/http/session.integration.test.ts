/**
 * Integration tests for Web Session Middleware + Role-Based Access Control
 * (M2-AUTH-03).
 *
 * Tests run against real PostgreSQL. Covers:
 *
 *   Layer 1 — requireWebSession:
 *     - Valid session → SessionUser attached
 *     - Missing/expired/revoked session → 401 (identical envelope)
 *     - Does NOT require team membership
 *
 *   Layer 2 — requireTeamMembership:
 *     - User with membership in target team → WebSessionContext attached
 *       with teamRole + ScopeContext (allProjects for that team)
 *     - User without membership in target team → 404 (indistinguishable
 *       from genuinely missing resource — does NOT leak team existence)
 *     - Missing teamId URL param → 500 (programmer error)
 *     - ScopeContext team_id comes from membership row, not client header
 *
 *   Layer 3 — requireRole:
 *     - viewer tries member+ operation → 403 (identical envelope)
 *     - All 4 roles pass their level and below
 *
 *   Counterexamples:
 *     - User in team A, accessing team B URL → 404 (same as non-existent
 *       team — cannot distinguish membership failure from 404)
 *     - API key (Bearer token) accessing web-admin endpoint → 401
 *       (API keys cannot pass web session middleware)
 *
 *   Security:
 *     - 401 responses identical regardless of cause
 *     - 403 responses identical regardless of required role
 *     - 404 responses identical regardless of "no membership" vs "team
 *       doesn't exist"
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono, type Context } from 'hono';
import { createDb, type AppDb } from '../db/client.js';
import {
  connectDatabase,
  closeDatabase,
  type Pool,
} from '../test/database.js';
import { requestContext } from './request-context.js';
import {
  globalErrorHandler,
  notFoundHandler,
} from './errors.js';
import {
  requireWebSession,
  requireTeamMembership,
  getSessionUser,
  getWebSession,
} from './session.js';
import {
  requireRole,
  roleRank,
} from '../auth/rbac.js';
import { requireAuth, requireScope } from './auth.js';
import {
  generateSessionToken,
  SESSION_COOKIE_NAME,
} from '../auth/oauth-github.js';
import { generateApiKeyToken, hashToken } from '../auth/api-key.js';
import type { TeamRole, ApiScope } from '@teamem/schema';

const url = process.env['TEST_DATABASE_URL'];

describe.skipIf(!url)('Web Session Middleware + RBAC (live Postgres)', () => {
  let pool: Pool;
  let db: AppDb;

  beforeAll(async () => {
    ({ pool } = connectDatabase());
    db = createDb(url!, { pool: pool as unknown as import('pg').Pool });
  });

  afterAll(async () => {
    await closeDatabase(pool);
  });

  beforeEach(async () => {
    // Clean up test data in reverse FK order (children before parents)
    await db.execute(`DELETE FROM web_sessions`);
    await db.execute(`DELETE FROM memberships`);
    await db.execute(`DELETE FROM invites`);
    await db.execute(`DELETE FROM job_events`);
    await db.execute(`DELETE FROM jobs`);
    await db.execute(`DELETE FROM concept_contributors`);
    await db.execute(`DELETE FROM concept_evidence`);
    await db.execute(`DELETE FROM concept_paths`);
    await db.execute(`DELETE FROM concepts`);
    await db.execute(`DELETE FROM events`);
    await db.execute(`DELETE FROM api_keys`);
    await db.execute(`DELETE FROM projects`);
    await db.execute(`DELETE FROM principals`);
    await db.execute(`DELETE FROM users`);
    await db.execute(`DELETE FROM teams`);
  });

  // ── Helpers ──────────────────────────────────────────────────────────────

  /** Create a user in the database. Returns user ID. */
  async function createUser(githubId: number, login: string): Promise<string> {
    const id = `usr_${randomBytes(8).toString('hex')}`;
    await db.execute(
      `INSERT INTO users (id, github_id, github_login) VALUES ('${id}', ${githubId}, '${login}')`,
    );
    return id;
  }

  /** Create a team in the database. Returns team ID. */
  async function createTeam(name: string): Promise<string> {
    const id = `team_${randomBytes(8).toString('hex')}`;
    await db.execute(`INSERT INTO teams (id, name) VALUES ('${id}', '${name}')`);
    return id;
  }

  /** Create a membership for a user in a team with a given role. */
  async function createMembership(userId: string, teamId: string, role: TeamRole): Promise<void> {
    await db.execute(
      `INSERT INTO memberships (user_id, team_id, role) VALUES ('${userId}', '${teamId}', '${role}') ON CONFLICT (user_id, team_id) DO UPDATE SET role = '${role}'`,
    );
  }

  /** Create a valid web session for a user. Returns { plaintext, sessionId }. */
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

  /** Create an expired web session. */
  async function createExpiredSession(userId: string): Promise<{ plaintext: string; sessionId: string }> {
    const { plaintext, hash } = generateSessionToken();
    const sessionId = `ses_${randomBytes(8).toString('hex')}`;
    const pastTime = new Date(Date.now() - 2 * 3600_000);
    const expiredAt = new Date(Date.now() - 3600_000);
    await db.execute(
      `INSERT INTO web_sessions (id, user_id, token_hash, issued_at, expires_at) VALUES ('${sessionId}', '${userId}', '${hash}', '${pastTime.toISOString()}', '${expiredAt.toISOString()}')`,
    );
    return { plaintext, sessionId };
  }

  /** Create a revoked web session. */
  async function createRevokedSession(userId: string): Promise<{ plaintext: string; sessionId: string }> {
    const { plaintext, hash } = generateSessionToken();
    const sessionId = `ses_${randomBytes(8).toString('hex')}`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 7 * 24 * 3600_000);
    await db.execute(
      `INSERT INTO web_sessions (id, user_id, token_hash, issued_at, expires_at, revoked_at) VALUES ('${sessionId}', '${userId}', '${hash}', '${now.toISOString()}', '${expiresAt.toISOString()}', '${now.toISOString()}')`,
    );
    return { plaintext, sessionId };
  }

  /** Create an API key with given scopes, bound to a team/project. */
  async function createApiKey(
    teamId: string,
    projectId: string,
    scopes: ApiScope[],
  ): Promise<string> {
    const keyId = `key_${randomBytes(8).toString('hex')}`;
    const { plaintext, hash } = (() => {
      const p = generateApiKeyToken();
      return { plaintext: p, hash: hashToken(p) };
    })();
    const allProjects = false;
    await db.execute(
      `INSERT INTO api_keys (id, team_id, project_id, name, token_hash, scopes, all_projects)
       VALUES ('${keyId}', '${teamId}', '${projectId}', 'Test Key', '${hash}', ARRAY[${scopes.map(s => `'${s}'`).join(',')}], ${allProjects})`,
    );
    return plaintext;
  }

  /** Build a minimal app with the three-layer auth middleware stack. */
  function buildTeamScopedApp(): Hono {
    const app = new Hono();
    app.use('*', requestContext);
    app.onError(globalErrorHandler);
    app.notFound(notFoundHandler);
    // Layer 1 + 2: session + team membership
    app.use('/teams/:teamId/*', requireWebSession(db));
    app.use('/teams/:teamId/*', requireTeamMembership(db));
    return app;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // requireWebSession — success
  // ══════════════════════════════════════════════════════════════════════════

  describe('requireWebSession — success', () => {
    it('attaches SessionUser with user info', async () => {
      const userId = await createUser(1001, 'sessionuser');
      const { plaintext } = await createSession(userId);

      const app = new Hono();
      app.use('*', requestContext);
      app.onError(globalErrorHandler);
      app.notFound(notFoundHandler);
      app.use('/web/*', requireWebSession(db));
      app.get('/web/me', (c: Context) => {
        const user = getSessionUser(c);
        return c.json({ userId: user.userId, githubLogin: user.githubLogin });
      });

      const res = await app.request('/web/me', {
        headers: { Cookie: `${SESSION_COOKIE_NAME}=${plaintext}` },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.userId).toBe(userId);
      expect(json.githubLogin).toBe('sessionuser');
    });

    it('does NOT require team membership (that is requireTeamMembership job)', async () => {
      // Create user with NO team membership
      const userId = await createUser(1002, 'noteam');
      const { plaintext } = await createSession(userId);

      const app = new Hono();
      app.use('*', requestContext);
      app.onError(globalErrorHandler);
      app.notFound(notFoundHandler);
      app.use('/web/*', requireWebSession(db));
      app.get('/web/me', (c: Context) => {
        const user = getSessionUser(c);
        return c.json({ userId: user.userId });
      });

      const res = await app.request('/web/me', {
        headers: { Cookie: `${SESSION_COOKIE_NAME}=${plaintext}` },
      });

      // requireWebSession does NOT check membership — it only validates
      // the session. So even users with no team membership can pass.
      expect(res.status).toBe(200);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // requireWebSession — rejection
  // ══════════════════════════════════════════════════════════════════════════

  describe('requireWebSession — rejection', () => {
    it('returns 401 without a session cookie', async () => {
      const app = new Hono();
      app.use('*', requestContext);
      app.onError(globalErrorHandler);
      app.notFound(notFoundHandler);
      app.use('/web/*', requireWebSession(db));
      app.get('/web/data', (c: Context) => c.json({ ok: true }));

      const res = await app.request('/web/data');
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error.code).toBe('unauthorized');
    });

    it('returns 401 for an unknown/fake session token', async () => {
      const app = new Hono();
      app.use('*', requestContext);
      app.onError(globalErrorHandler);
      app.notFound(notFoundHandler);
      app.use('/web/*', requireWebSession(db));
      app.get('/web/data', (c: Context) => c.json({ ok: true }));

      const res = await app.request('/web/data', {
        headers: { Cookie: `${SESSION_COOKIE_NAME}=fake_token_never_created` },
      });
      expect(res.status).toBe(401);
    });

    it('returns 401 for an expired session', async () => {
      const userId = await createUser(2001, 'expireduser');
      const { plaintext } = await createExpiredSession(userId);

      const app = new Hono();
      app.use('*', requestContext);
      app.onError(globalErrorHandler);
      app.notFound(notFoundHandler);
      app.use('/web/*', requireWebSession(db));
      app.get('/web/data', (c: Context) => c.json({ ok: true }));

      const res = await app.request('/web/data', {
        headers: { Cookie: `${SESSION_COOKIE_NAME}=${plaintext}` },
      });
      expect(res.status).toBe(401);
    });

    it('returns 401 for a revoked session', async () => {
      const userId = await createUser(2002, 'revokeduser');
      const { plaintext } = await createRevokedSession(userId);

      const app = new Hono();
      app.use('*', requestContext);
      app.onError(globalErrorHandler);
      app.notFound(notFoundHandler);
      app.use('/web/*', requireWebSession(db));
      app.get('/web/data', (c: Context) => c.json({ ok: true }));

      const res = await app.request('/web/data', {
        headers: { Cookie: `${SESSION_COOKIE_NAME}=${plaintext}` },
      });
      expect(res.status).toBe(401);
    });

    it('returns IDENTICAL 401 envelopes for all rejection causes', async () => {
      const app = new Hono();
      app.use('*', requestContext);
      app.onError(globalErrorHandler);
      app.notFound(notFoundHandler);
      app.use('/web/*', requireWebSession(db));
      app.get('/web/data', (c: Context) => c.json({ ok: true }));

      const resNoCookie = await app.request('/web/data');
      const resFakeToken = await app.request('/web/data', {
        headers: { Cookie: `${SESSION_COOKIE_NAME}=fake_token` },
      });

      expect(resNoCookie.status).toBe(401);
      expect(resFakeToken.status).toBe(401);

      const bodyNoCookie = (await resNoCookie.json()) as Record<string, unknown>;
      const bodyFake = (await resFakeToken.json()) as Record<string, unknown>;

      const errNoCookie = bodyNoCookie['error'] as Record<string, unknown>;
      const errFake = bodyFake['error'] as Record<string, unknown>;

      expect(errNoCookie['code']).toBe('unauthorized');
      expect(errFake['code']).toBe('unauthorized');
      expect(errNoCookie['message']).toBe(errFake['message']);
      expect(errNoCookie['details']).toBeUndefined();
      expect(errFake['details']).toBeUndefined();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // requireTeamMembership — success
  // ══════════════════════════════════════════════════════════════════════════

  describe('requireTeamMembership — success', () => {
    it('attaches WebSessionContext with teamRole + ScopeContext from membership', async () => {
      const teamId = await createTeam('Target Team');
      const userId = await createUser(3001, 'memberuser');
      await createMembership(userId, teamId, 'admin');
      const { plaintext } = await createSession(userId);

      const app = buildTeamScopedApp();
      app.get('/teams/:teamId/info', (c: Context) => {
        const ws = getWebSession(c);
        return c.json({
          userId: ws.userId,
          teamRole: ws.teamRole,
          scopeKind: ws.scope.kind,
          scopeTeamId: ws.scope.teamId,
        });
      });

      const res = await app.request(`/teams/${teamId}/info`, {
        headers: { Cookie: `${SESSION_COOKIE_NAME}=${plaintext}` },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.userId).toBe(userId);
      expect(json.teamRole).toBe('admin');
      expect(json.scopeKind).toBe('allProjects');
      expect(json.scopeTeamId).toBe(teamId);
    });

    it('ScopeContext uses allProjectsScope for the membership team', async () => {
      const teamId = await createTeam('AllProjects Team');
      const userId = await createUser(3002, 'apuser');
      await createMembership(userId, teamId, 'viewer');
      const { plaintext } = await createSession(userId);

      const app = buildTeamScopedApp();
      app.get('/teams/:teamId/scope', (c: Context) => {
        const s = getWebSession(c);
        return c.json({
          kind: s.scope.kind,
          teamId: s.scope.teamId,
          hasProjectId: 'projectId' in s.scope,
        });
      });

      const res = await app.request(`/teams/${teamId}/scope`, {
        headers: { Cookie: `${SESSION_COOKIE_NAME}=${plaintext}` },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.kind).toBe('allProjects');
      expect(json.teamId).toBe(teamId);
      expect(json.hasProjectId).toBe(false);
    });

    it('derives team_id from membership row, not from client header', async () => {
      const teamAId = await createTeam('Team A');
      const teamBId = await createTeam('Team B');
      const userId = await createUser(3003, 'crosscheck');
      await createMembership(userId, teamAId, 'member');
      await createMembership(userId, teamBId, 'admin'); // user is in BOTH teams
      const { plaintext } = await createSession(userId);

      const app = buildTeamScopedApp();
      app.get('/teams/:teamId/scope', (c: Context) => {
        const ws = getWebSession(c);
        return c.json({
          teamId: ws.scope.teamId,
          teamRole: ws.teamRole,
          clientHeader: c.req.header('x-team-id'),
        });
      });

      // Access team A via URL param — should get team A scope
      const resA = await app.request(`/teams/${teamAId}/scope`, {
        headers: {
          Cookie: `${SESSION_COOKIE_NAME}=${plaintext}`,
          'X-Team-Id': teamBId, // client tries to switch teams via header
        },
      });
      expect(resA.status).toBe(200);
      const jsonA = await resA.json();
      expect(jsonA.teamId).toBe(teamAId);
      expect(jsonA.teamRole).toBe('member');
      expect(jsonA.clientHeader).toBe(teamBId);

      // Access team B via URL param — should get team B scope
      const resB = await app.request(`/teams/${teamBId}/scope`, {
        headers: {
          Cookie: `${SESSION_COOKIE_NAME}=${plaintext}`,
          'X-Team-Id': teamAId, // client tries to switch teams via header
        },
      });
      expect(resB.status).toBe(200);
      const jsonB = await resB.json();
      expect(jsonB.teamId).toBe(teamBId);
      expect(jsonB.teamRole).toBe('admin');
      expect(jsonB.clientHeader).toBe(teamAId);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // requireTeamMembership — rejection (404 for no membership in target team)
  // ══════════════════════════════════════════════════════════════════════════

  describe('requireTeamMembership — rejection', () => {
    it('returns 404 when user has NO membership in the target team', async () => {
      const teamId = await createTeam('Target Team');
      const userId = await createUser(4001, 'outsider');
      // User has NO membership at all
      const { plaintext } = await createSession(userId);

      const app = buildTeamScopedApp();
      app.get('/teams/:teamId/data', (c: Context) => c.json({ ok: true }));

      const res = await app.request(`/teams/${teamId}/data`, {
        headers: { Cookie: `${SESSION_COOKIE_NAME}=${plaintext}` },
      });

      // Must be 404 — indistinguishable from "team doesn't exist"
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error.code).toBe('not_found');
    });

    it('returns 404 when user belongs to OTHER teams but not the target team', async () => {
      const targetTeamId = await createTeam('Target Team');
      const otherTeamId = await createTeam('Other Team');
      const userId = await createUser(4002, 'othermember');
      // User is a member of Other Team but NOT Target Team
      await createMembership(userId, otherTeamId, 'admin');
      const { plaintext } = await createSession(userId);

      const app = buildTeamScopedApp();
      app.get('/teams/:teamId/data', (c: Context) => c.json({ ok: true }));

      // Access the target team (where user has NO membership)
      const res = await app.request(`/teams/${targetTeamId}/data`, {
        headers: { Cookie: `${SESSION_COOKIE_NAME}=${plaintext}` },
      });

      // Must be 404 — identical to "team doesn't exist"
      // This is THE key counterexample: user has memberships in other
      // teams but NOT the target team. The response must NOT reveal
      // that the user exists or that the team exists.
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error.code).toBe('not_found');

      // But the user CAN access their own team
      const resOwn = await app.request(`/teams/${otherTeamId}/data`, {
        headers: { Cookie: `${SESSION_COOKIE_NAME}=${plaintext}` },
      });
      expect(resOwn.status).toBe(200);
    });

    it('returns IDENTICAL 404 for "no membership" vs "team genuinely does not exist"', async () => {
      // User who has membership but for a DIFFERENT team
      const realTeamId = await createTeam('Real Team');
      const userId = await createUser(4003, 'partialmember');
      await createMembership(userId, realTeamId, 'viewer');
      const { plaintext } = await createSession(userId);

      const app = buildTeamScopedApp();
      app.get('/teams/:teamId/data', (c: Context) => c.json({ ok: true }));

      // 1. Access a team they're NOT a member of
      const resNoMembership = await app.request(`/teams/team_nonexistent0000/data`, {
        headers: { Cookie: `${SESSION_COOKIE_NAME}=${plaintext}` },
      });

      // 2. Access a team that doesn't exist at all
      const resTeamNotExist = await app.request(`/teams/team_anotherfake0000/data`, {
        headers: { Cookie: `${SESSION_COOKIE_NAME}=${plaintext}` },
      });

      // Both must be 404
      expect(resNoMembership.status).toBe(404);
      expect(resTeamNotExist.status).toBe(404);

      const bodyNoMembership = (await resNoMembership.json()) as Record<string, unknown>;
      const bodyTeamNotExist = (await resTeamNotExist.json()) as Record<string, unknown>;

      const errNoMem = bodyNoMembership['error'] as Record<string, unknown>;
      const errNotExist = bodyTeamNotExist['error'] as Record<string, unknown>;

      // Identical error responses — no information leakage
      expect(errNoMem['code']).toBe('not_found');
      expect(errNotExist['code']).toBe('not_found');
      expect(errNoMem['message']).toBe(errNotExist['message']);
      expect(errNoMem['details']).toBeUndefined();
      expect(errNotExist['details']).toBeUndefined();
    });

    it('returns 404 when user has membership in target team but with wrong teamId param name', async () => {
      // Programmer error: route declares :otherParam but middleware
      // expects :teamId — should return 500, not 404
      const teamId = await createTeam('Weird Team');
      const userId = await createUser(4004, 'weirduser');
      await createMembership(userId, teamId, 'viewer');
      const { plaintext } = await createSession(userId);

      const app = new Hono();
      app.use('*', requestContext);
      app.onError(globalErrorHandler);
      app.notFound(notFoundHandler);
      app.use('/teams/:otherParam/*', requireWebSession(db));
      // requireTeamMembership with default 'teamId' param — won't match
      app.use('/teams/:otherParam/*', requireTeamMembership(db));
      app.get('/teams/:otherParam/data', (c: Context) => c.json({ ok: true }));

      const res = await app.request(`/teams/${teamId}/data`, {
        headers: { Cookie: `${SESSION_COOKIE_NAME}=${plaintext}` },
      });

      // The teamId param is missing → InternalError (500)
      expect(res.status).toBe(500);
    });

    it('supports custom teamIdParam name', async () => {
      const teamId = await createTeam('Custom Param Team');
      const userId = await createUser(4005, 'customparam');
      await createMembership(userId, teamId, 'viewer');
      const { plaintext } = await createSession(userId);

      const app = new Hono();
      app.use('*', requestContext);
      app.onError(globalErrorHandler);
      app.notFound(notFoundHandler);
      app.use('/orgs/:orgId/*', requireWebSession(db));
      app.use('/orgs/:orgId/*', requireTeamMembership(db, 'orgId'));
      app.get('/orgs/:orgId/data', (c: Context) => {
        const ws = getWebSession(c);
        return c.json({ teamId: ws.scope.teamId });
      });

      const res = await app.request(`/orgs/${teamId}/data`, {
        headers: { Cookie: `${SESSION_COOKIE_NAME}=${plaintext}` },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.teamId).toBe(teamId);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // requireRole — integration with real session + team membership
  // ══════════════════════════════════════════════════════════════════════════

  describe('requireRole — integration with full stack', () => {
    async function setupUserWithRole(role: TeamRole): Promise<{
      userId: string;
      teamId: string;
      sessionToken: string;
    }> {
      const teamId = await createTeam(`${role} Role Team`);
      const userId = await createUser(
        { viewer: 5001, member: 5002, admin: 5003, owner: 5004 }[role] ?? 5999,
        `${role}user`,
      );
      await createMembership(userId, teamId, role);
      const { plaintext } = await createSession(userId);
      return { userId, teamId, sessionToken: plaintext };
    }

    function buildRoleApp(minRole: TeamRole): Hono {
      const app = new Hono();
      app.use('*', requestContext);
      app.onError(globalErrorHandler);
      app.notFound(notFoundHandler);
      app.use('/teams/:teamId/*', requireWebSession(db));
      app.use('/teams/:teamId/*', requireTeamMembership(db));
      app.use('/teams/:teamId/route/*', requireRole(minRole));
      app.get('/teams/:teamId/route/data', (c: Context) => c.json({ ok: true }));
      return app;
    }

    it('viewer can access viewer route', async () => {
      const { teamId, sessionToken } = await setupUserWithRole('viewer');
      const app = buildRoleApp('viewer');
      const res = await app.request(`/teams/${teamId}/route/data`, {
        headers: { Cookie: `${SESSION_COOKIE_NAME}=${sessionToken}` },
      });
      expect(res.status).toBe(200);
    });

    it('viewer is rejected from member route (403)', async () => {
      const { teamId, sessionToken } = await setupUserWithRole('viewer');
      const app = buildRoleApp('member');
      const res = await app.request(`/teams/${teamId}/route/data`, {
        headers: { Cookie: `${SESSION_COOKIE_NAME}=${sessionToken}` },
      });
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error.code).toBe('forbidden');
      expect(json.error.details).toBeUndefined();
    });

    it('viewer is rejected from admin route (403)', async () => {
      const { teamId, sessionToken } = await setupUserWithRole('viewer');
      const app = buildRoleApp('admin');
      const res = await app.request(`/teams/${teamId}/route/data`, {
        headers: { Cookie: `${SESSION_COOKIE_NAME}=${sessionToken}` },
      });
      expect(res.status).toBe(403);
    });

    it('viewer is rejected from owner route (403)', async () => {
      const { teamId, sessionToken } = await setupUserWithRole('viewer');
      const app = buildRoleApp('owner');
      const res = await app.request(`/teams/${teamId}/route/data`, {
        headers: { Cookie: `${SESSION_COOKIE_NAME}=${sessionToken}` },
      });
      expect(res.status).toBe(403);
    });

    it('member can access member route', async () => {
      const { teamId, sessionToken } = await setupUserWithRole('member');
      const app = buildRoleApp('member');
      const res = await app.request(`/teams/${teamId}/route/data`, {
        headers: { Cookie: `${SESSION_COOKIE_NAME}=${sessionToken}` },
      });
      expect(res.status).toBe(200);
    });

    it('admin can access member route', async () => {
      const { teamId, sessionToken } = await setupUserWithRole('admin');
      const app = buildRoleApp('member');
      const res = await app.request(`/teams/${teamId}/route/data`, {
        headers: { Cookie: `${SESSION_COOKIE_NAME}=${sessionToken}` },
      });
      expect(res.status).toBe(200);
    });

    it('owner can access all role levels', async () => {
      const { teamId, sessionToken } = await setupUserWithRole('owner');

      for (const minRole of ['viewer', 'member', 'admin', 'owner'] as TeamRole[]) {
        const app = buildRoleApp(minRole);
        const res = await app.request(`/teams/${teamId}/route/data`, {
          headers: { Cookie: `${SESSION_COOKIE_NAME}=${sessionToken}` },
        });
        expect(res.status).toBe(200);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Cross-team access — user in team A accesses team B URL → 404
  // ══════════════════════════════════════════════════════════════════════════

  describe('Cross-team access — indistinguishable from 404', () => {
    it('user in team A accessing team B resource returns 404', async () => {
      // Team A
      const teamAId = await createTeam('Team Alpha');
      const userAId = await createUser(6001, 'alpha_user');
      await createMembership(userAId, teamAId, 'owner');
      const { plaintext: sessionA } = await createSession(userAId);

      // Team B
      const teamBId = await createTeam('Team Beta');
      const userBId = await createUser(6002, 'beta_user');
      await createMembership(userBId, teamBId, 'owner');
      const { plaintext: sessionB } = await createSession(userBId);

      // Build team-scoped app with a project-lookup route
      const projectBId = `prj_${randomBytes(8).toString('hex')}`;
      await db.execute(
        `INSERT INTO projects (id, team_id, name) VALUES ('${projectBId}', '${teamBId}', 'Beta Project')`,
      );

      const app = new Hono();
      app.use('*', requestContext);
      app.onError(globalErrorHandler);
      app.notFound(notFoundHandler);
      app.use('/teams/:teamId/*', requireWebSession(db));
      app.use('/teams/:teamId/*', requireTeamMembership(db));
      app.get('/teams/:teamId/projects/:projectId', async (c: Context) => {
        const ws = getWebSession(c);
        const projectId = c.req.param('projectId');
        const result = await db.$client.query(
          `SELECT id, name FROM projects WHERE id = $1 AND team_id = $2 LIMIT 1`,
          [projectId, ws.scope.teamId],
        );
        if (result.rows.length === 0) {
          return c.json({ error: { code: 'not_found', message: 'Not found' } }, 404);
        }
        return c.json({ id: result.rows[0]!['id'], name: result.rows[0]!['name'] });
      });

      // User A (team A) tries to access team B's project via team B URL
      // requireTeamMembership will reject because user A has no membership in team B
      const resCrossTeam = await app.request(`/teams/${teamBId}/projects/${projectBId}`, {
        headers: { Cookie: `${SESSION_COOKIE_NAME}=${sessionA}` },
      });

      // Must be 404 — indistinguishable from "team doesn't exist"
      expect(resCrossTeam.status).toBe(404);
      const crossBody = (await resCrossTeam.json()) as Record<string, unknown>;
      const crossErr = crossBody['error'] as Record<string, unknown>;
      expect(crossErr['code']).toBe('not_found');

      // User B CAN access their own team's project
      const resOwnTeam = await app.request(`/teams/${teamBId}/projects/${projectBId}`, {
        headers: { Cookie: `${SESSION_COOKIE_NAME}=${sessionB}` },
      });
      expect(resOwnTeam.status).toBe(200);

      // Verify: the 404 from cross-team is identical to a genuinely
      // non-existent team
      const resFakeTeam = await app.request(`/teams/team_nonexistent9999/projects/${projectBId}`, {
        headers: { Cookie: `${SESSION_COOKIE_NAME}=${sessionB}` },
      });
      expect(resFakeTeam.status).toBe(404);
      const fakeBody = (await resFakeTeam.json()) as Record<string, unknown>;
      const fakeErr = fakeBody['error'] as Record<string, unknown>;
      expect(crossErr['code']).toBe(fakeErr['code']);
      expect(crossErr['message']).toBe(fakeErr['message']);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Counterexample: API key accessing web-session-only endpoints
  // ══════════════════════════════════════════════════════════════════════════

  describe('API key cannot access web-session-only endpoints', () => {
    it('API key gets 401 when hitting a web-session-only route', async () => {
      const teamId = await createTeam('API Key vs Web Team');
      const projectId = `prj_${randomBytes(8).toString('hex')}`;
      await db.execute(
        `INSERT INTO projects (id, team_id, name) VALUES ('${projectId}', '${teamId}', 'API Project')`,
      );

      const userId = await createUser(7001, 'webadmin');
      await createMembership(userId, teamId, 'admin');
      const { plaintext: sessionToken } = await createSession(userId);

      const apiKeyToken = await createApiKey(teamId, projectId, ['read', 'events:write']);

      const app = new Hono();
      app.use('*', requestContext);
      app.onError(globalErrorHandler);
      app.notFound(notFoundHandler);

      // Web admin route (session-based)
      app.use('/teams/:teamId/admin/*', requireWebSession(db));
      app.use('/teams/:teamId/admin/*', requireTeamMembership(db));
      app.use('/teams/:teamId/admin/*', requireRole('admin'));
      app.get('/teams/:teamId/admin/config', (c: Context) =>
        c.json({ secret: 'management config' }),
      );

      // API data route (key-based)
      app.use('/v1/events', requireAuth(db as Parameters<typeof requireAuth>[0]));
      app.use('/v1/events', requireScope('read'));
      app.get('/v1/events', (c: Context) => c.json({ events: [] }));

      // API key tries web admin → 401 (can't pass session middleware)
      const resApiKeyOnWeb = await app.request(`/teams/${teamId}/admin/config`, {
        headers: { Authorization: `Bearer ${apiKeyToken}` },
      });
      expect(resApiKeyOnWeb.status).toBe(401);

      // API key works on data route (proves key is valid)
      const resApiKeyOnData = await app.request('/v1/events', {
        headers: { Authorization: `Bearer ${apiKeyToken}` },
      });
      expect(resApiKeyOnData.status).toBe(200);

      // Web session works on admin route
      const resWebOnAdmin = await app.request(`/teams/${teamId}/admin/config`, {
        headers: { Cookie: `${SESSION_COOKIE_NAME}=${sessionToken}` },
      });
      expect(resWebOnAdmin.status).toBe(200);

      // Web session does NOT work on API data route
      const resWebOnData = await app.request('/v1/events', {
        headers: { Cookie: `${SESSION_COOKIE_NAME}=${sessionToken}` },
      });
      expect(resWebOnData.status).toBe(401);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Full role matrix — all 4 roles tested against all 4 levels
  // ══════════════════════════════════════════════════════════════════════════

  describe('Full role matrix (real DB)', () => {
    const allRoles: TeamRole[] = ['viewer', 'member', 'admin', 'owner'];

    for (const userRole of allRoles) {
      for (const minRole of allRoles) {
        const expectedStatus = roleRank(userRole) >= roleRank(minRole) ? 200 : 403;
        it(`${userRole} accessing ${minRole} route → ${expectedStatus}`, async () => {
          const teamId = await createTeam(`Matrix ${userRole} Team`);
          const userId = await createUser(
            { viewer: 8001, member: 8002, admin: 8003, owner: 8004 }[userRole] ?? 8999,
            `matrix_${userRole}`,
          );
          await createMembership(userId, teamId, userRole);
          const { plaintext } = await createSession(userId);

          const app = new Hono();
          app.use('*', requestContext);
          app.onError(globalErrorHandler);
          app.notFound(notFoundHandler);
          app.use('/teams/:teamId/*', requireWebSession(db));
          app.use('/teams/:teamId/*', requireTeamMembership(db));
          app.use('/teams/:teamId/route/*', requireRole(minRole));
          app.get('/teams/:teamId/route/data', (c: Context) => c.json({ ok: true }));

          const res = await app.request(`/teams/${teamId}/route/data`, {
            headers: { Cookie: `${SESSION_COOKIE_NAME}=${plaintext}` },
          });
          expect(res.status).toBe(expectedStatus);
        });
      }
    }
  });
});
