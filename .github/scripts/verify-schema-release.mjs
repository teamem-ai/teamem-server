import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const [tag] = process.argv.slice(2);
const match = /^schema-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(tag ?? '');

if (!match) {
  throw new Error(
    `schema release tag must be schema-vMAJOR.MINOR.PATCH; received ${tag ?? 'nothing'}`,
  );
}

const version = tag.slice('schema-v'.length);
const manifest = JSON.parse(readFileSync('packages/schema/package.json', 'utf8'));

if (manifest.version !== version) {
  throw new Error(
    `packages/schema/package.json version is ${manifest.version}; expected ${version}`,
  );
}

const objectType = execFileSync('git', ['cat-file', '-t', tag], {
  encoding: 'utf8',
}).trim();

if (objectType !== 'tag') {
  throw new Error(`${tag} must be an annotated tag; found Git object type ${objectType}`);
}

execFileSync('git', ['merge-base', '--is-ancestor', 'HEAD', 'origin/main']);

process.stdout.write(`Schema release ${tag} is consistent and points to main.\n`);
