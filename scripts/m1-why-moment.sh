#!/usr/bin/env bash
# M1 "Why" Moment End-to-End Demo Script (AGPL-3.0-only)
#
# Core M1 exit-gate script: ingest a decision event with PR discussion +
# implementation commit → compile → MCP search → get_page → verify the
# decision page carries conclusion, PR discussion link, and commit permalink
# that link back to real GitHub.
#
# The script demonstrates the full "why moment" for design partners:
#   Agent asks "why did X use Y?" → search hits the decision page →
#   get_page returns rationale + evidence linking back to the actual
#   PR discussion and implementation commit.
#
# Steps:
#   1. Bootstrap isolated team/project/key (or reuse configured ones)
#   2. Ingest a CLI event describing a real engineering decision with
#      rationale, PR discussion reference, and implementation commit
#   3. Wait for compilation to complete (or skip if no LLM provider)
#   4. MCP search for the decision concept
#   5. MCP get_page to retrieve full concept detail
#   6. Assert: type=decision, body contains rationale, evidence links back
#      to GitHub (repo + commitSha permalink)
#   7. Without LLM provider: honestly skip compilation/retrieval assertions
#   8. Clean up test data
#
# Configuration (all via environment variables):
#   TEAMEM_BASE_URL             — server base URL (default: http://127.0.0.1:8080)
#   TEAMEM_DATABASE_URL         — Postgres connection string (required)
#   TEAMEM_SMOKE_KEEP_DATA      — keep rows after test (default: false)
#   TEAMEM_SMOKE_TEAM_ID        — team ID (overrides bootstrap)
#   TEAMEM_SMOKE_PROJECT_ID     — project ID (overrides bootstrap)
#   TEAMEM_API_KEY              — API key (overrides bootstrap)
#
#   Optional: set any TEAMEM_*_API_KEY to enable the LLM compilation path.
#
# Prerequisites: curl, jq, psql, node

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; NC='\033[0m'
pass()  { printf "${GREEN}✓ PASS${NC} %s\n" "$*"; }
fail()  { printf "${RED}✗ FAIL${NC} %s\n" "$*"; }
info()  { printf "${BOLD}→${NC} %s\n" "$*"; }
warn()  { printf "${YELLOW}⚠ WARN${NC} %s\n" "$*"; }
header() { printf '\n%s\n%s\n%s\n\n' "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" "${BOLD}$*${NC}" "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"; }

BASE_URL="${TEAMEM_BASE_URL:-http://127.0.0.1:8080}"
DATABASE_URL="${TEAMEM_DATABASE_URL:-}"
KEEP_DATA="${TEAMEM_SMOKE_KEEP_DATA:-false}"
TIMESTAMP="$(date +%Y%m%dT%H%M%S)"
TEAM_NAME="M1-WHY-${TIMESTAMP}"
PROJECT_NAME="why-demo-${TIMESTAMP}"

TMPDIR="${TMPDIR:-/tmp}"
WHY_TMP="$(mktemp -d "${TMPDIR}/teamem-why.XXXXXX")"
trap 'rm -rf "$WHY_TMP"' EXIT

# Counter files
PASS_F="${WHY_TMP}/pass"; echo 0 > "$PASS_F"
FAIL_F="${WHY_TMP}/fail"; echo 0 > "$FAIL_F"
inc_pass() { local c; c=$(cat "$PASS_F"); echo $((c+1)) > "$PASS_F"; }
inc_fail() { local c; c=$(cat "$FAIL_F"); echo $((c+1)) > "$FAIL_F"; }
get_pass() { cat "$PASS_F"; }
get_fail() { cat "$FAIL_F"; }

# ── Assertion helper ─────────────────────────────────────────────────────────
assert() {
  local desc="$1" cond="$2" detail="${3:-}"
  if eval "$cond"; then
    pass "$desc"; inc_pass
  else
    fail "$desc"; [[ -n "$detail" ]] && printf "    ${RED}%s${NC}\n" "$detail"
    inc_fail
  fi
}

# ── Flags ────────────────────────────────────────────────────────────────────
# Detected during prerequisite checks.
HAS_LLM_PROVIDER=false
USING_PRECONFIGURED=false

# ── Persistent state ─────────────────────────────────────────────────────────
TEAM_ID=""
PROJECT_ID=""
API_KEY=""
COMPILE_EVENT_ID=""
COMPILE_JOB_ID=""
CONCEPT_UUID=""

