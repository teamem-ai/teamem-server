/**
 * GET /v1/export integration tests — DUA-251 / M3-EXPORT-04.
 *
 * Tests the scope/role-gated OKF bundle download endpoint against real
 * Postgres (TEST_DATABASE_URL), from the HTTP entry point through the
 * scoped renderer to a real archive consumption exit:
 *
 *   Access control matrix:
 *     - API key (project-bound, `read`)            → 200
 *     - API key (allProjects, `read`) + projectId  → 200
 *     - API key without `read` scope               → 403
 *     - project-bound key + conflicting projectId  → 403
 *     - allProjects key, missing projectId         → 400
 *     - allProjects key, malformed projectId       → 400
 *     - web session member+                        → 200
 *     - web session viewer                         → 403
 *     - no credentials / revoked / garbage session → 401
 *   Anti-enumeration:
 *     - cross-team project and nonexistent project share byte-identical
 *       404 envelopes (cannot distinguish existence);
 *     - web session with no membership in the team → identical 404.
 *   Archive integrity:
 *     - application/gzip + attachment Content-Disposition with a sanitized
 *       <project>-okf-<version>.tar.gz filename;
 *     - system `tar` lists/extracts exactly the rendered bundle tree
 *       (index.md, log.md, one page per concept under its type dir) and
 *       the concept body contains the resolved relative teamem:// link;
 *     - two downloads of the same project are byte-identical
 *       (deterministic archive).
 *   No payload/query text leaked:
 *     - audit rows carry whitelisted metadata only (asserted via the
 *       export.download rows: no content-bearing column exists);
 *     - a successful download writes export.download/success; denied 404s
 *       write export.download/denied — both with metadata only.
 *
 * Runs only when TEST_DATABASE_URL is set; honestly skipped otherwise.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type AppDeps } from '../../app.js';
import { createDb, type AppDb } from '../../db/client.js';
import {
  connectDatabase,
  closeDatabase,
  type Pool,
} from '../../test/database.js';
import { runBootstrap } from '../../commands/bootstrap.js';
import { generateSessionToken } from '../../auth/oauth-github.js';
import { generateApiKeyToken, hashToken } from '../../auth/api-key.js';
import { createConcept, type CreateConceptInput } from '../../db/repositories/concepts-write.js';
import type { TeamRole, ApiScope } from '@teamem/schema';
import { OKF_FORMAT_VERSION } from '@teamem/schema';

const execFileAsync = promisify(execFile);
const url = process.env['TEST_DATABASE_URL'];

// ── Tiny tar name scanner (test-only; the unit archive tests and the
//    system tar binary pin the full format). ────────────────────────────────

function listTarEntries(tar: Buffer): string[] {
  const names: string[] = [];
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const block = tar.subarray(offset, offset + 512);
    if (block.every((b) => b === 0)) break;
    const sizeText = block.subarray(124, 136).toString('ascii').replace(/\0/g, ' ').trim();
    const size = sizeText === '' ? 0 : parseInt(sizeText, 8);
    const typeflag = String.fromCharCode(block[156]!);
    if (typeflag === '0') {
      names.push(block.subarray(0, 100).toString('ascii').replace(/\0.*$/, ''));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
}

describe.skipIf(!url)('GET /v1/export OKF bundle download (live Postgres)', () => {
  let pool: Pool;
  let db: AppDb;
  let app: ReturnType<typeof buildApp>;

  // Primary team + project
  let teamId: string;
  let projectId: string;
  let projectName: string;
  let bootstrapKey: string | undefined; // project-bound, read+read:payload+events:write

  // Same-team additional project (project-scope isolation)
  let secondProjectId: string;

  // Other team (cross-tenant)
  let otherTeamId: string;
  let otherProjectId: string;

  // Web sessions
  let viewerUserId: string;
  let memberUserId: string;
  let adminUserId: string;
  let outsiderUserId: string;
  let viewerSession: { plaintext: string };
  let memberSession: { plaintext: string };
  let adminSession: { plaintext: string };
  let outsiderSession: { plaintext: string };

  // API keys
  let readOnlyProjectKey: string; // project-bound, ['read'] only
  let allProjectsReadKey: string; // allProjects, ['read']
  let noReadKey: string; // project-bound, ['events:write']

  // Seeded concepts
  let decisionUuid: string;
  let decisionPath: string;
  let serviceUuid: string;
  let servicePath: string;

  // ── Test helpers ──────────────────────────────────────────────────────

  function authHeaders(token?: string) {
    return { Authorization: `Bearer ${token ?? bootstrapKey}` };
  }

  function sessionCookie(plaintext: string): string {
    return `teamem_session=${plaintext}`;
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

  async function createSession(userId: string): Promise<{ plaintext: string }> {
    const { plaintext, hash } = generateSessionToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 7 * 24 * 3600_000);
    await db.execute(
      `INSERT INTO web_sessions (id, user_id, token_hash, issued_at, expires_at) VALUES ('ses_${randomBytes(8).toString('hex')}', '${userId}', '${hash}', '${now.toISOString()}', '${expiresAt.toISOString()}')`,
    );
    return { plaintext };
  }

  async function createScopedApiKey(
    tId: string,
    pId: string | null,
    scopes: ApiScope[],
    allProjects: boolean,
  ): Promise<string> {
    const plaintext = generateApiKeyToken();
    const tokenHash = hashToken(plaintext);
    await db.execute(
      `INSERT INTO api_keys (id, team_id, project_id, name, token_hash, scopes, all_projects)
       VALUES ('key_${randomBytes(8).toString('hex')}', '${tId}', ${pId ? `'${pId}'` : 'NULL'},
               'Export Test Key', '${tokenHash}', ARRAY[${scopes.map((s) => `'${s}'`).join(',')}], ${allProjects})`,
    );
    return plaintext;
  }

  async function download(
    headers: Record<string, string>,
    query = `projectId=${projectId}`,
  ): Promise<{ status: number; body: ArrayBuffer; json: unknown; headers: Headers }> {
    const res = await app.request(`/v1/export?${query}`, { method: 'GET', headers });
    const body = await res.arrayBuffer();
    let json: unknown = null;
    if (res.headers.get('content-type')?.includes('application/json')) {
      json = JSON.parse(Buffer.from(body).toString('utf8'));
    }
    return { status: res.status, body, json, headers: res.headers };
  }

  function expectedBundleFiles(): string[] {
    return [
      'index.md',
      'log.md',
      `decisions/${decisionPath}.md`,
      `services/${servicePath}.md`,
    ];
  }

  // ── Setup ─────────────────────────────────────────────────────────────

  beforeAll(async () => {
    ({ pool } = connectDatabase());
    db = createDb(url!, { pool: pool as unknown as import('pg').Pool });

    // ── Team 1 (our team) ───────────────────────────────────────────
    const suffix = randomUUID().replace(/-/g, '').slice(0, 8);
    const result = await runBootstrap(db, {
      teamName: `Export Test ${suffix}`,
      projectName: `demo-${suffix}`,
      rotate: false,
    });
    teamId = result.team.id;
    projectId = result.project.id;
    projectName = result.project.name;
    bootstrapKey = result.key.token;

    // ── Team 2 (cross-tenant) ───────────────────────────────────────
    const otherSuffix = randomUUID().replace(/-/g, '').slice(0, 8);
    const otherResult = await runBootstrap(db, {
      teamName: `Export Other ${otherSuffix}`,
      projectName: `other-${otherSuffix}`,
      rotate: false,
    });
    otherTeamId = otherResult.team.id;
    otherProjectId = otherResult.project.id;

    // ── Same-team second project (project-scope isolation) ──────────
    const psSuffix = randomUUID().replace(/-/g, '').slice(0, 8);
    secondProjectId = `prj_second${psSuffix}`;
    await db.execute(
      `INSERT INTO projects (id, team_id, name) VALUES ('${secondProjectId}', '${teamId}', 'Second Project')`,
    );

    // ── Seed concepts (decision with a cross-link to the service) ───
    decisionPath = `use-postgres-${randomUUID().replace(/-/g, '').slice(0, 6)}`;
    servicePath = `auth-api-${randomUUID().replace(/-/g, '').slice(0, 6)}`;

    const decision = await createConcept(db, conceptInput(teamId, projectId, decisionPath, {
      title: 'Use Postgres',
      type: 'decision',
      body: 'We chose Postgres because it pins everything. See teamem://concept/{SERVICE_UUID} for the service.',
      tags: ['database'],
    }));
    decisionUuid = decision.uuid;

    const service = await createConcept(db, conceptInput(teamId, projectId, servicePath, {
      title: 'Auth API',
      type: 'service',
      body: 'The auth API serves tokens.',
      tags: ['api'],
    }));
    serviceUuid = service.uuid;

    // Patch the decision body now that the service UUID exists — the
    // renderer resolves teamem://concept/<uuid> to a relative link.
    await db.execute(
      `UPDATE concepts SET body = 'We chose Postgres because it pins everything. See teamem://concept/${serviceUuid} for the service.' WHERE uuid = '${decisionUuid}'`,
    );

    // ── Users / memberships / sessions ───────────────────────────────
    viewerUserId = await createUser(30001, 'viewer-export');
    memberUserId = await createUser(30002, 'member-export');
    adminUserId = await createUser(30003, 'admin-export');
    outsiderUserId = await createUser(30004, 'outsider-export');
    await createMembership(viewerUserId, teamId, 'viewer');
    await createMembership(memberUserId, teamId, 'member');
    await createMembership(adminUserId, teamId, 'admin');
    await createMembership(outsiderUserId, otherTeamId, 'member');
    viewerSession = await createSession(viewerUserId);
    memberSession = await createSession(memberUserId);
    adminSession = await createSession(adminUserId);
    outsiderSession = await createSession(outsiderUserId);

    // ── API keys ─────────────────────────────────────────────────────
    readOnlyProjectKey = await createScopedApiKey(teamId, projectId, ['read'], false);
    allProjectsReadKey = await createScopedApiKey(teamId, null, ['read'], true);
    noReadKey = await createScopedApiKey(teamId, projectId, ['events:write'], false);

    // ── Build the app ────────────────────────────────────────────────
    const deps: AppDeps = { dbUrl: url, db };
    app = buildApp(deps);
  });

  afterAll(async () => {
    for (const uid of [viewerUserId, memberUserId, adminUserId, outsiderUserId]) {
      await db.execute(`DELETE FROM web_sessions WHERE user_id = '${uid}'`);
      await db.execute(`DELETE FROM memberships WHERE user_id = '${uid}'`);
      await db.execute(`DELETE FROM users WHERE id = '${uid}'`);
    }
    for (const pid of [projectId, otherProjectId, secondProjectId]) {
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

  // ══════════════════════════════════════════════════════════════════════
  // 1. Happy path — API key with read + project scope
  // ══════════════════════════════════════════════════════════════════════

  describe('API key happy path', () => {
    it('GET /v1/export?projectId=... returns a valid deterministic tar.gz bundle', async () => {
      const res = await download(authHeaders());

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/gzip');
      expect(res.headers.get('content-disposition')).toBe(
        `attachment; filename="${projectName.toLowerCase()}-okf-${OKF_FORMAT_VERSION}.tar.gz"`,
      );

      const bytes = Buffer.from(res.body);
      expect(bytes.length).toBeGreaterThan(0);

      // Unwrap gzip and verify the exact bundle tree.
      const tar = gunzipSync(bytes);
      // First pass: header scan (works without system tar).
      expect(listTarEntries(tar)).toEqual(expectedBundleFiles());

      // Second pass: real consumption exit — system tar extracts and the
      // index.md + decision page content round-trip.
      const dir = await mkdtemp(join(tmpdir(), 'teamem-export-'));
      try {
        const archivePath = join(dir, 'bundle.tar.gz');
        await writeFile(archivePath, bytes);
        await execFileAsync('tar', ['-xzf', archivePath, '-C', dir]);

        const index = await readFile(join(dir, 'index.md'), 'utf8');
        expect(index).toContain('okf_version: "0.1"');
        // The catalog links to every page (UUIDs live in page frontmatter).
        expect(index).toContain(`./decisions/${decisionPath}.md`);
        expect(index).toContain(`./services/${servicePath}.md`);

        const decisionPage = await readFile(join(dir, `decisions/${decisionPath}.md`), 'utf8');
        expect(decisionPage).toContain(`uuid: ${decisionUuid}`);
        // The teamem:// link was rewritten to a relative markdown link
        // pointing at the service page (one ../ from decisions/).
        expect(decisionPage).toContain(`../services/${servicePath}.md`);
        expect(decisionPage).not.toContain(`teamem://concept/${serviceUuid}`);

        const servicePage = await readFile(join(dir, `services/${servicePath}.md`), 'utf8');
        expect(servicePage).toContain(`uuid: ${serviceUuid}`);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('project-bound key may omit projectId (scope project is used)', async () => {
      const b = await download(authHeaders(readOnlyProjectKey), '');
      expect(b.status).toBe(200);
      const tar = gunzipSync(Buffer.from(b.body));
      expect(listTarEntries(tar)).toEqual(expectedBundleFiles());
    });

    it('two downloads of the same project are byte-identical (deterministic)', async () => {
      const a = await download(authHeaders());
      const b = await download(authHeaders());
      expect(Buffer.from(a.body).equals(Buffer.from(b.body))).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // 2. API key scope enforcement
  // ══════════════════════════════════════════════════════════════════════

  describe('API key scope enforcement', () => {
    it('rejects a project-bound key that names another of its own team projects (403)', async () => {
      const res = await download(authHeaders(readOnlyProjectKey), `projectId=${secondProjectId}`);
      expect(res.status).toBe(403);
      expect((res.json as { error: { code: string } }).error.code).toBe('forbidden');
    });

    it('rejects a project-bound key with a malformed projectId (400)', async () => {
      const res = await download(authHeaders(readOnlyProjectKey), 'projectId=not-a-project');
      expect(res.status).toBe(400);
      expect((res.json as { error: { code: string } }).error.code).toBe('invalid_request');
    });

    it('requires projectId for an allProjects key (400)', async () => {
      const res = await download(authHeaders(allProjectsReadKey), '');
      expect(res.status).toBe(400);
      expect((res.json as { error: { code: string } }).error.code).toBe('invalid_request');
    });

    it('accepts an allProjects key that names a real team project (200)', async () => {
      const res = await download(authHeaders(allProjectsReadKey));
      expect(res.status).toBe(200);
      const tar = gunzipSync(Buffer.from(res.body));
      expect(listTarEntries(tar)).toEqual(expectedBundleFiles());
    });

    it('rejects a key without the read scope (403)', async () => {
      const res = await download(authHeaders(noReadKey));
      expect(res.status).toBe(403);
      expect((res.json as { error: { code: string } }).error.code).toBe('forbidden');
    });

    it('rejects unknown query parameters (400)', async () => {
      const res = await download(authHeaders(), `projectId=${projectId}&format=zip`);
      expect(res.status).toBe(400);
      expect((res.json as { error: { code: string } }).error.code).toBe('invalid_request');
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // 3. Anti-enumeration: cross-team ≡ missing
  // ══════════════════════════════════════════════════════════════════════

  describe('cross-team indistinguishable from missing', () => {
    it('returns 404 for another team project (allProjects key)', async () => {
      const res = await download(authHeaders(allProjectsReadKey), `projectId=${otherProjectId}`);
      expect(res.status).toBe(404);
      expect((res.json as { error: { code: string } }).error.code).toBe('not_found');
    });

    it('returns 404 for a nonexistent project', async () => {
      const res = await download(authHeaders(allProjectsReadKey), 'projectId=prj_nonexistent0000');
      expect(res.status).toBe(404);
      expect((res.json as { error: { code: string } }).error.code).toBe('not_found');
    });

    it('cross-team and nonexistent 404 envelopes are byte-identical', async () => {
      // Same x-request-id on both probes: the envelope (code, message,
      // requestId) must be byte-identical — existence is never revealed.
      const trace = { 'x-request-id': 'trace-export-404' };
      const a = await download({ ...authHeaders(allProjectsReadKey), ...trace }, `projectId=${otherProjectId}`);
      const b = await download({ ...authHeaders(allProjectsReadKey), ...trace }, 'projectId=prj_nonexistent0000');
      expect(a.status).toBe(b.status);
      expect(Buffer.from(a.body).equals(Buffer.from(b.body))).toBe(true);
    });

    it('web session with no membership in the team → identical 404', async () => {
      const res = await download({ Cookie: sessionCookie(outsiderSession.plaintext) }, `projectId=${projectId}`);
      expect(res.status).toBe(404);
      expect((res.json as { error: { code: string } }).error.code).toBe('not_found');
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // 4. Web session role gating (member+)
  // ══════════════════════════════════════════════════════════════════════

  describe('web session role gating (member+)', () => {
    it('member downloads the bundle (200)', async () => {
      const res = await download({ Cookie: sessionCookie(memberSession.plaintext) });
      expect(res.status).toBe(200);
      const tar = gunzipSync(Buffer.from(res.body));
      expect(listTarEntries(tar)).toEqual(expectedBundleFiles());
    });

    it('admin downloads the bundle (200 — role superset)', async () => {
      const res = await download({ Cookie: sessionCookie(adminSession.plaintext) });
      expect(res.status).toBe(200);
      const tar = gunzipSync(Buffer.from(res.body));
      expect(listTarEntries(tar)).toEqual(expectedBundleFiles());
    });

    it('viewer is denied with 403 (identical envelope to other member+ ops)', async () => {
      const res = await download({ Cookie: sessionCookie(viewerSession.plaintext) });
      expect(res.status).toBe(403);
      expect((res.json as { error: { code: string } }).error.code).toBe('forbidden');
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // 5. Authentication failures
  // ══════════════════════════════════════════════════════════════════════

  describe('authentication', () => {
    it('returns 401 without credentials', async () => {
      const res = await download({});
      expect(res.status).toBe(401);
      expect((res.json as { error: { code: string } }).error.code).toBe('unauthorized');
    });

    it('returns 401 for a garbage session cookie', async () => {
      const res = await download({ Cookie: sessionCookie('not-a-real-session-token') });
      expect(res.status).toBe(401);
      expect((res.json as { error: { code: string } }).error.code).toBe('unauthorized');
    });

    it('returns 401 for a revoked API key', async () => {
      const token = generateApiKeyToken();
      const tokenHash = hashToken(token);
      await db.execute(
        `INSERT INTO api_keys (id, team_id, project_id, name, token_hash, scopes, all_projects, revoked_at)
         VALUES ('key_revoked_${randomBytes(8).toString('hex')}', '${teamId}', '${projectId}', 'Revoked', '${tokenHash}', ARRAY['read'], false, now())`,
      );
      const res = await download(authHeaders(token));
      expect(res.status).toBe(401);
      expect((res.json as { error: { code: string } }).error.code).toBe('unauthorized');
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // 6. Audit: metadata only, success + denied, no content leakage
  // ══════════════════════════════════════════════════════════════════════

  describe('audit (N7 — export.download, metadata only)', () => {
    it('writes a success record for a downloaded bundle with whitelisted fields only', async () => {
      const res = await download(authHeaders());
      expect(res.status).toBe(200);

      const rows = await db.$client.query<{
        action: string;
        outcome: string;
        project_id: string | null;
        resource_id: string | null;
        principal_id: string | null;
      }>(
        `SELECT action, outcome, project_id, resource_id, principal_id
         FROM audit_log
         WHERE action = 'export.download' AND project_id = $1
         ORDER BY created_at DESC LIMIT 1`,
        [projectId],
      );
      expect(rows.rows).toHaveLength(1);
      const row = rows.rows[0]!;
      expect(row.action).toBe('export.download');
      expect(row.outcome).toBe('success');
      expect(row.project_id).toBe(projectId);
      expect(row.resource_id).toBe(projectId);
      // API keys may or may not carry a service principal; sessions carry
      // usr_* — either is valid, and null (no attached principal) is too.
      expect(row.principal_id === null || /^(pri_|usr_)/.test(row.principal_id)).toBe(true);
    });

    it('writes a denied record for cross-team / missing probes', async () => {
      await download(authHeaders(allProjectsReadKey), `projectId=${otherProjectId}`);
      await download(authHeaders(allProjectsReadKey), 'projectId=prj_nonexistent0000');

      const rows = await db.$client.query<{ outcome: string; project_id: string | null }>(
        `SELECT outcome, project_id FROM audit_log
         WHERE action = 'export.download' AND outcome = 'denied'
         ORDER BY created_at DESC LIMIT 2`,
      );
      expect(rows.rows.length).toBeGreaterThanOrEqual(2);
      for (const row of rows.rows) {
        expect(['success', 'denied']).toContain(row.outcome);
      }
    });

    it('audit schema has no content-bearing column (nothing to leak)', async () => {
      const cols = await db.$client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'audit_log'`,
      );
      const names = cols.rows.map((r) => r.column_name);
      // Whitelist exactly the frozen auditItem fields — no body/payload/
      // query/content columns can ever exist.
      expect(names.sort()).toEqual([
        'action', 'created_at', 'credential_id', 'id', 'outcome',
        'principal_id', 'project_id', 'request_id', 'resource_id',
        'resource_type', 'team_id',
      ].sort());
    });
  });
});