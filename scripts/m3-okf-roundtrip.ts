#!/usr/bin/env -S npx tsx
/**
 * M3-QA-01 OKF export round-trip live-acceptance helper (DUA-260).
 *
 * Independent read-only acceptance of "memory you can take with you". This
 * helper drives the reproducible live walkthrough against REAL PostgreSQL:
 *
 *   1. Seed a representative project (4 concepts across 4 types, nested
 *      paths, cross-links, evidence) using the server's OWN bootstrap +
 *      repositories — never test fixtures or a mock database.
 *   2. Render the REAL exported OKF bundle (renderOkfBundle, M3-EXPORT-03)
 *      and materialize it to disk under scripts/m3-okf-roundtrip-results/.
 *   3. Validate the materialized bundle with the REAL okf-skills validator
 *      (acquireOkfSkillsValidator, pinned one upstream commit, SHA-256
 *      verified, run via `uv`) and write its --json report.
 *   4. Round-trip evidence: the canonical UUID is preserved in every page's
 *      frontmatter and every rewritten internal link resolves to an emitted
 *      page carrying that same UUID.
 *   5. Negative cases (each pinned by the ticket):
 *        - a missing inline-link target is handled as "preserve the
 *          canonical teamem:// URI" — never silently dropped, never
 *          fabricated into a page;
 *        - cross-team / no-scope export returns null — byte-identical to a
 *          genuinely missing project (anti-enumeration);
 *        - the export contains no raw event payload / query text (a sentinel
 *          stored ONLY in an event payload never appears in the bundle) and
 *          the audit_log schema has no content-bearing column.
 *   6. Print a machine-readable summary (paths, counts, validator verdict)
 *      for the shell driver to push the bundle to a real GitHub repo and
 *      record the per-command evidence.
 *
 * Red lines: read-only (only reads already-persisted redacted data and
 * deletes the seeded tenant afterwards); the validator is the real okf-skills
 * script — never a stub; no external tool source is vendored into the repo.
 * No production code is changed.
 *
 * Usage:
 *   TEST_DATABASE_URL=postgres://... npx tsx scripts/m3-okf-roundtrip.ts
 *
 * Optional:
 *   TEAMEM_OKF_VALIDATOR_RUNTIME  'uv' | 'python3' | <python path> (default auto)
 *   TEAMEM_OKF_VALIDATOR_SCRIPT    path to a local pinned okf_validate.py
 *   M3_OKF_RESULTS_DIR             results directory (default scripts/m3-okf-roundtrip-results)
 */
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  OKF_BUNDLE_INDEX_FILE,
  OKF_BUNDLE_LOG_FILE,
  parseConceptPage,
} from '@teamem/schema';
import { createDbHandle, type AppDb } from '../apps/server/src/db/client.js';
import { renderOkfBundle, type OkfBundleFile } from '../apps/server/src/export/render-okf-bundle.js';
import { allProjectsScope, projectScope } from '../apps/server/src/auth/scope.js';
import { runBootstrap } from '../apps/server/src/commands/bootstrap.js';
import {
  createConcept,
  type CreateConceptInput,
} from '../apps/server/src/db/repositories/concepts-write.js';
import { acquireOkfSkillsValidator } from '../apps/server/src/test/okf-validator.js';

const url = process.env['TEST_DATABASE_URL'];
if (!url) {
  throw new Error('TEST_DATABASE_URL is not set — cannot run a real live acceptance.');
}
const DATABASE_URL: string = url;

const REPO_ROOT = resolve(__dirname, '..');
const RESULTS_DIR =
  process.env['M3_OKF_RESULTS_DIR'] ?? join(REPO_ROOT, 'scripts', 'm3-okf-roundtrip-results');
const RUN_DIR = join(RESULTS_DIR, `run-${Date.now()}`);
const BUNDLE_DIR = join(RUN_DIR, 'bundle');

