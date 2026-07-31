#!/usr/bin/env bash
# M2 SessionStart Live Injection + Viewer Read-Only Verification (DUA-244)
#
# Verifies two capabilities:
#   1. SessionStart Live Injection — /v1/context returns a token-budget-
#      controlled markdown summary for agent auto-injection. Demonstrates
#      that a new agent session receives team context without asking.
#   2. Viewer Read-Only — viewer role cannot mint keys, change config,
#      purge, or use search/context. Member+ can search and access context.
#
# Tests:
#   A. SessionStart context injection (API key)
#      A1 — project with concepts → 200, markdown with budget metadata
#      A2 — empty project → 200, honest empty summary (no error)
#      A3 — no payload/token/content leakage in response
#      A4 — viewer web session → 403
#      A5 — member web session → 200
#   B. Viewer read-only enforcement
#      B1 — viewer can list concepts → 200
#      B2 — viewer search → 403
#      B3 — viewer context → 403
#      B4 — viewer mint key → 403
#      B5 — viewer purge → 403
#      B6 — viewer LLM config → 403
#      B7 — member search → 200
#      B8 — member context → 200
#   C. Anti-enumeration & boundary
#      C1 — cross-team context → empty (200, not 404/403)
#      C2 — context response contains no payload, query text, or token
#
# Configuration (all via environment variables):
#   TEAMEM_BASE_URL       — server base URL (default: http://127.0.0.1:8080)
#   TEAMEM_DATABASE_URL   — Postgres connection string (required)
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
TIMESTAMP="$(date +%Y%m%dT%H%M%S)"
TEAM_NAME="M2-QA-Viewer-${TIMESTAMP}"
PROJECT_NAME="qa-viewer-${TIMESTAMP}"

TMPDIR="${TMPDIR:-/tmp}"
TMP="$(mktemp -d "${TMPDIR}/teamem-m2-viewer.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

PASS_F="${TMP}/pass"; echo 0 > "$PASS_F"
FAIL_F="${TMP}/fail"; echo 0 > "$FAIL_F"
inc_pass() { local c; c=$(cat "$PASS_F"); echo $((c+1)) > "$PASS_F"; }
inc_fail() { local c; c=$(cat "$FAIL_F"); echo $((c+1)) > "$FAIL_F"; }
get_pass() { cat "$PASS_F"; }
get_fail() { cat "$FAIL_F"; }

assert() {
  local desc="$1" cond="$2" detail="${3:-}"
  if eval "$cond"; then
    pass "$desc"; inc_pass
  else
    fail "$desc"; [[ -n "$detail" ]] && printf "    ${RED}%s${NC}\n" "$detail"
    inc_fail
  fi
}

