/**
 * M3 export repository integration tests — DUA-249 / M3-EXPORT-02.
 *
 * Tests against real Postgres (TEST_DATABASE_URL), directly against the
 * scoped repository entry point — no HTTP layer, no frozen-contract changes:
 *   - scope: ProjectScope is the ONLY entry; cross-team / missing project are
 *     both null (indistinguishable upstream); cross-project cursor rejected.
 *   - pagination: cursor pages over (created_at asc, uuid asc) with limit +
 *     hard cap; full coverage across pages, no duplicates, stable order,
 *     boundary page behavior, limit-contract rejection.
 *   - renderer-consumability: every returned concept validates against the
 *     frozen `concept` schema; the no-current-path and invalid-evidence
 *     counterexamples surface in `skipped`, never as disguised Concepts.
 *   - bounded reads: paths/evidence/contributors are fetched only for the
 *     current page's concepts (SQL row-count instrumentation for the
 *     contributors query, which previously leaked as a project-wide read).
 *   - cursor integrity: forged but parseable cursors (non-UUID boundary,
 *     nonexistent boundary, cross-team boundary, and a REAL boundary uuid
 *     carrying a forged timestamp) are rejected as ExportCursorInvalidError
 *     — never silently accepted, never a DB error; re-encoding a genuine
 *     cursor still works, and pagination over the whole project never misses
 *     or duplicates a concept, including created_at ties (uuid tie-break).
 *
 * Runs only when TEST_DATABASE_URL is set; honestly skipped otherwise.
 */
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { createDb, type AppDb } from '../client.js';
import * as schema from '../schema.js';
import {
  connectDatabase,
  closeDatabase,
} from '../../test/database.js';
import { runBootstrap } from '../../commands/bootstrap.js';
import { createConcept, type CreateConceptInput } from './concepts-write.js';
import { allProjectsScope, projectScope } from '../../auth/scope.js';
import {
  exportProject,
  EXPORT_PAGE_DEFAULT_LIMIT,
  EXPORT_PAGE_MAX_LIMIT,
  ExportCursorInvalidError,
  ExportLimitInvalidError,
  ExportScopeInvalidError,
} from './export.js';

const url = process.env['TEST_DATABASE_URL'];

