#!/usr/bin/env node

/**
 * License boundary audit (M3-REL-01).
 *
 * Enforces the repository's deliberate license split:
 *
 *   - root, apps/server, apps/web  -> AGPL-3.0-only
 *   - packages/schema              -> MIT (independent public package)
 *
 * The dangerous direction is AGPL source bleeding into the MIT package: MIT
 * code that depends on or statically imports AGPL material makes the combined
 * work AGPL, which would silently revoke the schema package's license promise.
 * This script fails the build on any such bleed, on a wrong declared license,
 * on a missing/incorrect LICENSE file, and on MIT-incompatible runtime
 * dependencies of the schema package.
 *
 * Usage:
 *   node scripts/check-licenses.mjs            # human-readable report
 *   node scripts/check-licenses.mjs --json     # JSON report for CI parsing
 *
 * Exit code 0 = boundary intact; non-zero = at least one violation.
 */
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { walk } from './lib/walk.mjs';

const jsonMode = process.argv.includes('--json');

// Expected license per package. Root has no package name but still declares a
// license in package.json (the repository default).
const EXPECTED = new Map([
  ['package.json', 'AGPL-3.0-only'],
  ['apps/server/package.json', 'AGPL-3.0-only'],
  ['apps/web/package.json', 'AGPL-3.0-only'],
  ['packages/schema/package.json', 'MIT'],
]);

// Runtime dependencies of the MIT schema package must not be copyleft-strong.
// yaml and zod are the current graph; the allowlist is the *contract* for what
// may be added, so a new AGPL/GPL dependency fails immediately.
const PERMISSIVE_LICENSES = new Set([
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  '0BSD',
  'Unlicense',
]);

// License strings that would poison an MIT package.
const COPILEFT_MARKERS = ['GPL', 'AGPL', 'SSPL', 'CC-BY-NC', 'CC-BY-SA', 'CC-BY-ND'];

// Workspace packages that are AGPL and therefore forbidden in schema deps.
const AGPL_WORKSPACE_PACKAGES = new Set(['@teamem/server', '@teamem/web', 'teamem-server']);

const violations = [];
const notes = [];

function fail(message) {
  violations.push(message);
}

function note(message) {
  notes.push(message);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * A dependency license string may be an SPDX id or an object
 * ({type, url}) as produced by older publish tooling.
 */
function depLicenseString(manifest) {
  const value = manifest.license ?? manifest.licenses?.[0]?.type ?? '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function normalizeNpmLicense(expression) {
  if (!expression) return '';
  return expression
    .replace(/\(([^)]*)\)/g, '$1')
    .replace(/\+/g, '')
    .replace(/\s+OR\s+.*$/i, '')
    .trim();
}

// --- 1. Declared license fields -------------------------------------------------

for (const [manifestPath, expected] of EXPECTED) {
  try {
    const manifest = readJson(manifestPath);
    const declared = manifest.license;
    if (declared !== expected) {
      fail(
        `${manifestPath} declares license "${declared}" but the repository contract is "${expected}"`,
      );
    } else {
      note(`${manifestPath} declares ${declared} (expected)`);
    }
  } catch (error) {
    fail(`cannot read ${manifestPath}: ${error.message}`);
  }
}

// --- 2. LICENSE files -----------------------------------------------------------

const licenseChecks = [
  {
    path: 'LICENSE',
    marker: 'GNU AFFERO GENERAL PUBLIC LICENSE',
    expected: 'AGPL-3.0-only',
  },
  {
    path: 'packages/schema/LICENSE',
    marker: 'MIT License',
    expected: 'MIT',
  },
];

for (const { path, marker, expected } of licenseChecks) {
  try {
    const text = readFileSync(path, 'utf8');
    if (!text.includes(marker)) {
      fail(`${path} does not contain the expected ${expected} license text`);
    } else {
      note(`${path} contains ${expected} license text`);
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      fail(`missing LICENSE file at ${path}; every published/declared license needs its text`);
    } else {
      fail(`cannot read ${path}: ${error.message}`);
    }
  }
}

// --- 3. MIT package publish integrity ------------------------------------------

const schemaManifest = readJson('packages/schema/package.json');
if (schemaManifest.publishConfig?.access !== 'public') {
  fail('packages/schema publishes privately; the MIT open-format carrier must be public');
}
if (!Array.isArray(schemaManifest.files) || !schemaManifest.files.includes('LICENSE')) {
  fail('packages/schema package files must include LICENSE so the MIT text ships to npm');
}

// --- 4. No AGPL dependency bleed into the MIT schema package -------------------