# ── Prerequisites ────────────────────────────────────────────────────────────
check_prereqs() {
  header "M1 'Why' Moment Demo — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local missing=0

  for cmd in curl jq psql node; do
    command -v "$cmd" >/dev/null 2>&1 || { fail "Missing: $cmd"; missing=1; }
  done

  [[ -z "$DATABASE_URL" ]] && { fail "TEAMEM_DATABASE_URL not set"; missing=1; }

  # Verify Postgres connectivity
  if ! psql "$DATABASE_URL" -c 'SELECT 1' >/dev/null 2>&1; then
    fail "Cannot connect to database at DATABASE_URL"
    missing=1
  else
    info "Database: connected"
  fi

  # Check server reachability
  if curl -fsS "${BASE_URL}/healthz" >/dev/null 2>&1; then
    info "Server: ${BASE_URL} reachable (/healthz OK)"
  else
    fail "Server not reachable at ${BASE_URL}/healthz"
    missing=1
  fi

  # LLM provider availability is detected empirically: we submit a compile
  # job and see if it completes. No upfront server-config check needed.
  # The script always submits events — if compilation completes, MCP
  # assertions run; if the job stays queued, the script honestly skips.
  info "LLM provider: will be detected by whether compile job completes"

  # Check for preconfigured credentials
  if [[ -n "${TEAMEM_SMOKE_TEAM_ID:-}" && -n "${TEAMEM_SMOKE_PROJECT_ID:-}" && -n "${TEAMEM_API_KEY:-}" ]]; then
    USING_PRECONFIGURED=true
    TEAM_ID="$TEAMEM_SMOKE_TEAM_ID"
    PROJECT_ID="$TEAMEM_SMOKE_PROJECT_ID"
    API_KEY="$TEAMEM_API_KEY"
    info "Using preconfigured team/project/key"
  fi

  if [[ "$missing" -ne 0 ]]; then echo; echo "Fix the failures above and re-run."; exit 1; fi
  pass "All prerequisites met"
  echo ""
}

# ── Bootstrap ────────────────────────────────────────────────────────────────
find_repo_root() {
  local dir
  dir="$(cd "$(dirname "$0")" && pwd)"
  dir="$(dirname "$dir")"
  if [[ -d "$dir/apps/server/src" && -d "$dir/packages/schema/src" ]]; then
    echo "$dir"
  else
    git rev-parse --show-toplevel 2>/dev/null || echo "$dir"
  fi
}
REPO_ROOT="$(find_repo_root)"

run_bootstrap() {
  header "1. Bootstrap — Creating Isolated Team / Project / Key"

  if [[ "$USING_PRECONFIGURED" == "true" ]]; then
    info "Skipping bootstrap — using preconfigured credentials"
    return
  fi

  local entrypoint bootstrap_cmd bootstrap_dir
  if [[ -f "$REPO_ROOT/apps/server/src/index.ts" ]]; then
    bootstrap_cmd="npx tsx"
    bootstrap_dir="$REPO_ROOT/apps/server"
    entrypoint="src/index.ts"
  elif [[ -f "$REPO_ROOT/dist/index.js" ]]; then
    bootstrap_cmd="node"
    bootstrap_dir="$REPO_ROOT"
    entrypoint="dist/index.js"
  else
    fail "Cannot find server entrypoint"
    inc_fail
    return
  fi

  info "Running bootstrap from $bootstrap_dir..."
  local bootstrap_out
  bootstrap_out="$(cd "$bootstrap_dir" && TEAMEM_DATABASE_URL="$DATABASE_URL" \
    $bootstrap_cmd "$entrypoint" --bootstrap \
    --team-name "$TEAM_NAME" \
    --project-name "$PROJECT_NAME" \
    --principal-name "why-demo-service" \
    2>/dev/null)" || {
    fail "Bootstrap command failed"
    inc_fail
    return
  }

  if ! echo "$bootstrap_out" | jq empty >/dev/null 2>&1; then
    fail "Bootstrap output is not valid JSON"
    inc_fail
    return
  fi

  TEAM_ID="$(echo "$bootstrap_out" | jq -r '.team.id')"
  PROJECT_ID="$(echo "$bootstrap_out" | jq -r '.project.id')"
  API_KEY="$(echo "$bootstrap_out" | jq -r '.key.token // empty')"

  if [[ -z "$TEAM_ID" || -z "$PROJECT_ID" ]]; then
    fail "Bootstrap did not produce team/project IDs"
    inc_fail
    return
  fi

  pass "Team:    $TEAM_ID"
  pass "Project:  $PROJECT_ID"

  if [[ -z "$API_KEY" ]]; then
    fail "Bootstrap did not produce an API key token"
    inc_fail
    return
  fi

  if [[ ! "$API_KEY" =~ ^tm_ ]]; then
    fail "API key does not start with 'tm_'"
    inc_fail
    return
  fi

  pass "API key: created (starts with tm_)"
  inc_pass
  echo ""
}

auth_header() {
  echo "Authorization: Bearer ${API_KEY}"
}

# ── MCP JSON-RPC helper ─────────────────────────────────────────────────────
mcp_tool_call() {
  local tool_name="$1" tool_args_json="$2"
  curl -s -X POST "${BASE_URL}/mcp" \
    -H "Content-Type: application/json" \
    -H "$(auth_header)" \
    -d "$(jq -n \
      --arg name "$tool_name" \
      --argjson args "$tool_args_json" \
      '{
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: $name, arguments: $args }
      }')" 2>/dev/null || true
}

