# AGENTS.md

This file applies to the entire `teamem-server/` repository and is intended for coding agents working in this repository.

## 1. Project Goal

Teamem is an open-source, self-hostable team knowledge compilation service. Its core loop is:

```text
GitHub webhook / teamem init / MCP memory_write
  -> ingestion, validation, and pre-persistence redaction
  -> Postgres events + pg-boss compilation queue
  -> F1 typed extraction + F2 entity resolution/merging
  -> structured concept pages
  -> MCP progressive disclosure, SessionStart context, and Web UI
```

The product's value is not “storing more observations.” It continuously compiles evidence-backed team signals into knowledge that can be merged, traced, and exported. Prioritize a real end-to-end loop, compilation quality, and the consumption experience. Do not sacrifice trustworthiness for feature count.

## 2. In-Repository Specifications and Precedence

This file contains the product boundaries, Q1-Q11/N1-N8 decisions, M0-M3 milestones, and validation rules required for coding. The repository remains self-contained for implementation and validation; private planning context is supplementary. Interpret in-repository specifications in this order:

1. `packages/schema/src/`: the frozen v0.2 executable DTO specification; highest precedence.
2. `apps/server/src/db/schema.ts` and committed migrations: the current database reality, which must remain consistent with the DTOs and the invariants in this file.
3. This `AGENTS.md`: product scope, architectural red lines, authorization model, and definition of done.
4. `README.md`, tests, and code comments: useful for understanding the current state, but they cannot independently override the first three sources.

When a prose summary conflicts with Zod code, `packages/schema/src/` wins. When the database implementation conflicts with the frozen contract, do not treat the current implementation as the new specification. Do not casually edit a frozen contract. Propose an explicit v0.3 change, enumerate the database, API, compiler, UI, MCP, CLI, export, and external compatibility impact, and add migrations and contract tests.

### 2.1 Private Planning Context

When working on product scope, frozen contracts, M0 implementation, or acceptance tasks:

1. Read `tasks/M0/README.md` through the `teamem-docs` MCP server.
2. Use `search_documents` with terms from the current task to search the PRD and MVP planning documents.
3. Use `read_document` only for headings relevant to the current task. Keep each read between 2,000 and 5,000 characters; request a narrower heading or subheading before requesting more context.
4. Do not read the complete PRD or MVP documents at the start of every task.
5. Skip this lookup for spelling, formatting, comment-only, and purely mechanical refactoring tasks.
6. In the final report, list the MCP `sourceCommit`, document IDs, and headings consulted. If the MCP server was unavailable, report that explicitly rather than claiming the documents were read.

MCP planning prose provides rationale and task context only. It cannot override the in-repository precedence above or expand the authorized scope of a task.

## 3. Repository and License Boundaries

This repository is a pnpm monorepo:

- `apps/server`: AGPL-3.0-only; ingestion API, compiler, worker, MCP, GitHub connector, and server configuration.
- `apps/web`: AGPL-3.0-only; React + Vite + shadcn/ui management surface.
- `packages/schema`: independent MIT package published as `@teamem/schema` for the server, the standalone CLI, and future connectors.
- `apps/server/drizzle`: database migrations and Drizzle metadata.

The root license is AGPL. `packages/schema` must retain its own MIT `LICENSE` and package `license`/`publishConfig`. Do not move AGPL server implementation into the MIT schema package, and do not let the schema package accidentally inherit the root license.

The `teamem` CLI belongs in the separate MIT-licensed `teamem-ai/cli` repository and is created in M1. Unless a task explicitly requires otherwise, do not create another CLI package inside this monorepo.

## 4. Fixed Technical Direction

- TypeScript; use Zod for every cross-boundary input.
- Postgres + pgvector; Drizzle ORM.
- pg-boss for queues; do not introduce Redis/Valkey.
- Default deployment is three containers: `postgres + server + worker`. `TEAMEM_ALL_IN_ONE=true` may embed the worker in the server.
- The Web app is a Vite SPA served directly by the server; do not add a Next.js deployment unit.
- LLMs use BYO keys: Claude, OpenAI, OpenRouter, or a custom OpenAI-compatible endpoint.
- The default embedding target is 1536 dimensions. When semantic capability is unavailable, explicitly fall back to FTS; never pretend vector search succeeded.
- Environment variables use the `TEAMEM_` prefix. Passwords and keys must not have insecure defaults or accidentally inherit bare host variables such as `OPENAI_API_KEY`.

Do not replace these choices based solely on personal preference. Before changing one, explain the impact on self-hosting complexity, licensing, migrations, and the ten-week validation window.

