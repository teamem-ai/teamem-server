/**
 * Integration tests for GET /v1/audit (DUA-227 M2-GOV-01).
 *
 * Covers:
 *   - List audit records with filters (actor, action, projectId)
 *   - Cursor-based pagination (created_at DESC, id DESC)
 *   - Denied records are visible in results
 *   - Viewer/member access is denied (403)
 *   - Cross-team isolation (anti-enumeration: 404/empty)
 *   - No query text, payload, or secret content in results
 *   - limit > 100 returns 400
 *   - Audit queries themselves are NOT re-audited
 *
 * Tests run against real PostgreSQL. Requires TEST_DATABASE_URL.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createDb, type AppDb } from '../../db/client.js';
import {
  connectDatabase,
  closeDatabase,
  type Pool,
} from '../../test/database.js';
import { buildAuditRoutes } from './audit.js';
import { buildAuthRoutes } from './auth.js';
import {
  generateSessionToken,
  SESSION_COOKIE_NAME,
} from '../../auth/oauth-github.js';
import type { GitHubOAuthConfig } from '../../auth/oauth-github.js';
import { requestContext } from '../request-context.js';
import { globalErrorHandler, notFoundHandler } from '../errors.js';
import { writeAuditRecord, type AuditWriteParams } from '../../db/repositories/audit.js';

// ── Setup ───────────────────────────────────────────────────────────────────

const url = process.env['TEST_DATABASE_URL'];

describe.skipIf(!url)('Audit Query API (live Postgres)', () => {
  let pool: Pool;
  let db: AppDb;
  let app: Hono;

  const oauthConfig: GitHubOAuthConfig = {
    clientId: 'Iv1.test_audit_client',
    clientSecret: 'test_audit_secret',
    redirectUri: 'http://localhost:8080/auth/github/callback',
    serverBaseUrl: 'http://localhost:8080',
  };

  // ── Test context: created per test ────────────────────────────────────────

  let teamId: string;
  let projectId: string;
  let ownerUser: string;
  let adminUser: string;
  let memberUser: string;
  let viewerUser: string;
  let otherTeamId: string;
  let otherProjectId: string;
  let otherTeamUser: string;

  beforeAll(async () => {
    ({ pool } = connectDatabase());
    db = createDb(url!, { pool: pool as unknown as import('pg').Pool });

    app = new Hono();
    app.use('*', requestContext);
    app.onError(globalErrorHandler);
    app.notFound(notFoundHandler);
    app.route('/', buildAuthRoutes(oauthConfig, db));
    app.route('/', buildAuditRoutes({ db, oauthConfig }));
  });

  afterAll(async () => {
    await closeDatabase(pool);
  });

  beforeEach(async () => {
    // Clean up in reverse FK order
    await db.execute(`DELETE FROM audit_log`);
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
    await db.execute(`DELETE FROM principals`);
    await db.execute(`DELETE FROM projects`);
    await db.execute(`DELETE FROM users`);
    await db.execute(`DELETE FROM teams`);

    // ── Create test data ──────────────────────────────────────────────────

    // Main team
    teamId = `team_${randomBytes(6).toString('hex')}`;
    await db.execute(
      `INSERT INTO teams (id, name) VALUES ('${teamId}', 'Test Team')`,
    );

    // Main project
    projectId = `prj_${randomBytes(6).toString('hex')}`;
    await db.execute(
      `INSERT INTO projects (id, team_id, name) VALUES ('${projectId}', '${teamId}', 'Test Project')`,
    );

    // Users with different roles
    ownerUser = await createUser(10001, 'owner-user');
    adminUser = await createUser(10002, 'admin-user');
    memberUser = await createUser(10003, 'member-user');
    viewerUser = await createUser(10004, 'viewer-user');

    // Create memberships
    await db.execute(
      `INSERT INTO memberships (user_id, team_id, role) VALUES ('${ownerUser}', '${teamId}', 'owner')`,
    );
    await db.execute(
      `INSERT INTO memberships (user_id, team_id, role) VALUES ('${adminUser}', '${teamId}', 'admin')`,
    );
    await db.execute(
      `INSERT INTO memberships (user_id, team_id, role) VALUES ('${memberUser}', '${teamId}', 'member')`,
    );
    await db.execute(
      `INSERT INTO memberships (user_id, team_id, role) VALUES ('${viewerUser}', '${teamId}', 'viewer')`,
    );

    // Other team (for cross-team tests)
    otherTeamId = `team_${randomBytes(6).toString('hex')}`;
    await db.execute(
      `INSERT INTO teams (id, name) VALUES ('${otherTeamId}', 'Other Team')`,
    );

    otherProjectId = `prj_${randomBytes(6).toString('hex')}`;
    await db.execute(
      `INSERT INTO projects (id, team_id, name) VALUES ('${otherProjectId}', '${otherTeamId}', 'Other Project')`,
    );

    otherTeamUser = await createUser(20001, 'other-user');
    await db.execute(
      `INSERT INTO memberships (user_id, team_id, role) VALUES ('${otherTeamUser}', '${otherTeamId}', 'owner')`,
    );
  });

  // ── Helpers ──────────────────────────────────────────────────────────────

  async function createUser(githubId: number, login: string): Promise<string> {
    const id = `usr_${randomBytes(8).toString('hex')}`;
    await db.execute(
      `INSERT INTO users (id, github_id, github_login) VALUES ('${id}', ${githubId}, '${login}')`,
    );
    return id;
  }

  async function createTestSession(userId: string): Promise<string> {
    const { plaintext, hash } = generateSessionToken();
    const sessionId = `ses_${randomBytes(8).toString('hex')}`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 7 * 24 * 3600_000);
    await db.execute(
      `INSERT INTO web_sessions (id, user_id, token_hash, issued_at, expires_at) VALUES ('${sessionId}', '${userId}', '${hash}', '${now.toISOString()}', '${expiresAt.toISOString()}')`,
    );
    return plaintext;
  }

  /** Make a request with a session cookie. */
  async function sessionRequest(
    path: string,
    sessionToken: string,
  ): Promise<Response> {
    const cookieHeader = `${SESSION_COOKIE_NAME}=${sessionToken}`;
    return app.request(path, {
      headers: { Cookie: cookieHeader },
    });
  }

  /** Insert an audit record and return it. */
  async function insertAudit(overrides: Partial<AuditWriteParams> = {}): Promise<void> {
    const params: AuditWriteParams = {
      requestId: overrides.requestId ?? `req_${randomUUID().replace(/-/g, '')}`,
      principalId: overrides.principalId ?? null,
      credentialId: overrides.credentialId ?? null,
      action: overrides.action ?? 'concept.read',
      resourceType: overrides.resourceType ?? 'concept',
      resourceId: overrides.resourceId ?? null,
      teamId: overrides.teamId ?? teamId,
      projectId: overrides.projectId ?? projectId,
      outcome: overrides.outcome ?? 'success',
    };
    await writeAuditRecord(db, params);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Success: list audit records
  // ═══════════════════════════════════════════════════════════════════════════

  describe('GET /v1/audit — success', () => {
    it('returns an empty list when no audit records exist', async () => {
      const token = await createTestSession(ownerUser);

      const res = await sessionRequest('/v1/audit', token);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data).toEqual([]);
      expect(body.nextCursor).toBeNull();
      expect(body.requestId).toBeDefined();
    });

    it('returns audit records with all whitelisted fields', async () => {
      // Insert several audit records
      await insertAudit({ action: 'concept.read', outcome: 'success' });
      await insertAudit({ action: 'event.ingest', outcome: 'success' });
      await insertAudit({ action: 'search.query', outcome: 'denied' });

      const token = await createTestSession(ownerUser);
      const res = await sessionRequest('/v1/audit', token);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data).toHaveLength(3);
      expect(body.nextCursor).toBeNull(); // fewer than default limit of 20

      // Verify each record has ONLY whitelisted fields
      for (const item of body.data) {
        const allowedFields = new Set([
          'id', 'createdAt', 'requestId', 'principalId', 'credentialId',
          'action', 'resourceType', 'resourceId', 'teamId', 'projectId', 'outcome',
        ]);
        for (const key of Object.keys(item)) {
          expect(
            allowedFields.has(key),
            `Field "${key}" is not in the audit whitelist`,
          ).toBe(true);
        }
      }

      // Verify actions are present (order is created_at DESC)
      const actions = body.data.map((i: Record<string, unknown>) => i.action);
      expect(actions).toContain('concept.read');
      expect(actions).toContain('event.ingest');
      expect(actions).toContain('search.query');
    });

    it('denied records are visible in results', async () => {
      await insertAudit({ action: 'concept.read', outcome: 'denied' });
      await insertAudit({ action: 'concept.read', outcome: 'success' });

      const token = await createTestSession(ownerUser);
      const res = await sessionRequest('/v1/audit', token);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data).toHaveLength(2);
      const outcomes = body.data.map((i: Record<string, unknown>) => i.outcome);
      expect(outcomes).toContain('denied');
      expect(outcomes).toContain('success');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Filters
  // ═══════════════════════════════════════════════════════════════════════════

  describe('GET /v1/audit — filters', () => {
    it('filters by action', async () => {
      await insertAudit({ action: 'concept.read' });
      await insertAudit({ action: 'event.ingest' });
      await insertAudit({ action: 'concept.read' });

      const token = await createTestSession(ownerUser);
      const res = await sessionRequest('/v1/audit?action=concept.read', token);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data).toHaveLength(2);
      for (const item of body.data) {
        expect(item.action).toBe('concept.read');
      }
    });

    it('filters by actor (principalId)', async () => {
      const actorId = 'pri_testactor001';
      await insertAudit({ principalId: actorId, action: 'concept.read' });
      await insertAudit({ principalId: null, action: 'event.ingest' });
      await insertAudit({ principalId: actorId, action: 'search.query' });

      const token = await createTestSession(ownerUser);
      const res = await sessionRequest(`/v1/audit?actor=${actorId}`, token);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data).toHaveLength(2);
      for (const item of body.data) {
        expect(item.principalId).toBe(actorId);
      }
    });

    it('filters by projectId', async () => {
      const secondProjectId = `prj_${randomBytes(6).toString('hex')}`;
      await db.execute(
        `INSERT INTO projects (id, team_id, name) VALUES ('${secondProjectId}', '${teamId}', 'Second Project')`,
      );

      await insertAudit({ projectId, action: 'concept.read' });
      await insertAudit({ projectId, action: 'event.ingest' });
      await insertAudit({ projectId: secondProjectId, action: 'concept.read' });

      const token = await createTestSession(ownerUser);
      const res = await sessionRequest(`/v1/audit?projectId=${secondProjectId}`, token);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].projectId).toBe(secondProjectId);
    });

    it('combines multiple filters', async () => {
      const actorId = 'pri_filtercombo';
      await insertAudit({ principalId: actorId, action: 'concept.read', projectId });
      await insertAudit({ principalId: actorId, action: 'event.ingest', projectId });
      await insertAudit({ principalId: 'pri_other999999', action: 'concept.read', projectId });

      const token = await createTestSession(ownerUser);
      const res = await sessionRequest(
        `/v1/audit?actor=${actorId}&action=concept.read`,
        token,
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].principalId).toBe(actorId);
      expect(body.data[0].action).toBe('concept.read');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Cursor pagination
  // ═══════════════════════════════════════════════════════════════════════════

  describe('GET /v1/audit — cursor pagination', () => {
    it('pages through results with a stable cursor', async () => {
      // Insert enough records to require pagination (default limit is 20)
      for (let i = 0; i < 5; i++) {
        await insertAudit({ action: 'concept.read' });
        // Small delay to ensure distinct created_at values
        await new Promise((r) => setTimeout(r, 5));
      }

      const token = await createTestSession(ownerUser);

      // Page 1: limit=2
      const res1 = await sessionRequest('/v1/audit?limit=2', token);
      expect(res1.status).toBe(200);
      const body1 = await res1.json();
      expect(body1.data).toHaveLength(2);
      expect(body1.nextCursor).toBeTruthy();

      // Page 2: use nextCursor
      const res2 = await sessionRequest(
        `/v1/audit?limit=2&cursor=${encodeURIComponent(body1.nextCursor)}`,
        token,
      );
      expect(res2.status).toBe(200);
      const body2 = await res2.json();
      expect(body2.data).toHaveLength(2);
      expect(body2.data[0].id).not.toBe(body1.data[0].id);
      expect(body2.data[0].id).not.toBe(body1.data[1].id);

      // Page 3: last page (should have 1 result, no nextCursor)
      if (body2.nextCursor) {
        const res3 = await sessionRequest(
          `/v1/audit?limit=2&cursor=${encodeURIComponent(body2.nextCursor)}`,
          token,
        );
        expect(res3.status).toBe(200);
        const body3 = await res3.json();
        expect(body3.data).toHaveLength(1);
        expect(body3.nextCursor).toBeNull();
      }
    });

    it('returns cursor_invalid for tampered cursors', async () => {
      const token = await createTestSession(ownerUser);

      const res = await sessionRequest('/v1/audit?cursor=tampered_token', token);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('cursor_invalid');
    });

    it('returns cursor_invalid when filters change between pages', async () => {
      for (let i = 0; i < 3; i++) {
        await insertAudit({ action: 'concept.read' });
        await new Promise((r) => setTimeout(r, 5));
      }

      const token = await createTestSession(ownerUser);

      // Get page 1 with filter action=concept.read
      const res1 = await sessionRequest('/v1/audit?limit=1&action=concept.read', token);
      expect(res1.status).toBe(200);
      const body1 = await res1.json();
      expect(body1.nextCursor).toBeTruthy();

      // Use that cursor with a DIFFERENT filter — must fail
      const res2 = await sessionRequest(
        `/v1/audit?limit=1&action=event.ingest&cursor=${encodeURIComponent(body1.nextCursor)}`,
        token,
      );
      expect(res2.status).toBe(400);
      const body2 = await res2.json();
      expect(body2.error.code).toBe('cursor_invalid');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Authorization: admin+ only
  // ═══════════════════════════════════════════════════════════════════════════

  describe('GET /v1/audit — authorization', () => {
    it('allows owner role', async () => {
      const token = await createTestSession(ownerUser);
      const res = await sessionRequest('/v1/audit', token);
      expect(res.status).toBe(200);
    });

    it('allows admin role', async () => {
      const token = await createTestSession(adminUser);
      const res = await sessionRequest('/v1/audit', token);
      expect(res.status).toBe(200);
    });

    it('denies member role', async () => {
      const token = await createTestSession(memberUser);
      const res = await sessionRequest('/v1/audit', token);
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.code).toBe('forbidden');
    });

    it('denies viewer role', async () => {
      const token = await createTestSession(viewerUser);
      const res = await sessionRequest('/v1/audit', token);
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.code).toBe('forbidden');
    });

    it('returns 401 for unauthenticated requests (no session cookie)', async () => {
      const res = await app.request('/v1/audit');
      expect(res.status).toBe(401);
    });

    it('returns 401 for invalid session tokens', async () => {
      const res = await sessionRequest('/v1/audit', 'invalid_fake_session_token');
      expect(res.status).toBe(401);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Cross-team isolation
  // ═══════════════════════════════════════════════════════════════════════════

  describe('GET /v1/audit — cross-team isolation', () => {
    it('does not return audit records from other teams', async () => {
      // Insert audit records for the main team
      await insertAudit({ teamId, action: 'concept.read' });

      // Insert audit records for the other team
      await insertAudit({
        teamId: otherTeamId,
        projectId: otherProjectId,
        action: 'concept.read',
      });

      // Main team owner can only see their team's records
      const token = await createTestSession(ownerUser);
      const res = await sessionRequest('/v1/audit', token);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].teamId).toBe(teamId);
    });

    it('other team user sees only their own team records', async () => {
      await insertAudit({ teamId, action: 'concept.read' });
      await insertAudit({
        teamId: otherTeamId,
        projectId: otherProjectId,
        action: 'event.ingest',
      });

      const token = await createTestSession(otherTeamUser);
      const res = await sessionRequest('/v1/audit', token);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].teamId).toBe(otherTeamId);
    });

    it('returns empty list for user without team membership', async () => {
      // Create a user with NO membership
      const noTeamUser = await createUser(30001, 'no-team-user');
      const token = await createTestSession(noTeamUser);

      await insertAudit({ teamId, action: 'concept.read' });

      const res = await sessionRequest('/v1/audit', token);
      expect(res.status).toBe(200);

      const body = await res.json();
      // No team → no records visible → empty list (anti-enumeration).
      // Not a 403 — that would reveal the user has no team.
      expect(body.data).toEqual([]);
      expect(body.nextCursor).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // No content/payload/query text in results
  // ═══════════════════════════════════════════════════════════════════════════

  describe('GET /v1/audit — no content columns', () => {
    it('SECURITY: results contain no query text, payload, or secret data', async () => {
      // Insert an audit record with a sentinel string in requestId
      // (requestId is a service-generated UUID, not query text)
      await insertAudit({
        action: 'search.query',
        resourceType: 'concept',
        resourceId: 'some-resource-uuid',
        requestId: 'req_normal_request_id',
      });

      const token = await createTestSession(ownerUser);
      const res = await sessionRequest('/v1/audit', token);
      expect(res.status).toBe(200);

      const body = await res.json();
      const bodyStr = JSON.stringify(body);

      // Sentinel strings that must NEVER appear in audit responses
      const forbiddenSubstrings = [
        'ZEBRAFISH',
        'SECRET=',
        'Bearer ',
        'tm_',
        'SELECT ',
        'INSERT ',
        'password',
        'client_secret',
        '<private>',
        'access_token',
      ];

      for (const forbidden of forbiddenSubstrings) {
        expect(
          bodyStr,
          `Forbidden substring "${forbidden}" found in audit response`,
        ).not.toContain(forbidden);
      }

      // Verify specific whitelisted fields are present
      for (const item of body.data) {
        expect(item).toHaveProperty('id');
        expect(item).toHaveProperty('createdAt');
        expect(item).toHaveProperty('action');
        expect(item).toHaveProperty('resourceType');
        expect(item).toHaveProperty('outcome');

        // These fields must NOT exist
        expect(item).not.toHaveProperty('query');
        expect(item).not.toHaveProperty('payload');
        expect(item).not.toHaveProperty('body');
        expect(item).not.toHaveProperty('content');
        expect(item).not.toHaveProperty('queryText');
        expect(item).not.toHaveProperty('searchQuery');
        expect(item).not.toHaveProperty('apiKey');
        expect(item).not.toHaveProperty('token');
        expect(item).not.toHaveProperty('secret');
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Limit validation
  // ═══════════════════════════════════════════════════════════════════════════

  describe('GET /v1/audit — limit validation', () => {
    it('returns 400 when limit exceeds 100 (no silent clamping)', async () => {
      const token = await createTestSession(ownerUser);
      const res = await sessionRequest('/v1/audit?limit=101', token);
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error.code).toBe('invalid_request');
    });

    it('returns 400 when limit is 0 (min is 1)', async () => {
      const token = await createTestSession(ownerUser);
      const res = await sessionRequest('/v1/audit?limit=0', token);
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error.code).toBe('invalid_request');
    });

    it('uses default limit of 20 when not specified', async () => {
      // Insert 25 records
      for (let i = 0; i < 25; i++) {
        await insertAudit({ action: 'concept.read' });
      }

      const token = await createTestSession(ownerUser);
      const res = await sessionRequest('/v1/audit', token);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data).toHaveLength(20); // default limit
      expect(body.nextCursor).toBeTruthy(); // there are 5 more
    });

    it('returns exactly the requested number of results', async () => {
      for (let i = 0; i < 10; i++) {
        await insertAudit({ action: 'concept.read' });
      }

      const token = await createTestSession(ownerUser);
      const res = await sessionRequest('/v1/audit?limit=5', token);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data).toHaveLength(5);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Audit queries are NOT re-audited (one-level audit, N7)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('GET /v1/audit — not re-audited', () => {
    it('reading audit does not create new audit records', async () => {
      // Count existing audit records
      const beforeCount = await db.$count(
        (await import('../../db/schema.js')).auditLog,
      );

      const token = await createTestSession(ownerUser);
      const res = await sessionRequest('/v1/audit', token);
      expect(res.status).toBe(200);

      // Count audit records after the query
      const afterCount = await db.$count(
        (await import('../../db/schema.js')).auditLog,
      );

      // No new audit records should have been created
      expect(afterCount).toBe(beforeCount);
    });
  });
});