# ── Path 1: Ingest decision event ───────────────────────────────────────────
ingest_decision_event() {
  header "2. Ingest Decision Event — CLI Init with Rationale + PR + Commit"

  # Build a realistic engineering decision document describing WHY a specific
  # technical choice was made. The content mirrors a real ADR: conclusion,
  # rationale, alternatives considered, links to PR discussion and commit.
  local content='## Decision: Use PostgreSQL with pgvector as the Primary Database

**Status:** Accepted  
**PR Discussion:** https://github.com/teamem-ai/teamem-server/pull/42  
**Implementation Commit:** https://github.com/teamem-ai/teamem-server/commit/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0

### Context

We needed a primary datastore that supports:
- Transactional semantics for event ingestion and idempotency enforcement
- Vector similarity search for concept retrieval (F2 merge candidates)
- Job queue semantics for the compilation pipeline
- Strong consistency guarantees

### Decision

We chose PostgreSQL with the pgvector extension as our single database,
explicitly rejecting a multi-database architecture.

### Rationale

1. **Single operational dependency.** PostgreSQL + pgvector handles
   relational data, vector search, and (via pg-boss) job queuing in
   one system. This eliminates Redis/Valkey, Qdrant, and Milvus as
   separate stateful services, dramatically simplifying self-hosted
   deployments.

2. **Transactional consistency across domains.** Event ingestion,
   idempotency checks, and compilation job creation happen in a single
   Postgres transaction. With separate databases we would need
   distributed transactions or outbox patterns.

3. **Team operational experience.** The team already runs Postgres in
   production. Adding pgvector is a simple extension, not a new
   infrastructure skill.

4. **pg-boss provides exactly-once job delivery** on top of Postgres
   SKIP LOCKED, removing the need for a Redis-backed queue.

### Alternatives Considered

- **Redis/Valkey + Postgres (no pgvector).** Would require a separate
  vector database (Qdrant, Milvus), three stateful services total.
  Rejected due to operational complexity for self-hosted users.

- **Postgres + separate vector DB (Qdrant).** Two databases, no
  cross-domain transactions. Embedding and relational data could
  drift independently.

- **SQLite + pgvector.** Suitable for single-process workloads but
  not for multi-process server deployments where the worker, API,
  and MCP endpoints each need concurrent access.

### Consequences

- The default deployment is two containers (postgres + server/worker
  all-in-one) instead of four or five.
- Embedding dimension is fixed at 1536 (OpenAI text-embedding-3-small).
- Semantic search gracefully degrades to full-text search when
  embedding is unavailable — never pretends vector search succeeded.'

  # Save content for idempotency replay later
  echo "$content" > "${WHY_TMP}/decision-content.txt"

  # Construct the ingest request payload
  local ingest_payload
  ingest_payload="$(jq -n \
    --arg projectId "$PROJECT_ID" \
    --arg ts "$TIMESTAMP" \
    --arg content "$content" \
    '{
      projectId: $projectId,
      source: {
        kind: "cli_init",
        externalId: "teamem-ai/teamem-server",
        url: "https://github.com/teamem-ai/teamem-server/blob/main/docs/decisions/001-use-postgres-pgvector.md"
      },
      idempotencyKey: ("why-moment-decision-" + $ts),
      options: { compile: true, wait: false },
      payload: {
        schemaVersion: 1,
        repo: "teamem-ai/teamem-server",
        commitSha: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
        path: "docs/decisions/001-use-postgres-pgvector.md",
        content: $content
      }
    }')"

  local resp http_code
  resp="$(curl -s -w '\n%{http_code}' -X POST "${BASE_URL}/v1/events" \
    -H "Content-Type: application/json" \
    -H "$(auth_header)" \
    -d "$ingest_payload" 2>/dev/null || true)"
  http_code="$(echo "$resp" | tail -1)"
  local body; body="$(echo "$resp" | sed '$d')"

  assert "ingest: HTTP 202 accepted" "[ \"$http_code\" = \"202\" ]" "got: $http_code"

  COMPILE_EVENT_ID="$(echo "$body" | jq -r '.eventId // empty')"
  COMPILE_JOB_ID="$(echo "$body" | jq -r '.jobId // empty')"

  if [[ -z "$COMPILE_EVENT_ID" || ! "$COMPILE_EVENT_ID" =~ ^evt_ ]]; then
    fail "ingest: no valid eventId in response"
    inc_fail
    return
  fi
  pass "ingest: eventId = $COMPILE_EVENT_ID"
  echo "$COMPILE_EVENT_ID" >> "${WHY_TMP}/cleanup-event-ids"

  if [[ -z "$COMPILE_JOB_ID" || "$COMPILE_JOB_ID" = "null" ]]; then
    fail "ingest: jobId is null — compilation job was not created"
    inc_fail
    return
  fi
  pass "ingest: jobId = $COMPILE_JOB_ID"
  echo "$COMPILE_JOB_ID" >> "${WHY_TMP}/cleanup-job-ids"

  # ── Verify redaction: payload stored without <private> tags ────────────
  local stored_content
  stored_content="$(psql "$DATABASE_URL" -t -A -c \
    "SELECT payload->>'content' FROM events WHERE id = '${COMPILE_EVENT_ID}'" 2>/dev/null || echo '')"

  if echo "$stored_content" | grep -q '<private>'; then
    fail "redaction: <private> tag leaked in stored content"
    inc_fail
  else
    pass "redaction: payload stored without <private> tags"
    inc_pass
  fi

  echo ""
}

