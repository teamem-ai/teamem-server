/**
 * Integration tests for Member & Role Management API (DUA-226 M2-AUTH-05).
 *
 * Covers:
 *   - GET /v1/members — list team members with principal linkage
 *   - PATCH /v1/members/:userId — change member role (owner only)
 *   - DELETE /v1/members/:userId — remove member (owner only)
 *   - Counterexamples:
 *     - Last owner cannot be demoted or removed (409 Conflict)
 *     - Non-owner (admin) cannot change roles or remove members (403 Forbidden)
 *     - Cross-team member access returns 404 indistinguishable from missing
 *     - Missing/invalid session returns 401
 *
 * Tests run against real PostgreSQL; all session operations use the
 * same session infrastructure tested in auth.integration.test.ts.
 *
 * Requires TEST_DATABASE_URL pointing to a Postgres instance with
 * migrations applied.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createDb, type AppDb } from '../../db/client.js';
import {
  connectDatabase,
  closeDatabase,
  type Pool,
} from '../../test/database.js';
import { buildMembersRoutes } from './members.js';
import { buildAuthRoutes } from './auth.js';
import type { GitHubOAuthConfig } from '../../auth/oauth-github.js';
import {
  generateSessionToken,
  SESSION_COOKIE_NAME,
} from '../../auth/oauth-github.js';
import { requestContext } from '../request-context.js';
import { globalErrorHandler, notFoundHandler } from '../errors.js';

const url = process.env['TEST_DATABASE_URL'];

describe.skipIf(!url)('Member & Role Management API (live Postgres)', () => {
  let pool: Pool;
  let db: AppDb;
  let app: Hono;

  // Test OAuth config (fake credentials; no real GitHub App needed for
  // these tests because we create sessions directly in the database).
  const oauthConfig: GitHubOAuthConfig = {
    clientId: 'Iv1.test_client_id',
    clientSecret: 'test_client_secret_for_member_tests',
    redirectUri: 'http://localhost:8080/auth/github/callback',
    serverBaseUrl: 'http://localhost:8080',
  };

  beforeAll(async () => {
    ({ pool } = connectDatabase());
    db = createDb(url!, { pool: pool as unknown as import('pg').Pool });

    // Build the Hono app with both auth and members routes.
    app = new Hono();
    app.use('*', requestContext);
    app.onError(globalErrorHandler);
    app.notFound(notFoundHandler);
    app.route('/', buildAuthRoutes(oauthConfig, db));
    app.route('/', buildMembersRoutes(oauthConfig, db));
  });

  afterAll(async () => {
    await closeDatabase(pool);
  });

  beforeEach(async () => {
    // Clean up test data in reverse FK order.
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

  const appRequest = (path: string, init?: RequestInit) =>
    app.request(path, init);

  /** Helper: create a user directly in DB. Returns { id, githubId, login, avatarUrl }. */
  async function createUser(
    githubId: number,
    login: string,
    avatarUrl?: string,
  ): Promise<{ id: string; githubId: number; login: string }> {
    const id = `usr_${randomBytes(8).toString('hex')}`;
    const avatarCol = avatarUrl ? `'${avatarUrl}'` : 'NULL';
    await db.execute(
      `INSERT INTO users (id, github_id, github_login, avatar_url) VALUES ('${id}', ${githubId}, '${login}', ${avatarCol})`,
    );
    return { id, githubId, login };
  }

  /** Helper: create a team directly in DB. Returns team id. */
  async function createTeam(name: string): Promise<string> {
    const id = `team_${randomBytes(8).toString('hex')}`;
    await db.execute(`INSERT INTO teams (id, name) VALUES ('${id}', '${name}')`);
    return id;
  }

  /** Helper: add a membership. */
  async function addMembership(userId: string, teamId: string, role: string): Promise<void> {
    await db.execute(
      `INSERT INTO memberships (user_id, team_id, role) VALUES ('${userId}', '${teamId}', '${role}')`,
    );
  }

  /** Helper: create a principal linked to a user. */
  async function createPrincipal(
    teamId: string,
    providerUserId: string,
    displayLogin: string,
  ): Promise<string> {
    const id = `pri_${randomBytes(8).toString('hex')}`;
    await db.execute(
      `INSERT INTO principals (id, team_id, kind, provider, provider_kind, provider_user_id, display_login)
       VALUES ('${id}', '${teamId}', 'human', 'github', 'github', '${providerUserId}', '${displayLogin}')`,
    );
    return id;
  }

  /** Helper: create a session for a user, returning the plaintext token. */
  async function createSession(userId: string): Promise<string> {
    const { plaintext, hash } = generateSessionToken();
    const sessionId = `ses_${randomBytes(8).toString('hex')}`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 7 * 24 * 3600_000);
    await db.execute(
      `INSERT INTO web_sessions (id, user_id, token_hash, issued_at, expires_at)
       VALUES ('${sessionId}', '${userId}', '${hash}', '${now.toISOString()}', '${expiresAt.toISOString()}')`,
    );
    return plaintext;
  }

  /** Build a Cookie header with the session token. */
  function sessionHeader(token: string): Record<string, string> {
    return { Cookie: `${SESSION_COOKIE_NAME}=${token}` };
  }

  /**
   * Full fixture: create team, owner user + session, optional additional
   * members. Returns { teamId, ownerUserId, ownerSession }.
   */
  async function setupTeam(
    members?: Array<{ githubId: number; login: string; role: string }>,
  ) {
    const teamId = await createTeam('Test Team');
    const owner = await createUser(1001, 'owneruser');
    await addMembership(owner.id, teamId, 'owner');
    const ownerSession = await createSession(owner.id);

    if (members) {
      for (const m of members) {
        const u = await createUser(m.githubId, m.login);
        await addMembership(u.id, teamId, m.role);
      }
    }

    return { teamId, ownerUserId: owner.id, ownerSession };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // GET /v1/members — success paths
  // ═══════════════════════════════════════════════════════════════════════════

  describe('GET /v1/members', () => {
    it('returns an empty list for user without a team', async () => {
      const user = await createUser(2001, 'orphan');
      const session = await createSession(user.id);

      const res = await appRequest('/v1/members', {
        headers: sessionHeader(session),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data).toEqual([]);
    });

    it('lists all team members in join order with roles', async () => {
      const { ownerSession } = await setupTeam([
        { githubId: 2002, login: 'member1', role: 'member' },
        { githubId: 2003, login: 'viewer1', role: 'viewer' },
      ]);

      const res = await appRequest('/v1/members', {
        headers: sessionHeader(ownerSession),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data).toHaveLength(3); // owner + 2 added

      // Owner should be first (oldest)
      expect(json.data[0]).toMatchObject({
        githubLogin: 'owneruser',
        role: 'owner',
      });
      expect(json.data[1]).toMatchObject({
        githubLogin: 'member1',
        role: 'member',
      });
      expect(json.data[2]).toMatchObject({
        githubLogin: 'viewer1',
        role: 'viewer',
      });

      // Every entry has expected shape
      for (const m of json.data) {
        expect(m).toHaveProperty('userId');
        expect(m.userId).toMatch(/^usr_/);
        expect(m).toHaveProperty('githubLogin');
        expect(m).toHaveProperty('avatarUrl');
        expect(m).toHaveProperty('role');
        expect(m).toHaveProperty('joinedAt');
        expect(m).toHaveProperty('principalId');
        expect(m).toHaveProperty('principalDisplayLogin');
      }
    });

    it('includes principal linkage when a matching principal exists', async () => {
      const teamId = await createTeam('PrincipalLink Team');
      const user = await createUser(3001, 'contributor');
      await addMembership(user.id, teamId, 'member');

      // Create a principal linked to this user's github_id
      const principalId = await createPrincipal(teamId, '3001', 'contributor');

      const session = await createSession(user.id);

      const res = await appRequest('/v1/members', {
        headers: sessionHeader(session),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data).toHaveLength(1);
      expect(json.data[0].principalId).toBe(principalId);
      expect(json.data[0].principalDisplayLogin).toBe('contributor');
    });

    it('returns null principalId when no matching principal exists', async () => {
      const teamId = await createTeam('NoPrincipal Team');
      const user = await createUser(3002, 'noprincipal');
      await addMembership(user.id, teamId, 'member');
      const session = await createSession(user.id);

      const res = await appRequest('/v1/members', {
        headers: sessionHeader(session),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data).toHaveLength(1);
      expect(json.data[0].principalId).toBeNull();
      expect(json.data[0].principalDisplayLogin).toBeNull();
    });

    it('a viewer can list members (any role can list)', async () => {
      const { teamId } = await setupTeam();
      const viewer = await createUser(3003, 'viewer');
      await addMembership(viewer.id, teamId, 'viewer');
      const viewerSession = await createSession(viewer.id);

      const res = await appRequest('/v1/members', {
        headers: sessionHeader(viewerSession),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // GET /v1/members — error / counterexample paths
  // ═══════════════════════════════════════════════════════════════════════════

  describe('GET /v1/members — counterexamples', () => {
    it('returns 401 for request without a session cookie', async () => {
      const res = await appRequest('/v1/members');
      expect(res.status).toBe(401);
    });

    it('returns 401 for request with a fake session token', async () => {
      const res = await appRequest('/v1/members', {
        headers: sessionHeader('fake_session_token'),
      });
      expect(res.status).toBe(401);
    });

    it('members list is scoped to the session team — never sees another team', async () => {
      // Team A with owner
      const { ownerSession } = await setupTeam();

      // Team B (different team, unknown to the session)
      const teamB = await createTeam('Team B');
      const userB = await createUser(4001, 'secretuser');
      await addMembership(userB.id, teamB, 'admin');

      // Owner of Team A lists members — should only see Team A members
      const res = await appRequest('/v1/members', {
        headers: sessionHeader(ownerSession),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      const logins = json.data.map((m: { githubLogin: string }) => m.githubLogin);
      expect(logins).toContain('owneruser');
      expect(logins).not.toContain('secretuser');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PATCH /v1/members/:userId — success paths
  // ═══════════════════════════════════════════════════════════════════════════

  describe('PATCH /v1/members/:userId — success paths', () => {
    it('owner can change a member role to admin', async () => {
      const { teamId, ownerSession } = await setupTeam();
      const member = await createUser(5001, 'memberuser');
      await addMembership(member.id, teamId, 'member');

      const res = await appRequest(`/v1/members/${member.id}`, {
        method: 'PATCH',
        headers: {
          ...sessionHeader(ownerSession),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ role: 'admin' }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.userId).toBe(member.id);
      expect(json.role).toBe('admin');
      expect(json.githubLogin).toBe('memberuser');

      // Verify in DB
      const rows = await db.$client.query(
        `SELECT role FROM memberships WHERE user_id = $1 AND team_id = $2`,
        [member.id, teamId],
      );
      expect(rows.rows[0]!['role']).toBe('admin');
    });

    it('owner can demote another owner (if not the last one)', async () => {
      const { teamId, ownerSession } = await setupTeam();
      const secondOwner = await createUser(5002, 'secondowner');
      await addMembership(secondOwner.id, teamId, 'owner');

      // Now there are 2 owners — demoting one is allowed
      const res = await appRequest(`/v1/members/${secondOwner.id}`, {
        method: 'PATCH',
        headers: {
          ...sessionHeader(ownerSession),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ role: 'member' }),
      });

      expect(res.status).toBe(200);
      expect((await res.json()).role).toBe('member');

      // Verify in DB
      const rows = await db.$client.query(
        `SELECT role FROM memberships WHERE user_id = $1 AND team_id = $2`,
        [secondOwner.id, teamId],
      );
      expect(rows.rows[0]!['role']).toBe('member');
    });

    it('role change is idempotent (same role)', async () => {
      const { teamId, ownerSession } = await setupTeam();
      const member = await createUser(5003, 'stablemember');
      await addMembership(member.id, teamId, 'viewer');

      const res = await appRequest(`/v1/members/${member.id}`, {
        method: 'PATCH',
        headers: {
          ...sessionHeader(ownerSession),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ role: 'viewer' }),
      });

      expect(res.status).toBe(200);
      expect((await res.json()).role).toBe('viewer');
    });

    it('owner can promote a viewer to owner (creates second owner)', async () => {
      const { teamId, ownerSession } = await setupTeam();
      const viewer = await createUser(5004, 'futureowner');
      await addMembership(viewer.id, teamId, 'viewer');

      const res = await appRequest(`/v1/members/${viewer.id}`, {
        method: 'PATCH',
        headers: {
          ...sessionHeader(ownerSession),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ role: 'owner' }),
      });

      expect(res.status).toBe(200);
      expect((await res.json()).role).toBe('owner');

      // Verify both owners exist
      const rows = await db.$client.query(
        `SELECT COUNT(*)::int AS count FROM memberships WHERE team_id = $1 AND role = 'owner'`,
        [teamId],
      );
      expect(rows.rows[0]!['count']).toBe(2);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PATCH /v1/members/:userId — error / counterexample paths
  // ═══════════════════════════════════════════════════════════════════════════

  describe('PATCH /v1/members/:userId — counterexamples', () => {
    it('last owner cannot be demoted (409 Conflict)', async () => {
      const { ownerUserId, ownerSession } = await setupTeam();

      const res = await appRequest(`/v1/members/${ownerUserId}`, {
        method: 'PATCH',
        headers: {
          ...sessionHeader(ownerSession),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ role: 'member' }),
      });

      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.error.code).toBe('conflict');
    });

    it('non-owner (admin) cannot change roles (403 Forbidden)', async () => {
      const { teamId } = await setupTeam();
      const admin = await createUser(6001, 'adminuser');
      await addMembership(admin.id, teamId, 'admin');
      const adminSession = await createSession(admin.id);

      const viewer = await createUser(6002, 'aviewer');
      await addMembership(viewer.id, teamId, 'viewer');

      const res = await appRequest(`/v1/members/${viewer.id}`, {
        method: 'PATCH',
        headers: {
          ...sessionHeader(adminSession),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ role: 'member' }),
      });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error.code).toBe('forbidden');
    });

    it('non-owner (member) cannot change roles (403 Forbidden)', async () => {
      const { teamId } = await setupTeam();
      const normalMember = await createUser(6003, 'normalmember');
      await addMembership(normalMember.id, teamId, 'member');
      const memberSession = await createSession(normalMember.id);

      const viewer = await createUser(6004, 'anotherviewer');
      await addMembership(viewer.id, teamId, 'viewer');

      const res = await appRequest(`/v1/members/${viewer.id}`, {
        method: 'PATCH',
        headers: {
          ...sessionHeader(memberSession),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ role: 'admin' }),
      });

      expect(res.status).toBe(403);
    });

    it('non-owner (viewer) cannot change roles (403 Forbidden)', async () => {
      const { teamId } = await setupTeam();
      const aviewer = await createUser(6005, 'simpleviewer');
      await addMembership(aviewer.id, teamId, 'viewer');
      const viewerSession = await createSession(aviewer.id);

      const other = await createUser(6006, 'otheruser');
      await addMembership(other.id, teamId, 'viewer');

      const res = await appRequest(`/v1/members/${other.id}`, {
        method: 'PATCH',
        headers: {
          ...sessionHeader(viewerSession),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ role: 'member' }),
      });

      expect(res.status).toBe(403);
    });

    it('cross-team member returns 404 indistinguishable from missing', async () => {
      const { ownerSession } = await setupTeam();

      // Create a user in another team
      const teamB = await createTeam('Team B');
      const userB = await createUser(6007, 'crossteam');
      await addMembership(userB.id, teamB, 'admin');

      const res = await appRequest(`/v1/members/${userB.id}`, {
        method: 'PATCH',
        headers: {
          ...sessionHeader(ownerSession),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ role: 'viewer' }),
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error.code).toBe('not_found');
    });

    it('non-existent user returns 404 indistinguishable from cross-team', async () => {
      const { ownerSession } = await setupTeam();

      const res = await appRequest('/v1/members/usr_nonexistent123', {
        method: 'PATCH',
        headers: {
          ...sessionHeader(ownerSession),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ role: 'viewer' }),
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error.code).toBe('not_found');
    });

    it('returns 401 without session', async () => {
      const res = await appRequest('/v1/members/usr_any', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'viewer' }),
      });

      expect(res.status).toBe(401);
    });

    it('returns 400 for invalid role in body', async () => {
      const teamId = await createTeam('Bogus Team');
      const owner = await createUser(6009, 'bogusowner');
      await addMembership(owner.id, teamId, 'owner');
      const ownerSession = await createSession(owner.id);
      const member = await createUser(6010, 'bogusmember2');
      await addMembership(member.id, teamId, 'member');

      const res = await appRequest(`/v1/members/${member.id}`, {
        method: 'PATCH',
        headers: {
          ...sessionHeader(ownerSession),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ role: 'superadmin' }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('invalid_request');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // DELETE /v1/members/:userId — success paths
  // ═══════════════════════════════════════════════════════════════════════════

  describe('DELETE /v1/members/:userId — success paths', () => {
    it('owner can remove a member', async () => {
      const { teamId, ownerSession } = await setupTeam();
      const member = await createUser(7001, 'removable');
      await addMembership(member.id, teamId, 'member');

      const res = await appRequest(`/v1/members/${member.id}`, {
        method: 'DELETE',
        headers: sessionHeader(ownerSession),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.removed).toBe(true);
      expect(json.userId).toBe(member.id);
      expect(json.githubLogin).toBe('removable');

      // Verify removed from DB
      const rows = await db.$client.query(
        `SELECT COUNT(*)::int AS count FROM memberships WHERE user_id = $1 AND team_id = $2`,
        [member.id, teamId],
      );
      expect(rows.rows[0]!['count']).toBe(0);
    });

    it('owner can remove another owner (if not the last one)', async () => {
      const { teamId, ownerSession, ownerUserId } = await setupTeam();
      const secondOwner = await createUser(7002, 'removableowner');
      await addMembership(secondOwner.id, teamId, 'owner');

      // Now 2 owners — removing one is allowed
      const res = await appRequest(`/v1/members/${secondOwner.id}`, {
        method: 'DELETE',
        headers: sessionHeader(ownerSession),
      });

      expect(res.status).toBe(200);
      expect((await res.json()).removed).toBe(true);

      // First owner should still be in place
      const rows = await db.$client.query(
        `SELECT role FROM memberships WHERE user_id = $1 AND team_id = $2`,
        [ownerUserId, teamId],
      );
      expect(rows.rows[0]!['role']).toBe('owner');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // DELETE /v1/members/:userId — error / counterexample paths
  // ═══════════════════════════════════════════════════════════════════════════

  describe('DELETE /v1/members/:userId — counterexamples', () => {
    it('last owner cannot be removed (409 Conflict)', async () => {
      const { ownerUserId, ownerSession } = await setupTeam();

      const res = await appRequest(`/v1/members/${ownerUserId}`, {
        method: 'DELETE',
        headers: sessionHeader(ownerSession),
      });

      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.error.code).toBe('conflict');
    });

    it('non-owner (admin) cannot remove members (403 Forbidden)', async () => {
      const { teamId } = await setupTeam();
      const admin = await createUser(8001, 'removeadmin');
      await addMembership(admin.id, teamId, 'admin');
      const adminSession = await createSession(admin.id);

      const viewer = await createUser(8002, 'removableviewer');
      await addMembership(viewer.id, teamId, 'viewer');

      const res = await appRequest(`/v1/members/${viewer.id}`, {
        method: 'DELETE',
        headers: sessionHeader(adminSession),
      });

      expect(res.status).toBe(403);
    });

    it('non-owner (member) cannot remove members (403 Forbidden)', async () => {
      const { teamId } = await setupTeam();
      const normalMember = await createUser(8003, 'removalmember');
      await addMembership(normalMember.id, teamId, 'member');
      const memberSession = await createSession(normalMember.id);

      const viewer = await createUser(8004, 'removableviewer2');
      await addMembership(viewer.id, teamId, 'viewer');

      const res = await appRequest(`/v1/members/${viewer.id}`, {
        method: 'DELETE',
        headers: sessionHeader(memberSession),
      });

      expect(res.status).toBe(403);
    });

    it('cross-team member returns 404 indistinguishable from missing', async () => {
      const { ownerSession } = await setupTeam();

      // Create a user in another team
      const teamB = await createTeam('Team Delete');
      const userB = await createUser(8005, 'deletablecross');
      await addMembership(userB.id, teamB, 'member');

      const res = await appRequest(`/v1/members/${userB.id}`, {
        method: 'DELETE',
        headers: sessionHeader(ownerSession),
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error.code).toBe('not_found');
    });

    it('non-existent user returns 404 indistinguishable from cross-team', async () => {
      const { ownerSession } = await setupTeam();

      const res = await appRequest('/v1/members/usr_fake_delete_999', {
        method: 'DELETE',
        headers: sessionHeader(ownerSession),
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error.code).toBe('not_found');
    });

    it('returns 401 without session', async () => {
      const res = await appRequest('/v1/members/usr_any', {
        method: 'DELETE',
      });

      expect(res.status).toBe(401);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // GET /v1/members/:userId/concepts — member-contributed concepts
  // ═══════════════════════════════════════════════════════════════════════════

  describe('GET /v1/members/:userId/concepts', () => {
    /** Helper: create a project in a team. Returns project id. */
    async function createProject(teamId: string, name: string): Promise<string> {
      const id = `prj_${randomBytes(12).toString('hex')}`;
      await db.execute(
        `INSERT INTO projects (id, team_id, name) VALUES ('${id}', '${teamId}', '${name}')`,
      );
      return id;
    }

    /** Helper: create a concept and link it to a contributor. */
    async function createConceptWithContributor(
      teamId: string,
      projectId: string,
      principalId: string,
      overrides?: { uuid?: string; path?: string; type?: string; title?: string },
    ): Promise<string> {
      const uuid = overrides?.uuid ?? crypto.randomUUID();
      const title = overrides?.title ?? 'Test Concept';
      const type = overrides?.type ?? 'decision';
      const path = overrides?.path ?? `test/${randomBytes(6).toString('hex')}`;
      const now = new Date().toISOString();

      await db.execute(
        `INSERT INTO concepts (uuid, team_id, project_id, schema_version, type, status, confidence, title, body, tags, first_seen, last_confirmed, created_at, updated_at)
         VALUES ('${uuid}', '${teamId}', '${projectId}', 1, '${type}', 'active', 'high', '${title}', 'Test body', '{test}', '${now}', '${now}', '${now}', '${now}')`,
      );
      await db.execute(
        `INSERT INTO concept_paths (concept_uuid, team_id, project_id, path, is_current)
         VALUES ('${uuid}', '${teamId}', '${projectId}', '${path}', true)`,
      );
      await db.execute(
        `INSERT INTO concept_contributors (concept_uuid, team_id, project_id, principal_id)
         VALUES ('${uuid}', '${teamId}', '${projectId}', '${principalId}')`,
      );
      return uuid;
    }

    it('returns concepts contributed by the member', async () => {
      const { teamId, ownerSession } = await setupTeam();

      // Create a member with a linked principal
      const member = await createUser(9001, 'contributor');
      await addMembership(member.id, teamId, 'member');
      const principalId = await createPrincipal(teamId, String(member.githubId), 'contributor');

      const projectId = await createProject(teamId, 'Test Project');
      const uuid = await createConceptWithContributor(teamId, projectId, principalId, {
        title: 'Use PostgreSQL as primary database',
        path: 'decisions/use-postgres',
        type: 'decision',
      });

      const res = await appRequest(
        `/v1/members/${member.id}/concepts?projectId=${projectId}`,
        { headers: sessionHeader(ownerSession) },
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data).toHaveLength(1);
      expect(json.data[0]).toMatchObject({
        uuid,
        path: 'decisions/use-postgres',
        type: 'decision',
        title: 'Use PostgreSQL as primary database',
      });
    });

    it('returns empty list when member has no linked principal', async () => {
      const { teamId, ownerSession } = await setupTeam();

      const member = await createUser(9002, 'noprincipal');
      await addMembership(member.id, teamId, 'viewer');
      // No principal created for this user

      const projectId = await createProject(teamId, 'Test Project');

      const res = await appRequest(
        `/v1/members/${member.id}/concepts?projectId=${projectId}`,
        { headers: sessionHeader(ownerSession) },
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data).toEqual([]);
      expect(json.nextCursor).toBeNull();
    });

    it('returns 400 when projectId is missing', async () => {
      const { teamId, ownerSession } = await setupTeam();

      const res = await appRequest(
        `/v1/members/${teamId}/concepts`,
        { headers: sessionHeader(ownerSession) },
      );

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('invalid_request');
    });

    it('returns 404 for cross-team member (indistinguishable from missing)', async () => {
      const { ownerSession } = await setupTeam();

      // Create a member in another team
      const teamB = await createTeam('Team B');
      const memberB = await createUser(9003, 'crossteam');
      await addMembership(memberB.id, teamB, 'member');
      const projectB = await createProject(teamB, 'Project B');

      const res = await appRequest(
        `/v1/members/${memberB.id}/concepts?projectId=${projectB}`,
        { headers: sessionHeader(ownerSession) },
      );

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error.code).toBe('not_found');
    });

    it('returns 404 for non-existent user (same shape as cross-team)', async () => {
      const { teamId, ownerSession } = await setupTeam();
      const projectId = await createProject(teamId, 'Test Project');

      const res = await appRequest(
        `/v1/members/usr_nonexistent_999/concepts?projectId=${projectId}`,
        { headers: sessionHeader(ownerSession) },
      );

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error.code).toBe('not_found');
    });

    it('returns 401 without session', async () => {
      const res = await appRequest(
        '/v1/members/usr_any/concepts?projectId=prj_any',
      );

      expect(res.status).toBe(401);
    });

    it('returns 401 with fake session token', async () => {
      const res = await appRequest(
        '/v1/members/usr_any/concepts?projectId=prj_any',
        { headers: sessionHeader('fake_token') },
      );

      expect(res.status).toBe(401);
    });

    it('respects limit parameter', async () => {
      const { teamId, ownerSession } = await setupTeam();

      const member = await createUser(9004, 'manyconcepts');
      await addMembership(member.id, teamId, 'member');
      const principalId = await createPrincipal(teamId, String(member.githubId), 'manyconcepts');
      const projectId = await createProject(teamId, 'Test Project');

      // Create 3 concepts
      for (let i = 0; i < 3; i++) {
        await createConceptWithContributor(teamId, projectId, principalId, {
          title: `Concept ${i + 1}`,
          path: `test/concept-${i + 1}`,
        });
      }

      const res = await appRequest(
        `/v1/members/${member.id}/concepts?projectId=${projectId}&limit=2`,
        { headers: sessionHeader(ownerSession) },
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data).toHaveLength(2);
    });

    it('concepts are scoped to the requested project (team member cannot see another project)', async () => {
      const { teamId, ownerSession } = await setupTeam();

      const member = await createUser(9005, 'scopedcontributor');
      await addMembership(member.id, teamId, 'member');
      const principalId = await createPrincipal(teamId, String(member.githubId), 'scopedcontributor');

      const projectA = await createProject(teamId, 'Project A');
      const projectB = await createProject(teamId, 'Project B');

      // Add a concept in project A only
      await createConceptWithContributor(teamId, projectA, principalId, {
        title: 'Only in Project A',
      });

      // Query project B — should return empty
      const res = await appRequest(
        `/v1/members/${member.id}/concepts?projectId=${projectB}`,
        { headers: sessionHeader(ownerSession) },
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data).toEqual([]);
    });
  });
});