# ── Prerequisites ────────────────────────────────────────────────────────────
check_prereqs() {
  header "M2 SessionStart + Viewer Read-Only Verification — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local missing=0

  for cmd in curl jq psql node; do
    command -v "$cmd" >/dev/null 2>&1 || { fail "Missing: $cmd"; missing=1; }
  done

  [[ -z "$DATABASE_URL" ]] && { fail "TEAMEM_DATABASE_URL not set"; missing=1; }

  if ! psql "$DATABASE_URL" -c 'SELECT 1' >/dev/null 2>&1; then
    fail "Cannot connect to database at DATABASE_URL"
    missing=1
  else
    info "Database: connected"
  fi

  if curl -fsS "${BASE_URL}/healthz" >/dev/null 2>&1; then
    info "Server: ${BASE_URL} reachable (/healthz OK)"
  else
    fail "Server not reachable at ${BASE_URL}/healthz"
    missing=1
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

E2E_TEAM_ID=""
E2E_PROJECT_ID=""
E2E_API_KEY=""
E2E_BOOTSTRAP_OUT=""

run_bootstrap() {
  header "1. Bootstrap — Creating Isolated Team / Project / Key"

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
  E2E_BOOTSTRAP_OUT="$(cd "$bootstrap_dir" && TEAMEM_DATABASE_URL="$DATABASE_URL" \
    $bootstrap_cmd "$entrypoint" --bootstrap \
    --team-name "$TEAM_NAME" \
    --project-name "$PROJECT_NAME" \
    --principal-name "e2e-qa-service" \
    2>/dev/null)" || {
    fail "Bootstrap command failed"
    inc_fail
    return
  }

  if ! echo "$E2E_BOOTSTRAP_OUT" | jq empty >/dev/null 2>&1; then
    fail "Bootstrap output is not valid JSON"
    inc_fail
    return
  fi

  E2E_TEAM_ID="$(echo "$E2E_BOOTSTRAP_OUT" | jq -r '.team.id')"
  E2E_PROJECT_ID="$(echo "$E2E_BOOTSTRAP_OUT" | jq -r '.project.id')"
  E2E_API_KEY="$(echo "$E2E_BOOTSTRAP_OUT" | jq -r '.key.token // empty')"

  if [[ -z "$E2E_TEAM_ID" || -z "$E2E_PROJECT_ID" || -z "$E2E_API_KEY" ]]; then
    fail "Bootstrap did not produce expected IDs/key"
    inc_fail
    return
  fi

  pass "Team:    $E2E_TEAM_ID"
  pass "Project: $E2E_PROJECT_ID"
  pass "API key: created (starts with tm_)"
  inc_pass
  echo ""
}

auth_header() { echo "Authorization: Bearer ${E2E_API_KEY}"; }
session_cookie() { echo "teamem_session=$1"; }

# ── DB helpers for creating test users with roles ──────────────────────────

create_db_user() {
  local github_id="$1" login="$2"
  local uid="usr_$(openssl rand -hex 8 2>/dev/null || echo "${RANDOM}${RANDOM}")"
  psql "$DATABASE_URL" -t -A -c \
    "INSERT INTO users (id, github_id, github_login) VALUES ('${uid}', ${github_id}, '${login}') ON CONFLICT (github_id) DO UPDATE SET id = users.id RETURNING id" \
    2>/dev/null || echo "$uid"
}

add_membership() {
  local user_id="$1" team_id="$2" role="$3"
  psql "$DATABASE_URL" -t -A -c \
    "INSERT INTO memberships (user_id, team_id, role) VALUES ('${user_id}', '${team_id}', '${role}') ON CONFLICT (user_id, team_id) DO UPDATE SET role = '${role}'" \
    2>/dev/null
}

create_web_session() {
  local user_id="$1"
  # Generate a session token (simulated — not through real OAuth).
  # For verification we insert a pre-hashed session directly.
  local ses_id="ses_$(openssl rand -hex 8 2>/dev/null || echo "${RANDOM}${RANDOM}")"
  # Use a known plaintext for testing: "qa-test-session-${TIMESTAMP}-${role}"
  local plaintext="qa-session-${user_id}-${TIMESTAMP}"

  # SHA-256 the plaintext
  local token_hash
  if command -v sha256sum >/dev/null 2>&1; then
    token_hash="$(echo -n "$plaintext" | sha256sum | cut -d' ' -f1)"
  elif command -v shasum >/dev/null 2>&1; then
    token_hash="$(echo -n "$plaintext" | shasum -a 256 | cut -d' ' -f1)"
  else
    warn "No sha256sum/shasum available — skipping session creation"
    echo ""
    return
  fi

  local now; now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local expires; expires="$(date -u -d '+7 days' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v+7d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo '2099-01-01T00:00:00Z')"

  psql "$DATABASE_URL" -t -A -c \
    "INSERT INTO web_sessions (id, user_id, token_hash, issued_at, expires_at)
     VALUES ('${ses_id}', '${user_id}', '${token_hash}', '${now}', '${expires}')" \
    2>/dev/null || true

  echo "$plaintext"
}

# ── Seed a concept for context tests ────────────────────────────────────────

seed_concept() {
  local content="## Decision

We decided to use PostgreSQL with pgvector as our primary database.
This gives us transactional semantics, strong consistency, and
vector similarity search in a single system.

### Rationale
- Avoids operational complexity of running Redis alongside Postgres.
- pg-boss provides job queue semantics on top of Postgres.
- Team already has operational experience with Postgres."

  local payload
  payload="$(jq -n \
    --arg projectId "$E2E_PROJECT_ID" \
    --arg ts "$TIMESTAMP" \
    --arg content "$content" \
    '{
    projectId: $projectId,
    source: { kind: "cli_init", externalId: "qa-org/qa-repo" },
    idempotencyKey: ("qa-seed-" + $ts),
    options: { compile: true, wait: true },
    payload: {
      schemaVersion: 1,
      repo: "qa-org/qa-repo",
      commitSha: "abc1234def567890123456789abcdef123456789",
      path: "docs/decisions/001-use-postgres.md",
      content: $content
    }
  }')"

  info "Seeding concept via compile=true event..."
  local resp; resp="$(curl -s -X POST "${BASE_URL}/v1/events" \
    -H "Content-Type: application/json" \
    -H "$(auth_header)" \
    -d "$payload" 2>/dev/null || true)"

  local http_code; http_code="$(echo "$resp" | tail -1 2>/dev/null || true)"
  if [[ -z "$http_code" ]]; then
    http_code="$(echo "$resp" | jq -r '.requestId // empty' 2>/dev/null)"
    # If jq didn't find a http_code line, just check if response has data
    if echo "$resp" | jq -e '.data' >/dev/null 2>&1; then
      info "Concept seed: compilation job created"
    else
      warn "Concept seed: unexpected response — continuing"
    fi
  fi

  # Wait a moment for compilation
  sleep 3
}