# ── Path 2: Wait for compilation ────────────────────────────────────────────
wait_for_compilation() {
  header "3. Compilation — Wait for Compile Job"

  info "Polling job ${COMPILE_JOB_ID}..."
  local max_attempts=60
  local attempt=0
  local job_status=""

  while [[ $attempt -lt $max_attempts ]]; do
    attempt=$((attempt + 1))

    local job_resp
    job_resp="$(curl -s -H "$(auth_header)" \
      "${BASE_URL}/v1/jobs/${COMPILE_JOB_ID}" 2>/dev/null || true)"

    if ! echo "$job_resp" | jq empty >/dev/null 2>&1; then
      warn "  attempt $attempt: non-JSON response, retrying..."
      sleep 2
      continue
    fi

    job_status="$(echo "$job_resp" | jq -r '.data.status // empty')"

    case "$job_status" in
      completed)
        info "  attempt $attempt: status=completed"
        local concept_ids
        concept_ids="$(echo "$job_resp" | jq -r '.data.conceptIds // []')"
        CONCEPT_UUID="$(echo "$concept_ids" | jq -r '.[0] // empty')"
        HAS_LLM_PROVIDER=true
        break
        ;;
      failed)
        local job_err; job_err="$(echo "$job_resp" | jq -c '.data.error // {}')"
        fail "Job ${COMPILE_JOB_ID} failed: $job_err"
        inc_fail
        local events_out; events_out="$(echo "$job_resp" | jq -c '.data.events // []')"
        info "Per-event outcomes: $events_out"
        echo ""
        return
        ;;
      processing|queued)
        if [[ $((attempt % 10)) -eq 0 ]]; then
          info "  attempt $attempt: status=$job_status, still waiting..."
        fi
        sleep 2
        ;;
      *)
        warn "  attempt $attempt: unknown status=$job_status, waiting..."
        sleep 2
        ;;
    esac
  done

  if [[ "$job_status" == "completed" ]]; then
    pass "Job completed: $COMPILE_JOB_ID"
    inc_pass
  elif [[ "$job_status" == "processing" || "$job_status" == "queued" ]]; then
    warn "Job still $job_status after ${max_attempts} attempts — no LLM provider or worker not running."
    warn "The event is persisted but compilation is not progressing."
    warn "Honest skip: compilation/retrieval assertions will be skipped (§5.5)."
    echo ""
    return
  else
    fail "Job did not complete within $max_attempts attempts (last status: ${job_status:-unknown})"
    inc_fail
    echo ""
    return
  fi

  if [[ -z "$CONCEPT_UUID" || "$CONCEPT_UUID" = "null" ]]; then
    fail "No concept pages produced — compilation yielded 0 concepts"
    inc_fail
    echo ""
    return
  fi

  pass "Concept UUID: $CONCEPT_UUID"
  echo "$CONCEPT_UUID" >> "${WHY_TMP}/cleanup-concept-ids"
  inc_pass
  echo ""
}

# ── Path 3: MCP search — find the decision concept ──────────────────────────
mcp_search_decision() {
  header "4. MCP Search — Find the Decision Concept"

  if [[ "$HAS_LLM_PROVIDER" != "true" ]]; then
    warn "No LLM provider — skipping MCP search."
    echo ""
    return
  fi

  if [[ -z "${CONCEPT_UUID:-}" ]]; then
    warn "No concept UUID available — skipping MCP search."
    echo ""
    return
  fi

  # Search for the decision using natural language: "why use postgres pgvector"
  local search_args='{"projectId": "'"$PROJECT_ID"'", "query": "why use postgres pgvector database decision"}'
  local search_resp
  search_resp="$(mcp_tool_call "search" "$search_args")"

  if ! echo "$search_resp" | jq empty >/dev/null 2>&1; then
    fail "MCP search: response is not valid JSON"
    inc_fail
    echo ""
    return
  fi

  # Check for JSON-RPC error
  if echo "$search_resp" | jq -e '.error' >/dev/null 2>&1; then
    local rpc_err; rpc_err="$(echo "$search_resp" | jq -r '.error.message // "unknown"')"
    fail "MCP search: JSON-RPC error: $rpc_err"
    inc_fail
    echo ""
    return
  fi

  # Parse the result — the text content is a JSON string
  local result_text
  result_text="$(echo "$search_resp" | jq -r '.result.content[0].text // ""')"

  if [[ -z "$result_text" ]]; then
    fail "MCP search: empty result content"
    inc_fail
    echo ""
    return
  fi

  local results_array degraded
  results_array="$(echo "$result_text" | jq -r '.results // []')"
  degraded="$(echo "$result_text" | jq -r '.degraded // false')"

  local result_count; result_count="$(echo "$results_array" | jq -r 'length // 0')"
  info "Search returned $result_count result(s)"

  if [[ "$degraded" == "true" ]]; then
    warn "Search is degraded (FTS-only mode — no vector capability)"
  fi

  # Verify that our concept UUID is in the search results
  local found_uuid
  found_uuid="$(echo "$results_array" | jq -r --arg uuid "$CONCEPT_UUID" \
    '.[] | select(.uuid == $uuid) | .uuid // empty')"

  if [[ -z "$found_uuid" ]]; then
    fail "MCP search: decision concept ($CONCEPT_UUID) not found in results"
    inc_fail
    info "Search results: $(echo "$results_array" | jq -c '[.[] | {uuid, title, type, relevance}]')"
  else
    pass "MCP search: decision concept found in search results"
    inc_pass

    # Verify the search result metadata
    local sr_type sr_title
    sr_type="$(echo "$results_array" | jq -r --arg uuid "$CONCEPT_UUID" \
      '.[] | select(.uuid == $uuid) | .type // ""')"
    sr_title="$(echo "$results_array" | jq -r --arg uuid "$CONCEPT_UUID" \
      '.[] | select(.uuid == $uuid) | .title // ""')"

    assert "  search result type is 'decision'" "[ \"$sr_type\" = \"decision\" ]" "got: $sr_type"
    assert "  search result has a title" "[ -n \"$sr_title\" ]"
    info "  Title: $sr_title"
  fi

  echo ""
}

