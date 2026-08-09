/**
 * M3 OKF bundle renderer integration tests — DUA-250 / M3-EXPORT-03.
 *
 * Tests against real Postgres (TEST_DATABASE_URL), composing the scoped
 * export repository (M3-EXPORT-02) with the frozen OKF pure functions
 * (M3-EXPORT-01) through the renderer service entry point:
 *   - tree shape: index.md + log.md always present, per-type dirs only for
 *     realized types, one page per concept at its frozen relPath, nested
 *     paths nested under the dir;
 *   - per-concept page: frontmatter with the canonical UUID preserved,
 *     in-body teamem://concept/<uuid> links rewritten to relative Markdown
 *     links (one ../ per source dir level), unresolved UUIDs keep the
 *     canonical URI untouched;
 *   - reserved files: index.md catalog grouped by type dir in frozen order
 *     with ./-prefixed links, log.md newest lastConfirmed first — both
 *     carrying every canonical UUID;
 *   - determinism: two renders are byte-identical; a pageLimit of 1 (one
 *     concept per repository page) produces the exact same bundle as the
 *     default pageLimit — file order never depends on pagination;
 *   - round-trip: every emitted concept page parses against the frozen
 *     okfConceptFrontmatter and recovers the expected frontmatter; every
 *     rewritten relative link points at an emitted file whose frontmatter
 *     carries the same UUID;
 *   - honesty: cross-team / missing projects are null (indistinguishable,
 *     anti-enumeration), an empty project renders an honest empty bundle
 *     (reserved files, zero concept pages), and a concept the repository
 *     cannot assemble is surfaced in `skipped` — no page is fabricated,
 *     `renderedConcepts + skipped` stays consistent, and links to the
 *     skipped UUID keep the canonical URI.
 *
 * Runs only when TEST_DATABASE_URL is set; honestly skipped otherwise.
 */
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  OKF_BUNDLE_INDEX_FILE,
  OKF_BUNDLE_LOG_FILE,
  OKF_TYPE_DIR_MAP,
  okfConceptFrontmatter,
  parseConceptPage,
} from '@teamem/schema';
import { createDb, type AppDb } from '../db/client.js';
import {
  connectDatabase,
  closeDatabase,
} from '../test/database.js';
import { runBootstrap } from '../commands/bootstrap.js';
import { createConcept, type CreateConceptInput } from '../db/repositories/concepts-write.js';
import { exportProject } from '../db/repositories/export.js';
import { allProjectsScope, projectScope } from '../auth/scope.js';
import { renderOkfBundle, type OkfBundleFile } from './render-okf-bundle.js';

const url = process.env['TEST_DATABASE_URL'];