describe.skipIf(!url)('Export repository (live Postgres)', () => {
  let pool: Pool;
  let db: AppDb;

  // Primary team + project
  let teamId: string;
  let projectId: string;
  let projectName: string;
  let scopeProject: ReturnType<typeof projectScope>;

  // Other team (cross-tenant) and same-team other project (scope isolation)
  let otherTeamId: string;
  let otherProjectId: string;
  let otherProjectIdSameTeam: string;

  // Fixtures reused across tests
  let conceptUuidWithAlias: string;
  let aliasPath: string;
  let principalId: string;

  beforeAll(async () => {
    ({ pool } = connectDatabase());
    db = createDb(url!, { pool: pool as unknown as import('pg').Pool });

    // ── Team 1 ────────────────────────────────────────────────────
    const suffix = randomUUID().replace(/-/g, '').slice(0, 8);
    const result = await runBootstrap(db, {
      teamName: `Export Repo Test ${suffix}`,
      projectName: `demo-${suffix}`,
      rotate: false,
    });
    teamId = result.team.id;
    projectId = result.project.id;
    projectName = result.project.name;
    scopeProject = projectScope(teamId, projectId);

    // ── Team 2 (cross-tenant) ──────────────────────────────────────
    const otherSuffix = randomUUID().replace(/-/g, '').slice(0, 8);
    const otherResult = await runBootstrap(db, {
      teamName: `Export Repo Other ${otherSuffix}`,
      projectName: `other-${otherSuffix}`,
      rotate: false,
    });
    otherTeamId = otherResult.team.id;
    otherProjectId = otherResult.project.id;

    // ── Same team, different project ───────────────────────────────
    const apSuffix = randomUUID().replace(/-/g, '').slice(0, 8);
    otherProjectIdSameTeam = `prj_other${apSuffix}`;
    await db.execute(
      `INSERT INTO projects (id, team_id, name) VALUES ('${otherProjectIdSameTeam}', '${teamId}', 'Other Same-Team Project')`,
    );

    // ── Seed fixtures ──────────────────────────────────────────────
    principalId = `pri_ctb${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    await db.execute(
      `INSERT INTO principals (id, team_id, kind, provider, provider_kind, provider_user_id, display_login)
       VALUES ('${principalId}', '${teamId}', 'human', 'github', 'github', 'ctbuser${randomUUID().replace(/-/g, '').slice(0, 8)}', 'ctb_user')`,
    );

    const path = `services/auth-service-${randomUUID().replace(/-/g, '').slice(0, 6)}`;
    aliasPath = `old-paths/former-auth-name-${randomUUID().replace(/-/g, '').slice(0, 6)}`;

    const c1 = await createConcept(db, conceptInput(teamId, projectId, path, {
      title: 'Auth Service',
      type: 'service',
      body: 'Handles authentication and authorization.',
      tags: ['auth', 'infra'],
      lastConfirmed: new Date('2025-06-02T00:00:00.000Z'),
    }, { contributor: principalId }));
    conceptUuidWithAlias = c1.uuid;

    // Historical alias (N5: aliases share the paths namespace).
    await db.execute(
      `INSERT INTO concept_paths (team_id, project_id, concept_uuid, path, is_current)
       VALUES ('${teamId}', '${projectId}', '${conceptUuidWithAlias}', '${aliasPath}', false)`,
    );

    // Second concept — pr evidence, no contributor.
    await createConcept(db, conceptInput(teamId, projectId,
      `decisions/use-postgres-${randomUUID().replace(/-/g, '').slice(0, 6)}`, {
        title: 'Use Postgres',
        type: 'decision',
        body: 'We decided to use Postgres as the primary database.',
      }));

    // A concept in the other team (cross-tenant tests).
    await createConcept(db, conceptInput(otherTeamId, otherProjectId,
      `services/other-service-${randomUUID().replace(/-/g, '').slice(0, 6)}`,
      { title: 'Other Team Service' },
    ));
  });

  afterAll(async () => {
    for (const pid of [projectId, otherProjectId, otherProjectIdSameTeam]) {
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
    await db.execute(`DELETE FROM principals            WHERE team_id = '${teamId}'`);
    await db.execute(`DELETE FROM teams                 WHERE id = '${teamId}'`);
    await db.execute(`DELETE FROM principals            WHERE team_id = '${otherTeamId}'`);
    await db.execute(`DELETE FROM teams                 WHERE id = '${otherTeamId}'`);
    await closeDatabase(pool);
  });

  function conceptInput(
    tId: string,
    pId: string,
    path: string,
    overrides?: Partial<CreateConceptInput>,
    extra?: { contributor?: string },
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
      contributors: extra?.contributor
        ? [{ principalId: extra.contributor, provenance: 'credential_bound' }]
        : [],
      ...overrides,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Scope — ProjectScope entry, anti-enumeration
  // ═══════════════════════════════════════════════════════════════════════

  it('returns the assembled export for the project scoped to the team', async () => {
    const page = await exportProject(db, scopeProject, { limit: 100 });

    expect(page).not.toBeNull();
    expect(page!.project).toEqual({ id: projectId, name: projectName });
    expect(page!.schemaVersion).toBe(1);
    expect(page!.totalConcepts).toBe(2);
    expect(page!.concepts).toHaveLength(2);
    expect(page!.skipped).toEqual([]);
    expect(page!.nextCursor).toBeNull();
  });

  it('returns null for a project of another team — indistinguishable from missing', async () => {
    const crossTeam = await exportProject(db, projectScope(teamId, otherProjectId));
    const missing = await exportProject(
      db,
      projectScope(teamId, `prj_noexist${randomUUID().replace(/-/g, '').slice(0, 8)}`),
    );
    expect(crossTeam).toBeNull();
    expect(missing).toBeNull();

    // Same rule for a team-wide scope naming a foreign project.
    const crossTeamAllProjects = await exportProject(db, allProjectsScope(teamId), {
      projectId: otherProjectId,
    });
    expect(crossTeamAllProjects).toBeNull();
  });

  it('returns null when the team does not match the scope team', async () => {
    const page = await exportProject(db, projectScope(otherTeamId, projectId));
    expect(page).toBeNull();
  });

  it('accepts an allProjects scope naming the project via options.projectId', async () => {
    const page = await exportProject(db, allProjectsScope(teamId), {
      projectId,
      limit: 100,
    });
    expect(page).not.toBeNull();
    expect(page!.project.id).toBe(projectId);
    expect(page!.totalConcepts).toBe(2);
  });

  it('rejects an allProjects scope without a projectId (ExportScopeInvalidError)', async () => {
    await expect(exportProject(db, allProjectsScope(teamId)))
      .rejects.toBeInstanceOf(ExportScopeInvalidError);
  });

  it('rejects a projectId conflicting with a project-scoped scope (ExportScopeInvalidError)', async () => {
    await expect(
      exportProject(db, scopeProject, { projectId: otherProjectIdSameTeam }),
    ).rejects.toBeInstanceOf(ExportScopeInvalidError);
    // Matching projectId is fine and returns the same project.
    const page = await exportProject(db, scopeProject, { projectId, limit: 100 });
    expect(page).not.toBeNull();
    expect(page!.project.id).toBe(projectId);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Assembly — evidence, current + historical paths, contributors
  // ═══════════════════════════════════════════════════════════════════════

  it('assembles evidence, current path, historical aliases, and contributors', async () => {
    const page = await exportProject(db, scopeProject, { limit: 100 });
    expect(page).not.toBeNull();

    const c1 = page!.concepts.find((c) => c.uuid === conceptUuidWithAlias);
    expect(c1).toBeDefined();
    expect(c1!.path).not.toBe('');
    expect(c1!.aliases).toContain(aliasPath);
    expect(c1!.evidence).toEqual([
      {
        kind: 'repo_file',
        repo: 'teamem-ai/teamem',
        commitSha: 'abc1234',
        path: 'src/index.ts',
        at: '2025-06-01T00:00:00.000Z',
      },
    ]);
    expect(c1!.contributors).toEqual([
      expect.objectContaining({
        principalId,
        kind: 'human',
        provider: 'github',
        githubLogin: 'ctb_user',
        displayName: 'ctb_user',
      }),
    ]);
  });

  it('every returned concept validates against the frozen concept schema (renderer-consumable)', async () => {
    const page = await exportProject(db, scopeProject, { limit: 100 });
    expect(page).not.toBeNull();

    const { concept: conceptSchema } = await import('@teamem/schema');
    for (const c of page!.concepts) {
      const parsed = conceptSchema.safeParse(c);
      expect(parsed.success, `concept ${c.uuid} must be a valid frozen page`).toBe(true);
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Renderer-consumability counterexamples — never fake Concepts
  // ═══════════════════════════════════════════════════════════════════════

  it('reports a concept with no current path in skipped instead of a fake path=""', async () => {
    // Simulate the raw-SQL counterexample: delete the path row entirely.
    const created = await createConcept(db, conceptInput(teamId, projectId,
      `services/broken-path-${randomUUID().replace(/-/g, '').slice(0, 6)}`));
    await db.execute(`DELETE FROM concept_paths WHERE concept_uuid = '${created.uuid}'`);

    try {
      const page = await exportProject(db, scopeProject, { limit: 100 });
      expect(page).not.toBeNull();
      expect(page!.concepts.find((c) => c.uuid === created.uuid)).toBeUndefined();
      const skipped = page!.skipped.find((s) => s.uuid === created.uuid);
      expect(skipped).toBeDefined();
      expect(skipped!.reason).toContain('path');
    } finally {
      await db.execute(`DELETE FROM concept_evidence WHERE concept_uuid = '${created.uuid}'`);
      await db.execute(`DELETE FROM concepts WHERE uuid = '${created.uuid}'`);
    }
  });

  it('reports a concept with schema-invalid evidence in skipped (repo_file without commitSha)', async () => {
    // Raw insert bypasses write-repo validation to model the counterexample:
    // a repo_file evidence row with a NULL immutable anchor.
    const uuid = randomUUID();
    const path = `services/bad-evidence-${randomUUID().replace(/-/g, '').slice(0, 6)}`;
    await db.execute(
      `INSERT INTO concepts (uuid, team_id, project_id, schema_version, type, status, confidence, title, body, tags, first_seen, last_confirmed)
       VALUES ('${uuid}', '${teamId}', '${projectId}', 1, 'gotcha', 'active', 'low', 'Bad Evidence', 'body', '{}', '2025-06-01', '2025-06-02')`,
    );
    await db.execute(
      `INSERT INTO concept_paths (team_id, project_id, concept_uuid, path, is_current)
       VALUES ('${teamId}', '${projectId}', '${uuid}', '${path}', true)`,
    );
    await db.execute(
      `INSERT INTO concept_evidence (team_id, project_id, concept_uuid, kind, ref, repo, commit_sha, path, at)
       VALUES ('${teamId}', '${projectId}', '${uuid}', 'repo_file', NULL, 'org/repo', NULL, 'src/x.ts', '2025-06-01')`,
    );

    try {
      const page = await exportProject(db, scopeProject, { limit: 100 });
      expect(page).not.toBeNull();
      expect(page!.concepts.find((c) => c.uuid === uuid)).toBeUndefined();
      const skipped = page!.skipped.find((s) => s.uuid === uuid);
      expect(skipped).toBeDefined();
      expect(skipped!.reason).toContain('evidence');
    } finally {
      await db.execute(`DELETE FROM concept_evidence WHERE concept_uuid = '${uuid}'`);
      await db.execute(`DELETE FROM concept_paths    WHERE concept_uuid = '${uuid}'`);
      await db.execute(`DELETE FROM concepts         WHERE uuid = '${uuid}'`);
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Pagination — bounded pages over a large project
  // ═══════════════════════════════════════════════════════════════════════

  it('pages over more concepts than any limit, with full coverage and no duplicates', async () => {
    // Isolate in a dedicated project so counts and ordering are deterministic.
    const pSuffix = randomUUID().replace(/-/g, '').slice(0, 8);
    const paginationProjectId = `prj_page${pSuffix}`;
    await db.execute(
      `INSERT INTO projects (id, team_id, name) VALUES ('${paginationProjectId}', '${teamId}', 'Pagination Project')`,
    );

    const LIMIT = 25;
    const TOTAL = 63; // 2 full pages + 13 on the last page
    const seededUuids: string[] = [];
    try {
      for (let i = 0; i < TOTAL; i++) {
        const created = await createConcept(db, conceptInput(teamId, paginationProjectId,
          `pagination/c-${i}-${randomUUID().replace(/-/g, '').slice(0, 6)}`, {
            title: `Page Concept ${i}`,
          }));
        seededUuids.push(created.uuid);
      }

      // Deterministic order key: distinct created_at so (created_at, uuid)
      // ordering is fully pinned.
      for (let i = 0; i < seededUuids.length; i++) {
        const day = String(Math.floor(i / 24) + 1).padStart(2, '0');
        const hour = String(i % 24).padStart(2, '0');
        await db.execute(
          `UPDATE concepts SET created_at = '2026-03-${day} ${hour}:00:00+00' WHERE uuid = '${seededUuids[i]}'`,
        );
      }
      const expectedRows = await db
        .select({ uuid: schema.concepts.uuid })
        .from(schema.concepts)
        .where(eq(schema.concepts.projectId, paginationProjectId))
        .orderBy(asc(schema.concepts.createdAt), asc(schema.concepts.uuid));
      const expectedOrder = expectedRows.map((r) => r.uuid);

      const scope = projectScope(teamId, paginationProjectId);

      // Page 1
      const p1 = await exportProject(db, scope, { limit: LIMIT });
      expect(p1).not.toBeNull();
      expect(p1!.totalConcepts).toBe(TOTAL);
      expect(p1!.concepts).toHaveLength(LIMIT);
      expect(p1!.nextCursor).not.toBeNull();

      // Page 2
      const p2 = await exportProject(db, scope, { limit: LIMIT, cursor: p1!.nextCursor! });
      expect(p2!.concepts).toHaveLength(LIMIT);
      expect(p2!.nextCursor).not.toBeNull();

      // Page 3 — last page
      const p3 = await exportProject(db, scope, { limit: LIMIT, cursor: p2!.nextCursor! });
      expect(p3!.concepts).toHaveLength(TOTAL - 2 * LIMIT);
      expect(p3!.nextCursor).toBeNull();

      // Full coverage, no duplicates, exact deterministic order.
      const allUuids = [
        ...p1!.concepts.map((c) => c.uuid),
        ...p2!.concepts.map((c) => c.uuid),
        ...p3!.concepts.map((c) => c.uuid),
      ];
      expect(new Set(allUuids).size).toBe(TOTAL);
      expect(allUuids).toEqual(expectedOrder);
    } finally {
      await db.execute(`DELETE FROM concept_contributors WHERE project_id = '${paginationProjectId}'`);
      await db.execute(`DELETE FROM concept_evidence      WHERE project_id = '${paginationProjectId}'`);
      await db.execute(`DELETE FROM concept_paths         WHERE project_id = '${paginationProjectId}'`);
      await db.execute(`DELETE FROM concepts              WHERE project_id = '${paginationProjectId}'`);
      await db.execute(`DELETE FROM projects              WHERE id = '${paginationProjectId}'`);
    }
  });

  it('bounds the contributors query to the current page — never a project-wide contributor read', async () => {
    // Regression pin (round-2 finding): fetchContributors used to filter only
    // by team+project, so a page-sized concept read still loaded EVERY
    // contributor row of the project. Output assertions cannot catch that
    // (off-page rows are discarded at grouping time), so this test counts
    // the rows returned by the actual concept_contributors SELECT.
    const pSuffix = randomUUID().replace(/-/g, '').slice(0, 8);
    const contributorProjectId = `prj_contrib${pSuffix}`;
    const PAGE = 10;
    const CONCEPTS = 40;
    const CONTRIBUTORS_PER_CONCEPT = 2;
    const totalContributorRows = CONCEPTS * CONTRIBUTORS_PER_CONCEPT;

    const principalIds = [
      `pri_cb1${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      `pri_cb2${randomUUID().replace(/-/g, '').slice(0, 16)}`,
    ];

    // Instrumented pool: accumulate rows returned by concept_contributors SELECTs.
    const countingPool = new Pool({ connectionString: url! });
    let contributorsRowsFetched = 0;
    const origQuery = countingPool.query.bind(countingPool);
    countingPool.query = ((input: string | { text?: string }, values?: unknown[]) => {
      const text = typeof input === 'string' ? input : (input.text ?? '');
      const result =
        typeof input === 'string'
          ? origQuery(input, values)
          : origQuery(input as never, values);
      if (/^\s*select/i.test(text) && /concept_contributors/i.test(text)) {
        return Promise.resolve(result).then((r: { rows?: unknown[] }) => {
          contributorsRowsFetched += Array.isArray(r?.rows) ? r.rows.length : 0;
          return r;
        });
      }
      return result;
    }) as unknown as typeof countingPool.query;

    try {
      const countedDb = createDb(url!, { pool: countingPool });
      await countedDb.execute(
        `INSERT INTO projects (id, team_id, name) VALUES ('${contributorProjectId}', '${teamId}', 'Contributor Boundedness')`,
      );
      for (const pid of principalIds) {
        await countedDb.execute(
          `INSERT INTO principals (id, team_id, kind, provider, provider_kind, provider_user_id, display_login)
           VALUES ('${pid}', '${teamId}', 'human', 'github', 'github', 'cbuser${randomUUID().replace(/-/g, '').slice(0, 8)}', 'cb_user')`,
        );
      }
      for (let i = 0; i < CONCEPTS; i++) {
        await createConcept(countedDb, conceptInput(teamId, contributorProjectId,
          `contrib-bound/c-${i}-${randomUUID().replace(/-/g, '').slice(0, 6)}`,
          {
            contributors: principalIds.map((principalId) => ({
              principalId,
              provenance: 'credential_bound' as const,
            })),
          },
        ));
      }

      contributorsRowsFetched = 0;
      const page = await exportProject(
        countedDb,
        projectScope(teamId, contributorProjectId),
        { limit: PAGE },
      );

      expect(page).not.toBeNull();
      expect(page!.concepts).toHaveLength(PAGE);
      const refsOnPage = page!.concepts.reduce((n, c) => n + c.contributors.length, 0);
      expect(refsOnPage).toBe(PAGE * CONTRIBUTORS_PER_CONCEPT);
      // The decisive assertion: the contributors query returned rows only for
      // the page's concepts — bounded, far below the project total.
      expect(contributorsRowsFetched).toBeLessThanOrEqual(PAGE * CONTRIBUTORS_PER_CONCEPT);
      expect(contributorsRowsFetched).toBeLessThan(totalContributorRows);
    } finally {
      await db.execute(`DELETE FROM concept_contributors WHERE project_id = '${contributorProjectId}'`);
      await db.execute(`DELETE FROM concept_evidence      WHERE project_id = '${contributorProjectId}'`);
      await db.execute(`DELETE FROM concept_paths         WHERE project_id = '${contributorProjectId}'`);
      await db.execute(`DELETE FROM concepts              WHERE project_id = '${contributorProjectId}'`);
      await db.execute(`DELETE FROM api_keys              WHERE project_id = '${contributorProjectId}'`);
      await db.execute(`DELETE FROM projects              WHERE id = '${contributorProjectId}'`);
      await db.execute(`DELETE FROM principals            WHERE id = ANY(ARRAY['${principalIds.join("','")}'])`);
      await countingPool.end();
    }
  });

  it('returns a single page with nextCursor=null when concepts do not exceed the limit', async () => {
    const page = await exportProject(db, scopeProject, { limit: 100 });
    expect(page).not.toBeNull();
    expect(page!.concepts).toHaveLength(2);
    expect(page!.nextCursor).toBeNull();
  });

  it('returns an honest empty page for a project with no concepts', async () => {
    const page = await exportProject(db, projectScope(teamId, otherProjectIdSameTeam));
    expect(page).not.toBeNull();
    expect(page!.project.id).toBe(otherProjectIdSameTeam);
    expect(page!.totalConcepts).toBe(0);
    expect(page!.concepts).toEqual([]);
    expect(page!.skipped).toEqual([]);
    expect(page!.nextCursor).toBeNull();
  });

  it('rejects a tampered cursor (ExportCursorInvalidError)', async () => {
    const p1 = await exportProject(db, scopeProject, { limit: 1 });
    expect(p1!.nextCursor).not.toBeNull();
    const tampered = p1!.nextCursor!.slice(0, -4) + 'AAAA';
    await expect(exportProject(db, scopeProject, { cursor: tampered }))
      .rejects.toBeInstanceOf(ExportCursorInvalidError);
    await expect(exportProject(db, scopeProject, { cursor: 'not-base64!!!' }))
      .rejects.toBeInstanceOf(ExportCursorInvalidError);
  });

  it('rejects a cursor issued for a different project (ExportCursorInvalidError)', async () => {
    const p1 = await exportProject(db, scopeProject, { limit: 1 });
    expect(p1!.nextCursor).not.toBeNull();
    // Same team, different project — the embedded projectId must not match.
    await expect(
      exportProject(db, projectScope(teamId, otherProjectIdSameTeam), {
        cursor: p1!.nextCursor!,
      }),
    ).rejects.toBeInstanceOf(ExportCursorInvalidError);
  });

  /** Build a structurally parseable cursor for `projectId`. */
  function forgeCursor(projectId: string, position: { createdAt: string; uuid: string }): string {
    return Buffer.from(
      JSON.stringify({ resource: 'export-project', v: 1, projectId, position }),
      'utf8',
    ).toString('base64url');
  }

  it('rejects a parseable-but-forged cursor with a non-UUID boundary id — never a DB error (ExportCursorInvalidError)', async () => {
    const forged = forgeCursor(projectId, {
      createdAt: '2026-01-01T00:00:00.000Z',
      uuid: 'not-a-uuid',
    });
    // The UUID-format gate rejects before any SQL is issued: this must be
    // ExportCursorInvalidError, never a Postgres 22P02 leaking as a Drizzle error.
    await expect(exportProject(db, scopeProject, { cursor: forged }))
      .rejects.toBeInstanceOf(ExportCursorInvalidError);
  });

  it('rejects a parseable-but-forged cursor whose boundary concept does not exist (integrity probe)', async () => {
    // Real-format UUID that exists nowhere in the project: the scoped
    // boundary probe rejects it instead of silently accepting an empty page.
    const forged = forgeCursor(projectId, {
      createdAt: '2026-01-01T00:00:00.000Z',
      uuid: randomUUID(),
    });
    await expect(exportProject(db, scopeProject, { cursor: forged }))
      .rejects.toBeInstanceOf(ExportCursorInvalidError);
  });

  it('rejects a forged cursor naming a concept that exists only in another team (scoped probe)', async () => {
    const { rows } = await db.execute(
      `SELECT uuid FROM concepts WHERE team_id = '${otherTeamId}' LIMIT 1`,
    );
    const foreignUuid = (rows[0] as Record<string, unknown>)['uuid'] as string;
    const forged = forgeCursor(projectId, {
      createdAt: '2026-01-01T00:00:00.000Z',
      uuid: foreignUuid,
    });
    await expect(exportProject(db, scopeProject, { cursor: forged }))
      .rejects.toBeInstanceOf(ExportCursorInvalidError);
  });

  it('accepts a re-encoded genuine cursor (same real boundary) — only forged positions are rejected', async () => {
    const p1 = await exportProject(db, scopeProject, { limit: 1 });
    expect(p1!.nextCursor).not.toBeNull();
    const decoded = JSON.parse(
      Buffer.from(p1!.nextCursor!, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    const reencoded = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url');

    const p2 = await exportProject(db, scopeProject, { limit: 1, cursor: reencoded });
    expect(p2).not.toBeNull();
    expect(p2!.concepts).toHaveLength(1);
  });

  it('rejects a forged cursor reusing a REAL boundary uuid with a different timestamp (full-pair probe)', async () => {
    // Round-3 finding: the probe used to validate only the uuid, so a real
    // boundary uuid carrying a forged (future) timestamp was silently
    // accepted and returned an empty page even when the project had rows.
    const p1 = await exportProject(db, scopeProject, { limit: 1 });
    expect(p1!.nextCursor).not.toBeNull();
    const decoded = JSON.parse(
      Buffer.from(p1!.nextCursor!, 'base64url').toString('utf8'),
    ) as { position: { uuid: string } };
    const realUuid = decoded.position.uuid;

    await expect(
      exportProject(db, scopeProject, {
        cursor: forgeCursor(projectId, {
          createdAt: '2099-01-01T00:00:00.000Z',
          uuid: realUuid,
        }),
      }),
    ).rejects.toBeInstanceOf(ExportCursorInvalidError);

    // Symmetric: a past timestamp on the same real uuid never existed either.
    await expect(
      exportProject(db, scopeProject, {
        cursor: forgeCursor(projectId, {
          createdAt: '2020-01-01T00:00:00.000Z',
          uuid: realUuid,
        }),
      }),
    ).rejects.toBeInstanceOf(ExportCursorInvalidError);
  });

  it('pages without missing or duplicating rows across the whole project, including created_at ties', async () => {
    // The boundary anchor uses the row's EXACT stored created_at (column is
    // timestamp(3), ms precision) so the page predicate's `equal + uuid >`
    // tie-break partitions shared-timestamp rows exactly once each — never
    // missed, never duplicated, never an empty page while rows remain.
    const pSuffix = randomUUID().replace(/-/g, '').slice(0, 8);
    const preciseProjectId = `prj_precise${pSuffix}`;
    await db.execute(
      `INSERT INTO projects (id, team_id, name) VALUES ('${preciseProjectId}', '${teamId}', 'Boundary Anchor')`,
    );

    const uuids: string[] = [];
    try {
      for (let i = 0; i < 5; i++) {
        const created = await createConcept(db, conceptInput(teamId, preciseProjectId,
          `precise/c-${i}-${randomUUID().replace(/-/g, '').slice(0, 6)}`,
          { title: `Precise ${i}` }));
        uuids.push(created.uuid);
      }
      // Deliberate created_at TIES (same millisecond) so the uuid tie-break
      // clause of the cursor predicate is exercised on every page boundary.
      const stamps = [
        '2026-04-01 03:04:00.100+00',
        '2026-04-01 03:05:00.200+00',
        '2026-04-01 03:05:00.200+00',
        '2026-04-01 03:06:00.300+00',
        '2026-04-01 03:06:00.300+00',
      ];
      for (let i = 0; i < uuids.length; i++) {
        await db.execute(
          `UPDATE concepts SET created_at = '${stamps[i]}' WHERE uuid = '${uuids[i]}'`,
        );
      }

      const expectedRows = await db
        .select({ uuid: schema.concepts.uuid })
        .from(schema.concepts)
        .where(eq(schema.concepts.projectId, preciseProjectId))
        .orderBy(asc(schema.concepts.createdAt), asc(schema.concepts.uuid));
      const expected = expectedRows.map((r) => r.uuid);

      const scope = projectScope(teamId, preciseProjectId);
      const pages: string[][] = [];
      let cursor: string | undefined;
      do {
        const page = await exportProject(db, scope, { limit: 2, cursor });
        expect(page).not.toBeNull();
        expect(page!.totalConcepts).toBe(5);
        pages.push(page!.concepts.map((c) => c.uuid));
        cursor = page!.nextCursor ?? undefined;
      } while (cursor !== undefined);

      const all = pages.flat();
      expect(new Set(all).size).toBe(all.length); // no duplicates (incl. ties)
      expect(all).toHaveLength(5); // nothing missed
      expect(all).toEqual(expected); // exact (created_at, uuid) order
      expect(pages.map((p) => p.length)).toEqual([2, 2, 1]);
    } finally {
      await db.execute(`DELETE FROM concept_contributors WHERE project_id = '${preciseProjectId}'`);
      await db.execute(`DELETE FROM concept_evidence      WHERE project_id = '${preciseProjectId}'`);
      await db.execute(`DELETE FROM concept_paths         WHERE project_id = '${preciseProjectId}'`);
      await db.execute(`DELETE FROM concepts              WHERE project_id = '${preciseProjectId}'`);
      await db.execute(`DELETE FROM projects              WHERE id = '${preciseProjectId}'`);
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Limits — bounded reads, contract rejected never clamped
  // ═══════════════════════════════════════════════════════════════════════

  it('exposes the documented page-size defaults and cap', async () => {
    expect(EXPORT_PAGE_DEFAULT_LIMIT).toBe(500);
    expect(EXPORT_PAGE_MAX_LIMIT).toBe(1000);
  });

  it('rejects limit above the hard cap, below 1, and non-integers', async () => {
    await expect(exportProject(db, scopeProject, { limit: EXPORT_PAGE_MAX_LIMIT + 1 }))
      .rejects.toBeInstanceOf(ExportLimitInvalidError);
    await expect(exportProject(db, scopeProject, { limit: 0 }))
      .rejects.toBeInstanceOf(ExportLimitInvalidError);
    await expect(exportProject(db, scopeProject, { limit: -5 }))
      .rejects.toBeInstanceOf(ExportLimitInvalidError);
    await expect(exportProject(db, scopeProject, { limit: 1.5 }))
      .rejects.toBeInstanceOf(ExportLimitInvalidError);
  });

  it('accepts limit exactly at the cap and returns a page', async () => {
    // Project has only 2 concepts — a 1000-page fetch is one bounded query.
    const page = await exportProject(db, scopeProject, { limit: EXPORT_PAGE_MAX_LIMIT });
    expect(page).not.toBeNull();
    expect(page!.concepts).toHaveLength(2);
    expect(page!.nextCursor).toBeNull();
  });
});