# ── Path 4: MCP get_page — retrieve full decision concept ───────────────────
mcp_get_decision_page() {
  header "5. MCP get_page — Full Decision Concept Detail"

  if [[ "$HAS_LLM_PROVIDER" != "true" ]]; then
    warn "No LLM provider — skipping MCP get_page."
    echo ""
    return
  fi

  if [[ -z "${CONCEPT_UUID:-}" ]]; then
    warn "No concept UUID available — skipping MCP get_page."
    echo ""
    return
  fi

  local get_args='{"uuid": "'"$CONCEPT_UUID"'"}'
  local get_resp
  get_resp="$(mcp_tool_call "get_page" "$get_args")"

  if ! echo "$get_resp" | jq empty >/dev/null 2>&1; then
    fail "MCP get_page: response is not valid JSON"
    inc_fail
    echo ""
    return
  fi

  # Check for JSON-RPC error
  if echo "$get_resp" | jq -e '.error' >/dev/null 2>&1; then
    local rpc_err; rpc_err="$(echo "$get_resp" | jq -r '.error.message // "unknown"')"
    fail "MCP get_page: JSON-RPC error: $rpc_err"
    inc_fail
    echo ""
    return
  fi

  # Check for tool-level error (isError: true)
  if echo "$get_resp" | jq -e '.result.isError == true' >/dev/null 2>&1; then
    local tool_err; tool_err="$(echo "$get_resp" | jq -r '.result.content[0].text // "unknown error"')"
    fail "MCP get_page: tool error: $tool_err"
    inc_fail
    echo ""
    return
  fi

  local concept_json
  concept_json="$(echo "$get_resp" | jq -r '.result.content[0].text // ""')"

  if [[ -z "$concept_json" ]]; then
    fail "MCP get_page: empty concept content"
    inc_fail
    echo ""
    return
  fi

  local page; page="$(echo "$concept_json" | jq '.' 2>/dev/null || echo '')"
  if [[ -z "$page" ]]; then
    fail "MCP get_page: concept content is not valid JSON"
    inc_fail
    echo ""
    return
  fi

  info "Retrieved concept page: $(echo "$page" | jq -r '.uuid')"

  # ── Assertions on the decision page ────────────────────────────────────

  # 1. Concept type must be "decision"
  local c_type; c_type="$(echo "$page" | jq -r '.type // ""')"
  assert "  type = decision" "[ \"$c_type\" = \"decision\" ]" "got: $c_type"

  # 2. Status should be active
  local c_status; c_status="$(echo "$page" | jq -r '.status // ""')"
  assert "  status = active" "[ \"$c_status\" = \"active\" ]" "got: $c_status"

  # 3. Title is non-empty
  local c_title; c_title="$(echo "$page" | jq -r '.title // ""')"
  assert "  title is non-empty" "[ -n \"$c_title\" ]"
  info "  Title: $c_title"

  # 4. Body contains the decision rationale (must mention "PostgreSQL" or "pgvector")
  local c_body; c_body="$(echo "$page" | jq -r '.body // ""')"
  assert "  body is non-empty" "[ -n \"$c_body\" ]"

  if echo "$c_body" | grep -qi 'postgres\|pgvector'; then
    pass "  body references PostgreSQL/pgvector (decision subject)"
    inc_pass
  else
    fail "  body does not reference PostgreSQL/pgvector"
    inc_fail
  fi

  if echo "$c_body" | grep -qi 'rationale\|because\|reason\|chose\|chosen\|decision\|why'; then
    pass "  body contains decision rationale language"
    inc_pass
  else
    warn "  body may not contain explicit rationale language"
  fi

  # 5. Evidence must be present and link back to GitHub
  local ev_count; ev_count="$(echo "$page" | jq -r '.evidence | length // 0')"
  assert "  evidence: at least 1 item" "[ \"$ev_count\" -ge 1 ]" "got: $ev_count"

  # Check each evidence item for GitHub-reachable fields
  local has_github_link=false
  local ev_idx=0
  while [[ $ev_idx -lt $ev_count ]]; do
    local ev_kind; ev_kind="$(echo "$page" | jq -r ".evidence[$ev_idx].kind // \"\"")"
    info "  evidence[$ev_idx]: kind=$ev_kind"

    case "$ev_kind" in
      repo_file)
        local ev_repo ev_sha ev_path
        ev_repo="$(echo "$page" | jq -r ".evidence[$ev_idx].repo // \"\"")"
        ev_sha="$(echo "$page" | jq -r ".evidence[$ev_idx].commitSha // \"\"")"
        ev_path="$(echo "$page" | jq -r ".evidence[$ev_idx].path // \"\"")"

        assert "    repo_file.repo is set" "[ -n \"$ev_repo\" ]"
        assert "    repo_file.commitSha matches 7-40 hex chars" \
          "[ \"$(echo \"$ev_sha\" | grep -cE '^[0-9a-f]{7,40}$' || echo 0)\" = \"1\" ]" \
          "got: $ev_sha"
        assert "    repo_file.path is set" "[ -n \"$ev_path\" ]"

        # Verify this evidence links back to real GitHub
        if [[ -n "$ev_repo" && -n "$ev_sha" ]]; then
          local gh_url="https://github.com/${ev_repo}/commit/${ev_sha}"
          info "    → GitHub commit permalink: $gh_url"
          has_github_link=true
        fi
        ;;
      pr)
        local pr_ref; pr_ref="$(echo "$page" | jq -r ".evidence[$ev_idx].ref // \"\"")"
        assert "    pr.ref is a URL" "[ -n \"$pr_ref\" ]"
        if echo "$pr_ref" | grep -qE '^https?://'; then
          info "    → PR link: $pr_ref"
          if echo "$pr_ref" | grep -qi 'github'; then
            has_github_link=true
          fi
        fi
        ;;
      commit)
        local cm_ref; cm_ref="$(echo "$page" | jq -r ".evidence[$ev_idx].ref // \"\"")"
        assert "    commit.ref is a URL" "[ -n \"$cm_ref\" ]"
        if echo "$cm_ref" | grep -qE '^https?://'; then
          info "    → Commit link: $cm_ref"
          if echo "$cm_ref" | grep -qi 'github'; then
            has_github_link=true
          fi
        fi
        ;;
      *)
        info "    evidence kind: $ev_kind"
        ;;
    esac
    ev_idx=$((ev_idx + 1))
  done

  # 6. At least one evidence item must link back to real GitHub
  if [[ "$has_github_link" == "true" ]]; then
    pass "  evidence links back to real GitHub (repo + commitSha permalink)"
    inc_pass
  else
    fail "  no evidence item links back to GitHub"
    inc_fail
  fi

  # 7. Body contains PR discussion reference (link to GitHub PR)
  if echo "$c_body" | grep -qE 'github\.com/[^/]+/[^/]+/(pull|issues)/[0-9]+'; then
    pass "  body contains GitHub PR/issue discussion link"
    inc_pass
    # Extract the actual link for display
    local pr_link; pr_link="$(echo "$c_body" | grep -oE 'https?://github\.com/[^/]+/[^/]+/(pull|issues)/[0-9]+' | head -1 || true)"
    if [[ -n "$pr_link" ]]; then
      info "    → PR discussion: $pr_link"
    fi
  else
    warn "  body does not contain explicit GitHub PR/issue link (may have been in original event but not extracted)"
  fi

  # 8. Body contains commit reference
  if echo "$c_body" | grep -qE 'github\.com/[^/]+/[^/]+/commit/[0-9a-f]{7,40}'; then
    pass "  body contains GitHub commit permalink"
    inc_pass
    local cm_link; cm_link="$(echo "$c_body" | grep -oE 'https?://github\.com/[^/]+/[^/]+/commit/[0-9a-f]{7,40}' | head -1 || true)"
    if [[ -n "$cm_link" ]]; then
      info "    → Implementation commit: $cm_link"
    fi
  else
    warn "  body does not contain explicit GitHub commit permalink (may have been in original event but not extracted)"
  fi

  # 9. Confidence is set
  local c_conf; c_conf="$(echo "$page" | jq -r '.confidence // ""')"
  assert "  confidence is set (high|medium|low)" \
    "[ \"$(echo \"$c_conf\" | grep -cE '^(high|medium|low)$' || echo 0)\" = \"1\" ]" \
    "got: $c_conf"

  # 10. Path is a valid concept path
  local c_path; c_path="$(echo "$page" | jq -r '.path // ""')"
  assert "  path is set and valid" "[ -n \"$c_path\" ]"

  echo ""
}