## 5. Non-Negotiable Engineering Red Lines

### 5.1 It Must Actually Work

- Do not put hard-coded demo data, mock responses, or preloaded “sample results” in production paths to make a feature look complete.
- Fixtures and mocks belong only in tests. With no real data, the UI must show an honest empty state.
- Mark an endpoint, queue, or page complete only after its real dependency chain works end to end. Existing types, comments, or a fake that returns an empty array do not constitute a closed loop.
- Report unfinished capability explicitly. Do not swallow errors through fallbacks and then present success.

### 5.2 LLM Output Must Be Structured

- F1/F2 must use provider-native structured output: forced tool use, JSON Schema/response formats, or equivalent.
- Output must pass the `@teamem/schema` Zod schema before persistence.
- Do not use “free text + regex/XML tag parsing.”
- Validation failure is an explicit compilation failure. Retry or route it to review; never loosely accept something that is “approximately correct.”

### 5.3 Redact Before Persistence

The fixed order is:

```text
receive -> Zod validation -> recursive stripPrivateTags -> persist -> enqueue
```

Remove complete `<private>...</private>` sections from every string field in the payload. Apply the same rule to GitHub, CLI, and MCP. The system must not retain a queryable pre-redaction copy. Logs, audits, errors, and job snapshots must not leak the original content either.

### 5.4 Always Preserve Original Facts

Store original claims, verification state, authentication context, and parsed results separately. Parsing can be rerun; original history cannot be reconstructed:

- `actor` is the subject claimed by the source event and may be `null`. Preserve unknown as unknown; never fabricate a person or a `system` placeholder.
- `actor_provenance` and `occurred_at_provenance` are independent dimensions.
- `ingested_by` is derived by the server from the credential or connector; clients cannot provide it.
- Record the credential and resolved principal at event time. Later key rebinding or revocation must not rewrite history.
- `client_claimed` actors do not enter contributors by default. Only a signature-verifying connector may produce `webhook_verified`.

### 5.5 Enforce Multi-Tenant Isolation at the Query Entry Point

- Every business query must explicitly carry `team_id`, even during the single-team phase.
- HTTP/session/connector layers first produce a `ScopeContext`. Every scoped repository must require a scope; do not expose an unscoped business-query entry point.
- Use tagged scopes to distinguish a single project from team-wide access. Do not treat `allProjects` as an ordinary project scope.
- Workers, pg-boss retries, scheduled jobs, purge operations, and scripts inherit the initiator's scope and preserve initiated-by attribution.
- Detail lookups must execute scoped SQL directly. Never fetch without scope and authorize afterward in the business layer.
- Cross-team access must return exactly the same 404 response as a genuinely missing resource.
- Composite database foreign keys must continue to enforce `team_id + project_id + parent` consistency. Future RLS is a second line of defense, not a replacement for application scope.

Cross-tenant operational aggregation code must never enter the public repository. It belongs only in a future, separate private operations service.

## 6. Frozen Contract Quick Reference

### 6.1 Concept Pages

- The canonical identity is a UUID. `path` is only a readable, renameable locator.
- Current paths and historical aliases share the `concept_paths` namespace. Paths are unique within a project, and each concept has at most one current path.
- Paths are lowercase; segments match `[a-z0-9-]` and are separated by `/`; maximum length is 200. Empty segments, `.`, `..`, a leading `/`, and a `.md` suffix are forbidden.
- Internal body links use `teamem://concept/<uuid>`. Export resolves them to relative Markdown links while preserving the UUID in frontmatter.
- Type is `decision | gotcha | convention | runbook | service | concept`.
- Status is `active | superseded | disputed | needs-review`.
- Confidence is `high | medium | low`. Contradictory evidence changes status to `disputed`; it does not merely lower confidence.
- Every concept must have at least one evidence item. `repo_file` evidence must include an immutable repository, commit SHA, and path.
- Update `last_confirmed` only when new evidence confirms the existing claim or a human explicitly confirms it. Ordinary rewrites do not refresh it.
- Concepts, evidence, contributors, and paths are first-class queryable data. Do not degrade them into one `content TEXT` field or an unconstrained metadata blob.

### 6.2 Ingestion, Idempotency, and Jobs