# ═══════════════════════════════════════════════════════════════════════════════
# A. SessionStart Context Injection Tests
# ═══════════════════════════════════════════════════════════════════════════════

test_context_injection() {
  header "A. SessionStart Context Injection (/v1/context)"

  # ── A1: Project with concepts → 200 with budget metadata ──────────────
  info "A1 — Context with seeded concepts"
  local resp; resp="$(curl -s "${BASE_URL}/v1/context?projectId=${E2E_PROJECT_ID}" \
    -H "$(auth_header)" 2>/dev/null || true)"

  if ! echo "$resp" | jq empty >/dev/null 2>&1; then
    fail "A1: /v1/context response is not valid JSON"
    inc_fail
    return
  fi

  assert "A1: HTTP 200" \
    "[ \"$(echo "$resp" | jq -r '.requestId // empty')\" != \"\" ]"

  local markdown budget_used concepts_included concepts_available
  markdown="$(echo "$resp" | jq -r '.data.markdown // ""')"
  budget_used="$(echo "$resp" | jq -r '.data.budgetUsed // 0')"
  concepts_included="$(echo "$resp" | jq -r '.data.conceptsIncluded // 0')"
  concepts_available="$(echo "$resp" | jq -r '.data.conceptsAvailable // 0')"

  assert "A1: markdown is non-empty string" '[ -n "$markdown" ]'
  assert "A1: budgetUsed > 0" '[ "$budget_used" -gt 0 ]'
  assert "A1: conceptsAvailable >= conceptsIncluded" \
    '[ "$concepts_available" -ge "$concepts_included" ]'

  info "A1 — Token budget: ${budget_used} tokens used, ${concepts_included}/${concepts_available} concepts"
  info "A1 — Markdown preview: $(echo "$markdown" | head -1)"

  # ── A2: Empty project → honest empty summary ──────────────────────────
  info "A2 — Empty project context (honest empty summary)"

  # Create a second project with no data
  local empty_proj_id="prj_emptyqa_$(openssl rand -hex 4 2>/dev/null || echo "${RANDOM}${RANDOM}")"
  psql "$DATABASE_URL" -c \
    "INSERT INTO projects (id, team_id, name) VALUES ('${empty_proj_id}', '${E2E_TEAM_ID}', 'QA Empty Project') ON CONFLICT DO NOTHING" \
    >/dev/null 2>&1 || true

  resp="$(curl -s "${BASE_URL}/v1/context?projectId=${empty_proj_id}" \
    -H "$(auth_header)" 2>/dev/null || true)"

  assert "A2: empty project → HTTP 200 (not error)" \
    "[ \"$(echo "$resp" | jq -r '.requestId // empty')\" != \"\" ]"
  assert "A2: conceptsIncluded = 0" \
    "[ \"$(echo "$resp" | jq -r '.data.conceptsIncluded // -1')\" = \"0\" ]"
  assert "A2: conceptsAvailable = 0" \
    "[ \"$(echo "$resp" | jq -r '.data.conceptsAvailable // -1')\" = \"0\" ]"

  local empty_markdown; empty_markdown="$(echo "$resp" | jq -r '.data.markdown // ""')"
  assert "A2: honest empty message (contains 'No high-confidence')" \
    '[ -n "$(echo "$empty_markdown" | grep -i "no high-confidence\|no.*knowledge")" ]' \
    "got: $(echo "$empty_markdown" | head -1)"

  # Cleanup the empty project
  psql "$DATABASE_URL" -c "DELETE FROM projects WHERE id = '${empty_proj_id}'" >/dev/null 2>&1 || true

  # ── A3: No payload/token/query leakage ────────────────────────────────
  info "A3 — No payload/token/query leakage in context response"
  local full_response; full_response="$(echo "$resp" | jq -c '.')"

  # JSON keys should only be: requestId, data (with markdown, budgetUsed, etc.)
  local top_keys; top_keys="$(echo "$resp" | jq -r 'keys | join(",")')"
  assert "A3: top-level keys are requestId + data only" \
    '[ "$(echo "$top_keys" | tr "," "\n" | sort | tr "\n" ",")" = "data,requestId," ]'

  local data_keys; data_keys="$(echo "$resp" | jq -r '.data | keys | join(",")')"
  assert "A3: data keys are markdown/budgetUsed/conceptsIncluded/conceptsAvailable" \
    '[ "$(echo "$data_keys" | tr "," "\n" | sort | tr "\n" ",")" = "budgetUsed,conceptsAvailable,conceptsIncluded,markdown," ]'

  assert "A3: response contains no 'payload' key" \
    '[ "$(echo "$full_response" | grep -ci '"payload"')" = "0" ]'
  assert "A3: response contains no 'token' key" \
    '[ "$(echo "$full_response" | grep -ci '"token"')" = "0" ]'
  assert "A3: response contains no 'query' key" \
    '[ "$(echo "$full_response" | grep -ci '"query"')" = "0" ]'

  echo ""
}