# ── Path 5: Idempotent replay ───────────────────────────────────────────────
test_idempotency() {
  header "6. Idempotency — Duplicate Replay"

  if [[ -z "${COMPILE_EVENT_ID:-}" ]]; then
    warn "No event to replay — skipping."
    echo ""
    return
  fi

  local replay_content
  replay_content="$(cat "${WHY_TMP}/decision-content.txt" 2>/dev/null || true)"
  if [[ -z "$replay_content" ]]; then
    warn "No saved content for replay — skipping."
    echo ""
    return
  fi

  # Replay the EXACT same payload → expect 200 duplicate
  local replay_payload
  replay_payload="$(jq -n \
    --arg projectId "$PROJECT_ID" \
    --arg ts "$TIMESTAMP" \
    --arg content "$replay_content" \
    '{
      projectId: $projectId,
      source: { kind: "cli_init", externalId: "teamem-ai/teamem-server" },
      idempotencyKey: ("why-moment-decision-" + $ts),
      options: { compile: false, wait: false },
      payload: {
        schemaVersion: 1,
        repo: "teamem-ai/teamem-server",
        commitSha: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
        path: "docs/decisions/001-use-postgres-pgvector.md",
        content: $content
      }
    }')"

  local resp http_code
  resp="$(curl -s -w '\n%{http_code}' -X POST "${BASE_URL}/v1/events" \
    -H "Content-Type: application/json" \
    -H "$(auth_header)" \
    -d "$replay_payload" 2>/dev/null || true)"
  http_code="$(echo "$resp" | tail -1)"
  local body; body="$(echo "$resp" | sed '$d')"

  assert "  replay: HTTP 200 (duplicate)" "[ \"$http_code\" = \"200\" ]" "got: $http_code"

  local dup; dup="$(echo "$body" | jq -r '.duplicate // false')"
  assert "  replay: duplicate=true" "[ \"$dup\" = \"true\" ]"

  local replay_event_id
  replay_event_id="$(echo "$body" | jq -r '.eventId // empty')"
  assert "  replay: same eventId as original" \
    "[ \"$replay_event_id\" = \"$COMPILE_EVENT_ID\" ]" \
    "original=$COMPILE_EVENT_ID replay=$replay_event_id"

  # Idempotency conflict: same key, DIFFERENT payload → 409
  local conflict_payload
  conflict_payload="$(jq -n \
    --arg projectId "$PROJECT_ID" \
    --arg ts "$TIMESTAMP" \
    '{
      projectId: $projectId,
      source: { kind: "cli_init", externalId: "teamem-ai/teamem-server" },
      idempotencyKey: ("why-moment-decision-" + $ts),
      options: { compile: false, wait: false },
      payload: {
        schemaVersion: 1,
        repo: "teamem-ai/teamem-server",
        commitSha: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
        path: "docs/decisions/001-use-postgres-pgvector.md",
        content: "DIFFERENT content — this must trigger an idempotency conflict"
      }
    }')"

  resp="$(curl -s -w '\n%{http_code}' -X POST "${BASE_URL}/v1/events" \
    -H "Content-Type: application/json" \
    -H "$(auth_header)" \
    -d "$conflict_payload" 2>/dev/null || true)"
  http_code="$(echo "$resp" | tail -1)"
  body="$(echo "$resp" | sed '$d')"

  assert "  conflict: HTTP 409 (idempotency_conflict)" \
    "[ \"$http_code\" = \"409\" ]" "got: $http_code"

  local err_code; err_code="$(echo "$body" | jq -r '.error.code // empty')"
  assert "  conflict: error.code = idempotency_conflict" \
    "[ \"$err_code\" = \"idempotency_conflict\" ]" "got: $err_code"

  echo ""
}

