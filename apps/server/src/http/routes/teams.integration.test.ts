/**
 * Integration tests for team management routes (DUA-230).
 *
 * Covers:
 *   - POST /v1/teams → creates team, creator becomes owner
 *   - GET  /v1/teams/mine → lists teams the session user belongs to
 *   - Counterexamples:
 *     - No session → 401
 *     - Invalid request body → 400
 *     - User sees only their own teams (cross-user isolation)
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
import { buildTeamsRoutes } from './teams.js';
import {
  generateSessionToken,
  SESSION_COOKIE_NAME,
} from '../../auth/oauth-github.js';
import { requestContext } from '../request-context.js';
import { globalErrorHandler, notFoundHandler } from '../errors.js';

const url = process.env['TEST_DATABASE_URL'];

describe.skipIf(!url)('Teams Routes (live Postgres)', () => {
  let pool: Pool;
  let db: AppDb;
  let app: Hono;

  beforeAll(async () => {
    ({ pool } = connectDatabase());
    db = createDb(url!, { pool: pool as unknown as import('pg').Pool });

    app = new Hono();
    app.use('*', requestContext);
    app.onError(globalErrorHandler);
    app.notFound(notFoundHandler);
    app.route('/', buildTeamsRoutes({ db }));
  });

  afterAll(async () => {
    await closeDatabase(pool);
  });

  beforeEach(async () => {
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

  async function createUser(githubId: number, login: string): Promise<string> {
    const id = `usr_${randomBytes(8).toString('hex')}`;
    await db.execute(
      `INSERT INTO users (id, github_id, github_login) VALUES ('${id}', ${githubId}, '${login}')`,
    );
    return id;
  }

  async function createSession(userId: string): Promise<string> {
    const { plaintext, hash } = generateSessionToken();
    const sessionId = `ses_${randomBytes(8).toString('hex')}`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 7 * 24 * 3600_000);
    await db.execute(
      `INSERT INTO web_sessions (id, user_id, token_hash, issued_at, expires_at) VALUES ('${sessionId}', '${userId}', '${hash}', '${now.toISOString()}', '${expiresAt.toISOString()}')`,
    );
    return plaintext;
  }

  async function createTeam(name: string): Promise<string> {
    const id = `team_${randomBytes(8).toString('hex')}`;
    await db.execute(`INSERT INTO teams (id, name) VALUES ('${id}', '${name}')`);
    return id;
  }

  async function addMembership(userId: string, teamId: string, role: string): Promise<void> {
    await db.execute(
      `INSERT INTO memberships (user_id, team_id, role) VALUES ('${userId}', '${teamId}', '${role}')`,
    );
  }

  function cookie(token: string): string {
    return `${SESSION_COOKIE_NAME}=${token}`;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // POST /v1/teams
  // ═══════════════════════════════════════════════════════════════════════════

  describe('POST /v1/teams', () => {
    it('creates a team and makes the creator an owner', async () => {
      const userId = await createUser(1, 'creator');
      const sessionToken = await createSession(userId);

      const res = await app.request('/v1/teams', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie(sessionToken),
        },
        body: JSON.stringify({ name: 'My New Team' }),
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.data.id).toMatch(/^team_/);
      expect(json.data.name).toBe('My New Team');
      expect(json.data.role).toBe('owner');
      expect(json.data.createdAt).toBeTruthy();

      // Verify membership in DB
      const memberships = await db.execute(
        `SELECT user_id, team_id, role FROM memberships WHERE team_id = '${json.data.id}'`,
      );
      expect(memberships.rows).toHaveLength(1);
      expect((memberships.rows[0] as Record<string, unknown>)['user_id']).toBe(userId);
      expect((memberships.rows[0] as Record<string, unknown>)['role']).toBe('owner');
    });

    it('returns 401 without a session', async () => {
      const res = await app.request('/v1/teams', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'No Session Team' }),
      });

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error.code).toBe('unauthorized');
    });

    it('returns 400 for missing name', async () => {
      const userId = await createUser(2, 'baduser');
      const sessionToken = await createSession(userId);

      const res = await app.request('/v1/teams', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie(sessionToken),
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 for empty name', async () => {
      const userId = await createUser(3, 'emptyuser');
      const sessionToken = await createSession(userId);

      const res = await app.request('/v1/teams', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie(sessionToken),
        },
        body: JSON.stringify({ name: '' }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 for overly long name (>100 chars)', async () => {
      const userId = await createUser(4, 'longuser');
      const sessionToken = await createSession(userId);

      const res = await app.request('/v1/teams', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie(sessionToken),
        },
        body: JSON.stringify({ name: 'x'.repeat(101) }),
      });

      expect(res.status).toBe(400);
    });

    it('allows a user to create multiple teams, each with owner membership', async () => {
      const userId = await createUser(5, 'serialcreator');
      const sessionToken = await createSession(userId);

      const res1 = await app.request('/v1/teams', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie(sessionToken),
        },
        body: JSON.stringify({ name: 'Team Alpha' }),
      });
      expect(res1.status).toBe(201);

      const res2 = await app.request('/v1/teams', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie(sessionToken),
        },
        body: JSON.stringify({ name: 'Team Beta' }),
      });
      expect(res2.status).toBe(201);

      // Verify both memberships
      const memberships = await db.execute(
        `SELECT m.team_id, m.role, t.name
         FROM memberships m
         JOIN teams t ON t.id = m.team_id
         WHERE m.user_id = '${userId}'
         ORDER BY m.created_at ASC`,
      );
      expect(memberships.rows).toHaveLength(2);
      expect((memberships.rows[0] as Record<string, unknown>)['name']).toBe('Team Alpha');
      expect((memberships.rows[0] as Record<string, unknown>)['role']).toBe('owner');
      expect((memberships.rows[1] as Record<string, unknown>)['name']).toBe('Team Beta');
      expect((memberships.rows[1] as Record<string, unknown>)['role']).toBe('owner');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // GET /v1/teams/mine
  // ═══════════════════════════════════════════════════════════════════════════

  describe('GET /v1/teams/mine', () => {
    it('returns teams the session user is a member of', async () => {
      const userId = await createUser(10, 'multi-team-user');
      const sessionToken = await createSession(userId);

      const teamAId = await createTeam('Team A');
      const teamBId = await createTeam('Team B');
      await addMembership(userId, teamAId, 'admin');
      await addMembership(userId, teamBId, 'viewer');

      // Create a third team the user does NOT belong to
      const otherUserId = await createUser(11, 'otheruser');
      await addMembership(otherUserId, await createTeam('Other Team'), 'owner');

      const res = await app.request('/v1/teams/mine', {
        headers: { Cookie: cookie(sessionToken) },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data).toHaveLength(2);

      // Verify both teams with correct roles
      const teamA = json.data.find((t: { name: string }) => t.name === 'Team A');
      const teamB = json.data.find((t: { name: string }) => t.name === 'Team B');
      expect(teamA).toBeTruthy();
      expect(teamA.role).toBe('admin');
      expect(teamB).toBeTruthy();
      expect(teamB.role).toBe('viewer');

      // "Other Team" should NOT appear
      expect(json.data.find((t: { name: string }) => t.name === 'Other Team')).toBeUndefined();
    });

    it('returns empty array for user with no memberships', async () => {
      const userId = await createUser(12, 'lonelyuser');
      const sessionToken = await createSession(userId);

      const res = await app.request('/v1/teams/mine', {
        headers: { Cookie: cookie(sessionToken) },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data).toEqual([]);
    });

    it('returns 401 without a session', async () => {
      const res = await app.request('/v1/teams/mine');
      expect(res.status).toBe(401);
    });

    it('does not return teams created by other users', async () => {
      const userAId = await createUser(13, 'usera');
      const userBId = await createUser(14, 'userb');
      const sessionA = await createSession(userAId);

      // User A creates a team (automatically becomes owner)
      const resCreate = await app.request('/v1/teams', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie(sessionA),
        },
        body: JSON.stringify({ name: 'A Only Team' }),
      });
      expect(resCreate.status).toBe(201);
      // teamAId is verified indirectly via the /mine response below

      // User B creates their own team
      const sessionB = await createSession(userBId);
      await app.request('/v1/teams', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie(sessionB),
        },
        body: JSON.stringify({ name: 'B Only Team' }),
      });

      // User A's "my teams" should only show A's team
      const resMine = await app.request('/v1/teams/mine', {
        headers: { Cookie: cookie(sessionA) },
      });
      expect(resMine.status).toBe(200);
      const json = await resMine.json();
      expect(json.data).toHaveLength(1);
      expect(json.data[0].name).toBe('A Only Team');
    });
  });
});
