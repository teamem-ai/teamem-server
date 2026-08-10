# M3 Final Acceptance Report

**Task**: DUA-262 — M3-QA-03 — Final M3 acceptance + adoption-metrics wiring
**Date**: 2026-08-10T03:25:00Z
**Server commit under test**: `68ecc62254b6f0ece3a7728ad8e3a8ed8199cdb0` (`main` HEAD)
**CLI repository under test**: `teamem-ai/cli` `main` @ `9f9aa2d1`
**Tester**: Independent acceptance agent — not an implementer of any M3 card
**Branch**: `feature/dua-262-m3-qa-03-final-m3-acceptance-adoption-metrics-wiring`

> **Read-only acceptance.** No production code was changed. This report and
> [`docs/adoption-metrics.md`](./adoption-metrics.md) are the only additions.
> Defects found are recorded as findings and routed to a workstream; they are
> not fixed here (AGENTS.md §12).
>
> Every verdict below is one of **PASS**, **CONDITIONAL PASS** (correct but
> blocked on a resource this environment does not have), or **FAIL**. A
> skipped check is reported as *not verified* — a skip is never a pass.

---

## 0. Overall verdict

### **M3 does NOT yet meet its exit standard. — 1 FAIL, 6 CONDITIONAL PASS, 3 PASS**

One exit item genuinely failed: the **CLI has not switched to
`contextResponse.parse()`** — the work is complete, CI-green and mergeable on
a branch, but `teamem-ai/cli` PR #10 is still **open**, so the shipping CLI
still hand-parses `data.markdown` against `@teamem/schema@^0.1.0`. Per the
M3 exit rules a FAIL on any item means M3 is not PASS. This one is a single
merge away from resolution.

The remaining gaps are resource-blocked rather than broken: no BYO LLM
provider key in this environment (so the one-command E2E cannot run green),
the `teamem` CLI is not yet published to npm, and the release media
(demo GIF, launch post) are founder-owned and not yet produced.

**All engineering red lines pass.** Nothing in §3 blocks the release on
correctness, licensing, redaction, tenancy, or honesty grounds.

| # | Exit checklist item | Verdict |
|---|---|---|
| 1 | One-click OKF export → okf-skills validator → GitHub, readable & clickable, round-trip | **PASS** |
| 2 | `bash scripts/e2e.sh` all green | **CONDITIONAL PASS** — no LLM provider key |
| 3 | UserPromptSubmit semantic injection, silent degrade | **PASS** |
| 4 | `@teamem/schema` published with context DTO **and CLI switched to `contextResponse.parse()`** | **FAIL** — CLI half not landed |
| 5 | Codex works over MCP (search / get_page / memory_write) | **CONDITIONAL PASS** — no live IDE run |
| 6 | SessionStart injection rechecked in the public-release config | **CONDITIONAL PASS** — CLI not on npm |
| 7 | Documentation quartet complete | **PASS** |
| 8 | GitHub public release ready (license / CI / GIF / launch post) | **CONDITIONAL PASS** — no demo GIF, no launch post |
| 9 | Adoption-metrics collection wired | **CONDITIONAL PASS** — question-quality landing points missing |
| 10 | lint / typecheck / test / integration / E2E / Compose smoke green; honest skips; license boundary correct | **CONDITIONAL PASS** — everything green except the E2E of item 2 |

---

## 1. Environment

| Component | Value |
|---|---|
| Node.js | v22.19.0 |
| pnpm | 10.33.2 |
| Docker | Server 29.4.0, Compose v2 |
| Postgres | `pgvector/pgvector:pg17` @ 127.0.0.1:5432, 6 committed migrations applied |
| `TEST_DATABASE_URL` | `postgres://teamem:test123@127.0.0.1:5432/teamem` (real vector-capable Postgres) |
| **LLM provider key** | **NONE** — no `TEAMEM_ANTHROPIC_API_KEY` / `TEAMEM_OPENAI_API_KEY` / `TEAMEM_OPENROUTER_API_KEY` / `TEAMEM_OPENAI_COMPAT_API_KEY`, and no `.env` present |
| GitHub | `gh` authenticated with push access to `teamem-ai/teamem-server` |

The missing provider key is the single environmental cause of the two
compilation-dependent conditionals (items 2 and 10). It is reported, not
worked around.

---

## 2. Exit checklist, item by item