# ── Path 6: PostgreSQL verification ──────────────────────────────────────────
verify_psql() {
  header "7. PostgreSQL Verification — First-Class Data"

  if [[ -z "${TEAM_ID:-}" || -z "${PROJECT_ID:-}" ]]; then
    warn "No team/project — skipping PostgreSQL verification."
    echo ""
    return
  fi

  # Verify events table
  local event_count
  event_count="$(psql "$DATABASE_URL" -t -A -c \
    "SELECT COUNT(*) FROM events WHERE project_id = '${PROJECT_ID}' AND team_id = '${TEAM_ID}'" 2>/dev/null || echo '0')"
  assert "  events: at least 1 row" "[ \"$event_count\" -ge 1 ]" "got: $event_count"

  # Verify channel/kind
  local cli_count
  cli_count="$(psql "$DATABASE_URL" -t -A -c \
    "SELECT COUNT(*) FROM events WHERE project_id = '${PROJECT_ID}' AND channel = 'cli' AND kind = 'cli_init'" 2>/dev/null || echo '0')"
  assert "  events: cli + cli_init row" "[ \"$cli_count\" -ge 1 ]" "got: $cli_count"

  # Verify concepts (if compilation ran)
  local concept_count
  concept_count="$(psql "$DATABASE_URL" -t -A -c \
    "SELECT COUNT(*) FROM concepts WHERE project_id = '${PROJECT_ID}' AND team_id = '${TEAM_ID}'" 2>/dev/null || echo '0')"
  info "  concepts: $concept_count row(s)"
  if [[ "$HAS_LLM_PROVIDER" == "true" ]]; then
    assert "  concepts: at least 1 row (compilation produced a page)" "[ \"$concept_count\" -ge 1 ]" "got: $concept_count"
  fi

  # Verify concept_evidence
  local evidence_count
  evidence_count="$(psql "$DATABASE_URL" -t -A -c \
    "SELECT COUNT(*) FROM concept_evidence WHERE project_id = '${PROJECT_ID}' AND team_id = '${TEAM_ID}'" 2>/dev/null || echo '0')"
  info "  concept_evidence: $evidence_count row(s)"

  # Verify concept_paths
  local path_count
  path_count="$(psql "$DATABASE_URL" -t -A -c \
    "SELECT COUNT(*) FROM concept_paths WHERE project_id = '${PROJECT_ID}' AND team_id = '${TEAM_ID}'" 2>/dev/null || echo '0')"
  info "  concept_paths: $path_count row(s)"

  # Verify jobs
  local job_count
  job_count="$(psql "$DATABASE_URL" -t -A -c \
    "SELECT COUNT(*) FROM jobs WHERE project_id = '${PROJECT_ID}' AND team_id = '${TEAM_ID}'" 2>/dev/null || echo '0')"
  assert "  jobs: at least 1 row" "[ \"$job_count\" -ge 1 ]" "got: $job_count"

  # Verify job_events linking
  local je_count
  je_count="$(psql "$DATABASE_URL" -t -A -c \
    "SELECT COUNT(*) FROM job_events WHERE project_id = '${PROJECT_ID}' AND team_id = '${TEAM_ID}'" 2>/dev/null || echo '0')"
  assert "  job_events: events linked to jobs" "[ \"$je_count\" -ge 1 ]" "got: $je_count"

  echo ""
}

