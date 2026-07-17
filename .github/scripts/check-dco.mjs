import { execFileSync } from 'node:child_process';

const [base, head] = process.argv.slice(2);

if (!base || !head) {
  throw new Error('usage: check-dco.mjs <base-sha> <head-sha>');
}

const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8' }).trimEnd();

const commits = git('rev-list', '--reverse', '--no-merges', `${base}..${head}`)
  .split('\n')
  .filter(Boolean);

if (commits.length === 0) {
  process.stderr.write('::error::No non-merge commits found in the pull request.\n');
  process.exit(1);
}

const failures = [];

for (const sha of commits) {
  const raw = execFileSync(
    'git',
    ['show', '-s', '--format=%an%x00%ae%x00%B', sha],
    { encoding: 'utf8' },
  );
  const [authorName = '', authorEmail = '', ...bodyParts] = raw.split('\0');
  const body = bodyParts.join('\0');
  const signoffs = [...body.matchAll(/^Signed-off-by:\s*(.+?)\s*<([^>]+)>\s*$/gim)];
  const authorSigned = signoffs.some(
    (match) => match[2].toLowerCase() === authorEmail.trim().toLowerCase(),
  );

  if (!authorSigned) {
    failures.push(
      `${sha.slice(0, 12)} (${authorName} <${authorEmail.trim()}>): missing matching Signed-off-by trailer`,
    );
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    process.stderr.write(`::error::${failure}\n`);
  }
  process.stderr.write(
    'Amend each commit with git commit --amend -s, or create signed-off commits with git commit -s.\n',
  );
  process.exit(1);
}

process.stdout.write(`DCO passed for ${commits.length} commit(s).\n`);