### 1. One-click OKF export → validator → GitHub — **PASS**

Accepted independently under **M3-QA-01 / DUA-260**; evidence is recorded in
[`docs/m3-okf-export-acceptance.md`](./m3-okf-export-acceptance.md) and is not
re-run here. Summary of what that acceptance actually exercised: a bundle
fetched over the **real** `GET /v1/export` HTTP endpoint from a live server
with a real Bearer token, extracted with system `tar`, validated by the
**real** okf-skills `okf_validate.py` (`passed: true`, `conformant: true`,
`errors: []`), then pushed to a real public GitHub repository where every page
renders at HTTP 200, relative links resolve to real target pages, and
frontmatter preserves the canonical UUID. All three required negative cases
(missing link target, cross-team export indistinguishable from missing,
no payload leakage) passed.

Re-verified here at HEAD: the export module's only entry point is scoped by
`ScopeContext` (`apps/server/src/export/render-okf-bundle.ts:139–171`), and
the export read repository (`apps/server/src/db/repositories/export.ts`) never
references the `events` table at all — payload leakage is structurally
impossible, not merely filtered.

### 2. `bash scripts/e2e.sh` all green — **CONDITIONAL PASS** (blocked: no LLM provider key)

Run at HEAD, real output:

```text
$ bash scripts/e2e.sh
M3 E2E — one-command real end-to-end — 2026-08-10T03:18:29Z
→ Mode: standard (3 containers: postgres + server + worker)
→ Compose project: 'teamem-e2e' (isolated …)
→ POSTGRES_PASSWORD not set — generated a strong ephemeral password for this run
⊘ SKIP  No LLM provider key is configured — SKIP, not green.
Compilation (F1/F2) would fail with no_llm_provider, so this run cannot
verify the up → ingest → compile → MCP search loop.
SKIP is NOT green — the M3 E2E exit check is left unverified.
```

**The one-command loop `up → ingest → compile → MCP search → cleanup` is NOT
verified.** The script itself behaves exactly as its contract requires: it
fails closed, refuses to fake a green result, and exits non-zero (2 = SKIP).
That is the correct behavior, but a correct SKIP is not a green gate.

Blocked on: **one BYO LLM provider key**. Everything else the script needs
(Docker, compose, curl, jq, git) is present, and the surrounding steps of the
same loop were independently verified — see item 10, where the real Compose
stack ingested a real event, created a compile job, and a real worker claimed
and terminated it.

### 3. UserPromptSubmit semantic injection — **PASS**

Accepted independently under **M3-QA-02 / DUA-261**
([`docs/m3-qa-02-acceptance.md`](./m3-qa-02-acceptance.md)). `teamem cli hook
UserPromptSubmit` posts the prompt to `POST /v1/search` validated with the
released `searchRequest`/`searchResponse` DTOs and injects the top-N matching
concepts; every failure path (network failure, non-2xx, schema-invalid body,
no results, empty prompt) yields an empty context with exit code 0 and no
error text. Zero server changes were required.

Re-verified here at HEAD: `POST /v1/search` exists and is scope-gated
(`apps/server/src/http/routes/search.ts`), and its unit + real-Postgres tests
are inside the green suites of item 10.

### 4. `@teamem/schema` published with context DTO + CLI switched — **FAIL**

This item has two halves. They do not have the same verdict.

**Server half — PASS.** `@teamem/schema@0.2.0` is published on the public npm
registry and the published artifact really does carry the context DTO. Not
inferred from source — the tarball was downloaded and inspected:

```text
$ npm view @teamem/schema versions --json      → ["0.1.0","0.2.0"]
$ npm view @teamem/schema dist-tags --json     → {"latest":"0.2.0"}   (published 2026-08-09T09:45:28Z)
$ npm pack @teamem/schema@0.2.0 && tar -xzf teamem-schema-0.2.0.tgz
$ grep -oE '(contextResponse|ContextResponse)' package/dist/index.d.ts | sort -u
ContextResponse
contextResponse
```

The tarball also ships `package/LICENSE` (MIT) — the license boundary holds in
the published artifact, not just in the repository.

**CLI half — FAIL. The switch has not landed.** `teamem-ai/cli` `main`
(`9f9aa2d1`) still ships the pre-DTO code:

