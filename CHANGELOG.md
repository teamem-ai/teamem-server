# Changelog

All notable changes to Teamem will be documented in this file.

The format follows Keep a Changelog, and releases use Semantic Versioning.

## [Unreleased]

### Added

- License boundary audit (`pnpm license:check`): enforces root/server/web
  AGPL-3.0-only and `packages/schema` MIT with no bleed — wrong declared
  license, missing/incorrect LICENSE text, AGPL deps or imports leaking into
  the MIT package, and missing LICENSE in the npm pack all fail the check.
  Runs in CI (`licenses`) and in the release verification workflow.
- Release hygiene guard (`.github/scripts/check-no-deploy.mjs`): the release
  workflow must never deploy to a hosted environment; the marker scan runs on
  every PR and again at tag time.
- CI `build` job: server + web SPA must build on every PR, not only at release.
- CI `release-hygiene` job for the no-deploy guard.
- `docs/release-checklist.md`: pre-tag gates, release-note/demo-GIF placement
  contract (founder-owned content), and post-release verification runbook.
- Release verification workflow now runs the DB-backed integration suite
  against real PostgreSQL/pgvector (previously only unit tests ran), plus the
  license boundary audit.
- Compose smoke CI — `required / compose (standard|all-in-one)`: both
  deployment topologies are boot-tested on every PR (password enforcement,
  health/readiness, migrations, bootstrap → ingest → compile job → worker,
  scaling safety, SIGTERM), and a `compose` gate in the release workflow
  blocks GitHub Release/GHCR publish if the container does not boot. The
  smoke script previously existed but was never wired into CI; running it
  caught a container startup crash that a build-only check cannot see.
- `check-no-deploy.mjs` is now a side-effect-free module with a guarded CLI
  entry point: importing it from `verify-release.mjs` no longer treats the
  release tag as a workflow path (tag-time verification previously crashed
  with ENOENT before reaching any check).
- LLM provider-connection tests in the DB-backed integration suite are
  hermetic: the provider HTTP boundary is faked via a `fetchImpl` seam, and
  the live real-provider round-trip is opt-in (`TEAMEM_LLM_LIVE_TEST=1`).
  The required `postgres` job no longer depends on outbound
  api.openai.com reachability — that dependency is what made CI red on main.
- Initial repository, frozen v0.2 contracts, database schema, and M0 architecture groundwork.
- Job retry distinguishes **Retry failed** (re-run only the failed events) from **Retry all**, mirroring CI re-run semantics; failed events are re-run without redoing already compiled/skipped ones.
- Jobs that finish with a mix of compiled and failed events show a distinct **Completed with errors** status instead of a plain **Completed**.
- [docs/QUICKSTART.md](./docs/QUICKSTART.md): the 30-minute stranger path from `docker compose up` to the agent's first cited answer, with Claude Code (`claude mcp add`) and Codex (`codex mcp add`) onboarding, per-step expected outputs, and an explicit verified-vs-flagged table.

### Fixed

- The server/worker Docker image crashed at boot with `Dynamic require of "process" is not supported` — yaml (a dependency of `@teamem/schema`'s OKF export contract) was inlined into the ESM bundle, where its CJS `require('process')` cannot be converted. `yaml` is now external to the server and schema bundles (and symlinked into the runtime node_modules), so `docker compose up` boots cleanly again.
- Compile jobs left stuck in `processing` after a worker restart are now auto-reclaimed to `failed` on worker startup, so they can be retried instead of blocking retry indefinitely.
- LLM structured-output parsing recovers output that a weaker OpenAI-compatible model wrapped in prose or a Markdown code fence, or mis-encoded (raw control characters, under-escaped backslashes) — reducing spurious `schema_validation_failed` compile failures. An unescaped inner double-quote remains an honest failure rather than risk fabricating content.
- Output cut off by a model's token limit is reported as `output_truncated` instead of masquerading as `schema_validation_failed`, and the default output-token ceiling was raised.
- An LLM request that times out while streaming the response body is classified as `timeout` instead of a misleading `provider_error`.
- Concept detail page renders with its intended layout and typography (styles that were missing from the app were ported from the design system).

[Unreleased]: https://github.com/teamem-ai/teamem-server/compare/v0.0.0...HEAD