for (const dep of Object.keys(schemaManifest.dependencies ?? {})) {
  if ([...AGPL_WORKSPACE_PACKAGES].some((pkg) => dep === pkg || dep.startsWith(`${pkg}/`))) {
    fail(`packages/schema depends on AGPL workspace package "${dep}" — MIT boundary breached`);
    continue;
  }
  // pnpm installs deps under the package's own node_modules or the workspace root;
  // try the known layouts before giving up.
  const candidates = [
    `packages/schema/node_modules/${dep}/package.json`,
    `node_modules/${dep}/package.json`,
    `node_modules/.pnpm/node_modules/${dep}/package.json`,
  ];
  let resolved = null;
  for (const candidate of candidates) {
    try {
      readFileSync(candidate, 'utf8');
      resolved = candidate;
      break;
    } catch {
      // try next layout
    }
  }
  if (!resolved) {
    fail(`cannot resolve license for schema dependency "${dep}" (checked ${candidates.join(', ')})`);
    continue;
  }
  const depManifest = readJson(resolved);
  const rawLicense = depLicenseString(depManifest);
  const normalized = normalizeNpmLicense(rawLicense);
  const isCopyleftStrong = COPILEFT_MARKERS.some((marker) =>
    rawLicense.toUpperCase().includes(marker),
  );
  if (!PERMISSIVE_LICENSES.has(normalized)) {
    fail(
      `packages/schema runtime dependency "${dep}" has non-permissive license "${rawLicense}"; ` +
        (isCopyleftStrong
          ? `copyleft-strong (${COPILEFT_MARKERS.find((m) => rawLicense.toUpperCase().includes(m))}) cannot ship inside an MIT package `
          : 'MIT package must only carry permissive-licensed runtime code ') +
        `(checked ${resolved})`,
    );
  } else {
    note(`schema dependency ${dep} is ${normalized} (permissive)`);
  }
}

// --- 5. No static import bleed from the MIT package ----------------------------

// Reject imports that resolve outside of packages/schema (a relative import that
// escapes the package would reach AGPL code) and any import of the AGPL apps.
const SCHEMA_ROOT = resolve('packages/schema');
for (const file of walk('packages/schema/src')) {
  const text = readFileSync(file, 'utf8');
  const importRe = /(?:import|export)[\s\S]*?(?:from\s+)?['"]([^'"]+)['"]/g;
  const declared = new Set();
  for (const match of text.matchAll(importRe)) declared.add(match[1]);
  for (const specifier of declared) {
    if (!specifier) continue;
    if ([...AGPL_WORKSPACE_PACKAGES].some((pkg) => specifier === pkg || specifier.startsWith(`${pkg}/`))) {
      fail(`${file} imports AGPL package "${specifier}" — MIT boundary breached`);
      continue;
    }
    if (!specifier.startsWith('.')) continue; // bare package imports are checked in §4
    const resolved = resolve(dirname(file), specifier).split(sep).join('/');
    const rel = relative(SCHEMA_ROOT, resolved);
    if (rel.startsWith('..') || rel === '') {
      fail(
        `${file} imports "${specifier}" which resolves outside packages/schema — ` +
          `AGPL code can bleed into the MIT package`,
      );
    }
  }
}

// --- 6. No MIT header accidentally stamped onto AGPL code -----------------------

for (const [manifestPath, expected] of EXPECTED) {
  if (expected !== 'AGPL-3.0-only') continue;
  const dir = manifestPath.replace(/\/package\.json$/, '');
  const candidates = walk(dir === '' ? 'apps' : dir)
    .filter((f) => f.endsWith('.ts') || f.endsWith('.tsx') || f.endsWith('.mjs'))
    .filter((f) => !f.includes('/dist/') && !f.includes('/node_modules/'));
  for (const file of candidates) {
    const head = readFileSync(file, 'utf8').slice(0, 2000);
    if (/MIT LICENSE/i.test(head) && !head.includes('AGPL')) {
      fail(
        `${file} carries an MIT header but lives in an AGPL package; either remove the header or the file is misplaced`,
      );
    }
  }
}

// --- Report --------------------------------------------------------------------

const ok = violations.length === 0;
const report = {
  status: ok ? 'ok' : 'violations',
  violations,
  notes,
  summary: {
    packages: EXPECTED.size,
    checked: notes.length,
  },
};

if (jsonMode) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  for (const note of notes) process.stdout.write(`  ✓ ${note}\n`);
  for (const violation of violations) process.stdout.write(`  ✗ ${violation}\n`);
  process.stdout.write(
    ok
      ? 'License boundary intact: root/server/web are AGPL-3.0-only and packages/schema stays MIT with no bleed.\n'
      : `License boundary VIOLATED: ${violations.length} problem(s).\n`,
  );
}

process.exit(ok ? 0 : 1);