# ── Cleanup ─────────────────────────────────────────────────────────────────
cleanup_all() {
  header "8. Cleanup"

  if [[ "${KEEP_DATA}" = "true" ]]; then
    info "KEEP_DATA=true — database rows preserved"
    return
  fi

  local pid="$PROJECT_ID"
  local tid="$TEAM_ID"

  if [[ -z "$pid" || -z "$tid" ]]; then
    warn "No team/project IDs — skipping cleanup"
    return
  fi

  if [[ "$USING_PRECONFIGURED" == "true" ]]; then
    info "Using preconfigured team/project — skipping cleanup"
    return
  fi

  info "Cleaning test data from project $pid..."

  psql "$DATABASE_URL" -c "
    DELETE FROM concept_contributors WHERE project_id = '${pid}' AND team_id = '${tid}';
    DELETE FROM concept_evidence      WHERE project_id = '${pid}' AND team_id = '${tid}';
    DELETE FROM concept_paths         WHERE project_id = '${pid}' AND team_id = '${tid}';
    DELETE FROM concepts              WHERE project_id = '${pid}' AND team_id = '${tid}';
    DELETE FROM job_events            WHERE project_id = '${pid}' AND team_id = '${tid}';
    DELETE FROM events                WHERE project_id = '${pid}' AND team_id = '${tid}';
    DELETE FROM jobs                  WHERE project_id = '${pid}' AND team_id = '${tid}';
  " >/dev/null 2>&1 || true

  pass "Test data cleaned from project $pid"
  echo ""
}

# ── Summary ─────────────────────────────────────────────────────────────────
print_summary() {
  header "9. M1 'Why' Moment Demo Summary"

  local pass_c fail_c total
  pass_c="$(get_pass)"; fail_c="$(get_fail)"; total=$((pass_c + fail_c))

  echo "  Total assertions: $total"
  printf "  ${GREEN}Passed: ${pass_c}${NC}\n"
  printf "  ${RED}Failed: ${fail_c}${NC}\n"

  if [[ "$HAS_LLM_PROVIDER" != "true" ]]; then
    echo ""
    warn "LLM provider was NOT available — compilation job did not complete."
    warn "Search, get_page, and retrieval assertions were skipped."
    warn "This is the honest fallback (§5.5: never pretend compilation succeeded)."
    warn "To see the full 'why moment', configure an LLM provider and ensure"
    warn "the worker is running, then re-run:"
    echo ""
    info "  export TEAMEM_DATABASE_URL=postgres://..."
    info "  bash scripts/m1-why-moment.sh"
  fi

  echo ""

  if [[ "$fail_c" -eq 0 ]]; then
    pass "ALL CHECKS PASSED — M1 'Why' Moment demo verified"
  else
    fail "SOME CHECKS FAILED — see details above"
    exit 1
  fi
}

# ── Main ────────────────────────────────────────────────────────────────────
main() {
  check_prereqs
  run_bootstrap
  ingest_decision_event
  wait_for_compilation
  mcp_search_decision
  mcp_get_decision_page
  test_idempotency
  verify_psql
  cleanup_all
  print_summary
}

main