- Public `POST /v1/events` accepts only `cli_init`. GitHub events come from the signature-verifying webhook connector, and the MCP endpoint constructs `mcp_write` internally.
- Single, batch, and compilation DTOs are defined in `packages/schema/src/ingest.ts`. Batch limit is 500, request-body limit is 5 MB, processing is non-atomic, and a normal 200 response contains per-item results.
- Default asynchronous ingestion returns 202. `wait=true` waits at most 30 seconds: completion returns 200, while timeout returns 202 with a job. `compile=false` creates no job.
- Transport idempotency is based on channel facts, not the parsed kind. The core unique identity is project, channel, delivery ID, and item key.
- Compute the payload hash over canonical JSON after redaction: sorted keys, no whitespace, UTF-8.
- Replaying the same idempotent identity and hash returns the original result without recompiling. A different hash returns 409 `idempotency_conflict`.
- The server generates a UUID for each MCP tool invocation to cover pipeline retries only. Independent writes with identical content are handled by F2 semantic merging; do not forbid them with a content hash.
- A compilation idempotency key is required. Job idempotency includes project, job kind, and key, and preserves both request hash and result snapshot.
- Job states and per-event results must use the frozen discriminated unions. Do not invent near-equivalent strings.

### 6.3 Queries, Pagination, and Exposure Boundaries

- M0 provides list and detail endpoints for concepts, events, and jobs. Audit queries activate according to the milestone plan. M1 search is a separate `POST /v1/search` endpoint.
- Lists return summaries only. Event payload appears only in detail responses, requires `read:payload`, and that scope must also include `read`.
- Default limit is 20 and maximum is 100. Return 400 above the maximum; do not silently clamp it.
- Use composite cursors everywhere, never offset pagination. Tampered or invalid cursors fail according to the contract.
- Concepts sort by `last_confirmed desc + uuid`; events/jobs/audit sort by `created_at desc + id`; timelines display `occurred_at`.
- SessionStart `/v1/context` has its own value/confidence/freshness budget strategy and must not simply reuse concept-list ordering.
- If an audit write fails for a sensitive read, fail closed. An ingestion-audit failure does not roll back the primary event, but it must produce a server error log.
- Audit records must not contain request bodies, payloads, or raw search-query text. Audit queries do not recursively audit themselves.
- Purge removes project events/concepts/jobs and related data, but retains audit records and principals and records deletion counts.

### 6.4 Versions and Errors

- API `/v1`, event envelope, payload schema, and concept schema are four independent versions.
- Forward-adapt known older versions. Return `unsupported_version` for unknown newer versions.
- Times use UTC `Z` and fixed millisecond-precision ISO 8601.
- Use the `@teamem/schema` error envelope and stable error-code/HTTP mapping. Do not expose internal exceptions, SQL, keys, or original payloads.
- Do not duplicate drifting cursor, ID, response DTO, or error-code definitions inside server or web apps.

## 7. SaaS Extension Seams

SaaS is another deployment configuration of the same public core plus a small set of private extensions, not a fork.

- Business code depends on an injected `EntitlementsService`; do not scatter `if (isSaaS)`. The self-hosted resolver enables self-hosted capabilities, but `platformManagedLlm` is false.
- LLM configuration must recognize the `platform-managed` branch. Self-hosted builds reject it explicitly and must not silently no-op.
- Connectors register through one registry. Connector openness must extend end to end—from the private package, normalized event, actor, mapping, and idempotency through persistence. Changing only TypeScript fields to `string` while database enums still cannot store them does not complete the extension seam.
- Storage for a generic external connector must preserve connector identity so different providers sharing a channel cannot collide on delivery-ID idempotency.
- Private Slack/Gmail packages should implement only provider access, signature verification, and `NormalizedEvent` conversion. Compilation, merging, persistence, and queries reuse the public core.
- Connector signature failures should use a distinguishable verification error mapped to 401. Do not misreport all internal failures as authentication failures.
- GitHub App credentials come from configuration; never hard-code the assumption of one installation.
- OKF exports must remain future-importable and round-trip compatible. The import endpoint is a SaaS backlog item, not part of the MVP.
- Core fixes must benefit both self-hosted and SaaS deployments. Avoid compatibility layers and duplicate business implementations.

## 8. Security and Authorization Rules

- Store only SHA-256 hashes of API keys. Return plaintext once at minting time. Revoked keys immediately receive 401.
- Normal keys must bind to a project. Team-wide keys require explicit `allProjects=true`. Database CHECK constraints must not degrade into comments.
- API keys grant data-plane scopes only; they never gain administrative capability.
- Web roles: viewer browses concepts/jobs; member adds search/context/detail; admin adds key, connector, LLM, audit, and payload management; owner adds purge, role management, and team deletion.
- Sensitive access, authentication failures, and cross-tenant probes must not reveal resource existence through response differences.
- Verify a webhook before granting `webhook_verified`. Preserve the raw body for signature verification; do not parse and reserialize it before verification.