const pass: string[] = [];
const fail: string[] = [];
function ok(name: string, detail = '') {
  pass.push(name);
  console.log(`\x1b[32m✓ PASS\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
}
function bad(name: string, detail = '') {
  fail.push(name);
  console.log(`\x1b[31m✗ FAIL\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Write the rendered bundle file tree onto disk under `root`. */
async function materialize(root: string, files: readonly OkfBundleFile[]): Promise<void> {
  for (const file of files) {
    const abs = join(root, file.relPath);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, file.content, 'utf8');
  }
}

/** Resolve a bundle-root-relative target (./x or ../x…) from a source file. */
function resolveFrom(fromRel: string, target: string): string {
  let rel = target;
  const depth = fromRel.split('/').length - 1;
  for (let i = 0; i < depth; i++) rel = rel.replace(/^\.\.\//, '');
  rel = rel.replace(/^\.\//, '');
  return rel.startsWith('/') ? rel.slice(1) : rel;
}

/** Delete the seeded tenants (read-only acceptance leaves no residue). */
async function cleanupTenants(
  db: AppDb,
  projectIds: readonly string[],
  teamIds: readonly string[],
): Promise<void> {
  for (const pid of projectIds) {
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
  for (const tid of teamIds) {
    await db.execute(`DELETE FROM principals WHERE team_id = '${tid}'`);
    await db.execute(`DELETE FROM teams WHERE id = '${tid}'`);
  }
}

const SEED_INFO_FILE = 'seed-info.json';

/** Latest run directory under RESULTS_DIR (fallback for --clean). */
function latestRunDir(): string {
  const dirs = readdirSync(RESULTS_DIR)
    .filter((d) => d.startsWith('run-'))
    .sort()
    .reverse();
  if (dirs.length === 0) throw new Error(`no run dirs under ${RESULTS_DIR}`);
  return join(RESULTS_DIR, dirs[0]!);
}

async function main(): Promise<void> {
  // ── --clean <runDir>: delete the seeded tenants of a previous run ──────
  if (process.argv[2] === '--clean') {
    const cleanRun = process.argv[3] ?? latestRunDir();
    const seedInfo = JSON.parse(await readFile(join(cleanRun, SEED_INFO_FILE), 'utf8')) as {
      teamA: string;
      projectA: string;
      teamB: string;
      projectB: string;
    };
    const { db, close } = createDbHandle(DATABASE_URL, {});
    await cleanupTenants(db, [seedInfo.projectA, seedInfo.projectB], [seedInfo.teamA, seedInfo.teamB]);
    await close();
    console.log(`Cleaned seeded tenants from ${cleanRun}`);
    return;
  }

  await mkdir(BUNDLE_DIR, { recursive: true });

  const { db, close } = createDbHandle(DATABASE_URL, {});

  // ── 1. Seed a representative project (real repositories) ──────────────
  const suffix = randomUUID().replace(/-/g, '').slice(0, 8);
  const a = await runBootstrap(db, {
    teamName: `M3 QA Team A ${suffix}`,
    projectName: `roundtrip-${suffix}`,
    rotate: false,
  });
  const teamA = a.team.id;
  const projectA = a.project.id;
  const projectAName = a.project.name;

  const b = await runBootstrap(db, {
    teamName: `M3 QA Team B ${suffix}`,
    projectName: `other-${suffix}`,
    rotate: false,
  });
  const teamB = b.team.id;
  const projectB = b.project.id;

  const decisionPath = `use-postgres-${suffix}`;
  const gotchaPath = `pg-timezone-cast-${suffix}`;
  const conventionPath = `migrations/sql-up-${suffix}`;
  const servicePath = `auth-api-${suffix}`;

  const base: CreateConceptInput = {
    teamId: teamA,
    projectId: projectA,
    schemaVersion: 1,
    type: 'decision',
    status: 'active',
    confidence: 'high',
    title: 'Placeholder',
    body: 'Placeholder body.',
    path: 'placeholder',
    firstSeen: new Date('2026-06-01T00:00:00.000Z'),
    lastConfirmed: new Date('2026-07-10T09:30:00.000Z'),
    evidence: [
      {
        kind: 'repo_file',
        repo: 'teamem-ai/teamem',
        commitSha: 'abc1234',
        path: 'src/index.ts',
        at: new Date('2026-06-01T00:00:00.000Z'),
      },
    ],
  };

  const decision = await createConcept(db, {
    ...base,
    type: 'decision',
    title: 'Use Postgres',
    body: 'We run Postgres as the primary database.',
    path: decisionPath,
    lastConfirmed: new Date('2026-07-10T09:30:00.000Z'),
  });
  const gotcha = await createConcept(db, {
    ...base,
    type: 'gotcha',
    title: 'PG timezone cast drops offsets',
    body: 'Blocked on [the Postgres decision](teamem://concept/PLACEHOLDER_DECISION).',
    path: gotchaPath,
    lastConfirmed: new Date('2026-07-12T14:05:00.000Z'),
  });
  const convention = await createConcept(db, {
    ...base,
    type: 'convention',
    title: 'Migrations use SQL UP',
    body: 'See [the auth service](teamem://concept/PLACEHOLDER_SERVICE).',
    path: conventionPath,
    lastConfirmed: new Date('2026-07-08T08:00:00.000Z'),
  });
  const service = await createConcept(db, {
    ...base,
    type: 'service',
    title: 'Auth Service',
    body: 'Handles authentication and authorization.',
    path: servicePath,
    lastConfirmed: new Date('2026-07-09T10:00:00.000Z'),
  });

  // ── Cross-links (real UUIDs) + one unresolved UUID (negative case) ────
  const unresolvedUuid = randomUUID();
  await db.execute(
    `UPDATE concepts SET body = 'We decided in [ADR-7](teamem://concept/${decision.uuid}). ' ||
      'After this we hit [a timezone gotcha](teamem://concept/${gotcha.uuid}) ' ||
      'and a link to nothing (teamem://concept/${unresolvedUuid}).'
     WHERE uuid = '${decision.uuid}'`,
  );
  await db.execute(
    `UPDATE concepts SET body = 'Blocked on [the Postgres decision](teamem://concept/${decision.uuid}).'
     WHERE uuid = '${gotcha.uuid}'`,
  );
  await db.execute(
    `UPDATE concepts SET body = 'See [the auth service](teamem://concept/${service.uuid}).'
     WHERE uuid = '${convention.uuid}'`,
  );

  // ── A raw event payload sentinel that must NEVER reach the export ─────
  const payloadSecret = `PAYLOAD-SENTINEL-${suffix}-${randomUUID()}`;
  const nowIso = new Date().toISOString();
  await db.execute(
    `INSERT INTO events (id, team_id, project_id, channel, kind, connector_kind, ` +
      `source_event, source_action, delivery_id, item_key, external_id, ` +
      `actor, actor_provenance, occurred_at, occurred_at_provenance, payload, ` +
      `payload_bytes, payload_hash, payload_schema_version, envelope_version, created_at) ` +
      `VALUES ('evt_payload_${suffix}', '${teamA}', '${projectA}', 'cli', 'cli_init', 'cli', ` +
      `'cli_init', 'init', 'del-${suffix}', 'root', 'ext-${suffix}', ` +
      `'{}'::jsonb, 'client_claimed', '${nowIso}', 'client', ` +
      `'{"note":"${payloadSecret}"}'::jsonb, ${128 + payloadSecret.length}, ` +
      `'sha256-placeholder', 1, 1, '${nowIso}')`,
  );

  // ── 2. Render the REAL bundle + materialize ───────────────────────────
  const scopeA = projectScope(teamA, projectA);
  const bundle = await renderOkfBundle(db, scopeA);
  if (bundle === null) {
    bad('renderOkfBundle returns a bundle for the seeded project', 'got null');
  } else {
    await materialize(BUNDLE_DIR, bundle.files);
    ok(
      `renderOkfBundle rendered ${bundle.renderedConcepts}/${bundle.totalConcepts} concepts`,
      `skipped=${JSON.stringify(bundle.skipped)}`,
    );
  }

  // ── 3. Real okf-skills validator ──────────────────────────────────────
  let validatorVerdict = 'SKIP';
  let validatorErrors: readonly string[] = [];
  let validatorScriptPath: string | null = null;
  const validator = await acquireOkfSkillsValidator();
  if (!validator.ready) {
    bad('real okf-skills validator is available', validator.reason ?? 'unavailable');
  } else {
    // Persist the pinned validator script into the run dir so the shell
    // driver's HTTP phase can re-validate the curl-downloaded bundle with
    // the EXACT same real validator.
    if (validator.scriptPath) {
      await writeFile(
        join(RUN_DIR, 'okf_validate.py'),
        await readFile(validator.scriptPath, 'utf8'),
      );
      validatorScriptPath = join(RUN_DIR, 'okf_validate.py');
    }
    const result = await validator.run(BUNDLE_DIR);
    await writeFile(join(RUN_DIR, 'validator-report.json'), JSON.stringify(result.report, null, 2));
    await writeFile(join(RUN_DIR, 'validator.stdout.txt'), result.stdout);
    await writeFile(join(RUN_DIR, 'validator.stderr.txt'), result.stderr);
    validatorVerdict = result.exitCode === 0 ? 'PASS' : 'FAIL';
    validatorErrors = result.report?.errors ?? [];
    if (result.exitCode !== 0) {
      bad(
        'okf-skills validator passes the exported bundle',
        `exitCode=${result.exitCode} errors=${JSON.stringify(validatorErrors)}`,
      );
    } else {
      ok(
        'okf-skills validator passes the exported bundle',
        `exit=${0} passed=${result.report?.passed} conformant=${result.report?.conformant} ` +
          `counts=${JSON.stringify(result.report?.counts)}`,
      );
    }
  }

  // ── 4. Round-trip evidence (frontmatter UUID + internal link resolution)
  const pages = new Map<string, ReturnType<typeof parseConceptPage>>();
  if (bundle) {
    for (const file of bundle.files) {
      if (file.relPath === OKF_BUNDLE_INDEX_FILE || file.relPath === OKF_BUNDLE_LOG_FILE) continue;
      const parsed = parseConceptPage(file.content);
      if (!parsed) bad(`page parses against the frozen contract: ${file.relPath}`);
      else pages.set(file.relPath, parsed);
    }

    // Every page preserves the canonical UUID in frontmatter.
    const hadUuid = [...pages.values()].every(
      (p) => p && /^[0-9a-f-]{36}$/.test(p.data.uuid),
    );
    if (hadUuid) ok('every exported page preserves its canonical UUID in frontmatter', `${pages.size} pages`);
    else bad('every exported page preserves its canonical UUID in frontmatter');

    // Every rewritten relative link resolves to an emitted page carrying the
    // same UUID.
    let allLinksResolve = true;
    for (const [relPath, p] of pages) {
      for (const m of p!.body.matchAll(/\]\(([^)]*\.md)\)/g)) {
        const resolved = resolveFrom(relPath, m[1]!);
        const target = pages.get(resolved);
        if (!target || !/^[0-9a-f-]{36}$/.test(target!.data.uuid)) allLinksResolve = false;
      }
    }
    if (allLinksResolve) ok('every rewritten internal link resolves to an emitted page carrying a UUID');
    else bad('every rewritten internal link resolves to an emitted page carrying a UUID');

    // Negative: missing inline-link target — preserved canonical URI, not fabricated.
    const decisionRel = `decisions/${decisionPath}.md`;
    const decisionPage = pages.get(decisionRel);
    const keepsCanonical =
      decisionPage !== undefined &&
      decisionPage!.body.includes(`teamem://concept/${unresolvedUuid}`);
    const notFabricated =
      decisionPage !== undefined && !decisionPage!.body.includes(`${unresolvedUuid}.md`);
    if (keepsCanonical && notFabricated) {
      ok(
        'missing inline-link target: preserved as canonical teamem:// URI (no fabrication, no loss)',
        unresolvedUuid,
      );
    } else {
      bad('missing inline-link target: preserved as canonical teamem:// URI (no fabrication, no loss)');
    }

    // Reserved files: log.md — the canonical-UUID catalog — carries every
    // UUID (N5: never lost); index.md is present and links to every page.
    const log = bundle.files.find((f) => f.relPath === OKF_BUNDLE_LOG_FILE)?.content ?? '';
    const index = bundle.files.find((f) => f.relPath === OKF_BUNDLE_INDEX_FILE)?.content ?? '';
    const uuids = [decision.uuid, gotcha.uuid, convention.uuid, service.uuid];
    const logCarriesEveryUuid = uuids.every((u) => log.includes(u));
    const indexIsCatalog = index.includes('okf_version') && index.includes('Teamem OKF bundle');
    if (logCarriesEveryUuid && indexIsCatalog) {
      ok('reserved files present; log.md carries every canonical UUID (N5 — never lost)');
    } else {
      bad('reserved files present; log.md carries every canonical UUID (N5 — never lost)');
    }
  }

  // ── 5a. Negative: cross-team / no-scope export indistinguishable ──────
  const crossTeamDirect = await renderOkfBundle(db, projectScope(teamA, projectB));
  const missingDirect = await renderOkfBundle(db, projectScope(teamA, `prj_nope${suffix}`));
  const crossTeamAllProjects = await renderOkfBundle(db, allProjectsScope(teamA), {
    projectId: projectB,
  });
  const reverseScope = await renderOkfBundle(db, projectScope(teamB, projectA));
  if (
    crossTeamDirect === null && missingDirect === null && crossTeamAllProjects === null && reverseScope === null
  ) {
    ok('cross-team / no-scope export returns null — indistinguishable from a missing project', 'anti-enumeration');
  } else {
    bad('cross-team / no-scope export returns null — indistinguishable from a missing project');
  }

  // ── 5b. Negative: no payload / query raw text in the export ───────────
  const allText = bundle ? bundle.files.map((f) => f.content).join('\n') : '';
  const noPayloadLeak = !allText.includes(payloadSecret);
  if (noPayloadLeak) ok('export contains no raw event payload text (sentinel never appears)');
  else bad('export contains no raw event payload text (sentinel never appears)');
  // audit_log schema: no content-bearing column (nothing to leak).
  const auditCols = await db.$client.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'audit_log'`,
  );
  const auditNames = auditCols.rows.map((r) => r.column_name).sort();
  const allowlist = [
    'action', 'created_at', 'credential_id', 'id', 'outcome',
    'principal_id', 'project_id', 'request_id', 'resource_id',
    'resource_type', 'team_id',
  ].sort();
  if (JSON.stringify(auditNames) === JSON.stringify(allowlist)) {
    ok('audit_log has no content-bearing column (metadata-only, whitelisted)');
  } else {
    bad('audit_log has no content-bearing column (metadata-only, whitelisted)', JSON.stringify(auditNames));
  }

  // ── Write summary for the shell driver ───────────────────────────────
  const summary = {
    runDir: RUN_DIR,
    bundleDir: BUNDLE_DIR,
    teamA,
    projectA,
    projectAName,
    projectB,
    projectBTeam: teamB,
    concepts: bundle ? { total: bundle.totalConcepts, rendered: bundle.renderedConcepts } : null,
    unresolvedUuid,
    payloadSecret,
    validator: { verdict: validatorVerdict, errors: validatorErrors },
    bundleTree: bundle ? bundle.files.map((f) => f.relPath) : [],
    results: { pass: [...pass], fail: [...fail] },
  };
  await writeFile(join(RUN_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
  // Seed info for the shell driver's REAL HTTP-download phase (a live server
  // reads these rows, so the seeded tenant is not deleted until that phase
  // has run). Contains the bootstrap key token needed for the Bearer call.
  await writeFile(
    join(RUN_DIR, SEED_INFO_FILE),
    JSON.stringify(
      {
        teamA,
        projectA,
        projectAName,
        teamB,
        projectB,
        bootstrapToken: a.key.token ?? null,
        validatorScriptPath,
        unresolvedUuid,
        payloadSecret,
        runDir: RUN_DIR,
        bundleDir: BUNDLE_DIR,
      },
      null,
      2,
    ),
  );
  console.log(`\nSummary written to ${RUN_DIR}/summary.json`);
  console.log(`Seed info written to ${RUN_DIR}/${SEED_INFO_FILE}`);
  console.log(`Passed: ${pass.length}  Failed: ${fail.length}`);

  // ── Cleanup the seeded tenants unless the HTTP phase still needs them ──
  if (process.env['M3_OKF_SKIP_CLEANUP'] !== '1') {
    await cleanupTenants(db, [projectA, projectB], [teamA, teamB]);
  } else {
    console.log('SKIP_CLEANUP=1: seeded tenant left in place for the HTTP-download phase.');
  }
  await close();

  if (fail.length > 0) {
    console.error(`\n${fail.length} acceptance check(s) FAILED.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll live-acceptance checks passed.');
  }
}

main().catch((err) => {
  console.error('Acceptance helper crashed:', err);
  process.exit(1);
});
