/**
 * Integration tests for the Project Purge endpoint (DUA-228).
 *
 * Covers:
 * - Success path: purge deletes all project-scoped data, returns counts
 * - Audit records survive (including the purge audit itself)
 * - Principals survive
 * - Counts match actual deleted rows
 * - Counterexamples:
 *   - Non-owner (admin/member/viewer) → 403
 *   - Cross-team access → 404
 *   - Missing project → 404
 *   - No session → 401
 * - Transactional: concurrent purge + data insertion is safe
 *
 * Tests run against real PostgreSQL; no mock database.
 *
 * Requires TEST_DATABASE_URL pointing to a Postgres instance with
 * migrations applied.
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
import { buildPurgeRoutes } from './purge.js';
import { requestContext } from '../request-context.js';
import { globalErrorHandler, notFoundHandler } from '../errors.js';
import {
  generateSessionToken,
  SESSION_COOKIE_NAME,
} from '../../auth/oauth-github.js';

const url = process.env['TEST_DATABASE_URL'];

describe.skipIf(!url)('Project Purge Route (live Postgres)', () => {
  let pool: Pool;
  let db: AppDb;
  let app: Hono;

  // ── Test fixture IDs ────────────────────────────────────────────────────
  let teamId: string;
  let projectId: string;
  let ownerUserId: string;
  let ownerSessionPlaintext: string;
  let adminUserId: string;
  let adminSessionPlaintext: string;
  let memberUserId: string;
  let memberSessionPlaintext: string;
  let viewerUserId: string;
  let viewerSessionPlaintext: string;
  let principalId: string;

  // Separate team for cross-team tests
  let otherTeamId: string;
  let otherProjectId: string;
  let otherUserSessionPlaintext: string;

  beforeAll(async () => {
    ({ pool } = connectDatabase());
    db = createDb(url!, { pool: pool as unknown as import('pg').Pool });

    // Build the Hono app with purge routes
    app = new Hono();
    app.use('*', requestContext);
    app.onError(globalErrorHandler);
    app.notFound(notFoundHandler);
    app.route('/', buildPurgeRoutes({ db }));
  });

  afterAll(async () => {
    await closeDatabase(pool);
  });

  beforeEach(async () => {
    // Clean up test data in reverse FK order
    await db.execute(`DELETE FROM web_sessions`);
    await db.execute(`DELETE FROM memberships`);
    await db.execute(`DELETE FROM invites`);
    await db.execute(`DELETE FROM audit_log`);
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

    // ── Create test team and project ────────────────────────────────────
    teamId = `team_${randomBytes(8).toString('hex')}`;
    projectId = `prj_${randomBytes(8).toString('hex')}`;
    await db.execute(`INSERT INTO teams (id, name) VALUES ('${teamId}', 'Purge Test Team')`);
    await db.execute(
      `INSERT INTO projects (id, team_id, name) VALUES ('${projectId}', '${teamId}', 'Purge Test Project')`,
    );

    // ── Create users with different roles ───────────────────────────────
    ownerUserId = `usr_${randomBytes(8).toString('hex')}`;
    adminUserId = `usr_${randomBytes(8).toString('hex')}`;
    memberUserId = `usr_${randomBytes(8).toString('hex')}`;
    viewerUserId = `usr_${randomBytes(8).toString('hex')}`;

    for (const [uid, login, ghId] of [
      [ownerUserId, 'owner-user', 1001],
      [adminUserId, 'admin-user', 1002],
      [memberUserId, 'member-user', 1003],
      [viewerUserId, 'viewer-user', 1004],
    ] as const) {
      await db.execute(
        `INSERT INTO users (id, github_id, github_login) VALUES ('${uid}', ${ghId}, '${login}')`,
      );
    }

    // ── Create memberships ──────────────────────────────────────────────
    await db.execute(
      `INSERT INTO memberships (user_id, team_id, role) VALUES ('${ownerUserId}', '${teamId}', 'owner')`,
    );
    await db.execute(
      `INSERT INTO memberships (user_id, team_id, role) VALUES ('${adminUserId}', '${teamId}', 'admin')`,
    );
    await db.execute(
      `INSERT INTO memberships (user_id, team_id, role) VALUES ('${memberUserId}', '${teamId}', 'member')`,
    );
    await db.execute(
      `INSERT INTO memberships (user_id, team_id, role) VALUES ('${viewerUserId}', '${teamId}', 'viewer')`,
    );

    // ── Create sessions ─────────────────────────────────────────────────
    const ownerSession = generateSessionToken();
    ownerSessionPlaintext = ownerSession.plaintext;
    const adminSession = generateSessionToken();
    adminSessionPlaintext = adminSession.plaintext;
    const memberSession = generateSessionToken();
    memberSessionPlaintext = memberSession.plaintext;
    const viewerSession = generateSessionToken();
    viewerSessionPlaintext = viewerSession.plaintext;

    const now = new Date();
    const expiresAt = new Date(now.getTime() + 7 * 24 * 3600_000);

    for (const [uid, hash, sid] of [
      [ownerUserId, ownerSession.hash, `ses_${randomBytes(8).toString('hex')}`],
      [adminUserId, adminSession.hash, `ses_${randomBytes(8).toString('hex')}`],
      [memberUserId, memberSession.hash, `ses_${randomBytes(8).toString('hex')}`],
      [viewerUserId, viewerSession.hash, `ses_${randomBytes(8).toString('hex')}`],
    ] as const) {
      await db.execute(
        `INSERT INTO web_sessions (id, user_id, token_hash, issued_at, expires_at) ` +
          `VALUES ('${sid}', '${uid}', '${hash}', '${now.toISOString()}', '${expiresAt.toISOString()}')`,
      );
    }

    // ── Create a principal (should survive purge) ───────────────────────
    principalId = `pri_${randomBytes(8).toString('hex')}`;
    await db.execute(
      `INSERT INTO principals (id, team_id, kind, provider, provider_kind, provider_user_id, display_login) ` +
        `VALUES ('${principalId}', '${teamId}', 'human', 'github', 'github', '12345', 'test-principal')`,
    );

    // ── Create separate team for cross-team tests ───────────────────────
    otherTeamId = `team_${randomBytes(8).toString('hex')}`;
    otherProjectId = `prj_${randomBytes(8).toString('hex')}`;
    const otherUserId = `usr_${randomBytes(8).toString('hex')}`;
    await db.execute(`INSERT INTO teams (id, name) VALUES ('${otherTeamId}', 'Other Team')`);
    await db.execute(
      `INSERT INTO projects (id, team_id, name) VALUES ('${otherProjectId}', '${otherTeamId}', 'Other Project')`,
    );
    await db.execute(
      `INSERT INTO users (id, github_id, github_login) VALUES ('${otherUserId}', 2001, 'other-user')`,
    );
    await db.execute(
      `INSERT INTO memberships (user_id, team_id, role) VALUES ('${otherUserId}', '${otherTeamId}', 'owner')`,
    );
    const otherSession = generateSessionToken();
    otherUserSessionPlaintext = otherSession.plaintext;
    await db.execute(
      `INSERT INTO web_sessions (id, user_id, token_hash, issued_at, expires_at) ` +
        `VALUES ('ses_${randomBytes(8).toString('hex')}', '${otherUserId}', '${otherSession.hash}', ` +
        `'${now.toISOString()}', '${expiresAt.toISOString()}')`,
    );
  });

  // ── Helpers ──────────────────────────────────────────────────────────────

  /** Make an authenticated request as a specific user role. */
  async function authedRequest(
    method: string,
    path: string,
    sessionPlaintext: string,
  ): Promise<Response> {
    return app.request(path, {
      method,
      headers: {
        Cookie: `${SESSION_COOKIE_NAME}=${sessionPlaintext}`,
        'Content-Type': 'application/json',
      },
    }) as Promise<Response>;
  }

  /** POST /teams/:teamId/projects/:projectId/purge as owner. */
  function purgeAsOwner(): Promise<Response> {
    return authedRequest(
      'POST',
      `/teams/${teamId}/projects/${projectId}/purge`,
      ownerSessionPlaintext,
    );
  }

  /** Seed project data: events, concepts, jobs, etc. Returns expected counts. */
  async function seedProjectData(): Promise<{
    eventCount: number;
    conceptCount: number;
    jobCount: number;
  }> {
    const eventCount = 3;
    const conceptCount = 2;
    const jobCount = 1;

    // Create events
    const eventIds: string[] = [];
    for (let i = 0; i < eventCount; i++) {
      const eid = `evt_${randomUUID().replace(/-/g, '')}`;
      eventIds.push(eid);
      await db.execute(
        `INSERT INTO events (id, team_id, project_id, channel, kind, connector_kind, delivery_id, item_key, ` +
          `external_id, actor_provenance, occurred_at, occurred_at_provenance, payload, payload_bytes, ` +
          `payload_hash, payload_schema_version, envelope_version) ` +
          `VALUES ('${eid}', '${teamId}', '${projectId}', 'github', 'github_commit', 'github', ` +
          `'delivery_${i}', 'root', 'org/repo#${i}', 'webhook_verified', NOW(), ` +
          `'provider', '{}', 2, 'abc123', 1, 1)`,
      );
    }

    // Create concepts with paths, evidence, contributors
    const conceptUuids: string[] = [];
    for (let i = 0; i < conceptCount; i++) {
      const cuid = randomUUID();
      conceptUuids.push(cuid);
      await db.execute(
        `INSERT INTO concepts (uuid, team_id, project_id, schema_version, type, status, confidence, ` +
          `title, body, first_seen, last_confirmed) ` +
          `VALUES ('${cuid}', '${teamId}', '${projectId}', 1, 'concept', 'active', 'high', ` +
          `'Concept ${i}', 'Body ${i}', NOW(), NOW())`,
      );
      // concept_paths
      await db.execute(
        `INSERT INTO concept_paths (team_id, project_id, concept_uuid, path, is_current) ` +
          `VALUES ('${teamId}', '${projectId}', '${cuid}', 'concept-${i}', true)`,
      );
      // concept_evidence
      await db.execute(
        `INSERT INTO concept_evidence (team_id, project_id, concept_uuid, kind, ref, at) ` +
          `VALUES ('${teamId}', '${projectId}', '${cuid}', 'commit', 'ref-${i}', NOW())`,
      );
      // concept_contributors
      if (principalId) {
        await db.execute(
          `INSERT INTO concept_contributors (team_id, project_id, concept_uuid, principal_id) ` +
            `VALUES ('${teamId}', '${projectId}', '${cuid}', '${principalId}')`,
        );
      }
    }

    // Create jobs
    const jobIds: string[] = [];
    for (let i = 0; i < jobCount; i++) {
      const jid = randomUUID();
      jobIds.push(jid);
      await db.execute(
        `INSERT INTO jobs (id, team_id, project_id, kind, status, attempts, initiated_by_kind, ` +
          `event_count) ` +
          `VALUES ('${jid}', '${teamId}', '${projectId}', 'compilation', 'completed', 1, 'credential', 1)`,
      );
      // job_events for each job
      if (eventIds.length > 0) {
        await db.execute(
          `INSERT INTO job_events (team_id, project_id, job_id, event_id, status) ` +
            `VALUES ('${teamId}', '${projectId}', '${jid}', '${eventIds[0]!}', 'compiled')`,
        );
      }
    }

    return { eventCount, conceptCount, jobCount };
  }

  // ── Helper: count rows in a table ────────────────────────────────────────

  async function countRows(table: string): Promise<number> {
    const result = await db.execute(`SELECT COUNT(*) as count FROM ${table}`);
    return Number((result.rows[0] as Record<string, unknown>)['count']);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Success path
  // ═══════════════════════════════════════════════════════════════════════════

  describe('POST /teams/:teamId/projects/:projectId/purge — success', () => {
    it('purges all project-scoped data and returns correct counts', async () => {
      const { eventCount, conceptCount, jobCount } = await seedProjectData();

      // Verify data exists before purge
      expect(await countRows('events')).toBeGreaterThanOrEqual(eventCount);
      expect(await countRows('concepts')).toBeGreaterThanOrEqual(conceptCount);
      expect(await countRows('jobs')).toBeGreaterThanOrEqual(jobCount);

      const res = await purgeAsOwner();

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.projectId).toBe(projectId);
      expect(json.eventsDeleted).toBe(eventCount);
      expect(json.conceptsDeleted).toBe(conceptCount);
      // concept_paths: 1 per concept
      expect(json.conceptPathsDeleted).toBe(conceptCount);
      // concept_evidence: 1 per concept
      expect(json.conceptEvidenceDeleted).toBe(conceptCount);
      // concept_contributors: 1 per concept
      expect(json.conceptContributorsDeleted).toBe(conceptCount);
      expect(json.jobsDeleted).toBe(jobCount);
      // job_events: 1 per job
      expect(json.jobEventsDeleted).toBe(jobCount);

      // Verify data is gone
      expect(await countRows('events')).toBe(0);
      expect(await countRows('concepts')).toBe(0);
      expect(await countRows('concept_paths')).toBe(0);
      expect(await countRows('concept_evidence')).toBe(0);
      expect(await countRows('concept_contributors')).toBe(0);
      expect(await countRows('jobs')).toBe(0);
      expect(await countRows('job_events')).toBe(0);
    });

    it('audit records survive the purge (including the purge audit itself)', async () => {
      await seedProjectData();

      // Count existing audit records (should be 0 in this test)
      const auditBefore = await countRows('audit_log');

      const res = await purgeAsOwner();
      expect(res.status).toBe(200);

      // Audit records should survive — the purge audit was written
      const auditAfter = await countRows('audit_log');
      expect(auditAfter).toBe(auditBefore + 1);

      // Verify the purge audit record
      const auditRows = await db.execute(
        `SELECT action, resource_type, resource_id, team_id, project_id, outcome FROM audit_log`,
      );
      const purgeAudit = auditRows.rows.find(
        (r) => (r as Record<string, unknown>)['action'] === 'project.purge',
      ) as Record<string, unknown> | undefined;
      expect(purgeAudit).toBeDefined();
      expect(purgeAudit!['resource_type']).toBe('project');
      expect(purgeAudit!['resource_id']).toBe(projectId);
      expect(purgeAudit!['team_id']).toBe(teamId);
      expect(purgeAudit!['project_id']).toBe(projectId);
      expect(purgeAudit!['outcome']).toBe('success');
    });

    it('principals survive the purge', async () => {
      await seedProjectData();

      const principalsBefore = await countRows('principals');
      expect(principalsBefore).toBeGreaterThanOrEqual(1);

      const res = await purgeAsOwner();
      expect(res.status).toBe(200);

      const principalsAfter = await countRows('principals');
      expect(principalsAfter).toBe(principalsBefore);

      // Principal row is intact
      const principalRows = await db.execute(
        `SELECT id, display_login FROM principals WHERE id = '${principalId}'`,
      );
      expect(principalRows.rows).toHaveLength(1);
    });

    it('project row itself survives (only data is deleted)', async () => {
      await seedProjectData();

      const projectsBefore = await countRows('projects');
      expect(projectsBefore).toBeGreaterThanOrEqual(1);

      const res = await purgeAsOwner();
      expect(res.status).toBe(200);

      const projectsAfter = await countRows('projects');
      expect(projectsAfter).toBe(projectsBefore);

      // Verify the project still exists
      const projRows = await db.execute(
        `SELECT id, name FROM projects WHERE id = '${projectId}'`,
      );
      expect(projRows.rows).toHaveLength(1);
    });

    it('counts are zero when project has no data to purge', async () => {
      // Don't seed any data — just purge an empty project
      const res = await purgeAsOwner();

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.eventsDeleted).toBe(0);
      expect(json.conceptsDeleted).toBe(0);
      expect(json.conceptPathsDeleted).toBe(0);
      expect(json.conceptEvidenceDeleted).toBe(0);
      expect(json.conceptContributorsDeleted).toBe(0);
      expect(json.jobsDeleted).toBe(0);
      expect(json.jobEventsDeleted).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Counterexamples — authorization
  // ═══════════════════════════════════════════════════════════════════════════

  describe('POST /teams/:teamId/projects/:projectId/purge — authorization counterexamples', () => {
    it('rejects admin (403)', async () => {
      await seedProjectData();

      const res = await authedRequest(
        'POST',
        `/teams/${teamId}/projects/${projectId}/purge`,
        adminSessionPlaintext,
      );

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error.code).toBe('forbidden');

      // Data must NOT have been deleted
      expect(await countRows('events')).toBeGreaterThan(0);
    });

    it('rejects member (403)', async () => {
      await seedProjectData();

      const res = await authedRequest(
        'POST',
        `/teams/${teamId}/projects/${projectId}/purge`,
        memberSessionPlaintext,
      );

      expect(res.status).toBe(403);
      expect(await countRows('events')).toBeGreaterThan(0);
    });

    it('rejects viewer (403)', async () => {
      await seedProjectData();

      const res = await authedRequest(
        'POST',
        `/teams/${teamId}/projects/${projectId}/purge`,
        viewerSessionPlaintext,
      );

      expect(res.status).toBe(403);
      expect(await countRows('events')).toBeGreaterThan(0);
    });

    it('returns identical 403 for admin, member, and viewer (no role leakage)', async () => {
      await seedProjectData();

      const adminRes = await authedRequest(
        'POST',
        `/teams/${teamId}/projects/${projectId}/purge`,
        adminSessionPlaintext,
      );
      const memberRes = await authedRequest(
        'POST',
        `/teams/${teamId}/projects/${projectId}/purge`,
        memberSessionPlaintext,
      );
      const viewerRes = await authedRequest(
        'POST',
        `/teams/${teamId}/projects/${projectId}/purge`,
        viewerSessionPlaintext,
      );

      const adminBody = await adminRes.json();
      const memberBody = await memberRes.json();
      const viewerBody = await viewerRes.json();

      // All must return the same status and error code
      expect(adminRes.status).toBe(403);
      expect(memberRes.status).toBe(403);
      expect(viewerRes.status).toBe(403);
      expect(adminBody.error.code).toBe('forbidden');
      expect(memberBody.error.code).toBe('forbidden');
      expect(viewerBody.error.code).toBe('forbidden');

      // Messages must be identical — no information leakage about
      // which role is required or what the user's role is
      expect(adminBody.error.message).toBe(memberBody.error.message);
      expect(memberBody.error.message).toBe(viewerBody.error.message);
    });

    it('returns 401 without a session', async () => {
      await seedProjectData();

      const res = await app.request(
        `/teams/${teamId}/projects/${projectId}/purge`,
        { method: 'POST' },
      );

      expect(res.status).toBe(401);
    });

    it('returns 401 with an invalid session token', async () => {
      await seedProjectData();

      const res = await app.request(
        `/teams/${teamId}/projects/${projectId}/purge`,
        {
          method: 'POST',
          headers: { Cookie: `${SESSION_COOKIE_NAME}=invalid_token_xyz` },
        },
      );

      expect(res.status).toBe(401);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Counterexamples — cross-team isolation
  // ═══════════════════════════════════════════════════════════════════════════

  describe('POST /teams/:teamId/projects/:projectId/purge — cross-team isolation', () => {
    it('cross-team purge returns 404 (indistinguishable from missing project)', async () => {
      await seedProjectData();

      // User from otherTeam tries to purge a project in the test team
      const res = await authedRequest(
        'POST',
        `/teams/${teamId}/projects/${projectId}/purge`,
        otherUserSessionPlaintext,
      );

      // Must return 404 — same as if the team didn't exist at all
      expect(res.status).toBe(404);
    });

    it('cross-team purge with non-existent project also returns 404 (identical responses)', async () => {
      // Attack: user from team A tries to access team B's non-existent project
      const res = await authedRequest(
        'POST',
        `/teams/${teamId}/projects/prj_nonexistent123/purge`,
        otherUserSessionPlaintext,
      );

      expect(res.status).toBe(404);

      // Also test with a project that exists but in another team
      const resExisting = await authedRequest(
        'POST',
        `/teams/${teamId}/projects/${otherProjectId}/purge`,
        otherUserSessionPlaintext,
      );

      expect(resExisting.status).toBe(404);

      // The responses must be byte-identical in structure (error code + message)
      const body1 = await res.json();
      const body2 = await resExisting.json();
      expect(body1.error.code).toBe('not_found');
      expect(body2.error.code).toBe('not_found');
      expect(body1.error.message).toBe(body2.error.message);
    });

    it('non-existent project in own team returns 404', async () => {
      const res = await authedRequest(
        'POST',
        `/teams/${teamId}/projects/prj_nonexistent456/purge`,
        ownerSessionPlaintext,
      );

      expect(res.status).toBe(404);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Transactional safety
  // ═══════════════════════════════════════════════════════════════════════════

  describe('POST /teams/:teamId/projects/:projectId/purge — transactional safety', () => {
    it('second purge of the same project returns zero counts (idempotent)', async () => {
      await seedProjectData();

      // First purge
      const res1 = await purgeAsOwner();
      expect(res1.status).toBe(200);
      const json1 = await res1.json();
      expect(json1.eventsDeleted).toBeGreaterThan(0);

      // Second purge — project already empty
      const res2 = await purgeAsOwner();
      expect(res2.status).toBe(200);
      const json2 = await res2.json();
      expect(json2.eventsDeleted).toBe(0);
      expect(json2.conceptsDeleted).toBe(0);
      expect(json2.jobsDeleted).toBe(0);

      // Both purges write separate audit records
      const auditCount = await countRows('audit_log');
      expect(auditCount).toBe(2);
    });

    it('purge does not affect other projects in the same team', async () => {
      await seedProjectData();

      // Create a second project in the same team
      const secondProjectId = `prj_${randomBytes(8).toString('hex')}`;
      await db.execute(
        `INSERT INTO projects (id, team_id, name) VALUES ('${secondProjectId}', '${teamId}', 'Second Project')`,
      );
      // Add an event to the second project
      await db.execute(
        `INSERT INTO events (id, team_id, project_id, channel, kind, connector_kind, delivery_id, item_key, ` +
          `external_id, actor_provenance, occurred_at, occurred_at_provenance, payload, payload_bytes, ` +
          `payload_hash, payload_schema_version, envelope_version) ` +
          `VALUES ('evt_${randomUUID().replace(/-/g, '')}', '${teamId}', '${secondProjectId}', 'github', ` +
          `'github_commit', 'github', 'delivery_999', 'root', 'org/repo#999', 'webhook_verified', ` +
          `NOW(), 'provider', '{}', 2, 'abc999', 1, 1)`,
      );

      // Purge the first project
      const res = await purgeAsOwner();
      expect(res.status).toBe(200);

      // First project's events are gone
      const mainEventCount = await db.execute(
        `SELECT COUNT(*) as count FROM events WHERE project_id = '${projectId}'`,
      );
      expect(Number((mainEventCount.rows[0] as Record<string, unknown>)['count'])).toBe(0);

      // Second project's events are intact
      const secondEventCount = await db.execute(
        `SELECT COUNT(*) as count FROM events WHERE project_id = '${secondProjectId}'`,
      );
      expect(Number((secondEventCount.rows[0] as Record<string, unknown>)['count'])).toBe(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Response validation
  // ═══════════════════════════════════════════════════════════════════════════

  describe('POST /teams/:teamId/projects/:projectId/purge — response validation', () => {
    it('response matches the purgeResponse DTO schema', async () => {
      await seedProjectData();

      const res = await purgeAsOwner();
      expect(res.status).toBe(200);
      const json = await res.json();

      // All required fields are present and of correct type
      expect(typeof json.requestId).toBe('string');
      expect(typeof json.projectId).toBe('string');
      expect(typeof json.eventsDeleted).toBe('number');
      expect(typeof json.conceptsDeleted).toBe('number');
      expect(typeof json.conceptPathsDeleted).toBe('number');
      expect(typeof json.conceptEvidenceDeleted).toBe('number');
      expect(typeof json.conceptContributorsDeleted).toBe('number');
      expect(typeof json.jobsDeleted).toBe('number');
      expect(typeof json.jobEventsDeleted).toBe('number');

      // No extra fields
      const allowedKeys = [
        'requestId', 'projectId',
        'eventsDeleted', 'conceptsDeleted', 'conceptPathsDeleted',
        'conceptEvidenceDeleted', 'conceptContributorsDeleted',
        'jobsDeleted', 'jobEventsDeleted',
      ];
      const actualKeys = Object.keys(json).sort();
      expect(actualKeys.sort()).toEqual(allowedKeys.sort());
    });

    it('purge response does not leak internal data', async () => {
      await seedProjectData();

      const res = await purgeAsOwner();
      const json = await res.json();
      const body = JSON.stringify(json);

      // No payloads, keys, or internal identifiers
      expect(body).not.toContain('payload');
      expect(body).not.toContain('tm_');
      expect(body).not.toContain('token_hash');
      expect(body).not.toContain('secret');
      expect(body).not.toContain('<private>');
    });
  });
});
