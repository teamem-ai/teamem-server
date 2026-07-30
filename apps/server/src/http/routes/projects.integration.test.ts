/**
 * Integration tests for project management routes (DUA-230).
 *
 * Covers:
 *   - POST /v1/teams/:teamId/projects → create project (admin+)
 *   - PATCH /v1/teams/:teamId/projects/:projectId → rename project (admin+)
 *   - GET  /v1/teams/:teamId/projects → list projects (any role)
 *   - Counterexamples:
 *     - No session → 401
 *     - No membership in target team → 404
 *     - member/viewer creating/renaming project → 403
 *     - Cross-team access → 404 (indistinguishable from missing)
 *     - Renaming a non-existent project → 404
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
import { buildProjectsRoutes } from './projects.js';
import {
  generateSessionToken,
  SESSION_COOKIE_NAME,
} from '../../auth/oauth-github.js';
import { requestContext } from '../request-context.js';
import { globalErrorHandler, notFoundHandler } from '../errors.js';

const url = process.env['TEST_DATABASE_URL'];

describe.skipIf(!url)('Projects Routes (live Postgres)', () => {
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
    app.route('/', buildProjectsRoutes({ db }));
  });

  afterAll(async () => {
    await closeDatabase(pool);
  });

  beforeEach(async () => {
    // Clean up in reverse FK order. We must include concept/event/job
    // tables because existing data may have FK references into projects
    // (via concepts_project_fk) that would block project deletion.
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

  // Use a unique base for github_ids to avoid collisions with other test
  // files (the users table has a UNIQUE constraint on github_id).
  let githubIdCounter = 10_000;
  function nextGithubId(): number {
    return githubIdCounter++;
  }

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

  async function createProject(teamId: string, name: string): Promise<string> {
    const id = `prj_${randomBytes(8).toString('hex')}`;
    await db.execute(
      `INSERT INTO projects (id, team_id, name) VALUES ('${id}', '${teamId}', '${name}')`,
    );
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
  // POST /v1/teams/:teamId/projects — create project
  // ═══════════════════════════════════════════════════════════════════════════

  describe('POST /v1/teams/:teamId/projects — create project', () => {
    it('creates a project for admin user', async () => {
      const userId = await createUser(nextGithubId(), 'adminuser');
      const teamId = await createTeam('Admin Team');
      await addMembership(userId, teamId, 'admin');
      const sessionToken = await createSession(userId);

      const res = await app.request(`/v1/teams/${teamId}/projects`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie(sessionToken),
        },
        body: JSON.stringify({ name: 'New Project' }),
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.data.id).toMatch(/^prj_/);
      expect(json.data.teamId).toBe(teamId);
      expect(json.data.name).toBe('New Project');
      expect(json.data.createdAt).toBeTruthy();

      // Verify project in DB
      const rows = await db.execute(
        `SELECT id FROM projects WHERE id = '${json.data.id}' AND team_id = '${teamId}'`,
      );
      expect(rows.rows).toHaveLength(1);
    });

    it('creates a project for owner user', async () => {
      const userId = await createUser(nextGithubId(), 'owneruser');
      const teamId = await createTeam('Owner Team');
      await addMembership(userId, teamId, 'owner');
      const sessionToken = await createSession(userId);

      const res = await app.request(`/v1/teams/${teamId}/projects`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie(sessionToken),
        },
        body: JSON.stringify({ name: 'Owner Project' }),
      });

      expect(res.status).toBe(201);
    });

    it('rejects project creation for viewer (403)', async () => {
      const userId = await createUser(nextGithubId(), 'vieweruser');
      const teamId = await createTeam('Viewer Team');
      await addMembership(userId, teamId, 'viewer');
      const sessionToken = await createSession(userId);

      const res = await app.request(`/v1/teams/${teamId}/projects`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie(sessionToken),
        },
        body: JSON.stringify({ name: 'Viewer Attempt' }),
      });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error.code).toBe('forbidden');
      expect(json.error.details).toBeUndefined();
    });

    it('rejects project creation for member (403)', async () => {
      const userId = await createUser(nextGithubId(), 'memberuser');
      const teamId = await createTeam('Member Team');
      await addMembership(userId, teamId, 'member');
      const sessionToken = await createSession(userId);

      const res = await app.request(`/v1/teams/${teamId}/projects`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie(sessionToken),
        },
        body: JSON.stringify({ name: 'Member Attempt' }),
      });

      expect(res.status).toBe(403);
    });

    it('returns 404 for cross-team access (user not in target team)', async () => {
      const userId = await createUser(nextGithubId(), 'teamAuser');
      const teamAId = await createTeam('Team A');
      const teamBId = await createTeam('Team B');
      await addMembership(userId, teamAId, 'admin');
      // User has NO membership in team B
      const sessionToken = await createSession(userId);

      const res = await app.request(`/v1/teams/${teamBId}/projects`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie(sessionToken),
        },
        body: JSON.stringify({ name: 'Cross Team Project' }),
      });

      expect(res.status).toBe(404);
    });

    it('returns 401 without session', async () => {
      const teamId = await createTeam('NoAuth Team');
      const res = await app.request(`/v1/teams/${teamId}/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'No Auth Project' }),
      });

      expect(res.status).toBe(401);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PATCH /v1/teams/:teamId/projects/:projectId — rename project
  // ═══════════════════════════════════════════════════════════════════════════

  describe('PATCH /v1/teams/:teamId/projects/:projectId — rename project', () => {
    it('renames a project for admin user', async () => {
      const userId = await createUser(nextGithubId(), 'renameadmin');
      const teamId = await createTeam('Rename Team');
      const projectId = await createProject(teamId, 'Old Name');
      await addMembership(userId, teamId, 'admin');
      const sessionToken = await createSession(userId);

      const res = await app.request(`/v1/teams/${teamId}/projects/${projectId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie(sessionToken),
        },
        body: JSON.stringify({ name: 'New Name' }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.id).toBe(projectId);
      expect(json.data.name).toBe('New Name');

      // Verify in DB
      const rows = await db.execute(
        `SELECT name FROM projects WHERE id = '${projectId}' AND team_id = '${teamId}'`,
      );
      expect((rows.rows[0] as Record<string, unknown>)['name']).toBe('New Name');
    });

    it('rejects rename for viewer (403)', async () => {
      const userId = await createUser(nextGithubId(), 'renameviewer');
      const teamId = await createTeam('Viewer Rename Team');
      const projectId = await createProject(teamId, 'Cannot Rename');
      await addMembership(userId, teamId, 'viewer');
      const sessionToken = await createSession(userId);

      const res = await app.request(`/v1/teams/${teamId}/projects/${projectId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie(sessionToken),
        },
        body: JSON.stringify({ name: 'Attempted Rename' }),
      });

      expect(res.status).toBe(403);
    });

    it('returns 404 for non-existent project', async () => {
      const userId = await createUser(nextGithubId(), 'noexist');
      const teamId = await createTeam('Missing Project Team');
      await addMembership(userId, teamId, 'admin');
      const sessionToken = await createSession(userId);

      const res = await app.request(`/v1/teams/${teamId}/projects/prj_nonexistent1234`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie(sessionToken),
        },
        body: JSON.stringify({ name: 'Ghost Project' }),
      });

      expect(res.status).toBe(404);
    });

    it('returns 404 for cross-team project rename (project in different team)', async () => {
      const userId = await createUser(nextGithubId(), 'crossrename');
      const teamAId = await createTeam('Cross Rename A');
      const teamBId = await createTeam('Cross Rename B');
      const projectInB = await createProject(teamBId, 'B Project');
      await addMembership(userId, teamAId, 'admin');
      // User is admin in team A, has NO membership in team B
      const sessionToken = await createSession(userId);

      // Try to rename a project in team B via team A URL
      const res = await app.request(`/v1/teams/${teamAId}/projects/${projectInB}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie(sessionToken),
        },
        body: JSON.stringify({ name: 'Stolen Project' }),
      });

      // Project belongs to team B, not team A → 404
      expect(res.status).toBe(404);
    });

    it('returns 404 for project in same team but accessed via wrong team URL', async () => {
      const userId = await createUser(nextGithubId(), 'wrongurl');
      const teamAId = await createTeam('Wrong URL A');
      const teamBId = await createTeam('Wrong URL B');
      // User is admin in both teams
      await addMembership(userId, teamAId, 'admin');
      await addMembership(userId, teamBId, 'admin');
      const projectInA = await createProject(teamAId, 'A Project');
      const sessionToken = await createSession(userId);

      // Access project in team A via team B's URL
      const res = await app.request(`/v1/teams/${teamBId}/projects/${projectInA}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie(sessionToken),
        },
        body: JSON.stringify({ name: 'Wrong Team' }),
      });

      // Project belongs to team A, but query is scoped to team B → 404
      expect(res.status).toBe(404);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // GET /v1/teams/:teamId/projects — list projects
  // ═══════════════════════════════════════════════════════════════════════════

  describe('GET /v1/teams/:teamId/projects — list projects', () => {
    it('lists projects for a team (any role can access)', async () => {
      const userId = await createUser(nextGithubId(), 'listviewer');
      const teamId = await createTeam('List Team');
      await createProject(teamId, 'Project 1');
      await createProject(teamId, 'Project 2');
      await addMembership(userId, teamId, 'viewer');
      const sessionToken = await createSession(userId);

      const res = await app.request(`/v1/teams/${teamId}/projects`, {
        headers: { Cookie: cookie(sessionToken) },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data).toHaveLength(2);
      expect(json.data.map((p: { name: string }) => p.name).sort()).toEqual(['Project 1', 'Project 2']);
    });

    it('returns empty array for team with no projects', async () => {
      const userId = await createUser(nextGithubId(), 'emptylister');
      const teamId = await createTeam('Empty Team');
      await addMembership(userId, teamId, 'viewer');
      const sessionToken = await createSession(userId);

      const res = await app.request(`/v1/teams/${teamId}/projects`, {
        headers: { Cookie: cookie(sessionToken) },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data).toEqual([]);
    });

    it('returns 404 for cross-team access (different team)', async () => {
      const userId = await createUser(nextGithubId(), 'crosslister');
      const teamAId = await createTeam('List A');
      const teamBId = await createTeam('List B');
      await addMembership(userId, teamAId, 'viewer');
      // No membership in team B
      const sessionToken = await createSession(userId);

      const res = await app.request(`/v1/teams/${teamBId}/projects`, {
        headers: { Cookie: cookie(sessionToken) },
      });

      expect(res.status).toBe(404);
    });

    it('returns 401 without session', async () => {
      const teamId = await createTeam('NoAuth List');
      const res = await app.request(`/v1/teams/${teamId}/projects`);
      expect(res.status).toBe(401);
    });
  });
});
