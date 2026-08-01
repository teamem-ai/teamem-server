# M2 Cold Deploy Test — Result Template

> Fill in this template when running the cold deploy test. Replace `«placeholder»` values with
> actual results from the test run. This template pairs with `scripts/m2-cold-deploy.sh`.

## Run Information

| Field | Value |
|---|---|
| **Date / Time** | `«ISO 8601»` |
| **Tester** | `«name»` |
| **Repository** | `teamem-server` |
| **Branch / Commit** | `«git describe»` |
| **Start time** | `«ISO 8601»` |
| **End time** | `«ISO 8601»` |
| **Total elapsed** | `«XmXXs»` |
| **30-minute budget met?** | `«YES / NO»` |

## Configuration

| Variable | Status | Notes |
|---|---|---|
| `POSTGRES_PASSWORD` | `«set / MISSING»` | «length» chars |
| `TEAMEM_GITHUB_APP_ID` | `«set / MISSING»` | |
| `TEAMEM_GITHUB_INSTALLATION_ID` | `«set / MISSING»` | |
| `TEAMEM_GITHUB_PRIVATE_KEY` | `«set / MISSING»` | |
| `TEAMEM_GITHUB_OAUTH_CLIENT_ID` | `«set / MISSING»` | |
| `TEAMEM_GITHUB_OAUTH_CLIENT_SECRET` | `«set / MISSING»` | |
| `TEAMEM_GITHUB_WEBHOOK_SECRET` | `«set / MISSING»` | |
| LLM provider key | `«anthropic / openai / openrouter / compat / NONE»` | |
| `TEAMEM_LLM_ENCRYPTION_KEY` | `«set / NOT SET»` | |

## Phase 0 — Prerequisites

| Check | Expected | Actual | Result |
|---|---|---|---|
| `docker` available | yes | `«version»` | «✓/✗» |
| `docker compose` available | yes | `«version»` | «✓/✗» |
| `curl` available | yes | `«path»` | «✓/✗» |
| `jq` available | yes | `«path»` | «✓/✗» |
| `POSTGRES_PASSWORD` set | ≥ 8 chars | `«length»` chars | «✓/✗» |

## Phase 1 — Configuration Validation

| Check | Expected | Actual | Result |
|---|---|---|---|
| GitHub App vars configured | 6/6 | `«n»/6` | «✓/✗/⚠» |
| LLM provider configured | ≥ 1 | `«n»` | «✓/✗/⚠» |
| LLM encryption key set | 64 hex chars | `«n»` chars | «✓/✗/⚠» |
| `.env` file exists | yes | `«yes/no»` | «✓/✗/⚠» |

## Phase 2 — Compose Up + Health

| Check | Expected | Actual | Result |
|---|---|---|---|
| Docker build | success | `«Xs»` | «✓/✗/⊘» |
| `docker compose up --wait` | all healthy | `«Xs»` | «✓/✗» |
| postgres container healthy | healthy | `«status»` | «✓/✗» |
| server container healthy | healthy | `«status»` | «✓/✗» |
| worker container healthy | healthy | `«status»` | «✓/✗» |

## Phase 3 — Topology & Security

| Check | Expected | Actual | Result |
|---|---|---|---|
| `GET /healthz` | `{"status":"ok"}` | `«body»` | «✓/✗» |
| `GET /readyz` | `{"status":"ok"}` | `«body»` | «✓/✗» |
| Postgres binds to 127.0.0.1 | `127.0.0.1:5432` | `«binding»` | «✓/✗» |
| Postgres does NOT bind to 0.0.0.0 | no 0.0.0.0 | `«ok / 0.0.0.0 found»` | «✓/✗» |
| `GET /login` | HTTP 200 | `«http_code»` | «✓/✗» |
| GitHub OAuth status | `{"configured":true/false}` | `«body»` | «✓/✗/⚠» |

## Phase 4 — Browser Manual Steps

### Step 1: Open Login Page

| Criterion | Expected | Actual | Result |
|---|---|---|---|
| Page loads without errors | HTTP 200, no console errors | `«yes/no»` | «✓/✗» |
| Logo + "teamem" heading visible | visible | `«yes/no»` | «✓/✗» |
| Feature list visible (3 items) | 3 features | `«yes/no»` | «✓/✗» |
| Sign-in button state | «enabled / disabled (no config)» | `«enabled/disabled»` | «✓/✗/⚠» |

**Time at checkpoint:** `«__:__»`

### Step 2: Sign In with GitHub

| Criterion | Expected | Actual | Result |
|---|---|---|---|
| Redirect to github.com/oauth/authorize | yes | `«yes/no»` | «✓/✗/⊘» |
| Redirect back to /app after auth | yes | `«yes/no»` | «✓/✗/⊘» |
| App landing page loads | yes | `«yes/no»` | «✓/✗/⊘» |
| No error banner | no error | `«yes/no»` | «✓/✗/⊘» |

**Time at checkpoint:** `«__:__»`
**Skipped?** `«NO / YES — reason»`

### Step 3: Create First Project

| Criterion | Expected | Actual | Result |
|---|---|---|---|
| Project creation form loads | yes | `«yes/no»` | «✓/✗/⊘» |
| Project created successfully | project name appears | `«yes/no»` | «✓/✗/⊘» |
| Knowledge page shows empty state | honest empty state | `«yes/no»` | «✓/✗/⊘» |

