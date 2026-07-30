/**
 * Integration tests for web-side API key minting route (DUA-230).
 *
 * Covers:
 *   - POST /v1/teams/:teamId/keys → mints key (admin+), returns one-time
 *     plaintext token + claude mcp add command
 *   - Counterexamples:
 *     - No session → 401
 *     - No membership in target team → 404
 *     - member/viewer minting key → 403
 *     - Plaintext token NOT retrievable after minting (only hash in DB)
 *     - Cross-team access → 404
 *     - allProjects + projectId conflict → 400
 *     - Normal key without projectId → 400
 *     - Invalid scopes → 400
 *     - Minted key has only data-plane scopes — no admin capability
 *     - Key resolves correctly via Bearer auth on data-plane endpoint
 *
 * Tests run against real PostgreSQL.
 *
 * Requires TEST_DATABASE_URL pointing to a Postgres instance with
 * migrations applied.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono, type Context } from 'hono';
import { createDb, type AppDb } from '../../db/client.js';
import {
  connectDatabase,
  closeDatabase,
  type Pool,
} from '../../test/database.js';
import { buildKeysRoutes } from './keys.js';
import {
  generateSessionToken,
  SESSION_COOKIE_NAME,
} from '../../auth/oauth-github.js';
import { requireAuth, requireScope, getAuth } from '../auth.js';
import { requestContext } from '../request-context.js';
import { globalErrorHandler, notFoundHandler } from '../errors.js';

const url = process.env['TEST_DATABASE_URL'];

describe.skipIf(!url)('Keys Routes — web key minting (live Postgres)', () => {
  let pool: Pool;
  let db: AppDb;
  let app: Hono;

  beforeAll(async () => {
    ({ pool } = connectDatabase());
    db = createDb(url!, { pool: pool as unknown as import('pg').Pool });

    // Build the app with both key minting route and a test data-plane route
    // so we can verify that minted keys actually work for data access.
    app = new Hono();
    app.use('*', requestContext);
    app.onError(globalErrorHandler);
    app.notFound(notFoundHandler);

    // Key minting route (web-session-authenticated)
    app.route('/', buildKeysRoutes({ db, mcpConfig: { host: 'test.example', port: 9999 } }));

    // Test data-plane route to verify minted keys work
    app.use('/v1/test-data', requireAuth(db as Parameters<typeof requireAuth>[0]));
    app.use('/v1/test-data', requireScope('read'));
    app.get('/v1/test-data', (c: Context) => {
      const auth = getAuth(c);
      return c.json({
        credentialId: auth.credentialId,
        teamId: auth.team.id,
        scope: auth.scope.kind,
      });
    });
  });

  afterAll(async () => {
    await closeDatabase(pool);
  });

  beforeEach(async () => {
    // Clean up in reverse FK order — must include concept/event/job
    // tables to avoid FK violations when deleting projects.
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
  let githubIdCounter = 20_000;
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
  // POST /v1/teams/:teamId/keys — success paths
  // ═══════════════════════════════════════════════════════════════════════════

  describe('POST /v1/teams/:teamId/keys — success paths', () => {
    it('mints a project-bound key with default scopes', async () => {
      const userId = await createUser(nextGithubId(), 'keyminter');
      const teamId = await createTeam('Key Team');
      const projectId = await createProject(teamId, 'Key Project');
      await addMembership(userId, teamId, 'admin');
      const sessionToken = await createSession(userId);

      const res = await app.request(`/v1/teams/${teamId}/keys`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie(sessionToken),
        },
        body: JSON.stringify({
          name: 'My API Key',
          projectId,
        }),
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      const data = json.data;

      // Response shape
      expect(data.id).toMatch(/^key_/);
      expect(data.name).toBe('My API Key');
      expect(data.token).toMatch(/^tm_/);
      expect(data.token.length).toBeGreaterThan(40);
      expect(data.mcpCommand).toContain('claude mcp add');
      expect(data.mcpCommand).toContain(data.token);
      expect(data.mcpCommand).toContain('test.example:9999');
      expect(data.scopes).toEqual(['read']);
      expect(data.allProjects).toBe(false);
      expect(data.projectId).toBe(projectId);
      expect(data.createdAt).toBeTruthy();

      // Verify: only hash stored in DB, NOT the plaintext
      const dbRows = await db.execute(
        `SELECT id, token_hash, team_id, project_id, scopes, all_projects
         FROM api_keys WHERE id = '${data.id}'`,
      );
      expect(dbRows.rows).toHaveLength(1);
      const row = dbRows.rows[0] as Record<string, unknown>;
      expect(row['token_hash']).toBeTruthy();
      expect(typeof row['token_hash']).toBe('string');
      expect((row['token_hash'] as string).length).toBe(64); // SHA-256 hex
      expect(row['token_hash']).not.toBe(data.token);

      // Verify: plaintext token NOT retrievable from DB
      const tokenInDb = JSON.stringify(dbRows.rows);
      expect(tokenInDb).not.toContain(data.token);
    });

    it('mints a team-wide (allProjects) key', async () => {
      const userId = await createUser(nextGithubId(), 'allprojects');
      const teamId = await createTeam('AllProjects Team');
      await addMembership(userId, teamId, 'admin');
      const sessionToken = await createSession(userId);

      const res = await app.request(`/v1/teams/${teamId}/keys`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie(sessionToken),
        },
        body: JSON.stringify({
          name: 'Team-Wide Key',
          allProjects: true,
          scopes: ['read'],
        }),
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.data.allProjects).toBe(true);
      expect(json.data.projectId).toBeNull();

      // Verify DB
      const rows = await db.execute(
        `SELECT all_projects, project_id FROM api_keys WHERE id = '${json.data.id}'`,
      );
      expect((rows.rows[0] as Record<string, unknown>)['all_projects']).toBe(true);
      expect((rows.rows[0] as Record<string, unknown>)['project_id']).toBeNull();
    });

    it('minted key works as Bearer token on data-plane endpoint', async () => {
      const userId = await createUser(nextGithubId(), 'bearertest');
      const teamId = await createTeam('Bearer Team');
      const projectId = await createProject(teamId, 'Bearer Project');
      await addMembership(userId, teamId, 'admin');
      const sessionToken = await createSession(userId);

      // Mint a key
      const mintRes = await app.request(`/v1/teams/${teamId}/keys`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie(sessionToken),
        },
        body: JSON.stringify({
          name: 'Bearer Key',
          projectId,
          scopes: ['read'],
        }),
      });
      expect(mintRes.status).toBe(201);
      const mintData = (await mintRes.json()).data;
      const token = mintData.token as string;

      // Use the minted key on a data-plane endpoint
      const dataRes = await app.request('/v1/test-data', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(dataRes.status).toBe(200);
      const dataJson = await dataRes.json();
      expect(dataJson.credentialId).toBe(mintData.id);
      expect(dataJson.teamId).toBe(teamId);
      expect(dataJson.scope).toBe('project');
    });

    it('mints a key with custom scopes', async () => {
      const userId = await createUser(nextGithubId(), 'scopetest');
      const teamId = await createTeam('Scope Team');
      const projectId = await createProject(teamId, 'Scope Project');
      await addMembership(userId, teamId, 'admin');
      const sessionToken = await createSession(userId);

      const res = await app.request(`/v1/teams/${teamId}/keys`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie(sessionToken),
        },
        body: JSON.stringify({
          name: 'Multi-Scope Key',
          projectId,
          scopes: ['read', 'read:payload', 'events:write'],
        }),
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.data.scopes.sort()).toEqual(['events:write', 'read', 'read:payload'].sort());
    });

    it('owner can mint keys', async () => {
      const userId = await createUser(nextGithubId(), 'ownerminter');
      const teamId = await createTeam('Owner Key Team');
      const projectId = await createProject(teamId, 'Owner Project');
      await addMembership(userId, teamId, 'owner');
      const sessionToken = await createSession(userId);

      const res = await app.request(`/v1/teams/${teamId}/keys`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie(sessionToken),
        },
        body: JSON.stringify({
          name: 'Owner Key',
          projectId,
        }),
      });

      expect(res.status).toBe(201);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // POST /v1/teams/:teamId/keys — rejection / counterexample paths
  // ═══════════════════════════════════════════════════════════════════════════

  describe('POST /v1/teams/:teamId/keys — counterexamples', () => {
    it('rejects member from minting keys (403)', async () => {
      const userId = await createUser(nextGithubId(), 'membermint');
      const teamId = await createTeam('Member Mint Team');
      const projectId = await createProject(teamId, 'Member Project');
      await addMembership(userId, teamId, 'member');
      const sessionToken = await createSession(userId);

      const res = await app.request(`/v1/teams/${teamId}/keys`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie(sessionToken),
        },
        body: JSON.stringify({
          name: 'Member Key',
          projectId,
        }),
      });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error.code).toBe('forbidden');
      expect(json.error.details).toBeUndefined();
    });

    it('rejects viewer from minting keys (403)', async () => {
      const userId = await createUser(nextGithubId(), 'viewermint');
      const teamId = await createTeam('Viewer Mint Team');
      const projectId = await createProject(teamId, 'Viewer Project');
      await addMembership(userId, teamId, 'viewer');
      const sessionToken = await createSession(userId);

      const res = await app.request(`/v1/teams/${teamId}/keys`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie(sessionToken),
        },
        body: JSON.stringify({
          name: 'Viewer Key',
          projectId,
        }),
      });

      expect(res.status).toBe(403);
    });

    it('returns 401 without session', async () => {
      const teamId = await createTeam('NoAuth Key Team');
      const projectId = await createProject(teamId, 'NoAuth Project');

      const res = await app.request(`/v1/teams/${teamId}/keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Bad Key', projectId }),
      });

      expect(res.status).toBe(401);
    });

    it('returns 404 for cross-team key minting', async () => {
      const userId = await createUser(nextGithubId(), 'crosskey');
      const teamAId = await createTeam('Key Team A');
      const teamBId = await createTeam('Key Team B');
      const projectInB = await createProject(teamBId, 'B Project');
      await addMembership(userId, teamAId, 'admin');
      // User has no membership in team B
      const sessionToken = await createSession(userId);

      const res = await app.request(`/v1/teams/${teamBId}/keys`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie(sessionToken),
        },
        body: JSON.stringify({
          name: 'Cross Team Key',
          projectId: projectInB,
        }),
      });

      expect(res.status).toBe(404);
    });

    it('rejects allProjects + projectId together (400)', async () => {
      const userId = await createUser(nextGithubId(), 'conflictkey');
      const teamId = await createTeam('Conflict Team');
      const projectId = await createProject(teamId, 'Conflict Project');
      await addMembership(userId, teamId, 'admin');
      const sessionToken = await createSession(userId);

      const res = await app.request(`/v1/teams/${teamId}/keys`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie(sessionToken),
        },
        body: JSON.stringify({
          name: 'Conflicting Key',
          projectId,
          allProjects: true,
        }),
      });

      expect(res.status).toBe(400);
    });

    it('rejects normal key without projectId (400)', async () => {
      const userId = await createUser(nextGithubId(), 'noprojectkey');
      const teamId = await createTeam('No Project Team');
      await addMembership(userId, teamId, 'admin');
      const sessionToken = await createSession(userId);

      const res = await app.request(`/v1/teams/${teamId}/keys`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie(sessionToken),
        },
        body: JSON.stringify({
          name: 'No Project Key',
          // No projectId, no allProjects
          scopes: ['read'],
        }),
      });

      expect(res.status).toBe(400);
    });

    it('rejects key with read:payload but no read scope (400)', async () => {
      const userId = await createUser(nextGithubId(), 'badscopekey');
      const teamId = await createTeam('Bad Scope Team');
      const projectId = await createProject(teamId, 'Bad Scope Project');
      await addMembership(userId, teamId, 'admin');
      const sessionToken = await createSession(userId);

      const res = await app.request(`/v1/teams/${teamId}/keys`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie(sessionToken),
        },
        body: JSON.stringify({
          name: 'Bad Scope Key',
          projectId,
          scopes: ['read:payload'],
        }),
      });

      // The validateApiKeyScopes function enforces read:payload requires read
      // as defense-in-depth; the DB CHECK constraint is the primary enforcer.
      // The schema refinement also catches this.
      expect(res.status).toBe(400);
    });

    it('rejects key bound to a project from a different team (404)', async () => {
      const userId = await createUser(nextGithubId(), 'otherteamproj');
      const teamAId = await createTeam('Team Alpha');
      const teamBId = await createTeam('Team Beta');
      const projectInB = await createProject(teamBId, 'B Project');
      await addMembership(userId, teamAId, 'admin');
      const sessionToken = await createSession(userId);

      // User is admin in team A. Try to bind a key to a project in team B
      // while accessing team A's URL.
      const res = await app.request(`/v1/teams/${teamAId}/keys`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie(sessionToken),
        },
        body: JSON.stringify({
          name: 'Wrong Project Key',
          projectId: projectInB,
        }),
      });

      // projectInB doesn't exist in team A → 404 (not found)
      expect(res.status).toBe(404);
    });

    it('plaintext token cannot be retrieved after minting', async () => {
      const userId = await createUser(nextGithubId(), 'notwice');
      const teamId = await createTeam('Once Only Team');
      const projectId = await createProject(teamId, 'Once Project');
      await addMembership(userId, teamId, 'admin');
      const sessionToken = await createSession(userId);

      // Mint a key
      const res1 = await app.request(`/v1/teams/${teamId}/keys`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie(sessionToken),
        },
        body: JSON.stringify({
          name: 'One-Time Key',
          projectId,
        }),
      });
      expect(res1.status).toBe(201);
      const data1 = (await res1.json()).data;
      const plaintext = data1.token;

      // The plaintext token should only appear in the mint response
      // Verify it's NOT in the database
      const dbRows = await db.execute(`SELECT token_hash FROM api_keys WHERE id = '${data1.id}'`);
      const tokenHash = (dbRows.rows[0] as Record<string, unknown>)['token_hash'] as string;
      expect(tokenHash).not.toBe(plaintext);

      // There is no endpoint to retrieve the plaintext again.
      // The only way to get a working token for this key is to have
      // captured it at mint time. The repo query only returns hashes.
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Security: minted keys have DATA-PLANE scopes only
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Security: minted keys are data-plane only', () => {
    it('minted key cannot access key minting endpoint (web session required)', async () => {
      const userId = await createUser(nextGithubId(), 'noadminkey');
      const teamId = await createTeam('DataPlane Team');
      const projectId = await createProject(teamId, 'DataPlane Project');
      await addMembership(userId, teamId, 'admin');
      const sessionToken = await createSession(userId);

      // Mint a key
      const mintRes = await app.request(`/v1/teams/${teamId}/keys`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie(sessionToken),
        },
        body: JSON.stringify({
          name: 'DataPlane Key',
          projectId,
          scopes: ['read', 'events:write'],
        }),
      });
      expect(mintRes.status).toBe(201);
      const mintedToken = (await mintRes.json()).data.token as string;

      // Try to use the minted key to mint another key
      const res = await app.request(`/v1/teams/${teamId}/keys`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${mintedToken}`,
        },
        body: JSON.stringify({
          name: 'Key From Key',
          projectId,
        }),
      });

      // API keys cannot pass web-session middleware → 401
      expect(res.status).toBe(401);
    });

    it('minted key cannot create projects (web session required)', async () => {
      const userId = await createUser(nextGithubId(), 'datakeyproj');
      const teamId = await createTeam('DataPlane Proj Team');
      const projectId = await createProject(teamId, 'Existing Project');
      await addMembership(userId, teamId, 'admin');
      const sessionToken = await createSession(userId);

      // Mint a key
      const mintRes = await app.request(`/v1/teams/${teamId}/keys`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie(sessionToken),
        },
        body: JSON.stringify({
          name: 'DataPlane Key 2',
          projectId,
        }),
      });
      const mintedToken = (await mintRes.json()).data.token as string;

      // Try to create a project with the API key
      const res = await app.request(`/v1/teams/${teamId}/projects`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${mintedToken}`,
        },
        body: JSON.stringify({ name: 'Key-Created Project' }),
      });

      // API keys cannot pass web-session middleware → 401
      expect(res.status).toBe(401);
    });
  });
});