```text
$ gh api repos/teamem-ai/cli/contents/package.json          → "@teamem/schema": "^0.1.0"
$ gh api repos/teamem-ai/cli/contents/src/commands/hook.ts
  :145  * `@teamem/schema@0.1.0` does not export a context DTO, so
  :164  parsed = JSON.parse(text) as { data?: { markdown?: unknown } };
```

That is exactly the "hand-rolled defensive `data.markdown` parsing" this exit
item requires to be gone. The replacement exists and is ready, but sits on an
unmerged branch:

```text
$ gh pr list --repo teamem-ai/cli
  #10  feat(hook): validate SessionStart context with contextResponse.parse (DUA-263)   OPEN
$ gh pr view 10 --repo teamem-ai/cli --json state,mergeable,mergeStateStatus
  {"state":"OPEN","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN"}      # CI: lint/typecheck SUCCESS
$ gh api ".../contents/src/commands/hook.ts?ref=feature/dua-263-…"
  :10   import { searchRequest, searchResponse, contextResponse } from '@teamem/schema';
  :165  const parsed = contextResponse.parse(JSON.parse(text));
$ gh api ".../contents/package.json?ref=feature/dua-263-…"    → "@teamem/schema": "^0.2.0"
```

**Verdict: FAIL — not landed.** The exit checklist asks what the CLI ships,
and the shipping CLI has not switched. One merge of `teamem-ai/cli#10`
converts this to PASS. → **Finding F1**, release/CLI workstream.

### 5. Codex over MCP — **CONDITIONAL PASS** (blocked: no interactive IDE run)

Accepted under M3-QA-02. `teamem mcp connect` emits both `claude mcp add` and
`codex mcp add teamem --url <endpoint> --bearer-token-env-var TEAMEM_TOKEN`
(Codex reads the token from the environment; it is never written into
`~/.codex/config.toml`). Both clients consume the same `/mcp` Bearer endpoint
with **zero server changes**; the server exposes `search`, `get_page`,
`timeline`, `memory_write` (`apps/server/src/mcp/registry.ts`).

QA-02 verified this at the unit and real-Postgres integration level. **This
acceptance went further and ran the wire protocol live.** A real server
process was booted against real Postgres (`/healthz` → `{"status":"ok"}` on
`127.0.0.1:18799`) and the committed smoke was run over the exact Streamable
HTTP + Bearer transport `codex mcp add` configures:

```text
$ TEAMEM_DATABASE_URL=… TEAMEM_BASE_URL=http://127.0.0.1:18799 \
    bash scripts/m3-codex-mcp-smoke.sh
✓ PASS  Bootstrapped project prj_4b3c02bb… with a fresh write-scoped key.
✓ PASS  initialize handshake OK — server identified as 'teamem' over Streamable HTTP.
✓ PASS  tools/list exposes 'search'
✓ PASS  tools/list exposes 'get_page'
✓ PASS  tools/list exposes 'memory_write'
✓ PASS  search round-trip succeeded (0 concept rows returned).
✓ PASS  memory_write persisted event evt_2b7e4fcd… (real write over /mcp).
✓ PASS  get_page handler executes over /mcp (honest boundary: 'Concept not found').
── VERDICT ──  PASS=8  FAIL=0  SKIP=0   → GREEN
```

That is a real JSON-RPC round-trip against a real server and a real database —
no protocol mocking. What remains conditional is narrow and specific: the
`codex` binary itself was **not** driven in an interactive IDE session, and
`get_page` was verified through its "Concept not found" boundary rather than
against a compiled concept, because compiling one needs the LLM provider key
this environment lacks. Both limits are stated by the script's own output
rather than glossed over.

### 6. SessionStart recheck in the public-release configuration — **CONDITIONAL PASS**

The code path is verified (M3-QA-02): the installed hook calls
`GET /v1/context?projectId=…` and injects exactly `data.markdown`, degrading
to an empty context on every failure. `GET /v1/context` is served with its own
budget strategy and is covered by 18 real-Postgres integration tests.

The conditional is about the word **public-release**: the distribution path
those docs describe is the npm package `teamem`, and that package **does not
exist on the registry**:

```text
$ npm view teamem version
npm error 404 Not Found - GET https://registry.npmjs.org/teamem
```

