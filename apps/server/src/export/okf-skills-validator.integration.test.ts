/**
 * M3 OKF-skills validator round-trip integration test — DUA-253 / M3-EXPORT-06.
 *
 * Exports a REAL project (Postgres-seeded concepts with evidence and cross
 * links) through the scoped OKF bundle renderer (M3-EXPORT-03, the declared
 * dependency), materializes the bundle to disk, and runs it through the REAL
 * okf-skills validator — `okf_validate.py` from
 * https://github.com/scaccogatto/okf-skills (MIT), pinned to ONE immutable
 * upstream commit and SHA-256 verified (see src/test/okf-validator.ts):
 *
 *   - assert pass:   the exported bundle is conformant — the validator exits
 *                     0 and `--json` reports passed:true, with zero hard
 *                     errors. Teamem emits OKF v0.1 plus its own profile, so
 *                     the checker reports v0.1-era soft guidance as warnings;
 *                     the conformance gate is the hard §11 rule set.
 *   - round-trip:    from the extracted files on disk, uuid / path / type /
 *                     evidence / links are all recoverable and equal the
 *                     persisted concepts (N5 — the canonical UUID is never
 *                     lost; an import can rebuild teamem identity from a page).
 *   - negative case: a deliberately corrupted copy of the bundle (the `type`
 *                     field removed from one page's frontmatter) FAILS the
 *                     validator (§11.2 hard error, exit ≠ 0) while the
 *                     pristine bundle still passes — the gate catches
 *                     corruption and is not a rubber stamp.
 *   - honest skip:   when the validator cannot be obtained or run (no
 *                     network, no uv/python3, no pyyaml), each test SKIPS
 *                     with the reason — a skip is NOT a pass (AGENTS.md §11;
 *                     ticket DUA-253: "honest skip when validator unavailable
 *                     (skip ≠ pass)"). Same for a missing TEST_DATABASE_URL.
 *
 * Runs only when TEST_DATABASE_URL is set; honestly skipped otherwise.
 */
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  OKF_BUNDLE_INDEX_FILE,
  OKF_BUNDLE_LOG_FILE,
  OKF_TYPE_DIR_MAP,
  okfConceptFrontmatter,
  okfConceptRelPath,
  parseConceptPage,
} from '@teamem/schema';
import { createDb, type AppDb } from '../db/client.js';
import { connectDatabase, closeDatabase } from '../test/database.js';
import { runBootstrap } from '../commands/bootstrap.js';
import { createConcept, type CreateConceptInput } from '../db/repositories/concepts-write.js';
import { exportProject } from '../db/repositories/export.js';
import { projectScope } from '../auth/scope.js';
import { renderOkfBundle, type OkfBundleFile } from './render-okf-bundle.js';
import {
  acquireOkfSkillsValidator,
  type OkfSkillsValidator,
} from '../test/okf-validator.js';

const url = process.env['TEST_DATABASE_URL'];

