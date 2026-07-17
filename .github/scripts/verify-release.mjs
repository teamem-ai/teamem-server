import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const [tag] = process.argv.slice(2);
const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(tag ?? '');

if (!match) {
  throw new Error(`release tag must be stable SemVer vMAJOR.MINOR.PATCH; received ${tag ?? 'nothing'}`);
}

const version = tag.slice(1);
const packageFiles = [
  'package.json',
  'apps/server/package.json',
  'apps/web/package.json',
  'packages/schema/package.json',
];

for (const file of packageFiles) {
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  if (manifest.version !== version) {
    throw new Error(`${file} version is ${manifest.version}; expected ${version}`);
  }
}

const changelog = readFileSync('CHANGELOG.md', 'utf8');
const escapedVersion = version.replaceAll('.', '\\.');
const releaseHeading = new RegExp(
  `^## \\[${escapedVersion}\\] - \\d{4}-\\d{2}-\\d{2}$`,
  'm',
);

if (!releaseHeading.test(changelog)) {
  throw new Error(`CHANGELOG.md is missing "## [${version}] - YYYY-MM-DD"`);
}

const objectType = execFileSync('git', ['cat-file', '-t', tag], {
  encoding: 'utf8',
}).trim();

if (objectType !== 'tag') {
  throw new Error(`${tag} must be an annotated tag; found Git object type ${objectType}`);
}

execFileSync('git', ['merge-base', '--is-ancestor', 'HEAD', 'origin/main']);

process.stdout.write(`Release ${tag} is consistent and points to main.\n`);