`README.md:30` and `:80` describe the CLI as "npm package `teamem`", and
`docs/m3-qa-02-acceptance.md:62` states the CLI "is the published MIT npm
package `teamem`". As of this acceptance that is not accurate — a user
following the public path today cannot install the CLI from npm. The hook
mechanism works; the public *distribution* of it is not live. →
**Finding F2**, release workstream.

### 7. Documentation quartet — **PASS**

| Required doc | File | Verified content |
|---|---|---|
| README with 30-minute deploy path + Claude Code/Codex onboarding | `README.md` | Quickstart section titled "first cited answer in ≤ 30 minutes"; both `claude mcp add` and `codex mcp add … --bearer-token-env-var TEAMEM_TOKEN` given verbatim; "Self-hosted deployment (≈ 30 minutes from zero)" section |
| Quickstart | `docs/QUICKSTART.md` (385 lines) | Time-budgeted walkthrough with expected outputs, an honest verified-vs-flagged table, and a "< 5 minutes" troubleshooting section |
| Architecture overview with dogfooding artifact | `docs/architecture.md` (316 lines) | Opens with "**Compiled by teamem from this repository.**" and a provenance block: 131 merged PRs → 45 concept pages / 76 evidence items / 45 contributors, exported through `GET /v1/export`; the committed OKF snapshot is in `docs/dogfooding/2026-08-09/` (`index.md`, `log.md`, and `decisions/`, `gotchas/`, `services/`, `runbooks/`, `concepts/` trees) |
| Contributing guide | `CONTRIBUTING.md` | Red-line summary, PR/DCO/squash discipline, pointers to `AGENTS.md` and `docs/GITFLOW.md`, private security path |

The architecture page carries the required "this page was compiled by teamem"
annotation *and* the honest limitations of that compilation — it does not
overstate what the compiler produced versus what a human structured.

The committed dogfooding bundle was link-checked directly: **47 markdown files
(45 concept pages + `index.md` + `log.md`), 45 relative links, 0 broken**, and
exactly 1 `teamem://concept/<uuid>` URI left unresolved — preserved verbatim
rather than fabricated or dropped, which is the required N5 behavior. One
cosmetic artifact is noted as Finding F8.

### 8. GitHub public release readiness — **CONDITIONAL PASS**

| Sub-item | Verdict | Evidence |
|---|---|---|
| License correct (server AGPL / schema MIT) | **PASS** | `pnpm license:check` — 8/8 checks pass, "License boundary intact". GitHub itself detects `agpl-3.0` on the public repo; the published npm tarball carries the MIT `LICENSE` |
| CI green | **PASS at HEAD** | `gh run list --branch main`: CI + CodeQL **success** on `68ecc62`, `5778e1b`, `da428c3`. See Finding F6 for a flaky red on an earlier commit |
| Repository public and governed | **PASS** | `visibility: PUBLIC`, issues enabled, bug/feature templates, CODEOWNERS, DCO + PR-policy + dependency-review + CodeQL workflows, release workflow with a no-deploy guard |
| Demo GIF | **NOT DONE** | `docs/assets/` does not exist; `docs/release-checklist.md` §3 defines exactly where the GIF must live, and nothing is there |
| Launch post | **NOT DONE** | Founder-owned; no draft in the repository. The checklist's positioning note ("structured compilation vs flat observation stream") is unaddressed |
| Release cut | **NOT DONE** | No product tag or GitHub Release exists — `git tag -l` shows only `schema-v0.2.0`; `gh release list` is empty. `CHANGELOG.md` still has only `## [Unreleased]` |

The *machinery* of release is ready and verified; the founder-owned media and
the tag itself are not. → **Finding F5**.

### 9. Adoption-metrics collection wired — **CONDITIONAL PASS** ("wired", not "met")

The collection definition is now recorded in
[`docs/adoption-metrics.md`](./adoption-metrics.md): source, retention limit,
cadence, records, token scope, and landing point for each metric, plus a
snapshot log seeded with a real first measurement.

**Stars / clones (Insights) — wired and exercised against the real source:**

```text
$ gh api repos/teamem-ai/teamem-server --jq '{stars:.stargazers_count,forks:.forks}'
{"forks":0,"stars":0}
$ gh api repos/teamem-ai/teamem-server/traffic/clones
{"count":3562,"uniques":338,"clones":[ …14 daily buckets, 2026-07-26 → 2026-08-08… ]}
$ gh api repos/teamem-ai/teamem-server/traffic/views
{"count":114,"uniques":2, …}
```

