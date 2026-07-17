## Summary

<!-- What changes, and why is this the smallest useful change? -->

## Contract and Security Impact

<!-- DTO/version, migration, tenant scope, auth, redaction, idempotency, audit, license boundary. Write "None" only after checking. -->

## Verification

<!-- Exact commands and results. Disclose skipped real-dependency tests. -->

- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] Real PostgreSQL/pgvector test, when relevant
- [ ] Docker/E2E test, when relevant

## Release

- [ ] Exactly one `semver:major`, `semver:minor`, `semver:patch`, or `semver:none` label is applied.
- [ ] Breaking changes use `!` in the PR title and include migration notes.
- [ ] Every commit contains a DCO `Signed-off-by` trailer.