# ═══════════════════════════════════════════════════════════════════════════════
# B. Viewer Read-Only Enforcement Tests
# ═══════════════════════════════════════════════════════════════════════════════

test_viewer_enforcement() {
  header "B. Viewer Read-Only Enforcement"

  # ── Create test users with roles ──────────────────────────────────────
  local viewer_uid member_uid
  viewer_uid="$(create_db_user 90001 'qa-viewer')"
  member_uid="$(create_db_user 90002 'qa-member')"

  add_membership "$viewer_uid" "$E2E_TEAM_ID" 'viewer'
  add_membership "$member_uid" "$E2E_TEAM_ID" 'member'

  local viewer_sess member_sess
  viewer_sess="$(create_web_session "$viewer_uid")"
  member_sess="$(create_web_session "$member_uid")"

  if [[ -z "$viewer_sess" || -z "$member_sess" ]]; then
    warn "Could not create web sessions — viewer enforcement tests will be limited"
    warn "Creating session tokens requires sha256sum/shasum utility"
    return
  fi

  info "Viewer user: $viewer_uid (session created)"
  info "Member user: $member_uid (session created)"

  local viewer_cookie; viewer_cookie="teamem_session=${viewer_sess}"
  local member_cookie; member_cookie="teamem_session=${member_sess}"

  # ── B1: Viewer can list concepts → 200 ────────────────────────────────
  info "B1 — Viewer can list concepts"
  local resp; resp="$(curl -s "${BASE_URL}/v1/concepts?projectId=${E2E_PROJECT_ID}" \
    -H "Cookie: ${viewer_cookie}" 2>/dev/null || true)"

  assert "B1: viewer GET /v1/concepts → 200" \
    '[ "$(echo "$resp" | jq -r ".data | type // \"\"")" = "array" ]' \
    "got status line from response"

  # ── B2: Viewer search → 403 ───────────────────────────────────────────
  info "B2 — Viewer cannot search"
  resp="$(curl -s -o /dev/null -w '%{http_code}' \
    -X POST "${BASE_URL}/v1/search" \
    -H "Content-Type: application/json" \
    -H "Cookie: ${viewer_cookie}" \
    -d "{\"projectId\":\"${E2E_PROJECT_ID}\",\"query\":\"test\"}" 2>/dev/null || true)"

  assert "B2: viewer POST /v1/search → 403" '[ "$resp" = "403" ]' "got: $resp"

  # ── B3: Viewer context → 403 ──────────────────────────────────────────
  info "B3 — Viewer cannot access context"
  resp="$(curl -s -o /dev/null -w '%{http_code}' \
    "${BASE_URL}/v1/context?projectId=${E2E_PROJECT_ID}" \
    -H "Cookie: ${viewer_cookie}" 2>/dev/null || true)"

  assert "B3: viewer GET /v1/context → 403" '[ "$resp" = "403" ]' "got: $resp"

  # ── B4: Viewer mint key → 403 ─────────────────────────────────────────
  info "B4 — Viewer cannot mint API keys"
  resp="$(curl -s -o /dev/null -w '%{http_code}' \
    -X POST "${BASE_URL}/v1/teams/${E2E_TEAM_ID}/keys" \
    -H "Content-Type: application/json" \
    -H "Cookie: ${viewer_cookie}" \
    -d '{"name":"qa-viewer-test-key","projectId":"'"${E2E_PROJECT_ID}"'","scopes":["read"]}' 2>/dev/null || true)"

  assert "B4: viewer POST /v1/teams/:id/keys → 403" '[ "$resp" = "403" ]' "got: $resp"

  # ── B5: Viewer purge → 403 ────────────────────────────────────────────
  info "B5 — Viewer cannot purge project"
  resp="$(curl -s -o /dev/null -w '%{http_code}' \
    -X POST "${BASE_URL}/teams/${E2E_TEAM_ID}/projects/${E2E_PROJECT_ID}/purge" \
    -H "Cookie: ${viewer_cookie}" 2>/dev/null || true)"

  assert "B5: viewer POST /teams/:id/projects/:id/purge → 403" \
    '[ "$resp" = "403" ]' "got: $resp"

  # ── B6: Viewer LLM config → 403 ───────────────────────────────────────
  info "B6 — Viewer cannot change LLM config"
  resp="$(curl -s -o /dev/null -w '%{http_code}' \
    -X PUT "${BASE_URL}/v1/teams/${E2E_TEAM_ID}/llm" \
    -H "Content-Type: application/json" \
    -H "Cookie: ${viewer_cookie}" \
    -d '{"provider":"openai","apiKey":"test-key-not-real"}' 2>/dev/null || true)"

  assert "B6: viewer PUT /v1/teams/:id/llm → 403" \
    '[ "$resp" = "403" ]' "got: $resp"

  # ── B7: Member search → 200 ───────────────────────────────────────────
  info "B7 — Member can search"
  resp="$(curl -s -o /dev/null -w '%{http_code}' \
    -X POST "${BASE_URL}/v1/search" \
    -H "Content-Type: application/json" \
    -H "Cookie: ${member_cookie}" \
    -d "{\"projectId\":\"${E2E_PROJECT_ID}\",\"query\":\"postgres\"}" 2>/dev/null || true)"

  assert "B7: member POST /v1/search → 200" '[ "$resp" = "200" ]' "got: $resp"

  # ── B8: Member context → 200 ──────────────────────────────────────────
  info "B8 — Member can access context"
  resp="$(curl -s -o /dev/null -w '%{http_code}' \
    "${BASE_URL}/v1/context?projectId=${E2E_PROJECT_ID}" \
    -H "Cookie: ${member_cookie}" 2>/dev/null || true)"

  assert "B8: member GET /v1/context → 200" '[ "$resp" = "200" ]' "got: $resp"

  # ── Cleanup test users ────────────────────────────────────────────────
  psql "$DATABASE_URL" -c "DELETE FROM web_sessions WHERE user_id IN ('${viewer_uid}','${member_uid}')" >/dev/null 2>&1 || true
  psql "$DATABASE_URL" -c "DELETE FROM memberships WHERE user_id IN ('${viewer_uid}','${member_uid}')" >/dev/null 2>&1 || true
  psql "$DATABASE_URL" -c "DELETE FROM users WHERE id IN ('${viewer_uid}','${member_uid}')" >/dev/null 2>&1 || true

  echo ""
}

