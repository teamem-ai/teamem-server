# Git Flow and GitHub Governance

This repository is an open-source product repository containing a server and a UI. It publishes releases, but it does not deploy a hosted environment.

## Goals

- Keep `main` releasable at all times.
- Make contribution from forks straightforward.
- Preserve a readable, bisectable linear history.
- Give every release one source commit, one immutable SemVer tag, one GitHub Release, and one container image digest.
- Keep publication separate from deployment. This repository has no staging/production environment, deployment approval, or cloud credential.

## Model: Protected-Main Trunk-Based Development

There is no long-lived `develop` branch and no permanent release branch. Long-lived branches make a small team merge fixes twice and allow the open-source and release lines to drift.

`main` is the only integration branch. All work happens on short-lived branches and enters `main` through a pull request.

```text
feat/* ─────┐
fix/* ──────┼─> pull request ─> protected main ─> release/vX.Y.Z PR ─> vX.Y.Z tag
docs/* ─────┤                                                        ├─> GitHub Release
chore/* ────┘                                                        └─> GHCR image
```

Publishing an image is distribution, not deployment. The release workflow never contacts a runtime environment.

## Branches

Use lowercase kebab-case names:

| Prefix | Use | Example |
|---|---|---|
| `feat/` | User-visible capability | `feat/github-webhook-ingest` |
| `fix/` | Defect or regression | `fix/cursor-tamper-rejection` |
| `security/` | Security hardening or private-advisory fix branch | `security/redaction-boundary` |
| `refactor/` | Behavior-preserving change | `refactor/scoped-repositories` |
| `perf/` | Measured performance work | `perf/event-cursor-index` |
| `test/` | Test-only work | `test/job-idempotency-counterexample` |
| `docs/` | Documentation only | `docs/self-hosted-quickstart` |
| `ci/` | GitHub Actions and repository automation | `ci/postgres-integration` |
| `chore/` | Maintenance | `chore/update-dependencies` |
| `release/` | Temporary release preparation only | `release/v0.1.0` |

Delete branches automatically after merge. A normal branch should live for hours or days, not weeks. Split a large change into independently valid vertical slices.

## Starting Work

```bash
git switch main
git pull --ff-only
git switch -c feat/short-description
```

Keep the branch current without creating merge commits:

```bash
git fetch origin
git rebase origin/main
```

Do not force-push a branch after review unless rebasing or amending is necessary. If you do, use `git push --force-with-lease`, never plain `--force`.

## Commits and DCO

All pull-request commits require a Developer Certificate of Origin sign-off:

```bash
git commit -s -m "feat(server): ingest verified GitHub webhooks"
```

The sign-off certifies that the contributor has the right to submit the change under the repository's licenses. This matters because the root/server/web are AGPL while `packages/schema` is MIT.

Local commit messages should be clear, but the pull-request title is the permanent squash commit. The required PR-title format is:

```text
type(scope): imperative summary
```

Allowed types: `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, and `revert`.

Examples:

```text
feat(server): add idempotent event ingestion
fix(schema): reject cross-tenant concept paths
docs(repo): explain the self-hosted release flow
```

Use `!` before the colon for a breaking change and explain migration impact in the PR body:

```text
feat(schema)!: version the event envelope
```

## Pull Requests

Every change, including maintainer and release changes, uses a pull request. Draft PRs are encouraged for early CI and design feedback.

Before requesting review:

1. Rebase on current `origin/main`.
2. Complete the PR template.
3. Select exactly one SemVer label:
   - `semver:major` for a breaking public contract or incompatible release;
   - `semver:minor` for backward-compatible capability;
   - `semver:patch` for backward-compatible fixes;
   - `semver:none` for changes that should not determine the next version.
4. Run `pnpm lint`, `pnpm typecheck`, and `pnpm test`.
5. Run real PostgreSQL/pgvector tests for database, migration, tenant, or idempotency changes.
6. Ensure every commit has a DCO sign-off.

Required checks are intentionally stable:

- `required / pr-policy`
- `required / dco`
- `required / lint`
- `required / typecheck`
- `required / unit (node 20)`
- `required / unit (node 22)`
- `required / postgres`
- `required / dependency-review`

CodeQL is initially non-blocking while the baseline is established. Make it required only after it has produced stable results on normal and fork pull requests.

All review conversations must be resolved. Do not merge with a skipped real-database check while claiming the database was verified.

## Merge Policy

- Squash merge only.
- The validated PR title becomes the commit title on `main`.
- No merge commits and no rebase-merge through the GitHub UI.
- Linear history is required.
- Direct pushes, force pushes, and deletion of `main` are blocked.
- The branch must be up to date with `main` before merge.
- Auto-merge is allowed after all requirements pass.

The initial single-maintainer configuration requires a PR but zero approving reviews, because GitHub does not allow an author to approve their own PR. CI, DCO, resolved conversations, and maintainer responsibility still apply. As soon as a second active maintainer exists:

1. Create a `teamem-ai/maintainers` team.
2. Replace the personal CODEOWNER with that team.
3. Set `TEAMEM_REQUIRED_APPROVALS=1` and re-run the settings script.
4. Enable required code-owner review for schema, migrations, security, workflows, and release automation.

For a high-volume period, GitHub's merge queue can replace repeated contributor rebases. The build/test CI already listens for `merge_group`; before enabling the queue, add merge-group handling for every policy check that remains required and test the queue on a non-critical pull request.

## Versioning

Product releases use SemVer tags in the form `vMAJOR.MINOR.PATCH`.

Before 1.0:

- minor releases may contain substantial new capability;
- patch releases remain backward-compatible fixes;
- breaking changes still require explicit migration notes and a `!` PR title.

The root, server, web, and schema package versions move in lockstep for product releases. This keeps one product tag understandable while the project is young. Reconsider independent package versioning only when `@teamem/schema` has a real external release cadence.

## Release Process

Releases are deliberate, not created on every merge.

1. Decide the next version from merged `semver:*` labels.
2. Create `release/vX.Y.Z` from current `main`.
3. Update the version in:
   - `package.json`;
   - `apps/server/package.json`;
   - `apps/web/package.json`;
   - `packages/schema/package.json`.
4. Move relevant entries from `CHANGELOG.md` under `## [X.Y.Z] - YYYY-MM-DD`.
5. Open PR `chore(release): vX.Y.Z` with `semver:none`.
6. Run all required checks and obtain the normal review.
7. Squash-merge the release PR.
8. On the exact resulting `main` commit, create an annotated, preferably signed tag:

   ```bash
   git switch main
   git pull --ff-only
   git tag -s vX.Y.Z -m "teamem vX.Y.Z"
   git push origin vX.Y.Z
   ```

