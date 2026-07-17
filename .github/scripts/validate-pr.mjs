const title = process.env.PR_TITLE ?? '';
const labels = JSON.parse(process.env.PR_LABELS_JSON ?? '[]');

const titlePattern =
  /^(feat|fix|docs|refactor|perf|test|build|ci|chore|revert)(\([a-z0-9][a-z0-9-]*\))?!?: [^\s].+$/;
const semverLabels = new Set([
  'semver:major',
  'semver:minor',
  'semver:patch',
  'semver:none',
]);
const selectedSemverLabels = labels.filter((label) => semverLabels.has(label));

const errors = [];

if (title.length > 100) {
  errors.push(`PR title is ${title.length} characters; maximum is 100.`);
}

if (!titlePattern.test(title)) {
  errors.push(
    'PR title must match type(scope): imperative summary. Allowed types: feat, fix, docs, refactor, perf, test, build, ci, chore, revert.',
  );
}

if (selectedSemverLabels.length !== 1) {
  errors.push(
    `PR must have exactly one semver label; found ${selectedSemverLabels.length}: ${selectedSemverLabels.join(', ') || 'none'}.`,
  );
}

if (errors.length > 0) {
  for (const error of errors) {
    process.stderr.write(`::error::${error}\n`);
  }
  process.exit(1);
}

process.stdout.write(
  `PR policy passed: ${title} (${selectedSemverLabels[0]}).\n`,
);

