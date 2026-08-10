# M3-QA-02 Distribution Recheck — Acceptance Report

**Task**: DUA-261 — M3-QA-02 — Distribution recheck (SessionStart + UserPromptSubmit + Codex MCP)
**Date**: 2026-08-10T10:00:00Z
**Server commit SHA (reviewed)**: `75c822c4f217ec7cd867ccb26927a3df5e8d9332`
**Branch**: `feature/dua-261-m3-qa-02-distribution-recheck-sessionstart-userpromptsubmit`
**Tester**: Independent read-only acceptance agent

> This is a point-in-time **read-only** recheck of the **distribution side**.
> Zero production code was changed during acceptance. The distribution
> implementation (SessionStart / UserPromptSubmit hooks + Codex MCP onboarding)
> lives in the `teamem-ai/cli` repository; the server only supplies the
> consuming endpoints (`GET /v1/context`, `POST /v1/search`, `/mcp`). This
> report verifies that loop and confirms the DIST red line (**zero server
> changes** and **no capture hooks**).

---

## Dependencies reviewed

| Distribution item | Where implemented | HEAD reviewed |
|---|---|---|
| SessionStart read-only hook | `teamem-ai/cli` — `teamem install-hook` (M2-CLI-01) | `262144195cb72fe926ab1dc83cd97cfd98649fd4` |
| `teamem cli hook` dispatcher + UserPromptSubmit (M3-DIST-01) | `teamem-ai/cli` — branch `dua-254` | `208f5be6e49dac4c8cc2475da631e63522ff73e1` |
| Codex first-class MCP (M3-DIST-02) | `teamem-ai/cli` — branch `dua-255` (includes DIST-01) | `859843491d2c2f240376d123f04581e12ba54362` |
| `GET /v1/context` (SessionStart consumption) | `teamem-server` `apps/server/src/http/routes/context.ts` | server `75c822c` |
| `POST /v1/search` (UserPromptSubmit consumption) | `teamem-server` `apps/server/src/http/routes/search.ts` | server `75c822c` |
| `/mcp` + tools `search`/`get_page`/`memory_write` | `teamem-server` `apps/server/src/mcp/` | server `75c822c` |

---

## Environment

| Variable | Status | Notes |
|---|---|---|
| pnpm | 10.33.2 | |
| Postgres (real) | 127.0.0.1:5432 pgvector/pgvector:pg17 | Used for server integration tests |
| `TEST_DATABASE_URL` | `postgres://teamem:test123@127.0.0.1:5432/teamem` | migrations applied |

---

## 1. SessionStart injection works in the public-release config — **PASS**

The installer writes the runtime command `teamem cli hook SessionStart` (with
`TEAMEM_URL`/`TEAMEM_TOKEN`/`TEAMEM_PROJECT` env vars) into
`~/.claude/settings.json`. At session start the hook calls:
`GET /v1/context?projectId=...` and injects **exactly** `data.markdown`
(`src/commands/hook.ts`, `sessionStartRuntime`).

Server side verified: `GET /v1/context?projectId=...` returns
`data: { markdown, budgetUsed, conceptsIncluded, conceptsAvailable }`
(`context.ts`, `contextResponse` in `packages/schema/src/context.ts`). The CLI
uses the `projectId` query param — matches the server contract exactly (the
dispatcher was reworked in DIST-01 to drop the old `project_id`).

Required counter-example (payload/token/private never injected): a 200
response carrying legal markdown **and** sensitive sibling fields injects
ONLY the markdown; a non-string / missing `data.markdown`, a non-2xx, a
network failure, or an unparseable body all yield an **EMPTY** context —
never an error payload, never a token (`hook.test.ts` lines 606–749).

Public-release config: the CLI is the published MIT npm package `teamem`
(`bin: teamem`, `teamem cli hook ...` installed command), and the server runs
as a container in the three-container compose / all-in-one config — no
dev-only wiring.

**Evidence**
- CLI unit tests — 46 hook tests pass (incl. SessionStart only-injects-markdown and all degrade paths).
- Server integration test `context.integration.test.ts` — 18 tests pass against real Postgres.

## 2. UserPromptSubmit injects per-question concepts, graceful silent degrade — **PASS**

`teamem cli hook UserPromptSubmit` reads the current prompt from hook stdin,
posts it to `POST /v1/search` (validated with the released
`searchRequest`/`searchResponse` Zod schemas), and injects the top-N
matching concepts (`[title] (type, confidence) path`). Default N=5, max 10,
query truncated to the schema 500-char limit.