Two collection constraints were discovered by running it and are written into
the metrics doc, because either one silently destroys the metric:

- **The traffic API retains only 14 days.** The response contains exactly 14
  daily buckets; anything older is gone permanently. Collection must therefore
  run at least fortnightly, and the daily buckets — not just the totals — must
  be archived.
- **`count` is not adoption; `uniques` is.** 3,562 clones against 338 uniques.
  Clone counts include this repository's own CI checkouts. Reporting `count`
  would inflate adoption by an order of magnitude.

**Question quality (Discord / Issues) — landing points NOT all live:**

| Landing point | Status |
|---|---|
| GitHub Issues | Live (`hasIssuesEnabled: true`, templates present, 0 issues to date) |
| GitHub Discussions | **Disabled** (`hasDiscussionsEnabled: false`) — yet `.github/ISSUE_TEMPLATE/config.yml` offers a "Questions and support" link to `/discussions` that returns **HTTP 404** |
| Discord | **Does not exist** — no server, invite, or reference anywhere in the repository |

So the metric is wired for Issues only, and one advertised support channel is
a dead link for anyone who opens the issue picker today. → **Findings F3, F4**.

**Explicitly not claimed:** nothing here says any adoption target has been
met. Stars 0, forks 0, issues 0, on a public but **unannounced** repository —
these are pre-launch baselines, and the W9–W10 window has not begun.

### 10. Full check battery — **CONDITIONAL PASS**

All commands below were run at HEAD in this environment.

| Check | Command | Result |
|---|---|---|
| Lint | `pnpm lint` | **PASS** — exit 0, zero findings |
| Typecheck | `pnpm typecheck` | **PASS** — server, web, schema, scripts; zero errors |
| License boundary | `pnpm license:check` | **PASS** — 8/8: root/server/web AGPL-3.0-only, `packages/schema` MIT, deps `yaml` (ISC) and `zod` (MIT) permissive, no bleed |
| Unit | `pnpm test` | **PASS** — **75 files passed, 1 skipped; 1676 tests passed, 16 skipped** |
| Integration (real Postgres/pgvector) | `TEST_DATABASE_URL=… pnpm test:integration` | **PASS** — **58 files, 1017 passed, 7 skipped**, exit 0 |
| Compose smoke, standard (3 containers) | `scripts/m0-compose-smoke.sh --mode standard` | **PASS — 18/18** |
| Compose smoke, all-in-one (2 containers) | `scripts/m0-compose-smoke.sh --mode all-in-one` | **PASS — 17/17** |
| Codex MCP connectivity smoke (live server) | `scripts/m3-codex-mcp-smoke.sh` | **PASS — 8/8, 0 skipped** (item 5) |
| One-command E2E | `bash scripts/e2e.sh` | **NOT VERIFIED** — SKIP, no provider key (item 2) |

**Honest skip accounting** (a skip is never a pass):

- Unit, 16 skipped: 4 in `lifecycle.M0-PLAT-05.test.ts` (platform-dependent
  process-entrypoint lifecycle) plus the unchanged baseline set; 1 file
  skipped. Same baseline as the M3-QA-01 run.
- Integration, 7 skipped: **6** in `connectors/github/github-api.integration.test.ts`
  (positive commit→PR discovery, blocked by GitHub Search API rate limiting)
  and **1** in `http/routes/llm-config.integration.test.ts`. Both causes are
  missing external resources, not passing behavior.
- E2E: not a skip within a suite but the whole gate — reported as unverified.

**What the Compose smoke does prove about the E2E loop**, in a real
three-container stack with a real worker: bootstrap → `POST /v1/events`
ingests a real event → a compile job is created → the worker claims it and
drives it to a terminal state → the event is queryable via
`GET /v1/events/:id` → `POST /v1/compilations` creates an explicit job →
clean SIGTERM shutdown of both worker and server. With no provider configured
the job terminates as `failed` with

> `No LLM provider is configured for this team, so this job could not be compiled.`

which is the correct honest failure — the queue path is real and the absence
of a provider is surfaced, not swallowed into a fake success. What remains
unverified is only the **F1/F2 compilation and MCP retrieval of the resulting
concept**, which is precisely what item 2 needs a provider key for.

---

## 3. Engineering red-line recheck

Each red line was probed with a counter-example, not merely read.