## 9. Milestone Boundaries

- M0: ingest a real GitHub event; redact, persist, enqueue, and run minimal F1; produce the first concept page with evidence; also provide list/query, scope enforcement, and the three low-cost SaaS seams.
- M1: complete the F1/F2 compilation loop, real pgvector/FTS, standalone CLI init, MCP `search/get_page/timeline`, and the “why” demonstration.
- M2: Web onboarding, GitHub OAuth, members/RBAC, SessionStart, audit/purge, multi-team support, and a publishable Compose setup.
- M3: OKF export, real E2E, documentation, and public release.

The MVP does not include F3/F4/F5, a full agent-capture hook suite, Slack/Gmail/meeting connectors, SaaS hosting, or billing. Future fields and interface seams are allowed, but placeholder UI/endpoints must not imply that a capability is implemented.

Plan only the next milestone in detail. Do not expand all ten weeks of work in advance for the sake of appearing complete; work after M1 must respond to real quality measurements and design-partner feedback.

## 10. Validation Orientation

Engineering priorities serve these validation outcomes:

- F0 commit/PR/issue anchoring should prefer omission over a wrong match. A false “why” poisons trust.
- Measure F1 signal-to-noise ratio, F2 wrong-assignment rate, and duplicate-page rate using real team data.
- M1 must demonstrate the “why” moment live: conclusion + PR discussion + implementation commit.
- The core M2 behavioral evidence is at least two design partners completing self-hosting within 30 minutes and continuing daily use.
- W5 is the midpoint gate. Stop expanding M2/M3 investment if payment/deployment intent or F2 merge quality misses the threshold.
- Do not substitute test coverage, file count, or page count for those product validations.

## 11. Development and Validation Workflow

Before editing:

1. Check `git status` and preserve existing user and unrelated changes.
2. Identify affected frozen contracts, database constraints, scopes, and milestones.
3. Reuse `@teamem/schema`; do not duplicate DTOs inside an app.
4. For data-model changes, consider Drizzle schema, SQL migration, existing-data upgrades, and real PostgreSQL counterexamples together.

Common repository checks:

```bash
pnpm lint
pnpm typecheck
pnpm test
```

Changes involving database constraints, migrations, pgvector, idempotency, or tenant isolation require integration tests against real PostgreSQL/pgvector. Tests may honestly skip when `TEST_DATABASE_URL` is missing, but do not report a skip as database verification and do not replace red-line validation with a mock database.

For Docker changes, verify both the standard three-container topology and the explicit all-in-one topology; parsing the YAML alone is insufficient. For API, queue, compiler, or MCP changes, add at least one test from a real entry point to real persistence or a real consumption exit.

Before declaring completion:

- Run lint, typecheck, unit, integration, and E2E checks in proportion to risk.
- Turn discovered counterexamples into regression tests; name tests after the Q/N/security decision they pin down.
- Confirm that production paths contain no fixtures, silent fallbacks, unscoped queries, or pre-redaction writes.
- Report checks that were not run and explain why.
- Do not mark planning-document tasks complete unless the task explicitly asks for a documentation update and acceptance evidence exists.

## 12. Definition of Done

A change is complete only when all of the following are true:

- The real user path or internal data path works end to end; it is not merely an interface/type skeleton.
- DTOs, database constraints, migrations, and implementation agree.
- Tenant scope, identity provenance, redaction, idempotency, audit behavior, and error exposure have been tested with counterexamples.
- New behavior has success, rejection, and replay/boundary tests.
- The frozen contract remains compatible, or the change follows a formal new version.
- License boundaries remain correct.
- Validation reporting is honest; unrun real-dependency tests are not presented as passing.

If a task asks for “acceptance” or “review,” perform read-only checks and report evidence by default. Do not fix code or update documentation unless requested.

## 13. Git and Pull Request Policy

- `main` is the only long-lived integration branch. Never push directly to it; use a short-lived branch and pull request.
- Follow `docs/GITFLOW.md` for branch names, review gates, release preparation, and emergency handling.
- Format pull-request titles as `type(scope): imperative summary`; the validated title becomes the squash commit on `main`.
- Add a DCO sign-off to every pull-request commit with `git commit -s`. Select exactly one `semver:major`, `semver:minor`, `semver:patch`, or `semver:none` label.
- Do not bypass required checks, unresolved review conversations, or real-Postgres validation. Use squash merge only.
- Product releases come from annotated immutable `vMAJOR.MINOR.PATCH` tags on `main`. Release automation may publish a GitHub Release and GHCR image, but it must never deploy to a hosted environment.