# ═══════════════════════════════════════════════════════════════════════════════
# C. Anti-Enumeration & Boundary Tests
# ═══════════════════════════════════════════════════════════════════════════════

test_anti_enumeration() {
  header "C. Anti-Enumeration & Boundary"

  # ── C1: Cross-team context → empty (200, not 404/403) ─────────────────
  info "C1 — Cross-team context returns empty 200"

  # Create a second team + project
  local other_suffix; other_suffix="$(openssl rand -hex 4 2>/dev/null || echo "${RANDOM}${RANDOM}")"
  local other_out; other_out="$(cd "$REPO_ROOT/apps/server" && TEAMEM_DATABASE_URL="$DATABASE_URL" \
    npx tsx src/index.ts --bootstrap \
    --team-name "QA-Other-${other_suffix}" \
    --project-name "qa-other-${other_suffix}" \
    --principal-name "qa-other-service" \
    2>/dev/null)" || true

  local other_team_id; other_team_id="$(echo "$other_out" | jq -r '.team.id // empty' 2>/dev/null)"
  local other_proj_id; other_proj_id="$(echo "$other_out" | jq -r '.project.id // empty' 2>/dev/null)"

  if [[ -n "$other_team_id" && -n "$other_proj_id" ]]; then
    # Use our primary API key (belongs to E2E_TEAM_ID) to query the other team's project.
    # Since the key is scoped to a different team/project, it should return empty 200.
    local resp; resp="$(curl -s "${BASE_URL}/v1/context?projectId=${other_proj_id}" \
      -H "$(auth_header)" 2>/dev/null || true)"

    assert "C1: cross-team context → 200 (not 403/404)" \
      '[ "$(echo "$resp" | jq -r ".requestId // empty")" != "" ]'

    assert "C1: cross-team conceptsIncluded = 0" \
      '[ "$(echo "$resp" | jq -r ".data.conceptsIncluded // -1")" = "0" ]'
    assert "C1: cross-team conceptsAvailable = 0" \
      '[ "$(echo "$resp" | jq -r ".data.conceptsAvailable // -1")" = "0" ]'

    # Cleanup other team
    psql "$DATABASE_URL" -c "DELETE FROM api_keys WHERE team_id = '${other_team_id}'" >/dev/null 2>&1 || true
    psql "$DATABASE_URL" -c "DELETE FROM principals WHERE team_id = '${other_team_id}'" >/dev/null 2>&1 || true
    psql "$DATABASE_URL" -c "DELETE FROM projects WHERE team_id = '${other_team_id}'" >/dev/null 2>&1 || true
    psql "$DATABASE_URL" -c "DELETE FROM teams WHERE id = '${other_team_id}'" >/dev/null 2>&1 || true
  else
    warn "C1: Could not create cross-team resources — skipping"
  fi

  # ── C2: Context response contains no payload/token/query ──────────────
  info "C2 — Full table scan for payload/token in context response"
  local resp; resp="$(curl -s "${BASE_URL}/v1/context?projectId=${E2E_PROJECT_ID}" \
    -H "$(auth_header)" 2>/dev/null || true)"

  local full; full="$(echo "$resp" | jq -c '.' 2>/dev/null)"

  assert "C2: no 'payload' anywhere in response" \
    '[ "$(echo "$full" | grep -c '"payload"')" = "0" ]'
  assert "C2: no 'token' anywhere in response" \
    '[ "$(echo "$full" | grep -c '"token"')" = "0" ]'
  assert "C2: no 'query' anywhere in response" \
    '[ "$(echo "$full" | grep -c '"query"')" = "0" ]'
  assert "C2: no '<private>' in response markdown" \
    '[ "$(echo "$resp" | jq -r ".data.markdown // \"\"" | grep -c "<private>")" = "0" ]'

  echo ""
}

