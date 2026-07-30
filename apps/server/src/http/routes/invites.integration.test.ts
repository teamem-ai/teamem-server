/**
 * Integration tests for Invite Links (M2-AUTH-04).
 *
 * Covers:
 *   - POST /teams/:teamId/invites — admin+ generates invite (returns link
 *     with plaintext token, stores only hash)
 *   - POST /teams/:teamId/invites/accept — authenticated user accepts
 *     invite, membership created, invite marked used
 *   - Counterexamples:
 *     - Expired link is rejected with clear message
 *     - Used link is rejected on second acceptance (single-use)
 *     - Member/viewer cannot generate invites (require admin+)
 *     - Only token hash is stored, not plaintext
 *     - Plaintext token appears only in the generation response
 *     - Unknown/malformed token returns 404
 *     - Non-admin cannot invite as owner
 *
 * Tests run against real PostgreSQL.
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
import { buildInvitesRoutes } from './invites.js';
import { buildAuthRoutes } from './auth.js';
import type { GitHubOAuthConfig } from '../../auth/oauth-github.js';
import {
  generateSessionToken,
  SESSION_COOKIE_NAME,
} from '../../auth/oauth-github.js';
import {
  hashInviteToken,
  DEFAULT_INVITE_TTL_MS,
} from '../../auth/invites.js';
import { requestContext } from '../request-context.js';
import { globalErrorHandler, notFoundHandler } from '../errors.js';

const url = process.env['TEST_DATABASE_URL'];

describe.skipIf(!url)('Invite Links Routes (live Postgres)', () => {
  let pool: Pool;
  let db: AppDb;
  let app: Hono;
  // OAuth config (not used directly — auth routes are mounted alongside
  // invite routes so the full middleware stack is available)
  const oauthConfig: GitHubOAuthConfig = {
    clientId: 'Iv1.test_invites_client',
    clientSecret: 'test_invites_secret',
    redirectUri: 'http://localhost:8080/auth/github/callback',
    serverBaseUrl: 'http://localhost:8080',
  };

  const serverBaseUrl = oauthConfig.serverBaseUrl;

  beforeAll(async () => {
    ({ pool } = connectDatabase());
    db = createDb(url!, { pool: pool as unknown as import('pg').Pool });

    // Build app with both auth routes (for session middleware) and
    // invite routes.
    app = new Hono();
    app.use('*', requestContext);
    app.onError(globalErrorHandler);
    app.notFound(notFoundHandler);
    app.route('/', buildAuthRoutes(oauthConfig, db));
    app.route('/', buildInvitesRoutes(db, serverBaseUrl));
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

  const appRequest = (path: string, init?: RequestInit) =>
    app.request(path, init);

  /** Create a user directly in DB. Returns user ID. */
  async function createUser(githubId: number, login: string): Promise<string> {
    const id = `usr_${randomBytes(8).toString('hex')}`;
    await db.execute(
      `INSERT INTO users (id, github_id, github_login) VALUES ('${id}', ${githubId}, '${login}')`,
    );
    return id;
  }

  /** Create a team directly in DB. Returns team ID. */
  async function createTeam(name: string): Promise<string> {
    const id = `team_${randomBytes(8).toString('hex')}`;
    await db.execute(`INSERT INTO teams (id, name) VALUES ('${id}', '${name}')`);
    return id;
  }

  /** Create a membership for a user in a team with a given role. */
  async function createMembership(
    userId: string,
    teamId: string,
    role: string,
  ): Promise<void> {
    await db.execute(
      `INSERT INTO memberships (user_id, team_id, role) VALUES ('${userId}', '${teamId}', '${role}') ON CONFLICT (user_id, team_id) DO UPDATE SET role = '${role}'`,
    );
  }

  /** Create a valid web session for a user. Returns { plaintext, sessionId }. */
  async function createSession(
    userId: string,
  ): Promise<{ plaintext: string; sessionId: string }> {
    const { plaintext, hash } = generateSessionToken();
    const sessionId = `ses_${randomBytes(8).toString('hex')}`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 7 * 24 * 3600_000);
    await db.execute(
      `INSERT INTO web_sessions (id, user_id, token_hash, issued_at, expires_at) VALUES ('${sessionId}', '${userId}', '${hash}', '${now.toISOString()}', '${expiresAt.toISOString()}')`,
    );
    return { plaintext, sessionId };
  }

  /** Helper: set up an admin user with team membership and session. */
  async function setupAdmin(): Promise<{
    userId: string;
    teamId: string;
    sessionToken: string;
  }> {
    const teamId = await createTeam('Admin Test Team');
    const userId = await createUser(
      Math.floor(Math.random() * 900000) + 100000,
      'adminuser',
    );
    await createMembership(userId, teamId, 'admin');
    const { plaintext } = await createSession(userId);
    return { userId, teamId, sessionToken: plaintext };
  }

  /** Helper: set up a member user with team membership and session. */
  async function setupMember(): Promise<{
    userId: string;
    teamId: string;
    sessionToken: string;
  }> {
    const teamId = await createTeam('Member Test Team');
    const userId = await createUser(
      Math.floor(Math.random() * 900000) + 100000,
      'memberuser',
    );
    await createMembership(userId, teamId, 'member');
    const { plaintext } = await createSession(userId);
    return { userId, teamId, sessionToken: plaintext };
  }

  /** Helper: set up an owner user with team membership and session. */
  async function setupOwner(): Promise<{
    userId: string;
    teamId: string;
    sessionToken: string;
  }> {
    const teamId = await createTeam('Owner Test Team');
    const userId = await createUser(
      Math.floor(Math.random() * 900000) + 100000,
      'owneruser',
    );
    await createMembership(userId, teamId, 'owner');
    const { plaintext } = await createSession(userId);
    return { userId, teamId, sessionToken: plaintext };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // POST /teams/:teamId/invites — generate invite (success)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('POST /teams/:teamId/invites — generate invite', () => {
    it('admin generates an invite and receives a link with plaintext token', async () => {
      const { teamId, sessionToken } = await setupAdmin();

      const res = await appRequest(`/teams/${teamId}/invites`, {
        method: 'POST',
        headers: {
          Cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ targetRole: 'member' }),
      });

      expect(res.status).toBe(201);
      const json = (await res.json()) as Record<string, unknown>;

      // Verify response shape
      expect(json.id).toBeTruthy();
      expect(typeof json.id).toBe('string');
      expect((json.id as string).startsWith('inv_')).toBe(true);
      expect(json.inviteLink).toBeTruthy();
      expect(typeof json.inviteLink).toBe('string');
      expect(json.targetRole).toBe('member');
      expect(json.expiresAt).toBeTruthy();

      // Verify the inviteLink contains a token
      const link = json.inviteLink as string;
      expect(link).toContain('/join?token=inv_');

      // Extract the token from the link
      const url = new URL(link);
      const token = url.searchParams.get('token');
      expect(token).toBeTruthy();
      expect(token!.startsWith('inv_')).toBe(true);

      // Verify only token hash is stored, not plaintext
      const inviteRows = await db.$client.query(
        `SELECT id, token_hash, target_role, invited_by_user_id, used_at FROM invites WHERE id = $1`,
        [json.id as string],
      );
      expect(inviteRows.rows).toHaveLength(1);
      const row = inviteRows.rows[0] as Record<string, unknown>;
      const storedHash = row['token_hash'] as string;

      // The hash must NOT be the plaintext token
      expect(storedHash).not.toBe(token);
      // The hash must match the computed hash of the token
      expect(storedHash).toBe(hashInviteToken(token!));

      // Plaintext token must NOT be in the database
      const allInvites = await db.$client.query(`SELECT token_hash FROM invites`);
      for (const r of allInvites.rows) {
        const hash = (r as Record<string, unknown>)['token_hash'] as string;
        expect(hash).not.toBe(token);
      }
    });

    it('owner generates an invite', async () => {
      const { teamId, sessionToken } = await setupOwner();

      const res = await appRequest(`/teams/${teamId}/invites`, {
        method: 'POST',
        headers: {
          Cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ targetRole: 'admin' }),
      });

      expect(res.status).toBe(201);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json.targetRole).toBe('admin');
    });

    it('admin can invite for all roles up to admin', async () => {
      const { teamId, sessionToken } = await setupAdmin();

      for (const role of ['viewer', 'member', 'admin']) {
        const res = await appRequest(`/teams/${teamId}/invites`, {
          method: 'POST',
          headers: {
            Cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ targetRole: role }),
        });

        expect(res.status).toBe(201);
        const json = (await res.json()) as Record<string, unknown>;
        expect(json.targetRole).toBe(role);
      }
    });

    it('owner can invite for owner role', async () => {
      const { teamId, sessionToken } = await setupOwner();

      const res = await appRequest(`/teams/${teamId}/invites`, {
        method: 'POST',
        headers: {
          Cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ targetRole: 'owner' }),
      });

      expect(res.status).toBe(201);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json.targetRole).toBe('owner');
    });

    it('invite is stored with 7-day expiration', async () => {
      const { teamId, sessionToken } = await setupAdmin();

      const res = await appRequest(`/teams/${teamId}/invites`, {
        method: 'POST',
        headers: {
          Cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ targetRole: 'viewer' }),
      });

      expect(res.status).toBe(201);
      const json = (await res.json()) as Record<string, unknown>;

      // Verify expiresAt is ~7 days from now
      const expiresAt = new Date(json.expiresAt as string);
      const now = new Date();
      const diffMs = expiresAt.getTime() - now.getTime();
      const sevenDaysMs = DEFAULT_INVITE_TTL_MS;
      // Allow 5 seconds of clock skew
      expect(Math.abs(diffMs - sevenDaysMs)).toBeLessThan(5000);

      // Verify expiresAt is set in the DB
      const inviteRows = await db.$client.query(
        `SELECT expires_at FROM invites WHERE id = $1`,
        [json.id as string],
      );
      const row = inviteRows.rows[0] as Record<string, unknown>;
      const dbExpiresAt = new Date((row['expires_at'] as Date).toISOString());
      expect(Math.abs(dbExpiresAt.getTime() - expiresAt.getTime())).toBeLessThan(1000);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // POST /teams/:teamId/invites — counterexamples
  // ═══════════════════════════════════════════════════════════════════════════

  describe('POST /teams/:teamId/invites — counterexamples', () => {
    it('member cannot generate invites (403)', async () => {
      const { teamId, sessionToken } = await setupMember();

      const res = await appRequest(`/teams/${teamId}/invites`, {
        method: 'POST',
        headers: {
          Cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ targetRole: 'member' }),
      });

      expect(res.status).toBe(403);
      const json = (await res.json()) as Record<string, unknown>;
      const err = json.error as Record<string, unknown>;
      expect(err.code).toBe('forbidden');
    });

    it('viewer cannot generate invites (403)', async () => {
      const teamId = await createTeam('Viewer Team');
      const userId = await createUser(777001, 'vieweruser');
      await createMembership(userId, teamId, 'viewer');
      const { plaintext: sessionToken } = await createSession(userId);

      const res = await appRequest(`/teams/${teamId}/invites`, {
        method: 'POST',
        headers: {
          Cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ targetRole: 'member' }),
      });

      expect(res.status).toBe(403);
    });

    it('admin cannot invite as owner (400)', async () => {
      const { teamId, sessionToken } = await setupAdmin();

      const res = await appRequest(`/teams/${teamId}/invites`, {
        method: 'POST',
        headers: {
          Cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ targetRole: 'owner' }),
      });

      expect(res.status).toBe(400);
      const json = (await res.json()) as Record<string, unknown>;
      const err = json.error as Record<string, unknown>;
      expect(err.code).toBe('invalid_request');
    });

    it('rejects invalid targetRole', async () => {
      const { teamId, sessionToken } = await setupAdmin();

      const res = await appRequest(`/teams/${teamId}/invites`, {
        method: 'POST',
        headers: {
          Cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ targetRole: 'superadmin' }),
      });

      expect(res.status).toBe(400);
      const json = (await res.json()) as Record<string, unknown>;
      const err = json.error as Record<string, unknown>;
      expect(err.code).toBe('invalid_request');
    });

    it('rejects missing targetRole', async () => {
      const { teamId, sessionToken } = await setupAdmin();

      const res = await appRequest(`/teams/${teamId}/invites`, {
        method: 'POST',
        headers: {
          Cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });

    it('returns 401 without a session', async () => {
      const teamId = `team_${randomBytes(8).toString('hex')}`;
      await db.execute(`INSERT INTO teams (id, name) VALUES ('${teamId}', 'No Session Team')`);

      const res = await appRequest(`/teams/${teamId}/invites`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetRole: 'member' }),
      });

      expect(res.status).toBe(401);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // POST /teams/:teamId/invites/accept — success path
  // ═══════════════════════════════════════════════════════════════════════════

  describe('POST /teams/:teamId/invites/accept — accept invite', () => {
    /**
     * Helper: generate an invite and return the token and invite ID.
     */
    async function generateInvite(
      adminSessionToken: string,
      adminTeamId: string,
      targetRole = 'member',
    ): Promise<{ token: string; inviteId: string }> {
      const res = await appRequest(`/teams/${adminTeamId}/invites`, {
        method: 'POST',
        headers: {
          Cookie: `${SESSION_COOKIE_NAME}=${adminSessionToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ targetRole }),
      });

      if (res.status !== 201) {
        throw new Error(`Failed to generate invite: ${res.status}`);
      }

      const json = (await res.json()) as Record<string, unknown>;
      const link = json.inviteLink as string;
      const url = new URL(link);
      const token = url.searchParams.get('token')!;
      return { token, inviteId: json.id as string };
    }

    it('accepts an invite, creates membership, marks invite used', async () => {
      // Setup admin to generate invite
      const { teamId, sessionToken: adminSession } = await setupAdmin();

      // Generate invite
      const { token } = await generateInvite(adminSession, teamId, 'member');

      // Setup a different user to accept the invite
      const accepterUserId = await createUser(888001, 'accepteruser');
      const { plaintext: accepterSession } = await createSession(accepterUserId);

      // Accept the invite (using the accepter's team URL —
      // the route needs a teamId param but it's not checked for
      // membership, only for context)
      const res = await appRequest(`/teams/${teamId}/invites/accept`, {
        method: 'POST',
        headers: {
          Cookie: `${SESSION_COOKIE_NAME}=${accepterSession}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ token }),
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as Record<string, unknown>;
      const acceptResultMembership = json.membership as Record<string, unknown>;
      const acceptResultInvite = json.invite as Record<string, unknown>;

      // Verify membership created
      expect(acceptResultMembership.userId).toBe(accepterUserId);
      expect(acceptResultMembership.teamId).toBe(teamId);
      expect(acceptResultMembership.role).toBe('member');

      // Verify membership exists in DB
      const membershipRows = await db.$client.query(
        `SELECT user_id, team_id, role FROM memberships WHERE user_id = $1 AND team_id = $2`,
        [accepterUserId, teamId],
      );
      expect(membershipRows.rows).toHaveLength(1);
      const mRow = membershipRows.rows[0] as Record<string, unknown>;
      expect(mRow['role']).toBe('member');

      // Verify invite marked as used
      const inviteRows = await db.$client.query(
        `SELECT id, used_at FROM invites WHERE id = $1`,
        [acceptResultInvite.id as string],
      );
      const iRow = inviteRows.rows[0] as Record<string, unknown>;
      expect(iRow['used_at']).not.toBeNull();
    });

    it('invite acceptance works when user is already in the team (idempotent)', async () => {
      const { teamId, sessionToken: adminSession } = await setupAdmin();

      // Generate invite
      const { token } = await generateInvite(adminSession, teamId, 'admin');

      // Create a user who is already a viewer in the team
      const existingUserId = await createUser(888002, 'existinguser');
      await createMembership(existingUserId, teamId, 'viewer');
      const { plaintext: existingSession } = await createSession(existingUserId);

      // Accept invite — user already has membership
      const res = await appRequest(`/teams/${teamId}/invites/accept`, {
        method: 'POST',
        headers: {
          Cookie: `${SESSION_COOKIE_NAME}=${existingSession}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ token }),
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as Record<string, unknown>;
      const invite = json.invite as Record<string, unknown>;

      // Invite should still be marked as used (single-use, consumed)
      const inviteRows = await db.$client.query(
        `SELECT used_at FROM invites WHERE id = $1`,
        [invite.id as string],
      );
      expect((inviteRows.rows[0] as Record<string, unknown>)['used_at']).not.toBeNull();

      // Existing role should NOT be changed (ON CONFLICT DO NOTHING)
      const membership = json.membership as Record<string, unknown>;
      expect(membership.role).toBe('viewer'); // preserved, not upgraded to admin
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // POST /teams/:teamId/invites/accept — counterexamples
  // ═══════════════════════════════════════════════════════════════════════════

  describe('POST /teams/:teamId/invites/accept — counterexamples', () => {
    async function generateInvite(
      adminSessionToken: string,
      adminTeamId: string,
      targetRole = 'member',
    ): Promise<{ token: string; inviteId: string }> {
      const res = await appRequest(`/teams/${adminTeamId}/invites`, {
        method: 'POST',
        headers: {
          Cookie: `${SESSION_COOKIE_NAME}=${adminSessionToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ targetRole }),
      });

      const json = (await res.json()) as Record<string, unknown>;
      const link = json.inviteLink as string;
      const url = new URL(link);
      const token = url.searchParams.get('token')!;
      return { token, inviteId: json.id as string };
    }

    it('rejects the same invite twice (single-use)', async () => {
      // Setup
      const { teamId, sessionToken: adminSession } = await setupAdmin();
      const { token } = await generateInvite(adminSession, teamId, 'member');

      const accepter1Id = await createUser(999001, 'accepter1');
      const { plaintext: accepter1Session } = await createSession(accepter1Id);

      // First acceptance — should succeed
      const res1 = await appRequest(`/teams/${teamId}/invites/accept`, {
        method: 'POST',
        headers: {
          Cookie: `${SESSION_COOKIE_NAME}=${accepter1Session}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ token }),
      });
      expect(res1.status).toBe(200);

      // Second acceptance (different user) — should be rejected
      const accepter2Id = await createUser(999002, 'accepter2');
      const { plaintext: accepter2Session } = await createSession(accepter2Id);

      const res2 = await appRequest(`/teams/${teamId}/invites/accept`, {
        method: 'POST',
        headers: {
          Cookie: `${SESSION_COOKIE_NAME}=${accepter2Session}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ token }),
      });
      expect(res2.status).toBe(409);
      const json2 = (await res2.json()) as Record<string, unknown>;
      const err2 = json2.error as Record<string, unknown>;
      expect(err2.code).toBe('conflict');
    });

    it('rejects an expired invite (409 conflict)', async () => {
      const { teamId, userId: adminUserId } = await setupAdmin();

      // Create an expired invite directly in the DB
      const plaintext = `inv_${randomBytes(32).toString('base64url').replace(/=/g, '')}`;
      const tokenHash = hashInviteToken(plaintext);
      const inviteId = `inv_${randomBytes(12).toString('hex')}`;
      const pastExpiry = new Date(Date.now() - 3600_000).toISOString();
      await db.$client.query(
        `INSERT INTO invites (id, team_id, token_hash, target_role, invited_by_user_id, expires_at)
         VALUES ($1, $2, $3, 'member', $4, $5)`,
        [inviteId, teamId, tokenHash, adminUserId, pastExpiry],
      );

      // Try to accept the expired invite
      const accepterId = await createUser(999007, 'expiredaccepter');
      const { plaintext: accepterSession } = await createSession(accepterId);

      const res = await appRequest(`/teams/${teamId}/invites/accept`, {
        method: 'POST',
        headers: {
          Cookie: `${SESSION_COOKIE_NAME}=${accepterSession}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ token: plaintext }),
      });

      expect(res.status).toBe(409);
      const json = (await res.json()) as Record<string, unknown>;
      const err = json.error as Record<string, unknown>;
      expect(err.code).toBe('conflict');
    });

    it('rejects unknown/malformed token (404)', async () => {
      const { teamId } = await setupAdmin();
      const userId = await createUser(999003, 'tokenprobe');
      const { plaintext: sessionToken } = await createSession(userId);

      // Test with a completely fake token
      const res = await appRequest(`/teams/${teamId}/invites/accept`, {
        method: 'POST',
        headers: {
          Cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ token: 'inv_fake_token_that_does_not_exist_anywhere' }),
      });

      expect(res.status).toBe(404);
      const json = (await res.json()) as Record<string, unknown>;
      const err = json.error as Record<string, unknown>;
      expect(err.code).toBe('not_found');
    });

    it('rejects token with wrong format (400)', async () => {
      const { teamId } = await setupAdmin();
      const userId = await createUser(999004, 'formatprobe');
      const { plaintext: sessionToken } = await createSession(userId);

      const res = await appRequest(`/teams/${teamId}/invites/accept`, {
        method: 'POST',
        headers: {
          Cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ token: 'not_an_inv_token' }),
      });

      expect(res.status).toBe(400);
    });

    it('rejects missing token in body (400)', async () => {
      const { teamId } = await setupAdmin();
      const userId = await createUser(999005, 'missingtoken');
      const { plaintext: sessionToken } = await createSession(userId);

      const res = await appRequest(`/teams/${teamId}/invites/accept`, {
        method: 'POST',
        headers: {
          Cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });

    it('returns 401 without a session', async () => {
      const { teamId } = await setupAdmin();

      const res = await appRequest(`/teams/${teamId}/invites/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'inv_some_token' }),
      });

      expect(res.status).toBe(401);
    });

    it('no plaintext token leaked in accept response', async () => {
      const { teamId, sessionToken: adminSession } = await setupAdmin();

      // Generate invite
      const genRes = await appRequest(`/teams/${teamId}/invites`, {
        method: 'POST',
        headers: {
          Cookie: `${SESSION_COOKIE_NAME}=${adminSession}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ targetRole: 'member' }),
      });
      const genJson = (await genRes.json()) as Record<string, unknown>;
      const link = genJson.inviteLink as string;
      const url = new URL(link);
      const token = url.searchParams.get('token')!;

      // Accept invite
      const accepterId = await createUser(999006, 'noleakuser');
      const { plaintext: accepterSession } = await createSession(accepterId);

      const acceptRes = await appRequest(`/teams/${teamId}/invites/accept`, {
        method: 'POST',
        headers: {
          Cookie: `${SESSION_COOKIE_NAME}=${accepterSession}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ token }),
      });

      expect(acceptRes.status).toBe(200);
      const acceptJson = (await acceptRes.json()) as Record<string, unknown>;
      const acceptBody = JSON.stringify(acceptJson);

      // The plaintext token must NOT appear in the acceptance response
      expect(acceptBody).not.toContain(token);
      // The invite response must NOT contain token_hash
      expect(acceptBody).not.toContain('token_hash');
      expect(acceptBody).not.toContain('tokenHash');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Security: token hash only in database
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Security: token hash only in database', () => {
    it('plaintext token is never persisted — only hash is stored', async () => {
      const { teamId, sessionToken } = await setupAdmin();

      const res = await appRequest(`/teams/${teamId}/invites`, {
        method: 'POST',
        headers: {
          Cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ targetRole: 'member' }),
      });

      expect(res.status).toBe(201);
      const json = (await res.json()) as Record<string, unknown>;
      const link = json.inviteLink as string;
      const url = new URL(link);
      const token = url.searchParams.get('token')!;

      // Query ALL columns from the invites table and verify:
      // 1. token_hash is a SHA-256 hex string (64 chars), not the plaintext
      // 2. The plaintext token does NOT appear anywhere in the row
      const inviteRows = await db.$client.query(
        `SELECT * FROM invites WHERE id = $1`,
        [json.id as string],
      );
      const row = inviteRows.rows[0] as Record<string, unknown>;

      // The hash column must exist and be 64 hex characters
      const tokenHash = row['token_hash'] as string;
      expect(tokenHash).toBeTruthy();
      expect(tokenHash.length).toBe(64); // SHA-256 hex = 64 chars
      expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);

      // The plaintext token must not be anywhere in the row
      const rowStr = JSON.stringify(row);
      expect(rowStr).not.toContain(token);

      // Verify the hash matches the computed hash
      expect(tokenHash).toBe(hashInviteToken(token));
    });
  });
});