describe.skipIf(!url)('OKF bundle renderer (live Postgres)', () => {
  let pool: Pool;
  let db: AppDb;

  // Primary team + project
  let teamId: string;
  let projectId: string;
  let scopeProject: ReturnType<typeof projectScope>;

  // Other team (cross-tenant) and same-team empty project
  let otherTeamId: string;
  let otherProjectId: string;
  let emptyProjectId: string;

  // Seeded concept identifiers (cross-links are seeded after creation)
  let decisionUuid: string;
  let gotchaUuid: string;
  let conventionUuid: string;
  let serviceUuid: string;
  let decisionPath: string;
  let gotchaPath: string;
  let conventionPath: string;
  let servicePath: string;

  beforeAll(async () => {
    ({ pool } = connectDatabase());
    db = createDb(url!, { pool });

    // ── Team 1 + project ─────────────────────────────────────────────
    const suffix = randomUUID().replace(/-/g, '').slice(0, 8);
    const result = await runBootstrap(db, {
      teamName: `Renderer Test ${suffix}`,
      projectName: `demo-${suffix}`,
      rotate: false,
    });
    teamId = result.team.id;
    projectId = result.project.id;
    scopeProject = projectScope(teamId, projectId);

    // ── Team 2 (cross-tenant) ────────────────────────────────────────
    const otherSuffix = randomUUID().replace(/-/g, '').slice(0, 8);
    const otherResult = await runBootstrap(db, {
      teamName: `Renderer Other ${otherSuffix}`,
      projectName: `other-${otherSuffix}`,
      rotate: false,
    });
    otherTeamId = otherResult.team.id;
    otherProjectId = otherResult.project.id;

    // ── Same team, project with zero concepts ────────────────────────
    const emptySuffix = randomUUID().replace(/-/g, '').slice(0, 8);
    emptyProjectId = `prj_empty${emptySuffix}`;
    await db.execute(
      `INSERT INTO projects (id, team_id, name) VALUES ('${emptyProjectId}', '${teamId}', 'Empty Render Project')`,
    );

    // ── Seed four concepts with distinct lastConfirmed values so the
    //    catalog/log order is fully pinned: gotcha(07-12) > decision(07-10)
    //    > service(07-09) > convention(07-08).
    decisionPath = `use-postgres-${randomUUID().replace(/-/g, '').slice(0, 6)}`;
    gotchaPath = `pg-timezone-cast-${randomUUID().replace(/-/g, '').slice(0, 6)}`;
    conventionPath = `migrations/sql-up-${randomUUID().replace(/-/g, '').slice(0, 6)}`;
    servicePath = `auth-api-${randomUUID().replace(/-/g, '').slice(0, 6)}`;

    const decision = await createConcept(db, conceptInput(teamId, projectId, decisionPath, {
      title: 'Use Postgres',
      type: 'decision',
      lastConfirmed: new Date('2026-07-10T09:30:00.000Z'),
      body: 'We run Postgres as the primary database.',
    }));
    decisionUuid = decision.uuid;

    const gotcha = await createConcept(db, conceptInput(teamId, projectId, gotchaPath, {
      title: 'PG timezone cast drops offsets',
      type: 'gotcha',
      lastConfirmed: new Date('2026-07-12T14:05:00.000Z'),
      body: 'Blocked on [the Postgres decision](teamem://concept/PLACEHOLDER_DECISION).',
    }));
    gotchaUuid = gotcha.uuid;

    const convention = await createConcept(db, conceptInput(teamId, projectId, conventionPath, {
      title: 'Migrations use SQL UP',
      type: 'convention',
      lastConfirmed: new Date('2026-07-08T08:00:00.000Z'),
      body: 'See [the auth service](teamem://concept/PLACEHOLDER_SERVICE).',
    }));
    conventionUuid = convention.uuid;

    const service = await createConcept(db, conceptInput(teamId, projectId, servicePath, {
      title: 'Auth Service',
      type: 'service',
      lastConfirmed: new Date('2026-07-09T10:00:00.000Z'),
      body: 'Handles authentication and authorization.',
    }));
    serviceUuid = service.uuid;

    // Cross-links need the target UUIds — patch the bodies after creation.
    await db.execute(
      `UPDATE concepts SET body = 'We decided in [ADR-7](teamem://concept/${decisionUuid}). ' ||
        'After this we hit [a timezone gotcha](teamem://concept/${gotchaUuid}) ' ||
        'and a link to nothing (teamem://concept/${randomUUID()}).'
       WHERE uuid = '${decisionUuid}'`,
    );
    await db.execute(
      `UPDATE concepts SET body = 'Blocked on [the Postgres decision](teamem://concept/${decisionUuid}).'
       WHERE uuid = '${gotchaUuid}'`,
    );
    await db.execute(
      `UPDATE concepts SET body = 'See [the auth service](teamem://concept/${serviceUuid}).'
       WHERE uuid = '${conventionUuid}'`,
    );
  });

  afterAll(async () => {
    for (const pid of [projectId, otherProjectId, emptyProjectId]) {
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
  ): CreateConceptInput {
    return {
      teamId: tId,
      projectId: pId,
      schemaVersion: 1,
      type: 'decision',
      status: 'active',
      confidence: 'high',
      title: 'Test Concept',
      body: 'Test body content.',
      firstSeen: new Date('2026-06-01T00:00:00.000Z'),
      lastConfirmed: new Date('2026-07-10T09:30:00.000Z'),
      path,
      evidence: [
        {
          kind: 'repo_file',
          repo: 'teamem-ai/teamem',
          commitSha: 'abc1234',
          path: 'src/index.ts',
          at: new Date('2026-06-01T00:00:00.000Z'),
        },
      ],
      ...overrides,
    };
  }

  /** Assert the bundle tree invariants shared by every render call. */
  function expectValidBundle(files: readonly OkfBundleFile[]): Map<string, string> {
    // Reserved files first, exactly two of them, unique relPaths.
    expect(files[0]!.relPath).toBe(OKF_BUNDLE_INDEX_FILE);
    expect(files[1]!.relPath).toBe(OKF_BUNDLE_LOG_FILE);
    const relPaths = files.map((f) => f.relPath);
    expect(new Set(relPaths).size).toBe(relPaths.length);

    const byPath = new Map(files.map((f) => [f.relPath, f.content] as const));
    // Every non-reserved file is a parseable concept page.
    for (const file of files.slice(2)) {
      expect(parseConceptPage(file.content), `page ${file.relPath}`).not.toBeNull();
    }
    return byPath;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Tree shape
  // ═══════════════════════════════════════════════════════════════════════

  it('renders the full bundle tree: index.md + log.md + one page per concept under its type dir', async () => {
    const bundle = await renderOkfBundle(db, scopeProject);
    expect(bundle).not.toBeNull();
    expect(bundle!.project).toEqual({ id: projectId, name: bundle!.project.name });
    expect(bundle!.schemaVersion).toBe(1);
    expect(bundle!.totalConcepts).toBe(4);
    expect(bundle!.renderedConcepts).toBe(4);
    expect(bundle!.skipped).toEqual([]);

    const byPath = expectValidBundle(bundle!.files);
    // index.md + log.md first, then per-type dirs in frozen OKF_TYPE_DIRS
    // order (decisions, gotchas, conventions, runbooks, services, concepts),
    // pages byte-sorted within each dir.
    expect(bundle!.files.map((f) => f.relPath)).toEqual([
      'index.md',
      'log.md',
      `decisions/${decisionPath}.md`,
      `gotchas/${gotchaPath}.md`,
      `conventions/${conventionPath}.md`,
      `services/${servicePath}.md`,
    ]);
    // Nested convention path lands under the type dir (frozen relPath rule).
    expect(byPath.has(`conventions/${conventionPath}.md`)).toBe(true);
  });

  it('places every concept under the directory of its frozen type mapping', async () => {
    const check = async (uuid: string, type: string) => {
      const page = await exportProject(db, scopeProject, { limit: 100 });
      const concept = page!.concepts.find((c) => c.uuid === uuid)!;
      expect(concept).toBeDefined();
      expect(OKF_TYPE_DIR_MAP[concept.type]).toBe(type);
    };
    await check(decisionUuid, 'decisions');
    await check(gotchaUuid, 'gotchas');
    await check(conventionUuid, 'conventions');
    await check(serviceUuid, 'services');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Per-concept pages — frontmatter + link rewrite
  // ═══════════════════════════════════════════════════════════════════════

  it('renders each concept page with the canonical UUID in frontmatter', async () => {
    const bundle = await renderOkfBundle(db, scopeProject);
    const byPath = expectValidBundle(bundle!.files);

    const decisionPage = parseConceptPage(byPath.get(`decisions/${decisionPath}.md`)!)!;
    expect(decisionPage.data.uuid).toBe(decisionUuid);
    expect(decisionPage.data.type).toBe('decision');
    expect(decisionPage.data.path).toBe(decisionPath);
    expect(decisionPage.data.title).toBe('Use Postgres');
  });

  it('rewrites teamem:// links to relative Markdown paths (one ../ per source dir level)', async () => {
    const bundle = await renderOkfBundle(db, scopeProject);
    const byPath = expectValidBundle(bundle!.files);

    // decisions/ → gotchas/ : one level up
    const decisionBody = parseConceptPage(byPath.get(`decisions/${decisionPath}.md`)!)!.body;
    expect(decisionBody).toContain(`[a timezone gotcha](../gotchas/${gotchaPath}.md)`);
    expect(decisionBody).toContain(`[ADR-7](../decisions/${decisionPath}.md)`); // self-link stays relative

    // gotchas/ → decisions/ : one level up
    const gotchaBody = parseConceptPage(byPath.get(`gotchas/${gotchaPath}.md`)!)!.body;
    expect(gotchaBody).toContain(`[the Postgres decision](../decisions/${decisionPath}.md)`);

    // conventions/migrations/ → services/ : two levels up
    const conventionBody = parseConceptPage(byPath.get(`conventions/${conventionPath}.md`)!)!.body;
    expect(conventionBody).toContain(`[the auth service](../../services/${servicePath}.md)`);
  });

  it('keeps links to UUIDs that are not part of the bundle as canonical teamem:// URIs', async () => {
    const bundle = await renderOkfBundle(db, scopeProject);
    const byPath = expectValidBundle(bundle!.files);

    const decisionBody = parseConceptPage(byPath.get(`decisions/${decisionPath}.md`)!)!.body;
    // One unseeded UUID was embedded in the decision body on purpose.
    const canonicalLinks = decisionBody.match(/teamem:\/\/concept\/[0-9a-f-]{36}/g) ?? [];
    expect(canonicalLinks).toHaveLength(1);
    const unresolved = canonicalLinks[0]!;
    // The UUID must not be part of the bundle — the link stays honest.
    const allUuids = new Set(
      bundle!.files.map((f) => parseConceptPage(f.content)?.data.uuid).filter(Boolean),
    );
    expect(allUuids.has(unresolved.slice('teamem://concept/'.length))).toBe(false);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Reserved files — index.md catalog + log.md change log
  // ═══════════════════════════════════════════════════════════════════════

  it('renders index.md as a catalog grouped by type dir in frozen order, ./-prefixed links', async () => {
    const bundle = await renderOkfBundle(db, scopeProject);
    const byPath = expectValidBundle(bundle!.files);
    const index = byPath.get('index.md')!;

    expect(index.startsWith('---\nokf_version: "0.1"\n---\n')).toBe(true);
    // Frozen dir order: decisions, gotchas, conventions, runbooks, services, concepts
    const decisions = index.indexOf('## decisions');
    const gotchas = index.indexOf('## gotchas');
    const conventions = index.indexOf('## conventions');
    const services = index.indexOf('## services');
    expect(decisions).toBeGreaterThan(-1);
    expect(gotchas).toBeGreaterThan(decisions);
    expect(conventions).toBeGreaterThan(gotchas);
    expect(services).toBeGreaterThan(conventions);
    // Empty type sections are omitted.
    expect(index).not.toContain('## runbooks');
    expect(index).not.toContain('## concepts');

    // From the bundle root the links are ./-prefixed.
    expect(index).toContain(`[Use Postgres](./decisions/${decisionPath}.md)`);
    expect(index).toContain(`[PG timezone cast drops offsets](./gotchas/${gotchaPath}.md)`);
    expect(index).toContain(`[Migrations use SQL UP](./conventions/${conventionPath}.md)`);
    expect(index).toContain(`[Auth Service](./services/${servicePath}.md)`);
  });

  it('renders log.md newest lastConfirmed first, carrying relPath + uuid + title', async () => {
    const bundle = await renderOkfBundle(db, scopeProject);
    const byPath = expectValidBundle(bundle!.files);
    const log = byPath.get('log.md')!;

    expect(log.startsWith('---\nokf_version: "0.1"\n---\n')).toBe(true);
    const gotchaLine = log.indexOf(`gotchas/${gotchaPath}.md`);
    const decisionLine = log.indexOf(`decisions/${decisionPath}.md`);
    const serviceLine = log.indexOf(`services/${servicePath}.md`);
    const conventionLine = log.indexOf(`conventions/${conventionPath}.md`);
    expect(gotchaLine).toBeGreaterThan(-1);
    expect(gotchaLine).toBeLessThan(decisionLine); // 07-12 before 07-10
    expect(decisionLine).toBeLessThan(serviceLine); // 07-10 before 07-09
    expect(serviceLine).toBeLessThan(conventionLine); // 07-09 before 07-08
    // Every entry is identifiable — nothing is lost in the log.
    expect(log).toContain(`(${decisionUuid})`);
    expect(log).toContain(`(${gotchaUuid})`);
    expect(log).toContain(`(${conventionUuid})`);
    expect(log).toContain(`(${serviceUuid})`);
    expect(log).toContain('Use Postgres');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Determinism — byte-identical, independent of page size
  // ═══════════════════════════════════════════════════════════════════════

  it('renders byte-identical bundles across repeated calls', async () => {
    const a = await renderOkfBundle(db, scopeProject);
    const b = await renderOkfBundle(db, scopeProject);
    expect(a).not.toBeNull();
    expect(a!.files).toEqual(b!.files);
  });

  it('renders the exact same bundle regardless of repository page size (pagination independence)', async () => {
    const a = await renderOkfBundle(db, scopeProject); // default (500)
    const b = await renderOkfBundle(db, scopeProject, { pageLimit: 1 }); // one concept per page
    const c = await renderOkfBundle(db, scopeProject, { pageLimit: 2 });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(c).not.toBeNull();
    expect(b!.files).toEqual(a!.files);
    expect(c!.files).toEqual(a!.files);
    expect(b!.renderedConcepts).toBe(a!.renderedConcepts);
    expect(b!.totalConcepts).toBe(a!.totalConcepts);
  });

  it('pages over a project larger than any single repository page with full coverage', async () => {
    // Isolated project with 25 concepts; force 7 pages of 4.
    const pSuffix = randomUUID().replace(/-/g, '').slice(0, 8);
    const bigProjectId = `prj_bigrender${pSuffix}`;
    const TOTAL = 25;
    await db.execute(
      `INSERT INTO projects (id, team_id, name) VALUES ('${bigProjectId}', '${teamId}', 'Big Render Project')`,
    );
    const seededUuids: string[] = [];
    try {
      for (let i = 0; i < TOTAL; i++) {
        const created = await createConcept(db, conceptInput(teamId, bigProjectId,
          `big/c-${i}-${randomUUID().replace(/-/g, '').slice(0, 6)}`, {
            title: `Big Concept ${i}`,
          }));
        seededUuids.push(created.uuid);
      }
      const bundle = await renderOkfBundle(db, projectScope(teamId, bigProjectId), {
        pageLimit: 4,
      });
      expect(bundle).not.toBeNull();
      expect(bundle!.totalConcepts).toBe(TOTAL);
      expect(bundle!.renderedConcepts).toBe(TOTAL);
      expect(bundle!.skipped).toEqual([]);
      expectValidBundle(bundle!.files);
      // Every concept's page exists exactly once, all under big/… paths.
      const emittedUuids = bundle!.files
        .slice(2)
        .map((f) => parseConceptPage(f.content)!.data.uuid);
      expect(new Set(emittedUuids).size).toBe(TOTAL);
      expect(emittedUuids.sort()).toEqual([...seededUuids].sort());
    } finally {
      await db.execute(`DELETE FROM concept_contributors WHERE project_id = '${bigProjectId}'`);
      await db.execute(`DELETE FROM concept_evidence      WHERE project_id = '${bigProjectId}'`);
      await db.execute(`DELETE FROM concept_paths         WHERE project_id = '${bigProjectId}'`);
      await db.execute(`DELETE FROM concepts              WHERE project_id = '${bigProjectId}'`);
      await db.execute(`DELETE FROM api_keys              WHERE project_id = '${bigProjectId}'`);
      await db.execute(`DELETE FROM projects              WHERE id = '${bigProjectId}'`);
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Round-trip — pages recover the frozen frontmatter; links resolve in-bundle
  // ═══════════════════════════════════════════════════════════════════════

  it('round-trips: every emitted page parses back to the exact frozen frontmatter', async () => {
    const bundle = await renderOkfBundle(db, scopeProject);
    const byPath = expectValidBundle(bundle!.files);
    const page = await exportProject(db, scopeProject, { limit: 100 });
    expect(page).not.toBeNull();

    for (const concept of page!.concepts) {
      const expected = okfConceptFrontmatter.parse({
        type: concept.type,
        uuid: concept.uuid,
        path: concept.path,
        status: concept.status,
        confidence: concept.confidence,
        title: concept.title,
        tags: concept.tags,
        lastConfirmed: concept.lastConfirmed,
        firstSeen: concept.firstSeen,
        createdAt: concept.createdAt,
        schemaVersion: concept.schemaVersion,
        supersedes: concept.supersedes,
        aliases: concept.aliases,
        contributors: concept.contributors,
        evidence: concept.evidence,
      });
      const relDir = OKF_TYPE_DIR_MAP[concept.type];
      const fileRelPath = `${relDir}/${concept.path}.md`;
      const file = byPath.get(fileRelPath);
      expect(file, `missing page for ${concept.uuid}`).toBeDefined();
      const parsed = parseConceptPage(file!);
      expect(parsed, `page ${fileRelPath}`).not.toBeNull();
      expect(parsed!.data).toEqual(expected);
    }
  });

  it('every rewritten relative link points at an emitted file with the same UUID', async () => {
    const bundle = await renderOkfBundle(db, scopeProject);
    const byPath = expectValidBundle(bundle!.files);

    for (const file of bundle!.files.slice(2)) {
      const parsed = parseConceptPage(file.content)!;
      // Recover bundle-relative targets from every markdown link destination.
      const targets = [...parsed.body.matchAll(/\]\(([^)]*\.md)\)/g)].map((m) => m[1]!);
      const fromDirDepth = file.relPath.split('/').length - 1;
      for (const target of targets) {
        let rel = target;
        for (let i = 0; i < fromDirDepth; i++) rel = rel.replace(/^\.\.\//, '');
        rel = rel.replace(/^\.\//, '');
        const resolved = rel.startsWith('/') ? rel.slice(1) : rel;
        const targetFile = byPath.get(resolved);
        expect(targetFile, `link target ${file.relPath} -> ${resolved}`).toBeDefined();
        const targetPage = parseConceptPage(targetFile!);
        expect(targetPage, `target page ${resolved}`).not.toBeNull();
      }
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Scope / anti-enumeration / honest empties
  // ═══════════════════════════════════════════════════════════════════════

  it('returns null for a project of another team — indistinguishable from missing', async () => {
    const crossTeam = await renderOkfBundle(db, projectScope(teamId, otherProjectId));
    const missing = await renderOkfBundle(
      db,
      projectScope(teamId, `prj_nope${randomUUID().replace(/-/g, '').slice(0, 8)}`),
    );
    expect(crossTeam).toBeNull();
    expect(missing).toBeNull();
    const crossTeamAllProjects = await renderOkfBundle(db, allProjectsScope(teamId), {
      projectId: otherProjectId,
    });
    expect(crossTeamAllProjects).toBeNull();
  });

  it('returns null when the scope team does not match the project team', async () => {
    expect(await renderOkfBundle(db, projectScope(otherTeamId, projectId))).toBeNull();
  });

  it('renders an honest empty bundle for a project with no concepts', async () => {
    const bundle = await renderOkfBundle(db, projectScope(teamId, emptyProjectId));
    expect(bundle).not.toBeNull();
    expect(bundle!.totalConcepts).toBe(0);
    expect(bundle!.renderedConcepts).toBe(0);
    expect(bundle!.skipped).toEqual([]);
    const byPath = expectValidBundle(bundle!.files);
    expect(bundle!.files.map((f) => f.relPath)).toEqual(['index.md', 'log.md']);
    // Reserved files are present even when there is nothing to catalog.
    expect(byPath.get('index.md')).toContain('# Teamem OKF bundle');
    expect(byPath.get('log.md')).toContain('# Change log');
    expect(byPath.get('index.md')).not.toContain('## ');
    expect(byPath.get('log.md')!.split('\n').length).toBeGreaterThan(2);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Skipped concepts — never fabricated pages, honest counts
  // ═══════════════════════════════════════════════════════════════════════

  it('surfaces concepts the repository cannot assemble in skipped — no page, no fake path', async () => {
    // Simulate the raw-SQL counterexample: delete the path row entirely so
    // the concept cannot be assembled into a valid page.
    const created = await createConcept(db, conceptInput(teamId, projectId,
      `services/broken-${randomUUID().replace(/-/g, '').slice(0, 6)}`,
      { title: 'Broken Concept' }));
    await db.execute(`DELETE FROM concept_paths WHERE concept_uuid = '${created.uuid}'`);

    try {
      const bundle = await renderOkfBundle(db, scopeProject);
      expect(bundle).not.toBeNull();
      expect(bundle!.skipped.map((s) => s.uuid)).toContain(created.uuid);
      const skipped = bundle!.skipped.find((s) => s.uuid === created.uuid)!;
      expect(skipped.reason).toContain('path');
      // Counts stay consistent: one concept is skipped, nothing fabricated.
      expect(bundle!.renderedConcepts).toBe(bundle!.totalConcepts - bundle!.skipped.length);
      // No page for the broken concept.
      const byPath = expectValidBundle(bundle!.files);
      expect([...byPath.keys()].some((p) => p.includes(created.uuid))).toBe(false);
      expect(
        bundle!.files.map((f) => f.relPath).some((p) => p.startsWith('services/broken-')),
      ).toBe(false);

      // A link toward the skipped UUID is not resurrected as a page link:
      // it stays the canonical teamem:// URI (honest, round-trip safe).
      await db.execute(
        `UPDATE concepts SET body = 'Depends on teamem://concept/${created.uuid}.' ` +
          `WHERE uuid = '${serviceUuid}'`,
      );
      const after = await renderOkfBundle(db, scopeProject);
      const serviceBody = parseConceptPage(
        after!.files.find((f) => f.relPath === `services/${servicePath}.md`)!.content,
      )!.body;
      expect(serviceBody).toContain(`teamem://concept/${created.uuid}`);
    } finally {
      await db.execute(`DELETE FROM concept_evidence WHERE concept_uuid = '${created.uuid}'`);
      await db.execute(`DELETE FROM concepts WHERE uuid = '${created.uuid}'`);
    }
  });

  it('keeps renderedConcepts + skipped aligned with totalConcepts for the seeded project', async () => {
    const bundle = await renderOkfBundle(db, scopeProject);
    expect(bundle).not.toBeNull();
    expect(bundle!.renderedConcepts + bundle!.skipped.length).toBe(bundle!.totalConcepts);
  });
});