9. The release workflow verifies the tag/version/changelog and full test suite, publishes `ghcr.io/teamem-ai/teamem-server`, adds build provenance, and creates the GitHub Release.
10. Smoke-test the published image as a user would. This is release verification, not deployment.

Release tags are immutable. Never move or reuse a version tag. If a release is bad, fix forward and publish the next patch.

## Hotfixes

There is no separate production branch because this repository does not deploy a hosted service.

1. Branch `fix/...` or `security/...` from current `main`.
2. Add a regression test.
3. Use the normal PR and required checks; do not bypass protection.
4. Merge and publish the next patch release through the normal release process.

If a vulnerability is not yet public, use a private GitHub Security Advisory and its private fork. Publish the advisory and patch release together.

## GitHub Repository Settings

The canonical settings are applied by `scripts/github/apply-repository-settings.sh` after the workflow files have landed on `main`.

| Setting | Value |
|---|---|
| Default branch | `main` |
| Merge methods | squash only |
| Auto-merge | enabled |
| Delete head branches | enabled |
| Update branch button | enabled |
| Issues | enabled |
| Discussions | enabled |
| Wiki | disabled; documentation stays versioned in Git |
| Default `GITHUB_TOKEN` | read-only; workflows elevate individual jobs only |
| Actions | allowed, but every external action must be pinned to a full commit SHA |
| Secret scanning/push protection | enabled where GitHub makes it available |
| Dependency graph/Dependabot | enabled |

The `main` repository ruleset requires pull requests, linear history, no deletion/force-push, resolved conversations, and the required checks listed above. A separate tag ruleset blocks deletion and movement of `v*` tags.

## Safe Bootstrap Order

Do not enable required checks before the workflows exist on the default branch.

1. Merge the PR that adds these workflows and policy files.
2. Confirm the `main` push CI and CodeQL runs succeed.
3. Open a temporary signed-off PR with `semver:none`. Confirm PR policy, DCO, dependency review, and every build/test check succeeds; then close it or merge it normally. This creates real bootstrap evidence before those contexts become mandatory.
4. From a clean, up-to-date checkout, preview settings:

   ```bash
   ./scripts/github/apply-repository-settings.sh
   ```

5. Apply the solo-maintainer configuration:

   ```bash
   TEAMEM_GOVERNANCE_CHECKS_VERIFIED=true \
     TEAMEM_REQUIRED_APPROVALS=0 \
     ./scripts/github/apply-repository-settings.sh --apply
   ```

6. Open a small test PR and prove direct push is blocked and all required checks gate merge.
7. When a second maintainer is active, re-run with `TEAMEM_REQUIRED_APPROVALS=1` (keeping `TEAMEM_GOVERNANCE_CHECKS_VERIFIED=true`).

## Emergency Procedure

Do not use a force push as an emergency mechanism. If GitHub itself or a broken ruleset makes all PRs impossible:

1. Record an issue describing the incident.
2. Temporarily disable only the affected ruleset in repository settings.
3. Merge the smallest reviewed fix through a PR.
4. Re-enable the ruleset immediately.
5. Record the ruleset history and preventive action in the issue.

Ruleset bypass is an audited emergency tool, not a normal maintainer shortcut.