**Project name created:** `«name»`
**Time at checkpoint:** `«__:__»`
**Skipped?** `«NO / YES — reason»`

### Step 4: Mint API Key

| Criterion | Expected | Actual | Result |
|---|---|---|---|
| API key form loads | yes | `«yes/no»` | «✓/✗/⊘» |
| Key created and shown once | key displayed | `«yes/no»` | «✓/✗/⊘» |
| Key starts with `tm_` | `tm_...` | `«prefix»` | «✓/✗/⊘» |
| Key appears in keys list | listed | `«yes/no»` | «✓/✗/⊘» |

**Key (first 20 chars):** `«tm_...»`
**Time at checkpoint:** `«__:__»`
**Skipped?** `«NO / YES — reason»`

### Step 5: Configure LLM Provider

| Criterion | Expected | Actual | Result |
|---|---|---|---|
| LLM settings page loads | yes | `«yes/no»` | «✓/✗/⊘» |
| Provider configured (env or UI) | at least one | `«provider name»` | «✓/✗/⚠» |

**Time at checkpoint:** `«__:__»`
**Skipped?** `«NO / YES — reason»`

### Step 6: Agent First Referenced Query

| Criterion | Expected | Actual | Result |
|---|---|---|---|
| MCP `tools/list` returns ≥ 3 tools | search, get_page, timeline, memory_write | `«n» tools: «names»` | «✓/✗/⊘» |
| `search` returns relevant results | concept(s) found | `«yes/no»` | «✓/✗/⊘» |
| `get_page` returns full concept body | body + evidence | `«yes/no»` | «✓/✗/⊘» |
| Agent response includes `teamem://concept/<uuid>` reference | reference link | `«yes/no»` | «✓/✗/⊘» |

**Query asked:** `«query text»`
**Agent response (excerpt):** `«response excerpt with references»`
**Time at checkpoint:** `«__:__»`
**Skipped?** `«NO / YES — reason»`

## Phase 5 — Automated Pipeline Verification

| Check | Expected | Actual | Result |
|---|---|---|---|
| Bootstrap team/project/key | `tm_` key created | `«event/error»` | «✓/✗» |
| Ingest compile=true event | HTTP 202 | `«http_code»` | «✓/✗» |
| Compile job enqueued | jobId not null | `«job_id»` | «✓/✗» |
| Compile job reaches terminal state | completed/failed | `«status»` | «✓/✗/⚠» |
| Concept page created (if completed) | ≥ 1 concept | `«count»` concepts | «✓/✗/⊘» |
| Event detail accessible | eventId matches | `«event_id»` | «✓/✗» |
| Idempotent replay | duplicate=true | `«duplicate?»` | «✓/✗» |
| Redaction (§5.3) | `<private>` stripped | `«leaked/stripped»` | «✓/✗» |
| MCP `tools/list` | ≥ 3 tools | `«n»` tools | «✓/✗» |
| MCP `search` | returns content | `«result»` | «✓/✗/⊘» |
| `GET /v1/context` | markdown returned | `«concepts_available»/«concepts_included»` | «✓/✗» |
| `GET /v1/concepts` | list returned | `«count»` concepts | «✓/✗» |

## Phase 6 — Summary

| Metric | Count |
|---|---|
| Total assertions | `«n»` |
| Passed | `«n»` |
| Failed | `«n»` |
| Skipped | `«n»` |

**Elapsed time:** `«XmXXs»`
**Overall result:** `«PASS / FAIL / INCONCLUSIVE»`

### 30-Minute Budget Breakdown

| Phase | Time | % of budget |
|---|---|---|
| 0 — Prerequisites | `«XmXXs»` | `«%»` |
| 1 — Configuration | `«XmXXs»` | `«%»` |
| 2 — Build + Compose Up | `«XmXXs»` | `«%»` |
| 3 — Topology & Security | `«XmXXs»` | `«%»` |
| 4 — Browser Manual Steps | `«XmXXs»` | `«%»` |
| 5 — Automated Pipeline | `«XmXXs»` | `«%»` |
| 6 — Report | `«XmXXs»` | `«%»` |
| **Total** | `«XmXXs»` | `«%»` |

## Regression Checks

| Check | Result |
|---|---|
| `pnpm lint` | «✓/✗» |
| `pnpm typecheck` | «✓/✗» |
| `pnpm test` | «✓/✗» («n» passed, «n» failed, «n» skipped) |

## Failures & Counterexamples

> List any failing checks here with the actual vs expected values and root cause.

| # | Phase | Check | Expected | Actual | Root Cause |
|---|---|---|---|---|---|
| 1 | «phase» | «check» | «expected» | «actual» | «root cause» |

## Notes

1. **GitHub App:** «Was a real GitHub App used? If not, which steps were affected?»
2. **LLM Provider:** «Was a real LLM provider configured? If not, compile jobs fail honestly.»
3. **Browser flow:** «Did all 6 manual steps complete? Any surprises?»
4. **30-minute budget:** «Was the end-to-end time ≤30 min? Where was time spent?»
5. **Counterexamples:** «Were any intentional counterexamples (wrong password, missing config) tested?»
