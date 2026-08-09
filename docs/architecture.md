# teamem-server: Architecture Overview

> **Compiled by teamem from this repository.**
>
> This page was produced by dogfooding: teamem ingested this repo's own
> merged pull requests (commits/PRs) as `cli_init` events, compiled them with
> its own F1 extraction + F2 merge pipeline, and exported the resulting
> concept pages through its own OKF bundle renderer. A human then structured
> and polished the compiled material into this architecture overview and
> added the in-repo authoritative facts the compiler does not chase
> (`AGENTS.md` invariants, frozen schemas). No fact here is pulled from
> outside this repository.
>
> ------
> **Provenance of this revision**
>
> - Source: `teamem-ai/teamem-server`, the 131 merged pull requests merged
>   between 2026-07-18 and 2026-08-09 (PRs #4–#145), plus `AGENTS.md`,
>   `packages/schema`, this repo's migrations, and `docs/`.
> - Compilation: 131 events → 1 batch store (compile=false) → 1 explicit
>   compilation → 45 concept pages, 76 evidence items, 45 contributors.
> - Export: `GET /v1/export` OKF bundle (the M3 export feature compiling its
>   own repo's compiled output); the committed snapshot lives in
>   [`docs/dogfooding/2026-08-09/`](./dogfooding/2026-08-09/index.md).
> - How to re-run and the honest limitations of this compilation are in
>   [“How this page was compiled”](#how-this-page-was-compiled) at the end.
> ------

---

## 1. What teamem is

**Team memory for AI coding agents.** teamem-server is an open, self-hostable
service that ingests a team's engineering signals (GitHub commits, PRs,
issues), continuously compiles them with LLMs into a structured, interlinked
knowledge base (open markdown format, fully exportable), and serves it to
every team member's code agent over MCP with progressive disclosure.

The core loop is:

```text
GitHub webhook / teamem init / MCP memory_write
  -> ingestion, validation, and pre-persistence redaction
  -> Postgres events + pg-boss compilation queue
  -> F1 typed extraction + F2 entity resolution/merging
  -> structured concept pages
  -> MCP progressive disclosure, SessionStart context, and Web UI
```

The product's value is not “storing more observations”: it continuously
compiles evidence-backed team signals into knowledge that can be merged,
traced, and exported. The compiled knowledge in this repository is organized
as **services** (running systems), **decisions** (why), **gotchas**
(watch out), **conventions**, **runbooks** (how), and **concepts** (the
knowledge contract itself).

## 2. Repository layout

| Path | Package | License | Purpose |
|---|---|---|---|
| `/` (root) | — | AGPL-3.0-only | pnpm monorepo, repository default license |
| `apps/server` | `@teamem/server` | AGPL-3.0-only | Ingestion API, F1/F2 compile engine, MCP endpoint, GitHub connector, queue worker |
| `apps/web` | `@teamem/web` | AGPL-3.0-only | Portal UI (React + Vite + shadcn/ui), served by the server |
| `packages/schema` | `@teamem/schema` (published) | **MIT** | Frozen v0.2 contract DTOs & Zod validators — the knowledge format carrier, free for clients to import |

The license split is deliberate: the portal stays AGPL so the product stays
open; the schema package stays MIT so the knowledge format is freely
adoptable by clients, connectors, and third-party tools. The standalone
`teamem` CLI lives in the separate MIT repository `teamem-ai/cli`.

## 3. Runtime topology and processes

Three containers, no Redis: the compile queue is **pg-boss**, which lives
inside Postgres — one fewer service to operate than comparable stacks.

```text
                  ┌──────────────────────────┐
GitHub webhook ──> │  server  (Hono on Node)  │
teamem init ─────> │  - HTTP API  /v1         │
MCP tools ───────> │  - MCP endpoint          │
                  └────────────┬─────────────┘
                               │ pg-boss (inside Postgres)
                  ┌────────────▼─────────────┐
                  │  worker  (F1 + F2)        │
                  └────────────┬─────────────┘
                               ▼
                  Postgres + pgvector (concepts, events, jobs)
```

- **Standard topology**: `postgres + server + worker` (3 containers).
- **All-in-one**: `TEAMEM_ALL_IN_ONE=true` embeds exactly one compile worker
  in the server process (2 containers); the HTTP read path and worker both
  resolve the team's LLM config per job.
- **Processes**: the server and worker are two independent, production-shaped
  entrypoints (`apps/server/src/index.ts` and `worker.ts`) with an ordered
  startup (`DB → queue → HTTP → worker`) and shutdown (`worker → queue →
  HTTP → DB`) sequence. Hono was frozen as the HTTP runtime for its ESM-native
  design and raw request-body access (compiled: `services/server-worker-entry-points` (`services/server-worker-entry-points`)).

## 4. Ingestion and the persistence path

Every source must anchor to a durable artifact (a landed decision,
convention, or gotcha) before it is admitted; undifferentiated activity
streams are noise and have no ingestion path.

1. **Receive** — public `POST /v1/events` and `/v1/events/batch` accept only
   `cli_init`; GitHub events arrive via the signature-verifying webhook
   connector; the MCP endpoint constructs `mcp_write` internally.
2. **Validate** — every payload passes a frozen Zod DTO (`@teamem/schema`).
3. **Redact** — `stripPrivateTags` removes complete `<private>…</private>`
   sections from every string field *before* anything is persisted; no
   queryable pre-redaction copy is ever retained.
4. **Persist** — events are stored with original facts kept separately:
   actor (`webhook_verified | credential_bound | client_claimed | unknown`),
   `occurredAt` provenance (`provider | client | server`), and the
   credential-bound `ingestedBy` are independent dimensions; unknown facts
   stay unknown, never fabricated.
5. **Enqueue** — a pg-boss `compilation` job is created (or stored-only when
   `compile=false`), with transport idempotency based on channel facts
   (project + channel + delivery id + item key) and a payload hash computed
   over canonical JSON after redaction. Replaying the same identity+hash
   returns the original result; a different hash returns 409.

Key compiled pieces: the GitHub connector (signature verification +
per-kind normalizers), the idempotent event repository (three-state
duplicates/conflicts), the job repository (idempotent `createJob` +
`enqueueCompilation`), and the events read API (cursor-paginated summaries;
payload appears only in detail, gated behind `read:payload`) —
`services/github-connector` (`services/github-connector`),
`services/idempotent-event-repository` (`services/idempotent-event-repository`),
`services/job-repository` (`services/job-repository`),
`services/events-api` (`services/events-api`).

## 5. The compilation pipeline (F1 → F2)

The queue worker runs a full-loop pipeline per job:

```text
event ──> prefilter noise ──> F1 extraction (provider-native
        structured output) ──> toConcept aggregate ──> embedding
        (semantic) ──> F2 candidate recall (vector or FTS) ──>
        F2 merge decider (confirms / extends / contradicts /
        unrelated) ──> mergeIntoConcept | createConcept ──> concept page
```

- **Prefilter**: deterministic noise checks run before any LLM call; things
  like meaningless commit messages are skipped without spending tokens
  (compiled gotcha: `gotchas/meaningless-commit-messages` (`gotchas/meaningless-commit-messages`)).
- **F1** produces one of six typed concept kinds — `service`, `concept`,
  `decision`, `gotcha`, `convention`, `runbook` — with explicit confidence
  rules and a *skip* decision when the event contains no extractable
  knowledge. Output must pass the frozen Zod schema before persistence;
  there is no “free text + regex/XML tag parsing” anywhere
  (compiled: `decisions/minimal-f1-structured-output` (`decisions/minimal-f1-structured-output`)).
- **toConcept** assembles the concept-page aggregate from validated F1 output
  plus server-owned facts (UUID, timestamps, evidence with immutable
  repo/commit/path anchors, actor provenance) that the LLM never supplies
  (compiled: `services/to-concept-mapper` (`services/to-concept-mapper`)).
- **F2** recalls candidate concept pages and asks the LLM for a merge
  decision with a four-value discriminator: `confirms`, `extends`,
  `contradicts`, `unrelated` — `targetConceptId` is `null` exactly when
  `unrelated`. A `contradicts` decision encodes the “disputed, never merely
  lower confidence” red line as a literal in the contract
  (compiled: `concepts/f2-merge-decision-structured-output-contract` (`concepts/f2-merge-decision-structured-output-contract`)).
  `mergeIntoConcept` applies the decision in a single scoped transaction
  (compiled: `services/merge-into-concept` (`services/merge-into-concept`)).
- **Retrieval**: hybrid vector (pgvector, 1536-dim default) / FTS recall.
  When semantic capability is unavailable the system *explicitly* falls back
  to full-text search and never pretends vector search succeeded
  (compiled: `services/mcp-search-tool` (`services/mcp-search-tool`),
  `services/embedding-client`).

## 6. Consumption

- **MCP** — a Bearer-authenticated streamable HTTP endpoint
  (`POST /mcp`, JSON-RPC 2.0) exposing `search`, `get_page`, `timeline`, and
  `memory_write` tools with progressive disclosure; the timeline sorts by
  `occurred_at DESC` using the existing composite-cursor infrastructure
  (compiled: `services/mcp-streamable-http-endpoint` (`services/mcp-streamable-http-endpoint`),
  `services/memory-write-tool` (`services/memory-write-tool`),
  `decisions/timeline-tool-design` (`decisions/timeline-tool-design`)).
- **Read APIs** — `GET /v1/concepts`, `/v1/events`, `/v1/jobs`
  (composite cursors, no offset pagination; lists are summaries only), plus
  `POST /v1/search` with explicit limit validation (400 above 100, no silent
  clamp) (compiled:
  `decisions/get-concepts-endpoint` (`decisions/get-concepts-endpoint`),
  `decisions/expose-v1-search-route` (`decisions/expose-v1-search-route`)).
- **SessionStart context** — `GET /v1/context` uses a value/confidence/
  freshness budget strategy (confidence, then last-confirmed, ≈800-token
  budget, `teamem://concept/<uuid>` links) instead of copying concept-list
  ordering (compiled: `decisions/budget-strategy-context-injection` (`decisions/budget-strategy-context-injection`)).
- **Export** — `GET /v1/export?projectId=…` returns a deterministic gzipped
  OKF bundle (`index.md` catalog + `log.md` change log + one markdown page
  per concept, frontmatter carrying type/uuid/path/status/confidence/
  evidence) (compiled: `services/scoped-okf-bundle-download` (`services/scoped-okf-bundle-download`),
  `concepts/okf-bundle-format-contract` (`concepts/okf-bundle-format-contract`)).

## 7. Authentication, tenant isolation, and governance

- **Keys**: only SHA-256 hashes of API keys are stored; plaintext is
  returned exactly once at minting; revoked keys get an immediate 401.
  Normal keys bind to a project; team-wide keys require `allProjects=true`
  (compiled: `decisions/key-minting-governance-separation` (`decisions/key-minting-governance-separation`)).
- **Scopes**: every business query carries `team_id` + `project_id`
  explicitly; tagged scopes distinguish a single project from team-wide
  access. Cross-team probes and genuinely missing resources return identical
  404s (anti-enumeration). Detail lookups execute scoped SQL directly —
  never “fetch then authorize” (compiled: `gotchas/missing-read-scope-enforcement` (`gotchas/missing-read-scope-enforcement`)).
- **Web sessions / RBAC**: viewer browses; member adds search/context/detail;
  admin adds key/connector/LLM/audit/payload management; owner adds purge,
  role management, team deletion. Sensitive reads append an audit record;
  a failed audit write on a sensitive read fails closed
  (compiled: `services/web-session-role-auth` (`services/web-session-role-auth`)).
- **LLM config** is per-team BYO (Claude / OpenAI / OpenRouter / custom
  OpenAI-compatible endpoint), stored encrypted (AES-256-GCM) in
  `llm_config` and resolved per compile job; the environment provider is the
  fallback. `platform-managed` is reserved for SaaS and explicitly rejected
  in the self-hosted build.

## 8. What the compiler found (the compiled concept map)

The 45 pages teamem compiled from this repo's own PRs are the factual map
this overview is built on. They are exported as a reproducible OKF bundle;
the most architecture-bearing ones:

**Decisions (14)** — `expose-v1-search-route`, `minimal-f1-structured-output`,
`production-docker-image` (reproducible multi-stage image, pinned Node base,
frozen pnpm install, non-root user), `validate-server-env-vars` (strict Zod
env parsing so malformed config fails before deployment), `close-generic-connector-persistence-seam`
(open `external` bucket so provider identity never collides on shared
delivery-ID idempotency), `get-concepts-endpoint`, `postgres-testing-helpers`
(real-database integration helper: no transactions, violation-safe clients,
dynamic UUIDs, FK-safe cleanup), `publish-schema-package` (independent MIT
npm package for the CLI), `document-trusted-publishing-workflow` (tokenless
OIDC release bootstrapping), `timeline-tool-design`, `budget-strategy-context-injection`,
`key-minting-governance-separation`, `onboarding-wizard-design` (explicit
FTS-degradation banner, key shown once, honest zero-count waiting states),
`m1-quality-metrics-report` (honest metrics: token costs marked untested
rather than fabricated, FTS fallback as honest degradation).

**Services (21)** — the process entrypoints, ingestion connectors and
repositories, the compile chain (`to-concept-mapper`, `merge-into-concept`),
MCP surface (`mcp-search-tool`, `mcp-streamable-http-endpoint`,
`memory-write-tool`), read APIs (`events-api`), export
(`scoped-okf-bundle-download`), auth (`web-session-role-auth`,
`auth-entry-pages`), embedding, and the quality/metric scripts
(`m1-why-moment-demo-script`, `f1-signal-to-noise-metric-script`,
`f2-merge-quality-metric-script`, `m2-cold-deploy-acceptance-script`).

**Gotchas (5)** — the warnings the compiler thought future readers/future
agents should be blocked from stumbling into: cold-start Postgres migrations,
a producer/consumer contract violation in the compile queue that silently
left jobs queued forever, the missing read-scope enforcement, the QA
capability-detection bug that silently suppressed assertion failures, and
meaningless commit messages.

**Runbooks (3)** — how to run `m0-compose-smoke.sh` (both topologies),
the M2 governance/security verification script, and the M3 E2E script.

**Concepts (2)** — the F2 merge-decision structured-output contract and the
OKF bundle format contract: the two contracts the compiler itself depends on.

## 9. Development, quality, and deployment notes (compiled view)

- The M1 “why” demonstration exists as a script
  (`scripts/m1-why-moment.sh`): conclusion + PR discussion + implementation
  commit, delivered live to design partners.
- Integration tests run against real PostgreSQL/pgvector; a skipped database
  test is never presented as database verification.
- The production Dockerfile ships one image for both topologies with
  automatic schema migration on boot, and an explicit
  `TEAMEM_AUTO_MIGRATE=false` escape hatch when an operator runs migrations
  out-of-band.
- F1 signal-to-noise and F2 merge-quality metrics are computed from real
  database data by standalone scripts (`m1-f1-signal.ts`, `m1-f2-quality.ts`)
  — the same measurement loop used to validate this overview's compilation.

## How this page was compiled

**Method (rerunnable):**

1. `gh pr list --repo teamem-ai/teamem-server --state merged` → 131 merged
   PRs (#4–#145, 2026-07-18 → 2026-08-09).
2. Each PR became one `cli_init` event: title, author, merged date, body,
   labels, and changed-file list, anchored to its **merge commit SHA** and
   `path: prs/<n>.md`, with an idempotency key derived from
   `(repo + commitSha + path)`.
3. One batch `POST /v1/events/batch` with `compile=false` stored all 131
   events (all `accepted`).
4. One explicit `POST /v1/compilations` over all event IDs; the compile
   worker ran F1 extraction + F2 merging.
5. `GET /v1/export?projectId=…` downloaded the OKF bundle
   (`index.md` + `log.md` + 45 concept pages) — the source material for this
   page, then human-structured and polished. The committed snapshot of that
   bundle is [`docs/dogfooding/2026-08-09/`](./dogfooding/2026-08-09/index.md).

**Dogfooding outcomes (honest report):**

- The first compile run surfaced a **real product bug**: the F2
  merge-decider schema produced an invalid provider-side JSON Schema
  (`targetConceptId` merged across discriminated-union branches into a
  type-less `{}`), so every F2 call failed with HTTP 400 on OpenAI-family
  providers. Fixed in the LLM schema normalizer
  (`apps/server/src/llm/factory.ts`) with regression tests in
  `apps/server/src/llm/llm.factory.test.ts` (“F2 decision schema properties
  always carry a type”). With gpt-4o-mini over OpenRouter, F1 extraction
  then succeeded on ~90% of events, and F2 merged the rest.
- Final run: 78 events compiled into 45 concepts (71+ in the retry job),
  ~24 pages merged away as duplicates, 15 skipped as noise, and 1 event
  failed recompilation with a deterministic `concept_paths` unique-violation
  when two F1 outputs inferred the same `services/embedding-client` path —
  an F2-recall miss (no embedding provider configured, so recall fell back
  to FTS). Noted here as a known edge, not silently hidden.
- This page was written from the exported bundle plus in-repo authoritative
  files (`AGENTS.md`, `packages/schema`, migrations); page claims that come
  from the compiler carry their concept path; claims about invariants come
  from `AGENTS.md` in the same repository.