describe.skipIf(!url)('okf-skills validator round-trip (live Postgres)', () => {
  let pool: Pool;
  let db: AppDb;

  // Primary team + project + seeded concepts
  let teamId: string;
  let projectId: string;
  let scopeProject: ReturnType<typeof projectScope>;
  let decisionUuid: string;
  let gotchaUuid: string;
  let conventionUuid: string;
  let serviceUuid: string;
  let decisionPath: string;
  let gotchaPath: string;
  let conventionPath: string;
  let servicePath: string;

  // The real okf-skills validator (unavailable → honest skip)
  let validator: OkfSkillsValidator;

  // Materialized bundle on disk
  let bundleDir: string;
  let bundleFiles: readonly OkfBundleFile[];

  beforeAll(async () => {
    validator = await acquireOkfSkillsValidator();
    if (!validator.ready) {
      // No DB or render work when the validator cannot run: every test below
      // skips with the reason — the check did not run, so it is not "passed".
      return;
    }

    ({ pool } = connectDatabase());
    db = createDb(url!, { pool });

    // ── Team + project ────────────────────────────────────────────────────
    const suffix = randomUUID().replace(/-/g, '').slice(0, 8);
    const result = await runBootstrap(db, {
      teamName: `OKF Validator ${suffix}`,
      projectName: `validator-${suffix}`,
      rotate: false,
    });
    teamId = result.team.id;
    projectId = result.project.id;
    scopeProject = projectScope(teamId, projectId);

    // ── Seed four concepts (all six DTO fields exercised; evidence + links) ──
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

    // ── Cross links need target UUIDs — patch bodies after creation. One
    //    link points at a UUID that is NOT part of the bundle (stays canonical).
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

    // ── Export the REAL bundle and materialize it to disk ─────────────────
    const bundle = await renderOkfBundle(db, scopeProject);
    if (bundle === null) throw new Error('renderOkfBundle returned null for a seeded project');
    expect(bundle.renderedConcepts).toBe(4);
    expect(bundle.skipped).toEqual([]);
    bundleFiles = bundle.files;
    bundleDir = await mkdtemp(join(tmpdir(), 'teamem-okf-bundle-'));
    await materializeBundle(bundleDir, bundle.files);
  });

  afterAll(async () => {
    if (validator?.ready && db) {
      // Remove seeded project data, then the team/principals.
      for (const pid of [projectId]) {
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
      await closeDatabase(pool);
    }
    if (bundleDir) await rm(bundleDir, { recursive: true, force: true });
    await validator?.dispose();
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

  /** Honest-skip guard: skip (never pass) when the real validator is absent. */
  function requireValidator(ctx: { skip: (note?: string) => never }): void {
    if (!validator.ready) {
      ctx.skip(
        `okf-skills validator unavailable: ${validator.reason} — SKIP, not pass`,
      );
    }
  }

  /** Resolve a relative target (./x or ../x…) inside the bundle root. */
  function resolveBundleLink(fromRel: string, target: string): string {
    let rel = target;
    const depth = fromRel.split('/').length - 1;
    for (let i = 0; i < depth; i++) rel = rel.replace(/^\.\.\//, '');
    rel = rel.replace(/^\.\//, '');
    return rel.startsWith('/') ? rel.slice(1) : rel;
  }

  it('passes the real okf-skills validator in default conformance mode (conformant)', async (ctx) => {
    requireValidator(ctx);

    const result = await validator.run(bundleDir);
    expect(result.exitCode, result.stderr || JSON.stringify(result.report)).toBe(0);
    expect(result.report, `validator did not emit --json:\n${result.stdout}`).not.toBeNull();
    expect(result.report!.passed).toBe(true); // the validator's own pass verdict
    expect(result.report!.conformant).toBe(true);
    expect(result.report!.errors).toEqual([]); // hard §11 rules: zero errors
    // It really checked our bundle: 4 concept pages + index.md + log.md.
    expect(result.report!.counts).toEqual({ concepts: 4, indexes: 1, logs: 1 });
  });

  it('round-trips uuid / path / type / evidence from every exported page (frontmatter)', async (ctx) => {
    requireValidator(ctx);

    const page = await exportProject(db, scopeProject, { limit: 100 });
    expect(page).not.toBeNull();
    expect(page!.concepts).toHaveLength(4);

    for (const concept of page!.concepts) {
      // Recoverable location rule: uuid → type dir, path → file name (N5).
      const expectedRel = okfConceptRelPath(concept.type, concept.path);
      expect(expectedRel).toBe(`${OKF_TYPE_DIR_MAP[concept.type]}/${concept.path}.md`);

      const text = await readFile(join(bundleDir, expectedRel), 'utf8');
      const parsed = parseConceptPage(text);
      expect(parsed, `page ${expectedRel} must parse against the frozen contract`).not.toBeNull();

      // uuid / path / type / status / confidence / evidence … all recoverable.
      expect(parsed!.data.uuid).toBe(concept.uuid);
      expect(parsed!.data.type).toBe(concept.type);
      expect(parsed!.data.path).toBe(concept.path);
      expect(parsed!.data.title).toBe(concept.title);
      // The full frontmatter shape equals the frozen contract mapping of the
      // persisted concept — evidence included.
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
      expect(parsed!.data).toEqual(expected);
    }

    // Reserved files are present; log.md carries every canonical UUID (the
    // catalog's index.md carries titles + links, whose resolution is asserted
    // in the links test below) — the canonical UUID is never lost (N5).
    const index = await readFile(join(bundleDir, OKF_BUNDLE_INDEX_FILE), 'utf8');
    const log = await readFile(join(bundleDir, OKF_BUNDLE_LOG_FILE), 'utf8');
    for (const uuid of [decisionUuid, gotchaUuid, conventionUuid, serviceUuid]) {
      expect(log).toContain(uuid);
    }
    expect(index).toContain('# Teamem OKF bundle');
  });

  it('round-trips links: in-body and catalog links resolve to emitted pages on disk', async (ctx) => {
    requireValidator(ctx);

    // Index of everything emitted on disk: relPath → parsed page.
    const diskPages = new Map<string, ReturnType<typeof parseConceptPage>>();
    for (const file of bundleFiles) {
      if (file.relPath === OKF_BUNDLE_INDEX_FILE || file.relPath === OKF_BUNDLE_LOG_FILE) continue;
      const abs = join(bundleDir, file.relPath);
      const parsed = parseConceptPage(await readFile(abs, 'utf8'));
      expect(parsed, `disk page ${file.relPath} parses`).not.toBeNull();
      diskPages.set(file.relPath, parsed!);
    }
    const emittedUuids = new Set([...diskPages.values()].map((p) => p!.data.uuid));

    for (const [relPath, page] of diskPages) {
      // Every relative markdown link in the body must hit an existing page.
      const targets = [...page!.body.matchAll(/\]\(([^)]*\.md)\)/g)].map((m) => m[1]!);
      for (const target of targets) {
        const resolved = resolveBundleLink(relPath, target);
        const targetPage = diskPages.get(resolved);
        expect(targetPage, `link ${relPath} -> ${resolved} must exist on disk`).toBeDefined();
        // The UUID is recoverable by following the link (its frontmatter).
        expect(targetPage!.data.uuid).toMatch(/^[0-9a-f-]{36}$/);
      }
      // Canonical teamem:// URIs remain ONLY for UUIDs outside the bundle.
      for (const uri of page!.body.matchAll(/teamem:\/\/concept\/([0-9a-f-]{36})/g)) {
        expect(emittedUuids.has(uri[1]!), `canonical URI for emitted uuid in ${relPath}: ${uri[0]}`)
          .toBe(false);
      }
    }

    // index.md catalog entries link to files that exist on disk.
    const index = await readFile(join(bundleDir, OKF_BUNDLE_INDEX_FILE), 'utf8');
    for (const target of index.matchAll(/\]\((\.\/[^)]*\.md)\)/g)) {
      const resolved = resolveBundleLink(OKF_BUNDLE_INDEX_FILE, target[1]!);
      expect(diskPages.has(resolved), `catalog link -> ${resolved} must exist`).toBe(true);
    }
  });

  it('fails on a deliberately corrupted bundle while the pristine bundle still passes', async (ctx) => {
    requireValidator(ctx);

    // Pristine first — establish the pass baseline within the same test.
    const pristine = await validator.run(bundleDir);
    expect(pristine.exitCode, pristine.stderr).toBe(0);

    // Corrupt ONE page: strip the `type` field from its frontmatter — the
    // validator's §11.2 hard rule (missing/empty required `type`).
    const corruptDir = join(bundleDir, '..', `corrupt-${randomUUID().slice(0, 8)}`);
    await rm(corruptDir, { recursive: true, force: true });
    try {
      await cp(bundleDir, corruptDir, { recursive: true });
      const pageRel = `decisions/${decisionPath}.md`;
      const abs = join(corruptDir, pageRel);
      const text = await readFile(abs, 'utf8');
      const stripped = text.replace(/^type: [^\n]+\n/m, '');
      expect(stripped, 'corruption must actually remove the type field').not.toContain('type: decision');
      await writeFile(abs, stripped, 'utf8');

      const result = await validator.run(corruptDir);
      expect(result.exitCode, result.stderr).not.toBe(0); // the gate trips
      expect(result.report).not.toBeNull();
      expect(result.report!.passed).toBe(false);
      expect(
        result.report!.errors.some((e) => e.includes('§11.2') && e.includes('type')),
        `expected a §11.2 type error, got: ${JSON.stringify(result.report!.errors)}`,
      ).toBe(true);
    } finally {
      await rm(corruptDir, { recursive: true, force: true });
    }
  });
});

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Write the rendered bundle file tree onto disk under `root`. */
async function materializeBundle(
  root: string,
  files: readonly OkfBundleFile[],
): Promise<void> {
  for (const file of files) {
    const abs = join(root, file.relPath);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, file.content, 'utf8');
  }
}

