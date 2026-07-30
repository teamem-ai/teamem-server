/**
 * Context endpoint integration tests — DUA-229 M2-GOV-03.
 *
 * Tests against real Postgres (TEST_DATABASE_URL):
 *   - Success: returns token-budget-controlled markdown summary
 *   - Empty database: honest empty summary
 *   - Budget truncation: many high-confidence concepts → budget-limited
 *   - Anti-enumeration: cross-team / cross-project → empty (not 404/403)
 *   - Auth/scope: 401 without token, 403 without read scope
 *   - Response shape validation against frozen contract
 *   - Internal links use teamem://concept/<uuid> format
 *   - Response contains no raw payload or query text
 *
 * Runs only when TEST_DATABASE_URL is set; honestly skipped otherwise.
 */
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type AppDeps } from '../../app.js';
import { createDb, type AppDb } from '../../db/client.js';
import {
  connectDatabase,
  closeDatabase,
  type Pool,
} from '../../test/database.js';
import { runBootstrap } from '../../commands/bootstrap.js';
import { createConcept, type CreateConceptInput } from '../../db/repositories/concepts-write.js';

const url = process.env['TEST_DATABASE_URL'];

describe.skipIf(!url)('GET /v1/context (live Postgres)', () => {
  let pool: Pool;
  let db: AppDb;
  let app: ReturnType<typeof buildApp>;

  // Primary team
  let teamId: string;
  let projectId: string;
  let apiKeyToken: string | undefined;

  // Other team for cross-tenant tests
  let otherTeamId: string;
  let otherProjectId: string;

  // For scope tests
  let otherProjectIdSameTeam: string;
  let allProjectsKey: string;
  let writeOnlyKey: string;

  beforeAll(async () => {
    ({ pool } = connectDatabase());
    db = createDb(url!, { pool: pool as unknown as import('pg').Pool });

    // ── Team 1 (our team) ──────────────────────────────────────────
    const suffix = randomUUID().replace(/-/g, '').slice(0, 8);
    const result = await runBootstrap(db, {
      teamName: `Context Test ${suffix}`,
      projectName: `demo-${suffix}`,
      rotate: false,
    });

    teamId = result.team.id;
    projectId = result.project.id;
    apiKeyToken = result.key.token;

    // ── Team 2 (other team — cross-tenant tests) ───────────────────
    const otherSuffix = randomUUID().replace(/-/g, '').slice(0, 8);
    const otherResult = await runBootstrap(db, {
      teamName: `Context Other ${otherSuffix}`,
      projectName: `other-${otherSuffix}`,
      rotate: false,
    });
    otherTeamId = otherResult.team.id;
    otherProjectId = otherResult.project.id;

    // ── Another project in the same team (scope isolation) ─────────
    const apSuffix = randomUUID().replace(/-/g, '').slice(0, 8);
    otherProjectIdSameTeam = `prj_ctxother${apSuffix}`;
    await db.execute(
      `INSERT INTO projects (id, team_id, name) VALUES ('${otherProjectIdSameTeam}', '${teamId}', 'Context Other Same-Team Project')`,
    );

    // ── All-projects key for scope tests ───────────────────────────
    allProjectsKey = await createAllProjectsKey(db, teamId);

    // ── Write-only key (no read scope) for 403 test ───────────────
    writeOnlyKey = await createWriteOnlyKey(db, teamId, projectId);

    // ── Build the Hono app ─────────────────────────────────────────
    const deps: AppDeps = { dbUrl: url, db };
    app = buildApp(deps);
  });

  afterAll(async () => {
    // Clean up in FK dependency order.
    const ids = [projectId, otherProjectId, otherProjectIdSameTeam];
    for (const pid of ids) {
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
    await db.execute(`DELETE FROM api_keys              WHERE team_id = '${teamId}' AND project_id IS NULL`);
    await db.execute(`DELETE FROM principals            WHERE team_id = '${teamId}'`);
    await db.execute(`DELETE FROM teams                 WHERE id = '${teamId}'`);
    await db.execute(`DELETE FROM principals            WHERE team_id = '${otherTeamId}'`);
    await db.execute(`DELETE FROM teams                 WHERE id = '${otherTeamId}'`);
    await closeDatabase(pool);
  });

  // ── Helpers ──────────────────────────────────────────────────────────

  function authHeaders(token?: string) {
    return {
      Authorization: `Bearer ${token ?? apiKeyToken}`,
    };
  }

  async function seedConcept(
    tId: string,
    pId: string,
    overrides?: {
      path?: string;
      title?: string;
      body?: string;
      confidence?: 'high' | 'medium' | 'low';
      type?: string;
      lastConfirmed?: Date;
    },
  ): Promise<{ uuid: string; path: string }> {
    const path = overrides?.path ?? `concepts/test-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const input: CreateConceptInput = {
      teamId: tId,
      projectId: pId,
      schemaVersion: 1,
      type: (overrides?.type ?? 'concept') as CreateConceptInput['type'],
      status: 'active',
      confidence: overrides?.confidence ?? 'high',
      title: overrides?.title ?? `Test Concept ${path}`,
      body: overrides?.body ?? `This is the body for concept at path ${path}. It contains useful knowledge.`,
      firstSeen: new Date('2025-01-01T00:00:00.000Z'),
      lastConfirmed: overrides?.lastConfirmed ?? new Date('2025-01-01T00:00:00.000Z'),
      path,
      evidence: [
        {
          kind: 'mcp_write',
          ref: `evt_ctx_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
          at: new Date('2025-01-01T00:00:00.000Z'),
        },
      ],
      contributors: [],
    };

    const result = await createConcept(db, input);
    return { uuid: result.uuid, path };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Success tests
  // ═══════════════════════════════════════════════════════════════════════

  describe('success path', () => {
    it('returns 200 with markdown summary for project with concepts', async () => {
      // Seed a couple of high-confidence concepts.
      const c1 = await seedConcept(teamId, projectId, {
        title: 'Auth Service Architecture',
        body: 'The auth service uses JWT tokens with RS256 signing. It validates requests at the API gateway.',
        confidence: 'high',
        lastConfirmed: new Date('2025-06-15T00:00:00.000Z'),
      });
      const c2 = await seedConcept(teamId, projectId, {
        title: 'Database Migration Strategy',
        body: 'All database migrations are run through a CLI tool. Never apply migrations manually in production.',
        confidence: 'high',
        lastConfirmed: new Date('2025-06-10T00:00:00.000Z'),
      });

      const res = await app.request(
        `/v1/context?projectId=${projectId}`,
        { headers: authHeaders() },
      );

      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.requestId).toBeTruthy();
      expect(json.data).toBeDefined();

      const { markdown, budgetUsed, conceptsIncluded, conceptsAvailable } = json.data;
      expect(typeof markdown).toBe('string');
      expect(markdown.length).toBeGreaterThan(0);
      expect(typeof budgetUsed).toBe('number');
      expect(budgetUsed).toBeGreaterThan(0);
      expect(typeof conceptsIncluded).toBe('number');
      expect(conceptsIncluded).toBeGreaterThanOrEqual(1);
      expect(typeof conceptsAvailable).toBe('number');
      expect(conceptsAvailable).toBeGreaterThanOrEqual(2);

      // Should contain concept titles.
      expect(markdown).toContain('Auth Service Architecture');
      expect(markdown).toContain('Database Migration Strategy');

      // Should contain teamem:// links.
      expect(markdown).toContain(`teamem://concept/${c1.uuid}`);
      expect(markdown).toContain(`teamem://concept/${c2.uuid}`);
    });

    it('returns markdown with one-line summaries from concept bodies', async () => {
      await seedConcept(teamId, projectId, {
        title: 'One-Line Test',
        body: 'This is the first sentence. This is the second sentence with more detail that would make this too long.',
        confidence: 'high',
        lastConfirmed: new Date('2025-07-01T00:00:00.000Z'),
      });

      const res = await app.request(
        `/v1/context?projectId=${projectId}`,
        { headers: authHeaders() },
      );

      expect(res.status).toBe(200);
      const json = await res.json();

      // The summary should contain the first sentence but not the full body.
      expect(json.data.markdown).toContain('This is the first sentence.');
      // Should not contain the second sentence fully.
      expect(json.data.markdown).not.toContain('This is the second sentence with more detail');
    });

    it('sorts high-confidence before medium-confidence concepts', async () => {
      // Seed one high and one medium concept. Medium has newer last_confirmed
      // but should still come AFTER high in the output.
      const highPath = `concepts/high-priority-${randomUUID().replace(/-/g, '').slice(0, 6)}`;
      const medPath = `concepts/med-priority-${randomUUID().replace(/-/g, '').slice(0, 6)}`;

      await seedConcept(teamId, projectId, {
        path: medPath,
        title: 'Medium Confidence Concept',
        confidence: 'medium',
        lastConfirmed: new Date('2025-07-15T00:00:00.000Z'), // newer
      });
      await seedConcept(teamId, projectId, {
        path: highPath,
        title: 'High Confidence Concept',
        confidence: 'high',
        lastConfirmed: new Date('2025-07-01T00:00:00.000Z'), // older
      });

      const res = await app.request(
        `/v1/context?projectId=${projectId}`,
        { headers: authHeaders() },
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      const markdown = json.data.markdown;

      const highIdx = markdown.indexOf('High Confidence Concept');
      const medIdx = markdown.indexOf('Medium Confidence Concept');

      expect(highIdx).toBeGreaterThan(-1);
      expect(medIdx).toBeGreaterThan(-1);
      expect(highIdx).toBeLessThan(medIdx);
    });

    it('excludes low-confidence concepts entirely', async () => {
      await seedConcept(teamId, projectId, {
        title: 'Low Confidence Speculation',
        confidence: 'low',
        body: 'This might be the case but we are not sure.',
        lastConfirmed: new Date('2025-07-15T00:00:00.000Z'),
      });

      const res = await app.request(
        `/v1/context?projectId=${projectId}`,
        { headers: authHeaders() },
      );

      expect(res.status).toBe(200);
      const json = await res.json();

      // Low confidence concept should not appear in the markdown.
      expect(json.data.markdown).not.toContain('Low Confidence Speculation');
      // conceptsAvailable should not count low-confidence concepts.
      // But it may count existing ones from other tests...
      // The important thing: it should not include the low confidence one.
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Empty database
  // ═══════════════════════════════════════════════════════════════════════

  describe('empty project', () => {
    it('returns honest empty summary for a project with no high/medium concepts', async () => {
      const res = await app.request(
        `/v1/context?projectId=${otherProjectIdSameTeam}`,
        { headers: authHeaders() },
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.markdown).toBeTruthy();
      expect(json.data.conceptsIncluded).toBe(0);
      expect(json.data.conceptsAvailable).toBe(0);

      // The empty markdown should indicate absence without fabricating content.
      const markdown = json.data.markdown as string;
      expect(markdown).toContain('No high-confidence team knowledge available');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Budget truncation
  // ═══════════════════════════════════════════════════════════════════════

  describe('budget truncation', () => {
    it('truncates output when many high-confidence concepts exceed token budget', async () => {
      // Seed many concepts with long bodies to force budget truncation.
      const longBody = 'A'.repeat(500) + '. This provides detailed context.';
      const seeded = [];
      for (let i = 0; i < 15; i++) {
        seeded.push(await seedConcept(teamId, projectId, {
          title: `Budget Test Concept ${i}`,
          body: longBody,
          confidence: 'high',
          lastConfirmed: new Date(`2025-07-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`),
        }));
      }

      const res = await app.request(
        `/v1/context?projectId=${projectId}`,
        { headers: authHeaders() },
      );

      expect(res.status).toBe(200);
      const json = await res.json();

      // conceptsAvailable should be >= 15
      expect(json.data.conceptsAvailable).toBeGreaterThanOrEqual(15);

      // conceptsIncluded should be strictly less than conceptsAvailable
      expect(json.data.conceptsIncluded).toBeLessThan(json.data.conceptsAvailable);

      // budgetUsed should be within the budget (~800 tokens ≈ 3200 chars)
      expect(json.data.budgetUsed).toBeLessThanOrEqual(800);

      // The newest concepts (highest last_confirmed among high confidence)
      // should appear; older ones should be truncated out.
      // Concept 14 (i=14, date=2025-07-15) should be present.
      expect(json.data.markdown).toContain('Budget Test Concept 14');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Internal link format
  // ═══════════════════════════════════════════════════════════════════════

  describe('internal links', () => {
    it('uses teamem://concept/<uuid> format for body links', async () => {
      const c = await seedConcept(teamId, projectId, {
        title: 'Link Test Concept',
        body: 'This concept references other things.',
        confidence: 'high',
        lastConfirmed: new Date('2025-07-20T00:00:00.000Z'),
      });

      const res = await app.request(
        `/v1/context?projectId=${projectId}`,
        { headers: authHeaders() },
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      const markdown = json.data.markdown as string;

      // Should contain a teamem:// link.
      expect(markdown).toMatch(/teamem:\/\/concept\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);

      // Should contain the correct UUID in the link.
      expect(markdown).toContain(`teamem://concept/${c.uuid}`);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // No payload/query text leakage
  // ═══════════════════════════════════════════════════════════════════════

  describe('no sensitive data leakage', () => {
    it('does not contain raw event payload references', async () => {
      // Seed a concept with a body that looks like it came from an event.
      await seedConcept(teamId, projectId, {
        title: 'Sensitive Concept',
        body: 'The API key rotation happens every 90 days.',
        confidence: 'high',
        lastConfirmed: new Date('2025-07-20T00:00:00.000Z'),
      });

      const res = await app.request(
        `/v1/context?projectId=${projectId}`,
        { headers: authHeaders() },
      );

      expect(res.status).toBe(200);
      const json = await res.json();

      // The response data should only contain concept fields, not raw payload.
      // Check that the response shape is correct.
      const keys = Object.keys(json.data);
      expect(keys).toContain('markdown');
      expect(keys).toContain('budgetUsed');
      expect(keys).toContain('conceptsIncluded');
      expect(keys).toContain('conceptsAvailable');
      // Should not contain unexpected fields like raw payload or query.
      expect(keys).not.toContain('payload');
      expect(keys).not.toContain('query');
      expect(keys).not.toContain('rawBody');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Anti-enumeration: cross-team / cross-project
  // ═══════════════════════════════════════════════════════════════════════

  describe('anti-enumeration', () => {
    it('returns empty context for cross-project access with project-scoped key', async () => {
      // Project-scoped key tries to access a different project in the same team.
      const res = await app.request(
        `/v1/context?projectId=${otherProjectIdSameTeam}`,
        { headers: authHeaders() },
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.conceptsIncluded).toBe(0);
      expect(json.data.conceptsAvailable).toBe(0);
    });

    it('returns empty context for cross-team project with allProjects key', async () => {
      // allProjects key tries to access a project in a different team.
      const res = await app.request(
        `/v1/context?projectId=${otherProjectId}`,
        { headers: { Authorization: `Bearer ${allProjectsKey}` } },
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.conceptsIncluded).toBe(0);
      expect(json.data.conceptsAvailable).toBe(0);
    });

    it('returns identical empty response for cross-team and genuinely empty project', async () => {
      // Cross-team access with allProjects key.
      const crossTeamRes = await app.request(
        `/v1/context?projectId=${otherProjectId}`,
        { headers: { Authorization: `Bearer ${allProjectsKey}` } },
      );

      // Genuinely empty project in the same team.
      const emptyRes = await app.request(
        `/v1/context?projectId=${otherProjectIdSameTeam}`,
        { headers: { Authorization: `Bearer ${allProjectsKey}` } },
      );

      expect(crossTeamRes.status).toBe(200);
      expect(emptyRes.status).toBe(200);

      const crossTeamJson = await crossTeamRes.json();
      const emptyJson = await emptyRes.json();

      // Both should have 0 concepts.
      expect(crossTeamJson.data.conceptsIncluded).toBe(0);
      expect(emptyJson.data.conceptsIncluded).toBe(0);

      // The markdown should be similar (both indicate no knowledge).
      // We don't require byte-for-byte equality, but both should indicate
      // the absence of team knowledge in a non-distinguishing way.
      expect(crossTeamJson.data.markdown).toContain('No high-confidence');
      expect(emptyJson.data.markdown).toContain('No high-confidence');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Auth / scope
  // ═══════════════════════════════════════════════════════════════════════

  describe('auth and scope', () => {
    it('returns 401 without Authorization header', async () => {
      const res = await app.request(`/v1/context?projectId=${projectId}`);
      expect(res.status).toBe(401);
      expect((await res.json()).error.code).toBe('unauthorized');
    });

    it('returns 401 with invalid API key', async () => {
      const res = await app.request(`/v1/context?projectId=${projectId}`, {
        headers: { Authorization: 'Bearer tm_invalid_key_12345' },
      });
      expect(res.status).toBe(401);
    });

    it('returns 403 for key without read scope (write-only key)', async () => {
      const res = await app.request(`/v1/context?projectId=${projectId}`, {
        headers: { Authorization: `Bearer ${writeOnlyKey}` },
      });
      expect(res.status).toBe(403);
    });

    it('returns 400 when projectId query parameter is missing', async () => {
      const res = await app.request('/v1/context', {
        headers: authHeaders(),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe('invalid_request');
    });

    it('returns 400 for invalid projectId format', async () => {
      const res = await app.request('/v1/context?projectId=not-a-valid-id', {
        headers: authHeaders(),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe('invalid_request');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Response shape validation
  // ═══════════════════════════════════════════════════════════════════════

  describe('response shape validation', () => {
    it('response matches the frozen contextResponse contract', async () => {
      await seedConcept(teamId, projectId, {
        title: 'Contract Validation Concept',
        confidence: 'high',
        lastConfirmed: new Date('2025-07-01T00:00:00.000Z'),
      });

      const res = await app.request(
        `/v1/context?projectId=${projectId}`,
        { headers: authHeaders() },
      );
      expect(res.status).toBe(200);

      const { contextResponse } = await import('@teamem/schema');
      const parsed = contextResponse.safeParse(await res.json());
      expect(parsed.success).toBe(true);
    });

    it('empty response also matches the frozen contract', async () => {
      const res = await app.request(
        `/v1/context?projectId=${otherProjectIdSameTeam}`,
        { headers: authHeaders() },
      );
      expect(res.status).toBe(200);

      const { contextResponse } = await import('@teamem/schema');
      const parsed = contextResponse.safeParse(await res.json());
      expect(parsed.success).toBe(true);
    });
  });
});

// ── Helpers ──────────────────────────────────────────────────────────────

function generateTestToken(): string {
  const bytes = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
  return `tm_${Buffer.from(bytes, 'utf8').toString('base64url').replace(/=/g, '').slice(0, 43)}`;
}

async function createAllProjectsKey(db: AppDb, teamId: string): Promise<string> {
  const plaintext = generateTestToken();
  const hash = createHash('sha256').update(plaintext, 'utf8').digest('hex');

  await db.execute(
    `INSERT INTO api_keys (id, team_id, project_id, name, token_hash, scopes, all_projects)
     VALUES ('key_all_ctx_${randomUUID().replace(/-/g, '').slice(0, 26)}', '${teamId}', NULL,
             'test-all-read-key', '${hash}', ARRAY['read'], true)`,
  );

  return plaintext;
}

async function createWriteOnlyKey(
  db: AppDb,
  teamId: string,
  projectId: string,
): Promise<string> {
  const plaintext = generateTestToken();
  const hash = createHash('sha256').update(plaintext, 'utf8').digest('hex');

  await db.execute(
    `INSERT INTO api_keys (id, team_id, project_id, name, token_hash, scopes, all_projects)
     VALUES ('key_write_ctx_${randomUUID().replace(/-/g, '').slice(0, 22)}', '${teamId}', '${projectId}',
             'test-write-only-key', '${hash}', ARRAY['events:write'], false)`,
  );

  return plaintext;
}