Graceful silent degrade on server down / any failure — every path returns an
EMPTY context with **exit code 0** and **no error text**:
- network failure → empty (`hook.test.ts` line 721)
- non-2xx from `/v1/search` → empty (line 837)
- server response fails schema validation → empty (line 817)
- no results → empty (line 851)
- empty/missing prompt → empty, no HTTP call (line 803)

The dispatcher only ever supports `SessionStart | UserPromptSubmit` —
see §4 for no-capture-hook confirmation.

**Evidence**
- CLI unit tests — 46 hook tests pass (UserPromptSubmit paths at lines 751–851).
- Server side: `POST /v1/search` route (`search.ts`, 16 unit tests) and MCP `search` tool integration (22 tests) pass against real Postgres.
- CLI `pnpm typecheck` PASS, `pnpm lint` PASS, `pnpm test` **145 passed / 6 files**.

## 3. Codex works over MCP (search / get_page / memory_write) — **PASS** (conditional: not run interactively in an IDE)

`teamem mcp connect` prints a pasteable block with **both** consumers:
`claude mcp add` and `codex mcp add teamem --url <endpoint>
--bearer-token-env-var TEAMEM_TOKEN` (token never stored in
`~/.codex/config.toml`; Codex reads it from the env var — this is the correct
Codex auth mechanism, which does not support static `headers`).

Both clients consume the **same** server endpoint `<base>/mcp` with Bearer
auth — **zero server changes**. The server exposes the full tool set:
`search`, `get_page`, `timeline`, `memory_write`
(`apps/server/src/mcp/registry.ts`, wired in `app.ts`).

**Evidence**
- CLI mcp tests — 14 pass (`mcp.test.ts`).
- Server MCP integration tests against real Postgres: `search` (22), `get_page` (14), `memory_write` (10) — 46 tests pass.
- `mcp/server.test.ts` 22 tests pass.

> **Conditional note (honest attribution):** end-to-end verification was done
> via unit + real-Postgres integration tests and code inspection. An actual
> interactive Codex/Claude Code IDE session was **not** launched during this
> recheck (requires the IDE CLIs); that live step remains a manual
> acceptance item.

## 4. ZERO server changes in DIST-01/02 — **PASS** and no capture hooks — **PASS**

**ZERO server changes.** The server M3 window (`git log` from main) contains
no distribution commits. The only `codex`-touching server change is a README
docs edit (DUA-257 `docs(m3): README polish ... Codex onboarding`), which is
documentation, not server code. Confirmed server M3 commits are export/OKF
and release work only:
`feat(export)` (DUA-248/249/250/251/252), `chore(schema) publish 0.2.0`
(DUA-263), `chore(release)` (DUA-259), `docs(m3)` (DUA-257/258).

The server mint-key flow is unchanged (still returns `claude mcp add`, DUA-211 /
M1-MCP-06); the parallel `codex mcp add` output is produced **CLI-side** by
`teamem mcp connect` — the Codex seam required no server change.

**No capture hooks.** The CLI supports only `SessionStart | UserPromptSubmit`
(`SUPPORTED_EVENTS`, `normalizeEvent` rejects anything else). Both are
read-only **distribution** hooks: they only read from the portal
(`GET /v1/context`, `POST /v1/search`) and never write events back. No
`PostToolUse`, `Stop`, or `SessionEnd` capture/ingestion hook exists; the
server has no new capture-ingestion endpoint in the M3 window.

**Evidence**
- `git log --oneline` (server, M3 window) — no DIST/userprompt/codex feature commits.
- Server MCP endpoint unchanged (Bearer `/mcp`); no new POST ingestion surface for hooks.
- CLI `normalizeEvent` allowlist and `SUPPORTED_EVENTS` — exactly two events.

---

## Honest completion statement

The distribution mechanism is verified end-to-end at the unit + real-Postgres
integration level, and the DIST red line (**zero server changes**, **no
capture hooks**) holds. Live in-IDE interactive sessions (Claude Code /
Codex) were not launched during this read-only recheck; that single manual
step remains. No production code was modified by this acceptance.

## Verification summary

| Requirement | Result |
|---|---|
| SessionStart injection works (public-release config) | **PASS** |
| UserPromptSubmit per-question injection, graceful silent degrade | **PASS** |
| Codex over MCP (search / get_page / memory_write) | **PASS** (conditional: no live IDE run) |
| ZERO server changes in DIST-01/02 | **PASS** |
| No capture hooks snuck in | **PASS** |