| Red line | Result | Evidence |
|---|---|---|
| **License bleed** (AGPL leaking into MIT, or the reverse) | **PASS** | `pnpm license:check` 8/8; root/server/web declare `AGPL-3.0-only`, `packages/schema` declares MIT with its own LICENSE; schema deps are ISC/MIT only; the **published** 0.2.0 tarball ships `package/LICENSE` (MIT). GitHub's own detection reports AGPL-3.0 for the repo |
| **Export leaks event payload** | **PASS** | `apps/server/src/db/repositories/export.ts` contains no reference to the `events` table — the export read path cannot reach payloads. Independently pinned by QA-01's sentinel test (a string stored only in a raw payload never appears in any bundle file) and by `export.integration.test.ts` |
| **Distribution work modified the server** | **PASS** | DIST-01/02 (hook dispatcher, UserPromptSubmit, Codex onboarding output) landed entirely in `teamem-ai/cli`. One later change in this repo, `5778e1b` "feat(web): add Codex as first-class MCP consumer in onboarding" (#155), surfaces the Codex connect config in the portal — it touches `apps/web/`, `docs/QUICKSTART.md`, `package.json` and `scripts/m3-codex-mcp-smoke.sh`, and **no file under `apps/server/src/`**. The `/mcp` endpoint, its Bearer auth, and the tool registry are untouched: Codex reuses the endpoint Claude Code already used, which is what the red line requires |
| **Capture hooks smuggled into ingestion** | **PASS** | CLI `SUPPORTED_EVENTS = ['SessionStart', 'UserPromptSubmit']` (`hook.ts:112`) — both read-only distribution hooks; no `PostToolUse` / `Stop` / `SessionEnd`. Server-side, the public write surface is `POST /v1/events` with `const KIND = 'cli_init'` hard-fixed in `ingest-one.ts:43`, `ingest-batch.ts:46` and `events-write.ts:39`; there is no new capture-ingestion endpoint |
| **Fake data / fixtures in production paths** | **PASS** | The only fixture module, `connectors/github/pull-request.fixtures.ts`, is imported solely by `pull-request.test.ts`. No sample/demo/mock data in any server or web production path. The one non-product route, `POST /__e2e/setup`, is double-gated (not registered unless `TEAMEM_E2E_SECRET` is set, then requires a matching `x-e2e-secret` header, and returns the unified 404 otherwise) and that variable appears in **neither** `.env.example`, `docker-compose.yml`, `docker/`, nor the `Dockerfile` — it cannot be switched on by a default deployment |
| **Structured LLM output** | **PASS** | Anthropic path uses forced tool use (`tool_choice: { type: 'tool', name: … }`, `claude-adapter.ts:89`); OpenAI-family paths use `response_format: { type: 'json_schema', … }` derived from Zod (`factory.ts:469`). No free-text/regex parsing path |
| **Redaction before persistence** | **PASS** | `ingest-one.ts` executes validate → `stripPrivateTags` (line 133) → `payloadHash` **over the redacted payload** (139) → `insertEvent` (154) → `createJob` (216) → enqueue. No pre-redaction write, and the idempotency hash is computed post-redaction as the contract requires |
| **Tenant-scope isolation** | **PASS** | Export's only entry point takes a `ScopeContext` and derives `teamId` from it exclusively; a cross-team or missing project both return `null`, rendered as an identical 404 (QA-01 negative case 2, anti-enumeration) |
| **Overstated verification** | **PASS (this report)** | Item 2 is reported as unverified rather than substituted with an equivalent; items 5 and 6 carry their specific blockers; item 4 is called FAIL rather than "pending" |

No red line is violated. Nothing in this section blocks the release.

---

## 4. Findings routed to workstreams

Recorded, not fixed (this is a read-only acceptance).

| # | Finding | Severity | Owner |
|---|---|---|---|
| **F1** | `teamem-ai/cli` PR #10 (DUA-263, `contextResponse.parse`) is open and unmerged; shipping CLI still depends on `@teamem/schema@^0.1.0` and hand-parses `data.markdown`. This is the single FAIL against the M3 exit checklist. PR is MERGEABLE with green CI | **Blocker** | release / CLI |
| **F2** | The npm package `teamem` is not published (registry 404), while `README.md:30,80` describe it as "npm package `teamem`" and `docs/m3-qa-02-acceptance.md:62` calls it "the published MIT npm package". Either publish it or correct the wording before launch | **High** | release |
| **F3** | `.github/ISSUE_TEMPLATE/config.yml` offers "Questions and support" → `https://github.com/teamem-ai/teamem-server/discussions`, but Discussions is disabled and the URL returns **HTTP 404**. Breaks a public support entry point and the Issues/Discussions half of the adoption metric | **High** | infra / release |
| **F4** | No Discord landing point exists anywhere, though the exit checklist names Discord as a question-quality source. Either create it or narrow the metric to Issues and say so | **Medium** | founder / community |
| **F5** | No demo GIF (`docs/assets/` absent), no launch post, no product tag or GitHub Release, `CHANGELOG.md` still `[Unreleased]`-only. `docs/release-checklist.md` defines where each must go | **Medium** | release / founder |
| **F6** | `apps/web/src/__tests__/invite.test.tsx > InvitePage > shows error banner when acceptInvite fails` failed CI on `main` at `75c822c` (run 31342603509: 1 failed / 1669 passed) with `TestingLibraryElementError: Unable to find an element with the text: This invite link has already been used`. The test file was not modified afterwards and now passes locally and in later CI runs — i.e. it is **flaky**, and a red commit landed on `main` | **Medium** | web |
| **F7** | `README.md:21` still reads "Status: M0–M2 complete; M3 (export, docs) in progress" — accurate today, but it must be updated as part of cutting the release | **Low** | docs / release |
| **F8** | The OKF renderer prefixes each page with its type directory *and* then its full `path`, so a concept whose path already starts with a type-like segment renders at a doubled location — the dogfooding bundle emits `decisions/decisions/expose-v1-search-route.md` for `path: decisions/expose-v1-search-route`. Links stay internally consistent (0 broken of 45) and the validator passes, so this is readability, not correctness — but it is visible in the flagship public artifact | **Low** | export |

---

## 5. Honest "not yet" list

Deliberately out of scope for the MVP, per AGENTS.md §9 — present as seams
only, never as placeholder UI or endpoints that imply an implementation:

- **OKF import endpoint** — export round-trips by format contract; there is no
  import endpoint, and it is a SaaS backlog item.
- **Agent capture hooks** — excluded by design (AGENTS.md §1 ingestion
  criterion). Only the two read-only distribution hooks exist.
- **Codex context-injection hook** — Codex is supported over MCP only;
  automatic injection is V1.1.
- **F3 / F4 / F5 compilation stages** — not started.
- **Slack / Gmail / meeting connectors** — private-package seam only.
- **SaaS hosting and billing** — entitlements seam only; `platformManagedLlm`
  is false in every self-hosted resolver.
- **Full documentation site** — the four in-repo documents are the whole of it.

### Not verified in this acceptance (unverified ≠ passing)

1. **The one-command E2E green gate** — `scripts/e2e.sh` SKIPped; needs one BYO LLM provider key.
2. **A live F1/F2 compilation** producing a concept page in this environment — same cause.
3. **An interactive Claude Code / Codex IDE session** — needs those CLIs; not launched in QA-02 or here.
4. **6 GitHub commit→PR discovery integration tests** — GitHub Search API rate limiting.
5. **1 `llm-config` integration test** — skipped for a missing external resource.
6. **A design-partner 30-minute self-hosting run** — that is M2 behavioral evidence and requires a real partner; not attempted here.

---

## 6. Conclusion

M3's substance is in place and its red lines hold: the OKF export round-trip
is proven against a real validator and a real GitHub repository, the
distribution loop works with zero server changes and no capture hooks, the
documentation quartet is complete with a genuinely dogfooded architecture
page, the license boundary is intact in both the repository and the published
artifact, and the full check battery is green apart from one gate.

**M3 is not closed.** One exit item failed — the CLI has not switched to
`contextResponse.parse()` (F1) — and five more are conditional on resources
rather than code: an LLM provider key for the one-command E2E, an npm
publication for the CLI, an interactive IDE session, and the founder-owned
release media. The adoption-metrics collection is **wired and exercised**, not
met, with its question-quality landing points still incomplete.

To close M3: merge `teamem-ai/cli#10`, run `scripts/e2e.sh` green with a
provider key, publish the CLI to npm, fix or remove the dead Discussions link,
decide the Discord question, and produce the GIF, launch post and tag.
