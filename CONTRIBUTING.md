# Contributing to Teamem

Thank you for contributing. Teamem welcomes focused issues and pull requests from forks.

## Before You Start

- Read `AGENTS.md` for architectural and security invariants.
- Read `docs/GITFLOW.md` for branch, PR, and release policy.
- For a substantial feature or frozen-contract change, open an issue before implementation.
- Security vulnerabilities must be reported privately as described in `SECURITY.md`.

## Development

Requirements: Node.js 20 or 22 and the pnpm version declared in `package.json`.

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
```

Database behavior must be tested against real PostgreSQL/pgvector. A skipped database test is not database verification.

## Branch and Pull Request

1. Fork the repository or create a short-lived branch.
2. Use a branch prefix such as `feat/`, `fix/`, `docs/`, `test/`, or `ci/`.
3. Sign off every commit for DCO compliance:

   ```bash
   git commit -s -m "fix(server): reject an invalid cursor"
   ```

4. Open a pull request using the template.
5. Use a Conventional Commit-style PR title such as `feat(server): add event ingestion`.
6. Ask a maintainer to apply exactly one `semver:*` label.
7. Resolve review conversations and keep the branch current with `main`.

Pull requests are squash-merged. The PR title becomes the permanent commit title on `main`.

## License Boundary

- Root, server, and web contributions are AGPL-3.0-only.
- `packages/schema` contributions are MIT.

By adding a DCO sign-off, you certify that you have the right to submit the contribution under the applicable repository license.

