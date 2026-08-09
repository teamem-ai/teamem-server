/**
 * Integration tests for LLM configuration routes (DUA-237).
 *
 * Requires TEST_DATABASE_URL with migrations applied.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createDb, type AppDb } from '../../db/client.js';
import { connectDatabase, closeDatabase, type Pool } from '../../test/database.js';
import { buildLlmConfigRoutes } from './llm-config.js';
import { generateSessionToken, SESSION_COOKIE_NAME } from '../../auth/oauth-github.js';
import { requestContext } from '../request-context.js';
import { globalErrorHandler, notFoundHandler } from '../errors.js';

const url = process.env['TEST_DATABASE_URL'];

/**
 * Fake provider transport for the DB-backed CI job (M3-REL-01).
 *
 * The endpoint's outbound calls to api.openai.com & co are not guaranteed to
 * be reachable from a CI runner; a real call with an invalid key timed out
 * `required / postgres` on main and blocked every release. Only the external
 * HTTP boundary is faked — Postgres, sessions, RBAC, and the provider
 * decision logic remain real.
 */
function fakeProviderFetch(
  options: { networkError?: boolean } = {},
): typeof fetch {
  return async (input, init) => {
    if (options.networkError) {
      throw new TypeError('fetch failed: network unreachable');
    }
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const auth = headers['Authorization'] ?? '';
    // Mirror a real provider: the magic valid key is accepted (200), every
    // other key is rejected as invalid (401).
    const ok = auth === 'Bearer sk-valid-test-key';
    return new Response(JSON.stringify({ data: [] }), {
      status: ok ? 200 : 401,
      headers: { 'content-type': 'application/json' },
    });
  };
}

/**
 * We run the suite only when a real Postgres is available. The skipped
 * count is reported so CI can surface the missing database signal.
 */