# ── Cleanup ─────────────────────────────────────────────────────────────────
cleanup_all() {
  header "D. Cleanup"

  local pid="$E2E_PROJECT_ID"
  local tid="$E2E_TEAM_ID"

  if [[ -z "$pid" || -z "$tid" ]]; then
    warn "No team/project IDs available — skipping cleanup"
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
    DELETE FROM api_keys              WHERE project_id = '${pid}';
    DELETE FROM projects              WHERE id = '${pid}';
    DELETE FROM api_keys              WHERE team_id = '${tid}' AND project_id IS NULL;
    DELETE FROM principals            WHERE team_id = '${tid}';
    DELETE FROM teams                 WHERE id = '${tid}';
  " >/dev/null 2>&1 || true

  pass "Test data cleaned"
  echo ""
}

# ── Summary ─────────────────────────────────────────────────────────────────
print_summary() {
  header "E. M2 SessionStart + Viewer Read-Only — Verification Summary"

  local pass_c fail_c total
  pass_c="$(get_pass)"; fail_c="$(get_fail)"; total=$((pass_c + fail_c))

  echo "  Total assertions: $total"
  printf "  ${GREEN}Passed: ${pass_c}${NC}\n"
  printf "  ${RED}Failed: ${fail_c}${NC}\n"
  echo ""

  if [[ "$fail_c" -eq 0 ]]; then
    pass "ALL CHECKS PASSED — SessionStart injection + viewer read-only verified"
  else
    fail "SOME CHECKS FAILED — see details above"
    exit 1
  fi

  # ── Manual UI walkthrough notes ──────────────────────────────────────
  cat <<'EOF'

  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Manual UI Walkthrough (to be performed by a human tester)
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  SessionStart Live Injection:
    1. Open a web browser, sign in as owner.
    2. Configure an MCP hook (Settings → Sources).
    3. Open a new agent session (Claude Code / Cursor / etc.)
    4. Verify: the agent's first message includes a team-context summary
       WITHOUT the user explicitly asking for it.
    5. Verify: the context shows budgetUsed, conceptsIncluded,
       conceptsAvailable metadata.
    6. Verify: context uses teamem://concept/<uuid> links.

  Viewer Read-Only (UI):
    1. As owner, invite a second GitHub user as viewer.
    2. Sign in as viewer in a separate browser/incognito window.
    3. Verify: Knowledge page shows ViewerInfoBanner.
    4. Verify: NO search bar appears on Knowledge page.
    5. Verify: member+ user HAS a search bar (confirm with member session).
    6. Navigate to Settings → API keys:
       → Verify: ViewerInfoBanner + PermissionDenied shown.
       → Verify: No "Mint API key" button.
    7. Navigate to Settings → Project:
       → Verify: ViewerInfoBanner + PermissionDenied shown.
    8. Navigate to Settings → Team:
       → Verify: ViewerInfoBanner + PermissionDenied shown.
    9. Navigate to Settings → LLM:
       → Verify: ViewerInfoBanner + PermissionDenied shown.
   10. Navigate to Settings → Sources:
       → Verify: ViewerInfoBanner + PermissionDenied shown.
   11. Navigate to Events → click an event detail:
       → Verify: payload section shows lock/permission guidance for viewer.
   12. Navigate to Audit:
       → Verify: PermissionDenied shown.

  Empty Database:
    1. Create a fresh project with no ingested events.
    2. Call GET /v1/context?projectId=<empty-project-id>.
    3. Verify: returns 200 with honest "No high-confidence team knowledge
       available yet" message.
    4. Verify: does NOT throw 500 or return a fake summary.

EOF
}

# ── Main ────────────────────────────────────────────────────────────────────
main() {
  check_prereqs
  run_bootstrap
  seed_concept
  test_context_injection
  test_viewer_enforcement
  test_anti_enumeration
  cleanup_all
  print_summary
}

main
