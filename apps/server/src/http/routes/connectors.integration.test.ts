/**
 * Integration tests for GET /v1/teams/:teamId/connectors (DUA-237).
 *
 * Regression coverage for a real bug: `connected` used to be derived from a
 * `connectors` database table that was never migrated, so the query always
 * threw, was silently caught, and GitHub showed "Not connected" regardless
 * of actual configuration. `connected` now reflects the real env-derived
 * GitHub App config (see config/env.ts githubAppConfigured), injected via
 * ConnectorStatusDeps instead of a phantom table.
 *
 * Requires TEST_DATABASE_URL with migrations applied.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createDb, type AppDb } from '../../db/client.js';
import { connectDatabase, closeDatabase, type Pool } from '../../test/database.js';
import { buildConnectorStatusRoutes, type ConnectorStatusDeps } from './connectors.js';
import { generateSessionToken, SESSION_COOKIE_NAME } from '../../auth/oauth-github.js';
import { requestContext } from '../request-context.js';
import { globalErrorHandler, notFoundHandler } from '../errors.js';
import type { GitHubApiClient } from '../../connectors/github/app-api-client.js';

const url = process.env['TEST_DATABASE_URL'];

describe.skipIf(!url)('GET /v1/teams/:teamId/connectors — live Postgres', () => {
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
    await db.execute('DELETE FROM web_sessions');
    await db.execute('DELETE FROM memberships');
    await db.execute('DELETE FROM projects');
    await db.execute('DELETE FROM principals');
    await db.execute('DELETE FROM users');
    await db.execute('DELETE FROM teams');
  });

  let githubIdCounter = 60_000;
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

  async function addMembership(userId: string, teamId: string, role: string): Promise<void> {
    await db.execute(
      `INSERT INTO memberships (user_id, team_id, role) VALUES ('${userId}', '${teamId}', '${role}')`,
    );
  }

  function cookie(token: string): string {
    return `${SESSION_COOKIE_NAME}=${token}`;
  }

  function buildApp(deps: Omit<ConnectorStatusDeps, 'db'>) {
    const app = new Hono();
    app.use('*', requestContext);
    app.onError(globalErrorHandler);
    app.notFound(notFoundHandler);
    app.route('/', buildConnectorStatusRoutes({ db, ...deps }));
    return app;
  }

  async function ownerSession(name: string) {
    const userId = await createUser(nextGithubId(), name);
    const teamId = await createTeam(`${name} Team`);
    await addMembership(userId, teamId, 'owner');
    const sessionToken = await createSession(userId);
    return { teamId, sessionToken };
  }

  it('reports GitHub connected when the App is fully configured', async () => {
    const app = buildApp({ githubAppConfigured: true, githubWebhookConfigured: true });
    const { teamId, sessionToken } = await ownerSession('gh_on');

    const res = await app.request(`/v1/teams/${teamId}/connectors`, {
      headers: { Cookie: cookie(sessionToken) },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.github.connected).toBe(true);
    expect(json.data.github.webhookSecretConfigured).toBe(true);
  });

  it('reports GitHub NOT connected when nothing is configured (default state)', async () => {
    // No githubAppConfigured/githubWebhookConfigured passed — this is the
    // real bug scenario: a fresh deployment with no GitHub App set up yet.
    const app = buildApp({});
    const { teamId, sessionToken } = await ownerSession('gh_off');

    const res = await app.request(`/v1/teams/${teamId}/connectors`, {
      headers: { Cookie: cookie(sessionToken) },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.github.connected).toBe(false);
    expect(json.data.github.webhookSecretConfigured).toBe(false);
  });

  it('does NOT depend on a "connectors" database table (none exists)', async () => {
    // Regression guard: querying a nonexistent table must not be how this
    // route determines status. Confirm the table truly does not exist, and
    // that the route still answers correctly despite that.
    await expect(
      db.execute('SELECT 1 FROM connectors LIMIT 1'),
    ).rejects.toThrow();

    const app = buildApp({ githubAppConfigured: true, githubWebhookConfigured: true });
    const { teamId, sessionToken } = await ownerSession('gh_notable');
    const res = await app.request(`/v1/teams/${teamId}/connectors`, {
      headers: { Cookie: cookie(sessionToken) },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).data.github.connected).toBe(true);
  });

  it('counts active write-scoped keys for the CLI/MCP cards', async () => {
    const app = buildApp({});
    const { teamId, sessionToken } = await ownerSession('gh_keys');

    const res = await app.request(`/v1/teams/${teamId}/connectors`, {
      headers: { Cookie: cookie(sessionToken) },
    });
    const json = await res.json();
    expect(json.data.cli.activeKeysWithWrite).toBe(0);
    expect(json.data.mcp.activeKeysWithWrite).toBe(0);
  });

  it('requires a valid session (401 without one)', async () => {
    const app = buildApp({ githubAppConfigured: true });
    const res = await app.request('/v1/teams/team_nope/connectors');
    expect(res.status).toBe(401);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Live repository list (GET /installation/repositories via GitHubApiClient)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('repositories (fetched live from GitHub, never stored)', () => {
    function fakeGithubApiClient(
      impl: () => Promise<string[]>,
    ): GitHubApiClient {
      return {
        getPullRequestsForCommit: async () => null,
        getPullRequest: async () => null,
        listInstallationRepositories: impl,
      };
    }

    it('returns the real repository list from the injected GitHubApiClient', async () => {
      const app = buildApp({
        githubAppConfigured: true,
        githubWebhookConfigured: true,
        githubApiClient: fakeGithubApiClient(async () => [
          'duan-li/laravel-11-getting-started',
        ]),
      });
      const { teamId, sessionToken } = await ownerSession('gh_repos_ok');

      const res = await app.request(`/v1/teams/${teamId}/connectors`, {
        headers: { Cookie: cookie(sessionToken) },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.github.repositories).toEqual([
        'duan-li/laravel-11-getting-started',
      ]);
    });

    it('degrades to an empty list (not a 500) when the GitHub call fails', async () => {
      const app = buildApp({
        githubAppConfigured: true,
        githubApiClient: fakeGithubApiClient(async () => {
          throw new Error('GitHub API rate limited');
        }),
      });
      const { teamId, sessionToken } = await ownerSession('gh_repos_fail');

      const res = await app.request(`/v1/teams/${teamId}/connectors`, {
        headers: { Cookie: cookie(sessionToken) },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.github.repositories).toEqual([]);
      // Still honestly "connected" — the App config itself is fine, only the
      // live repo fetch failed.
      expect(json.data.github.connected).toBe(true);
    });

    it('stays an empty list when no githubApiClient is injected (installation ID not set)', async () => {
      const app = buildApp({ githubAppConfigured: true });
      const { teamId, sessionToken } = await ownerSession('gh_repos_none');

      const res = await app.request(`/v1/teams/${teamId}/connectors`, {
        headers: { Cookie: cookie(sessionToken) },
      });
      const json = await res.json();
      expect(json.data.github.repositories).toEqual([]);
    });
  });
});
