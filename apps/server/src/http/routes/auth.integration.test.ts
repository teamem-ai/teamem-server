/**
 * Integration tests for GitHub OAuth auth routes (M2-AUTH-02).
 *
 * Covers:
 *   - GET /auth/github → redirect to GitHub with state parameter
 *   - GET /auth/github/callback → state validation, code exchange (mocked),
 *     user upsert, session creation, bootstrap team
 *   - POST /auth/logout → session revocation, cookie clearing
 *   - GET /auth/me → returns current user info from session
 *   - Counterexamples:
 *     - Forged/expired state is rejected
 *     - Second user without team membership gets "no team" status
 *     - Logged-out session is immediately invalid
 *     - No secrets/tokens in response bodies
 *
 * Tests run against real PostgreSQL; GitHub API calls are mocked via
 * injected fetch so no real GitHub App credentials are needed for CI.
 *
 * Requires TEST_DATABASE_URL pointing to a Postgres instance with
 * migrations applied.
 */
import { randomBytes, createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createDb, type AppDb } from '../../db/client.js';
import {
  connectDatabase,
  closeDatabase,
  type Pool,
} from '../../test/database.js';
import { buildAuthRoutes } from './auth.js';
import type { GitHubOAuthConfig } from '../../auth/oauth-github.js';
import {
  generateState,
  generateSessionToken,
  parseSessionCookie,
  SESSION_COOKIE_NAME,
} from '../../auth/oauth-github.js';
import { requestContext } from '../request-context.js';
import { globalErrorHandler, notFoundHandler } from '../errors.js';

const url = process.env['TEST_DATABASE_URL'];

