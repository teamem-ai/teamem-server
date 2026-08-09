#!/usr/bin/env node

/**
 * Release hygiene guard (M3-REL-01).
 *
 * The release workflow distributes artifacts (GitHub Release + GHCR image) and
 * must NEVER deploy to a hosted environment — no fly.io/Vercel/Heroku/cloud
 * platform, no kube/helm/terraform, no remote shells. This static check runs
 * on every PR (ci.yml) and again at tag time (verify-release.mjs) so a future
 * change that sneaks a deploy step into release.yml fails fast in both places.
 *
 * The module is side-effect free when imported: `verify-release.mjs` imports
 * `checkNoDeploy` and passes it the workflow path explicitly. The CLI entry
 * point below only runs when this file is executed directly:
 *
 *   node .github/scripts/check-no-deploy.mjs            # default: release.yml
 *   node .github/scripts/check-no-deploy.mjs <workflow> # custom path
 *
 * Exit code 0 = no deployment markers; non-zero = at least one hit.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const FORBIDDEN_DEPLOY_PATTERNS = [
  /\bfly\.io\b/i,
  /\bvercel\b/i,
  /\bheroku\b/i,
  /\brender\.com\b/i,
  /\bnetlify\b/i,
  /\bwrangler\b/i,
  /\bkubectl\b/i,
  /\bhelm\b/i,
  /\bgcloud\b/i,
  /\bterraform\b/i,
  /\baws\s+(?:ecr|ecs|eks|lambda|amplify)\b/i,
  /\bssh\s+/i,
  /\bdeploy\b/i,
];

export function checkNoDeploy(workflowPath) {
  let workflow;
  try {
    workflow = readFileSync(workflowPath, 'utf8');
  } catch (error) {
    throw new Error(`cannot read workflow ${workflowPath}: ${error.message}`);
  }
  return workflow
    .split('\n')
    .map((line, index) => ({ line, index: index + 1 }))
    .filter(({ line }) => !line.trim().startsWith('#')) // ignore comments
    .filter(({ line }) => FORBIDDEN_DEPLOY_PATTERNS.some((pattern) => pattern.test(line)));
}

// CLI entry point — guarded so importing this module never executes it
// (verify-release.mjs imports checkNoDeploy and hands it the workflow path;
// in that context process.argv[2] is the release tag, not a file).
const isDirectRun =
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (isDirectRun) {
  const workflowPath = process.argv[2] ?? '.github/workflows/release.yml';
  const hits = checkNoDeploy(workflowPath);

  if (hits.length > 0) {
    process.stderr.write(
      `${workflowPath} must not deploy to a hosted environment; found deployment markers:\n` +
        hits.map(({ line, index }) => `  line ${index}: ${line.trim()}`).join('\n') +
        '\n',
    );
    process.exit(1);
  }

  process.stdout.write(`${workflowPath}: no hosted-environment deployment markers found.\n`);
}