describe.skipIf(!url)('LLM Config Routes — live Postgres', () => {
  let pool: Pool;
  let db: AppDb;
  let app: Hono;

  // Backup and restore the encryption key so we don't pollute the process.
  const savedKey = process.env['TEAMEM_LLM_ENCRYPTION_KEY'];
  const validKey = Buffer.from('a'.repeat(32)).toString('hex'); // 64 hex chars

  beforeAll(async () => {
    process.env['TEAMEM_LLM_ENCRYPTION_KEY'] = validKey;
    ({ pool } = connectDatabase());
    db = createDb(url!, { pool: pool as unknown as import('pg').Pool });

    app = new Hono();
    app.use('*', requestContext);
    app.onError(globalErrorHandler);
    app.notFound(notFoundHandler);
    // The fake transport keeps the DB-backed CI job hermetic: outbound calls
    // to api.openai.com & co are not guaranteed reachable from a runner and
    // made `required / postgres` time out (M3-REL-01). The endpoint logic
    // (real Postgres sessions/RBAC/provider decision) is what we test; only
    // the external HTTP boundary is faked, which is the sanctioned seam.
    app.route('/', buildLlmConfigRoutes({ db, fetchImpl: fakeProviderFetch() }));
  });

  afterAll(async () => {
    process.env['TEAMEM_LLM_ENCRYPTION_KEY'] = savedKey;
    await closeDatabase(pool);
  });

  // Clean up in full FK dependency order — the postgres CI job runs all
  // integration files against one shared database, so this must tolerate
  // rows left by any other file's tests, not just this file's own. A
  // partial list here (e.g. missing jobs/events) is exactly what causes an
  // unrelated file's leftover row to break `DELETE FROM projects` with a
  // foreign-key violation.
  beforeEach(async () => {
    await db.execute('DELETE FROM llm_config');
    await db.execute('DELETE FROM job_events');
    await db.execute('DELETE FROM concept_contributors');
    await db.execute('DELETE FROM concept_evidence');
    await db.execute('DELETE FROM concept_paths');
    await db.execute('DELETE FROM jobs');
    await db.execute('DELETE FROM concepts');
    await db.execute('DELETE FROM events');
    await db.execute('DELETE FROM api_keys');
    await db.execute('DELETE FROM web_sessions');
    await db.execute('DELETE FROM invites');
    await db.execute('DELETE FROM memberships');
    await db.execute('DELETE FROM principals');
    await db.execute('DELETE FROM users');
    await db.execute('DELETE FROM projects');
    await db.execute('DELETE FROM teams');
  });

  let githubIdCounter = 50_000;
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
  // GET /v1/teams/:teamId/llm
  // ═══════════════════════════════════════════════════════════════════════════

  describe('GET /v1/teams/:teamId/llm', () => {
    it('returns empty config when no provider is set', async () => {
      const userId = await createUser(nextGithubId(), 'llmadmin');
      const teamId = await createTeam('LLM Team');
      await createProject(teamId, 'LLM Project');
      await addMembership(userId, teamId, 'admin');
      const sessionToken = await createSession(userId);

      const res = await app.request(`/v1/teams/${teamId}/llm`, {
        headers: { Cookie: cookie(sessionToken) },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.provider).toBeNull();
      expect(json.data.hasKey).toBe(false);
      expect(json.data.semanticRetrieval.mode).toBe('fts-only');
    });

    it('returns configured provider without exposing any key material', async () => {
      const userId = await createUser(nextGithubId(), 'llmowner');
      const teamId = await createTeam('LLM Owner Team');
      await createProject(teamId, 'LLM Project');
      await addMembership(userId, teamId, 'owner');
      const sessionToken = await createSession(userId);

      await app.request(`/v1/teams/${teamId}/llm`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: cookie(sessionToken) },
        body: JSON.stringify({ provider: 'openai', apiKey: 'sk-test' }),
      });

      const res = await app.request(`/v1/teams/${teamId}/llm`, {
        headers: { Cookie: cookie(sessionToken) },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.provider).toBe('openai');
      expect(json.data.hasKey).toBe(true);
      expect(json.data.semanticRetrieval.available).toBe(true);
      expect(JSON.stringify(json)).not.toContain('sk-test');
      expect(JSON.stringify(json)).not.toContain('api_key_encrypted');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PUT /v1/teams/:teamId/llm
  // ═══════════════════════════════════════════════════════════════════════════

  describe('PUT /v1/teams/:teamId/llm', () => {
    it('stores the API key encrypted, not hashed', async () => {
      const userId = await createUser(nextGithubId(), 'llmadmin');
      const teamId = await createTeam('LLM Encrypt Team');
      await createProject(teamId, 'LLM Project');
      await addMembership(userId, teamId, 'admin');
      const sessionToken = await createSession(userId);

      const put = await app.request(`/v1/teams/${teamId}/llm`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: cookie(sessionToken) },
        body: JSON.stringify({ provider: 'openai', apiKey: 'sk-encrypt-me' }),
      });
      expect(put.status).toBe(200);

      const rows = await db.execute(
        `SELECT api_key_encrypted FROM llm_config WHERE team_id = '${teamId}'`,
      );
      const encrypted = (rows.rows[0] as Record<string, unknown>)['api_key_encrypted'] as string;
      expect(encrypted).not.toBe('sk-encrypt-me');
      // AES-256-GCM ciphertext is hex-encoded and longer than the plaintext.
      expect(encrypted.length).toBeGreaterThan('sk-encrypt-me'.length);
      // SHA-256 of the plaintext would be exactly 64 hex chars; ciphertext is longer.
      expect(encrypted.length).toBeGreaterThan(64);
    });

    it('rejects without encryption key (server misconfiguration)', async () => {
      process.env['TEAMEM_LLM_ENCRYPTION_KEY'] = '';
      const userId = await createUser(nextGithubId(), 'llmadmin');
      const teamId = await createTeam('LLM No Key Team');
      await createProject(teamId, 'LLM Project');
      await addMembership(userId, teamId, 'admin');
      const sessionToken = await createSession(userId);

      const res = await app.request(`/v1/teams/${teamId}/llm`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: cookie(sessionToken) },
        body: JSON.stringify({ provider: 'openai', apiKey: 'sk-test' }),
      });
      expect(res.status).toBe(500);
      process.env['TEAMEM_LLM_ENCRYPTION_KEY'] = validKey;
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // POST /v1/teams/:teamId/llm/test
  // ═══════════════════════════════════════════════════════════════════════════

  describe('POST /v1/teams/:teamId/llm/test', () => {
    // Hermetic by default: the shared app injects a fake provider transport
    // (fakeProviderFetch), so this suite never depends on api.openai.com being
    // reachable from a CI runner. A rejected key maps to the endpoint's
    // "not-ok" decision. The live provider round-trip is covered separately,
    // opt-in via TEAMEM_LLM_LIVE_TEST=1.
    it('returns not-ok when the provider rejects the key (401)', async () => {
      const userId = await createUser(nextGithubId(), 'llmadmin');
      const teamId = await createTeam('LLM Test Team');
      await createProject(teamId, 'LLM Project');
      await addMembership(userId, teamId, 'admin');
      const sessionToken = await createSession(userId);

      const res = await app.request(`/v1/teams/${teamId}/llm/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie(sessionToken) },
        body: JSON.stringify({ provider: 'openai', apiKey: 'sk-invalid-test-key' }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.ok).toBe(false);
    });

    // Live provider round-trip check. Opt in with TEAMEM_LLM_LIVE_TEST=1;
    // deliberately skipped otherwise so the required DB-backed CI job never
    // depends on outbound provider reachability (that dependency is what made
    // `required / postgres` red on main in the first place).
    it.skipIf(process.env['TEAMEM_LLM_LIVE_TEST'] !== '1')(
      'returns not-ok against the real provider (live, opt-in)',
      async () => {
        const live = new Hono();
        live.use('*', requestContext);
        live.onError(globalErrorHandler);
        live.notFound(notFoundHandler);
        live.route('/', buildLlmConfigRoutes({ db, fetchImpl: fetch })); // real transport

        const userId = await createUser(nextGithubId(), 'llmadmin');
        const teamId = await createTeam('LLM Live Team');
        await createProject(teamId, 'LLM Project');
        await addMembership(userId, teamId, 'admin');
        const sessionToken = await createSession(userId);

        const res = await live.request(`/v1/teams/${teamId}/llm/test`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: cookie(sessionToken) },
          body: JSON.stringify({ provider: 'openai', apiKey: 'sk-invalid-test-key' }),
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.data.ok).toBe(false);
      },
    );

    it('returns ok when the provider accepts the key (200)', async () => {
      const userId = await createUser(nextGithubId(), 'llmadmin');
      const teamId = await createTeam('LLM Ok Team');
      await createProject(teamId, 'LLM Project');
      await addMembership(userId, teamId, 'admin');
      const sessionToken = await createSession(userId);

      const res = await app.request(`/v1/teams/${teamId}/llm/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie(sessionToken) },
        body: JSON.stringify({ provider: 'openai', apiKey: 'sk-valid-test-key' }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.ok).toBe(true);
    });

    it('returns not-ok without a crash when the provider is unreachable', async () => {
      const bounced = new Hono();
      bounced.use('*', requestContext);
      bounced.onError(globalErrorHandler);
      bounced.notFound(notFoundHandler);
      // A network failure (DNS/connect/timeout) maps to not-ok, not a 500.
      bounced.route('/', buildLlmConfigRoutes({ db, fetchImpl: fakeProviderFetch({ networkError: true }) }));

      const userId = await createUser(nextGithubId(), 'llmadmin');
      const teamId = await createTeam('LLM Bounce Team');
      await createProject(teamId, 'LLM Project');
      await addMembership(userId, teamId, 'admin');
      const sessionToken = await createSession(userId);

      const res = await bounced.request(`/v1/teams/${teamId}/llm/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie(sessionToken) },
        body: JSON.stringify({ provider: 'openai', apiKey: 'sk-invalid-test-key' }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.ok).toBe(false);
      expect(json.data.latencyMs).toBeNull();
    });

    it('rejects viewer from testing (403)', async () => {
      const userId = await createUser(nextGithubId(), 'llmviewer');
      const teamId = await createTeam('LLM Viewer Test Team');
      await createProject(teamId, 'LLM Project');
      await addMembership(userId, teamId, 'viewer');
      const sessionToken = await createSession(userId);

      const res = await app.request(`/v1/teams/${teamId}/llm/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie(sessionToken) },
        body: JSON.stringify({ provider: 'openai', apiKey: 'sk-test' }),
      });

      expect(res.status).toBe(403);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Model selection
  // ═══════════════════════════════════════════════════════════════════════════

  describe('model selection', () => {
    async function adminSession(name: string) {
      const userId = await createUser(nextGithubId(), name);
      const teamId = await createTeam(`${name} Team`);
      await createProject(teamId, 'P');
      await addMembership(userId, teamId, 'admin');
      const sessionToken = await createSession(userId);
      return { teamId, sessionToken };
    }

    it('stores the chosen model and returns it from GET', async () => {
      const { teamId, sessionToken } = await adminSession('llmmodel');

      const put = await app.request(`/v1/teams/${teamId}/llm`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: cookie(sessionToken) },
        body: JSON.stringify({
          provider: 'openai',
          apiKey: 'sk-model',
          model: 'gpt-4o-mini',
        }),
      });
      expect(put.status).toBe(200);

      const get = await app.request(`/v1/teams/${teamId}/llm`, {
        headers: { Cookie: cookie(sessionToken) },
      });
      const json = await get.json();
      expect(json.data.model).toBe('gpt-4o-mini');
      expect(json.data.provider).toBe('openai');
    });

    it('defaults model to null when omitted', async () => {
      const { teamId, sessionToken } = await adminSession('llmnomodel');

      await app.request(`/v1/teams/${teamId}/llm`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: cookie(sessionToken) },
        body: JSON.stringify({ provider: 'openai', apiKey: 'sk-x' }),
      });

      const get = await app.request(`/v1/teams/${teamId}/llm`, {
        headers: { Cookie: cookie(sessionToken) },
      });
      expect((await get.json()).data.model).toBeNull();
    });

    it('changes only the model via __STORED__, preserving the saved key', async () => {
      const { teamId, sessionToken } = await adminSession('llmstored');

      // Initial save with a real key + model.
      await app.request(`/v1/teams/${teamId}/llm`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: cookie(sessionToken) },
        body: JSON.stringify({ provider: 'openai', apiKey: 'sk-keep-me', model: 'gpt-4o' }),
      });
      const before = await db.execute(
        `SELECT api_key_encrypted FROM llm_config WHERE team_id = '${teamId}'`,
      );
      const keyBefore = (before.rows[0] as Record<string, unknown>)['api_key_encrypted'];

      // Model-only change: keep the key via the sentinel.
      const put = await app.request(`/v1/teams/${teamId}/llm`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: cookie(sessionToken) },
        body: JSON.stringify({ provider: 'openai', apiKey: '__STORED__', model: 'gpt-4o-mini' }),
      });
      expect(put.status).toBe(200);

      const after = await db.execute(
        `SELECT api_key_encrypted, model FROM llm_config WHERE team_id = '${teamId}'`,
      );
      const row = after.rows[0] as Record<string, unknown>;
      expect(row['model']).toBe('gpt-4o-mini');
      expect(row['api_key_encrypted']).toBe(keyBefore); // unchanged
    });

    it('rejects __STORED__ when there is no saved key', async () => {
      const { teamId, sessionToken } = await adminSession('llmnostored');

      const put = await app.request(`/v1/teams/${teamId}/llm`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: cookie(sessionToken) },
        body: JSON.stringify({ provider: 'openai', apiKey: '__STORED__' }),
      });
      expect(put.status).toBe(400);
    });

    it('rejects a viewer from listing models (403)', async () => {
      const userId = await createUser(nextGithubId(), 'llmmodelsviewer');
      const teamId = await createTeam('Models Viewer Team');
      await createProject(teamId, 'P');
      await addMembership(userId, teamId, 'viewer');
      const sessionToken = await createSession(userId);

      const res = await app.request(`/v1/teams/${teamId}/llm/models`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie(sessionToken) },
        body: JSON.stringify({ provider: 'openai', apiKey: 'sk-x' }),
      });
      expect(res.status).toBe(403);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Provider-only save (onboarding: record the choice before a key exists)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('provider-only save (apiKey omitted)', () => {
    async function adminSession(name: string) {
      const userId = await createUser(nextGithubId(), name);
      const teamId = await createTeam(`${name} Team`);
      await createProject(teamId, 'P');
      await addMembership(userId, teamId, 'admin');
      const sessionToken = await createSession(userId);
      return { teamId, sessionToken };
    }

    it('stores the provider with no key when apiKey is omitted', async () => {
      const { teamId, sessionToken } = await adminSession('llmprovonly');

      const put = await app.request(`/v1/teams/${teamId}/llm`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: cookie(sessionToken) },
        body: JSON.stringify({ provider: 'openrouter' }),
      });
      expect(put.status).toBe(200);

      const get = await app.request(`/v1/teams/${teamId}/llm`, {
        headers: { Cookie: cookie(sessionToken) },
      });
      const json = await get.json();
      expect(json.data.provider).toBe('openrouter');
      expect(json.data.hasKey).toBe(false);
    });

    it('preserves an existing key when a later provider-only PUT arrives', async () => {
      const { teamId, sessionToken } = await adminSession('llmprovkeep');

      // First: full save with a key.
      await app.request(`/v1/teams/${teamId}/llm`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: cookie(sessionToken) },
        body: JSON.stringify({ provider: 'openai', apiKey: 'sk-keep' }),
      });
      // Then: provider-only PUT (no key) switching provider.
      const put = await app.request(`/v1/teams/${teamId}/llm`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: cookie(sessionToken) },
        body: JSON.stringify({ provider: 'openrouter' }),
      });
      expect(put.status).toBe(200);

      const get = await app.request(`/v1/teams/${teamId}/llm`, {
        headers: { Cookie: cookie(sessionToken) },
      });
      const json = await get.json();
      expect(json.data.provider).toBe('openrouter');
      expect(json.data.hasKey).toBe(true); // key preserved
    });
  });
});