describe.skipIf(!url)('GitHub OAuth Auth Routes (live Postgres)', () => {
  let pool: Pool;
  let db: AppDb;
  let app: Hono;

  // Mock fetch for GitHub API calls
  const mockFetch = vi.fn<typeof fetch>();

  // Test OAuth config (fake client credentials for CI — no real GitHub App needed)
  const oauthConfig: GitHubOAuthConfig = {
    clientId: 'Iv1.test_client_id',
    clientSecret: 'test_client_secret_for_unit_tests',
    redirectUri: 'http://localhost:8080/auth/github/callback',
    serverBaseUrl: 'http://localhost:8080',
    fetchImpl: mockFetch as unknown as typeof fetch,
  };

  beforeAll(async () => {
    ({ pool } = connectDatabase());
    db = createDb(url!, { pool: pool as unknown as import('pg').Pool });

    // Build the Hono app with auth routes and global middleware
    app = new Hono();
    app.use('*', requestContext);
    app.onError(globalErrorHandler);
    app.notFound(notFoundHandler);
    app.route('/', buildAuthRoutes(oauthConfig, db));
  });

  afterAll(async () => {
    await closeDatabase(pool);
  });

  beforeEach(async () => {
    mockFetch.mockReset();
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

  /** Extract Set-Cookie value from response headers. */
  function getSessionCookie(res: Response): string | null {
    const setCookie = res.headers.get('set-cookie');
    if (!setCookie) return null;
    return parseSessionCookie(setCookie);
  }

  /** Helper: create a user directly in DB. Returns the user ID. */
  async function createUser(githubId: number, login: string, avatarUrl?: string): Promise<string> {
    const id = `usr_${randomBytes(8).toString('hex')}`;
    const avatarCol = avatarUrl ? `'${avatarUrl}'` : 'NULL';
    await db.execute(
      `INSERT INTO users (id, github_id, github_login, avatar_url) VALUES ('${id}', ${githubId}, '${login}', ${avatarCol})`,
    );
    return id;
  }

  /** Helper: create a team directly in DB. Returns the team ID. */
  async function createTeam(name: string): Promise<string> {
    const id = `team_${randomBytes(8).toString('hex')}`;
    await db.execute(`INSERT INTO teams (id, name) VALUES ('${id}', '${name}')`);
    return id;
  }

  /** Helper: create a session directly in DB. Returns plaintext + sessionId. */
  async function createTestSession(userId: string): Promise<{ plaintext: string; sessionId: string }> {
    const { plaintext, hash } = generateSessionToken();
    const sessionId = `ses_${randomBytes(8).toString('hex')}`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 7 * 24 * 3600_000);
    await db.execute(
      `INSERT INTO web_sessions (id, user_id, token_hash, issued_at, expires_at) VALUES ('${sessionId}', '${userId}', '${hash}', '${now.toISOString()}', '${expiresAt.toISOString()}')`,
    );
    return { plaintext, sessionId };
  }

  /** Helper: create a session that is already expired. */
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

  // ═══════════════════════════════════════════════════════════════════════════
  // GET /auth/github
  // ═══════════════════════════════════════════════════════════════════════════

  describe('GET /auth/github', () => {
    it('redirects to GitHub authorize URL with state parameter', async () => {
      const res = await appRequest('/auth/github', { redirect: 'manual' });

      expect(res.status).toBe(302);
      const location = res.headers.get('location');
      expect(location).toContain('https://github.com/login/oauth/authorize');
      expect(location).toContain('client_id=Iv1.test_client_id');
      expect(location).toContain('redirect_uri=');
      expect(location).toContain('scope=read%3Auser');
      expect(location).toContain('state=');

      // Extract state from location and verify it
      const url = new URL(location!);
      const state = url.searchParams.get('state');
      expect(state).toBeTruthy();
      const result = await import('../../auth/oauth-github.js').then((m) =>
        m.verifyState(state!, oauthConfig.clientSecret),
      );
      expect(result.valid).toBe(true);
    });

    it('sets a CSRF state cookie for defense-in-depth', async () => {
      const res = await appRequest('/auth/github', { redirect: 'manual' });
      const setCookie = res.headers.get('set-cookie');
      expect(setCookie).toContain('teamem_oauth_state=');
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('SameSite=Lax');
      expect(setCookie).toContain('Max-Age=600');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // GET /auth/github/callback — success path
  // ═══════════════════════════════════════════════════════════════════════════

  describe('GET /auth/github/callback — success path', () => {
    it('completes OAuth flow: upserts user, creates session, redirects to /app', async () => {
      const state = generateState(oauthConfig.clientSecret);

      // Mock GitHub token exchange
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'gho_test_access_token',
            token_type: 'bearer',
            scope: 'read:user',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      // Mock GitHub /user API
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 12345,
            login: 'testuser',
            avatar_url: 'https://avatars.githubusercontent.com/u/12345?v=4',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      const res = await appRequest(
        `/auth/github/callback?code=test_code&state=${encodeURIComponent(state)}`,
        { redirect: 'manual' },
      );

      // Should redirect to /app (success)
      expect(res.status).toBe(302);
      const location = res.headers.get('location');
      expect(location).toContain('/app');

      // Should set session cookie
      const sessionCookie = getSessionCookie(res);
      expect(sessionCookie).toBeTruthy();
      expect(sessionCookie!.length).toBeGreaterThan(20);

      // Verify user was created in database
      const userRows = await db.execute(
        `SELECT id, github_id, github_login, avatar_url FROM users WHERE github_id = 12345`,
      );
      expect(userRows.rows).toHaveLength(1);
      const userId = (userRows.rows[0] as Record<string, unknown>)['id'] as string;

      // Verify team was bootstrapped (first user)
      const teamRows = await db.execute(`SELECT id, name FROM teams`);
      expect(teamRows.rows.length).toBeGreaterThanOrEqual(1);

      // Verify membership was created
      const membershipRows = await db.execute(
        `SELECT m.user_id, m.team_id, m.role FROM memberships m WHERE m.user_id = '${userId}'`,
      );
      expect(membershipRows.rows).toHaveLength(1);
      expect((membershipRows.rows[0] as Record<string, unknown>)['role']).toBe('owner');

      // Verify session was created
      const sessionRows = await db.execute(`SELECT id, user_id, revoked_at FROM web_sessions`);
      expect(sessionRows.rows.length).toBeGreaterThanOrEqual(1);
      expect((sessionRows.rows[0] as Record<string, unknown>)['revoked_at']).toBeNull();

      // No secrets in response body or location
      expect(location).not.toContain('access_token');
      expect(location).not.toContain('gho_');
      expect(location).not.toContain('client_secret');
      expect(location).not.toContain('test_client_secret');
    });

    it('does not create duplicate users on second login (same github_id)', async () => {
      const state = generateState(oauthConfig.clientSecret);

      // Mock GitHub token exchange and user API
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: 'gho_token', token_type: 'bearer', scope: 'read:user' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ id: 42, login: 'duplicate_user', avatar_url: null }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      // First login
      await appRequest(
        `/auth/github/callback?code=code1&state=${encodeURIComponent(state)}`,
        { redirect: 'manual' },
      );

      const count1Result = await db.execute(`SELECT COUNT(*) as count FROM users WHERE github_id = 42`);
      const count1 = Number((count1Result.rows[0] as Record<string, unknown>)['count']);
      expect(count1).toBe(1);

      const state2 = generateState(oauthConfig.clientSecret);

      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: 'gho_token2', token_type: 'bearer', scope: 'read:user' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ id: 42, login: 'duplicate_user_renamed', avatar_url: 'https://example.com/avatar.png' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      // Second login (same github_id, different login name)
      await appRequest(
        `/auth/github/callback?code=code2&state=${encodeURIComponent(state2)}`,
        { redirect: 'manual' },
      );

      const count2Result = await db.execute(`SELECT COUNT(*) as count FROM users WHERE github_id = 42`);
      const count2 = Number((count2Result.rows[0] as Record<string, unknown>)['count']);
      expect(count2).toBe(1);

      // Login should have been updated
      const userRows = await db.execute(`SELECT github_login, avatar_url FROM users WHERE github_id = 42`);
      expect((userRows.rows[0] as Record<string, unknown>)['github_login']).toBe('duplicate_user_renamed');
      expect((userRows.rows[0] as Record<string, unknown>)['avatar_url']).toBe('https://example.com/avatar.png');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // GET /auth/github/callback — error / counterexample paths
  // ═══════════════════════════════════════════════════════════════════════════

  describe('GET /auth/github/callback — counterexamples', () => {
    it('rejects callback with missing state parameter', async () => {
      const res = await appRequest(
        '/auth/github/callback?code=test_code',
        { redirect: 'manual' },
      );

      expect(res.status).toBe(302);
      const location = res.headers.get('location');
      expect(location).toContain('error=invalid_request');
    });

    it('rejects callback with missing code parameter', async () => {
      const state = generateState(oauthConfig.clientSecret);
      const res = await appRequest(
        `/auth/github/callback?state=${encodeURIComponent(state)}`,
        { redirect: 'manual' },
      );

      expect(res.status).toBe(302);
      const location = res.headers.get('location');
      expect(location).toContain('error=invalid_request');
    });

    it('rejects tampered/forged state parameter (HMAC mismatch)', async () => {
      const forgedState = `forged_random.${Date.now() + 999999}.badsignature`;
      const res = await appRequest(
        `/auth/github/callback?code=test_code&state=${encodeURIComponent(forgedState)}`,
        { redirect: 'manual' },
      );

      expect(res.status).toBe(302);
      const location = res.headers.get('location');
      expect(location).toContain('error=invalid_state');
    });

    it('rejects expired state parameter', async () => {
      // Build an expired state token manually
      const random = 'expiredtest';
      const pastExpiry = Date.now() - 3600_000; // 1 hour ago
      const payload = `${random}.${pastExpiry}`;
      const sig = createHmac('sha256', oauthConfig.clientSecret).update(payload).digest('base64url');
      const expiredState = `${payload}.${sig}`;

      const res = await appRequest(
        `/auth/github/callback?code=test_code&state=${encodeURIComponent(expiredState)}`,
        { redirect: 'manual' },
      );

      expect(res.status).toBe(302);
      const location = res.headers.get('location');
      expect(location).toContain('error=invalid_state');
    });

    it('handles GitHub returning an error parameter (user denied access)', async () => {
      const state = generateState(oauthConfig.clientSecret);
      const res = await appRequest(
        `/auth/github/callback?error=access_denied&error_description=User+denied&state=${encodeURIComponent(state)}`,
        { redirect: 'manual' },
      );

      expect(res.status).toBe(302);
      const location = res.headers.get('location');
      expect(location).toContain('error=github_denied');
    });

    it('second user without team membership gets "no_team" flag in redirect', async () => {
      // First, create a team with a different user
      const existingTeamId = await createTeam('Existing Team');
      const existingUserId = await createUser(99999, 'existinguser');
      await db.execute(
        `INSERT INTO memberships (user_id, team_id, role) VALUES ('${existingUserId}', '${existingTeamId}', 'owner')`,
      );

      const state = generateState(oauthConfig.clientSecret);

      // Mock GitHub token exchange
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: 'gho_new_user_token', token_type: 'bearer', scope: 'read:user' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      // Mock GitHub /user API — new user, not in any team
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ id: 55555, login: 'newuser', avatar_url: null }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      const res = await appRequest(
        `/auth/github/callback?code=new_user_code&state=${encodeURIComponent(state)}`,
        { redirect: 'manual' },
      );

      expect(res.status).toBe(302);
      const location = res.headers.get('location');
      expect(location).toContain('no_team=true');

      // Verify user was created but no membership
      const userRows = await db.execute(`SELECT id FROM users WHERE github_id = 55555`);
      expect(userRows.rows).toHaveLength(1);
      const newUserId = (userRows.rows[0] as Record<string, unknown>)['id'];

      const membershipRows = await db.execute(
        `SELECT * FROM memberships WHERE user_id = '${newUserId}'`,
      );
      expect(membershipRows.rows).toHaveLength(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // POST /auth/logout
  // ═══════════════════════════════════════════════════════════════════════════

  describe('POST /auth/logout', () => {
    it('revokes the session and clears the cookie', async () => {
      const userId = await createUser(111, 'logoutuser');
      const { plaintext, sessionId } = await createTestSession(userId);

      // Make request with session cookie
      const sessionCookie = `${SESSION_COOKIE_NAME}=${plaintext}`;
      const res = await appRequest('/auth/logout', {
        method: 'POST',
        headers: { Cookie: sessionCookie },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.status).toBe('ok');

      // Verify cookie was cleared
      const setCookie = res.headers.get('set-cookie');
      expect(setCookie).toContain('Max-Age=0');

      // Verify session was revoked in DB
      const sessionRows = await db.execute(
        `SELECT revoked_at FROM web_sessions WHERE id = '${sessionId}'`,
      );
      expect((sessionRows.rows[0] as Record<string, unknown>)['revoked_at']).not.toBeNull();
    });

    it('old session cookie is rejected after logout (immediate revocation)', async () => {
      const userId = await createUser(222, 'revokeduser');
      const { plaintext } = await createTestSession(userId);

      const sessionCookie = `${SESSION_COOKIE_NAME}=${plaintext}`;

      // Logout
      await appRequest('/auth/logout', {
        method: 'POST',
        headers: { Cookie: sessionCookie },
      });

      // Try to access /auth/me with the same cookie
      const res = await appRequest('/auth/me', {
        headers: { Cookie: sessionCookie },
      });

      expect(res.status).toBe(401);
    });

    it('returns 401 for logout without a session', async () => {
      const res = await appRequest('/auth/logout', { method: 'POST' });
      expect(res.status).toBe(401);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // GET /auth/me
  // ═══════════════════════════════════════════════════════════════════════════

  describe('GET /auth/me', () => {
    it('returns user info for a valid session', async () => {
      const userId = await createUser(333, 'meuser', 'https://avatars.example.com/me.png');
      const teamId = await createTeam('Me Team');
      await db.execute(
        `INSERT INTO memberships (user_id, team_id, role) VALUES ('${userId}', '${teamId}', 'admin')`,
      );
      const { plaintext } = await createTestSession(userId);

      const res = await appRequest('/auth/me', {
        headers: { Cookie: `${SESSION_COOKIE_NAME}=${plaintext}` },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.userId).toBe(userId);
      expect(json.githubLogin).toBe('meuser');
      expect(json.avatarUrl).toBe('https://avatars.example.com/me.png');
      expect(json.teamId).toBe(teamId);
      expect(json.teamName).toBe('Me Team');
      expect(json.role).toBe('admin');
    });

    it('returns teamId=null for user without team membership', async () => {
      const userId = await createUser(444, 'noteamuser');
      const { plaintext } = await createTestSession(userId);

      const res = await appRequest('/auth/me', {
        headers: { Cookie: `${SESSION_COOKIE_NAME}=${plaintext}` },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.userId).toBe(userId);
      expect(json.githubLogin).toBe('noteamuser');
      expect(json.teamId).toBeNull();
      expect(json.role).toBeNull();
    });

    it('returns 401 without a session cookie', async () => {
      const res = await appRequest('/auth/me');
      expect(res.status).toBe(401);
    });

    it('returns 401 with a fake session token', async () => {
      const res = await appRequest('/auth/me', {
        headers: { Cookie: `${SESSION_COOKIE_NAME}=fake_token_that_does_not_exist` },
      });
      expect(res.status).toBe(401);
    });

    it('returns 401 with an expired session', async () => {
      const userId = await createUser(555, 'expireduser');
      const { plaintext } = await createExpiredSession(userId);

      const res = await appRequest('/auth/me', {
        headers: { Cookie: `${SESSION_COOKIE_NAME}=${plaintext}` },
      });

      expect(res.status).toBe(401);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Security: no secrets in responses
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Security: no secrets in responses', () => {
    it('callback error response does not expose client secret', async () => {
      const res = await appRequest(
        '/auth/github/callback?code=test&state=bad',
        { redirect: 'manual' },
      );

      expect(res.status).toBe(302);
      const location = res.headers.get('location') ?? '';
      const setCookie = res.headers.get('set-cookie') ?? '';

      // No secrets in URL or cookies
      expect(location).not.toContain(oauthConfig.clientSecret);
      expect(location).not.toContain('access_token');
      expect(setCookie).not.toContain(oauthConfig.clientSecret);
    });

    it('GET /auth/me response does not contain session token', async () => {
      const userId = await createUser(666, 'nosecretuser');
      const { plaintext, sessionId } = await createTestSession(userId);

      const res = await appRequest('/auth/me', {
        headers: { Cookie: `${SESSION_COOKIE_NAME}=${plaintext}` },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      const body = JSON.stringify(json);

      // The session plaintext should never be in a response
      expect(body).not.toContain(plaintext);
      // No sessionId or tokenHash leaked
      expect(body).not.toContain(sessionId);
      expect(body).not.toContain('token_hash');
    });
  });
});
