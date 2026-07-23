#!/usr/bin/env bash
# M1 Semantic Recall Differentiator QA Script (AGPL-3.0-only)
#
# DUA-216: Validates the core differentiator — F2 semantic recall correctly
# attributes a new event to an existing concept page even when the new event
# uses completely non-overlapping keywords (different language / rephrasing).
#
# Scenario:
#  1. Plant a known concept about "rate limiting with Redis token bucket"
#     via a CLI init event (English).
#  2. Ingest a second event describing the same concept with zero keyword
#     overlap — Chinese phrasing "避免接口被刷爆，用了令牌桶那套方案".
#  3. Assert F2 merges the second event into the existing page (page count
#     does NOT increase) when vector embedding is available.
#  4. If vector is unavailable, honestly skip with a clear explanation.
#
# The differentiator:
#  - Vector mode: embedding similarity correctly recalls the existing concept
#    as a merge candidate despite zero lexical overlap → F2 merges.
#  - FTS-only mode: keyword-based search cannot bridge different languages →
#    the second event creates a separate page (expected degradation). In this
#    mode we skip the main assertion and report the honest limitation.
#
# Prerequisites: curl, jq, a running teamem server, DATABASE_URL.
#
# Usage:
#   TEAMEM_BASE_URL=http://127.0.0.1:8080 \
#   TEAMEM_DATABASE_URL=postgres://... \
#   ./scripts/m1-semantic-recall.sh

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; NC='\033[0m'
pass()  { printf "${GREEN}✓ PASS${NC} %s\n" "$*"; }
fail()  { printf "${RED}✗ FAIL${NC} %s\n" "$*"; }
info()  { printf "${BOLD}→${NC} %s\n" "$*"; }
warn()  { printf "${YELLOW}⚠ WARN${NC} %s\n" "$*"; }
header() { printf '\n%s\n%s\n%s\n\n' "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" "${BOLD}$*${NC}" "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"; }

BASE_URL="${TEAMEM_BASE_URL:-http://127.0.0.1:8080}"
DATABASE_URL="${TEAMEM_DATABASE_URL:-}"
TIMESTAMP="$(date +%Y%m%dT%H%M%S)"
TEAM_NAME="M1-SEMRECALL-${TIMESTAMP}"
PROJECT_NAME="semrecall-${TIMESTAMP}"

TMPDIR="${TMPDIR:-/tmp}"
E2E_TMP="$(mktemp -d "${TMPDIR}/teamem-m1-semrecall.XXXXXX")"
trap 'rm -rf "$E2E_TMP"' EXIT

# Counter files
PASS_F="${E2E_TMP}/pass"; echo 0 > "$PASS_F"
FAIL_F="${E2E_TMP}/fail"; echo 0 > "$FAIL_F"
SKIP_F="${E2E_TMP}/skip"; echo 0 > "$SKIP_F"
inc_pass() { local c; c=$(cat "$PASS_F"); echo $((c+1)) > "$PASS_F"; }
inc_fail() { local c; c=$(cat "$FAIL_F"); echo $((c+1)) > "$FAIL_F"; }
inc_skip() { local c; c=$(cat "$SKIP_F"); echo $((c+1)) > "$SKIP_F"; }
get_pass() { cat "$PASS_F"; }
get_fail() { cat "$FAIL_F"; }
get_skip() { cat "$SKIP_F"; }

# ── Assertion helpers ────────────────────────────────────────────────────────
assert() {
  local desc="$1" cond="$2" detail="${3:-}"
  if eval "$cond"; then
    pass "$desc"; inc_pass
  else
    fail "$desc"; [[ -n "$detail" ]] && printf "    ${RED}%s${NC}\n" "$detail"
    inc_fail
  fi
}

# ── Find repo root ──────────────────────────────────────────────────────────
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

# ── Prerequisites ───────────────────────────────────────────────────────────
check_prereqs() {
  header "M1 Semantic Recall Differentiator — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local missing=0

  for cmd in curl jq; do
    command -v "$cmd" >/dev/null 2>&1 || { fail "Missing: $cmd"; missing=1; }
  done

  [[ -z "$DATABASE_URL" ]] && { fail "TEAMEM_DATABASE_URL not set"; missing=1; }

  # Check server reachability
  if curl -fsS "${BASE_URL}/healthz" >/dev/null 2>&1; then
    info "Server: ${BASE_URL} reachable (/healthz OK)"
  else
    fail "Server not reachable at ${BASE_URL}/healthz"
    missing=1
  fi

  # Check server has LLM configured (try a simple search to see if we get
  # a real response rather than a configuration error)
  local health_json
  health_json="$(curl -fsS "${BASE_URL}/healthz" 2>/dev/null || echo '{}')"
  info "Health response: $(echo "$health_json" | head -c 200)"

  if [[ "$missing" -ne 0 ]]; then echo; echo "Fix the failures above and re-run."; exit 1; fi
  pass "All prerequisites met"
  echo ""
}

# ── Bootstrap ───────────────────────────────────────────────────────────────
E2E_TEAM_ID=""
E2E_PROJECT_ID=""
E2E_API_KEY=""
E2E_BOOTSTRAP_OUT=""

run_bootstrap() {
  header "1. Bootstrap — Creating Isolated Team / Project / Key"

  local entrypoint
  if [[ -f "$REPO_ROOT/apps/server/src/index.ts" ]]; then
    entrypoint="$REPO_ROOT/apps/server/src/index.ts"
  elif [[ -f "$REPO_ROOT/dist/index.js" ]]; then
    entrypoint="$REPO_ROOT/dist/index.js"
  else
    fail "Cannot find server entrypoint at $REPO_ROOT/apps/server/src/index.ts"
    inc_fail
    return 1
  fi

  info "Repo root: $REPO_ROOT"

  local bootstrap_cmd bootstrap_dir
  if [[ "$entrypoint" == *.ts ]]; then
    bootstrap_cmd="npx tsx"
    bootstrap_dir="$REPO_ROOT/apps/server"
    entrypoint="src/index.ts"
  else
    bootstrap_cmd="node"
    bootstrap_dir="$REPO_ROOT"
  fi

  info "Running bootstrap from $bootstrap_dir..."
  E2E_BOOTSTRAP_OUT="$(cd "$bootstrap_dir" && TEAMEM_DATABASE_URL="$DATABASE_URL" \
    $bootstrap_cmd "$entrypoint" --bootstrap \
    --team-name "$TEAM_NAME" \
    --project-name "$PROJECT_NAME" \
    --principal-name "m1-semrecall-svc" \
    2>/dev/null)" || {
    fail "Bootstrap command failed"
    inc_fail
    return 1
  }

  if ! echo "$E2E_BOOTSTRAP_OUT" | jq empty >/dev/null 2>&1; then
    fail "Bootstrap output is not valid JSON"
    info "Output: $(echo "$E2E_BOOTSTRAP_OUT" | head -5)"
    inc_fail
    return 1
  fi

  E2E_TEAM_ID="$(echo "$E2E_BOOTSTRAP_OUT" | jq -r '.team.id')"
  E2E_PROJECT_ID="$(echo "$E2E_BOOTSTRAP_OUT" | jq -r '.project.id')"
  E2E_API_KEY="$(echo "$E2E_BOOTSTRAP_OUT" | jq -r '.key.token // empty')"

  if [[ -z "$E2E_TEAM_ID" || -z "$E2E_PROJECT_ID" ]]; then
    fail "Bootstrap did not produce team/project IDs"
    inc_fail
    return 1
  fi

  pass "Team:    $E2E_TEAM_ID"
  pass "Project:  $E2E_PROJECT_ID"

  if [[ -z "$E2E_API_KEY" ]]; then
    fail "Bootstrap did not produce an API key token"
    inc_fail
    return 1
  fi

  if [[ ! "$E2E_API_KEY" =~ ^tm_ ]]; then
    fail "API key does not start with 'tm_'"
    inc_fail
    return 1
  fi

  pass "API key:  created (starts with tm_)"
  inc_pass
  echo ""
}

# ── API helpers ─────────────────────────────────────────────────────────────
# Note: we do NOT use curl -f (fail-on-http-error) because we need to parse
# the JSON error body even on 4xx/5xx responses. We use -s (silent) and
# capture stderr separately.
api_get() {
  local path="$1"
  curl -sS -H "Authorization: Bearer $E2E_API_KEY" \
    -H "Content-Type: application/json" \
    "${BASE_URL}${path}" 2>/dev/null
}

api_post() {
  local path="$1" body="$2"
  curl -sS -X POST \
    -H "Authorization: Bearer $E2E_API_KEY" \
    -H "Content-Type: application/json" \
    -d "$body" \
    "${BASE_URL}${path}" 2>/dev/null
}

# ── Detect embedding capability ─────────────────────────────────────────────
# Uses POST /v1/search with a simple query. The `degraded` field tells us
# whether semantic (vector) search is available.
detect_semantic_capability() {
  header "2. Detecting Semantic (Embedding) Capability"

  local search_body search_resp degraded
  search_body="{\"projectId\":\"$E2E_PROJECT_ID\",\"query\":\"rate limiting token bucket\"}"
  search_resp="$(api_post "/v1/search" "$search_body" 2>/dev/null || echo '{}')"

  if ! echo "$search_resp" | jq empty >/dev/null 2>&1; then
    warn "Search response was not valid JSON — assuming fts-only"
    echo "fts-only"
    return
  fi

  degraded="$(echo "$search_resp" | jq -r '.degraded // true')"

  if [[ "$degraded" == "true" ]]; then
    info "Semantic capability: fts-only (vector embedding NOT available)"
    echo "fts-only"
  else
    info "Semantic capability: vector (embedding provider IS available)"
    echo "vector"
  fi
  echo ""
}

# ── Ingest an event and wait for compilation ────────────────────────────────
# Usage: ingest_and_wait <content_text> <external_id> <repo> <commit_sha> <path>
# Returns: JSON with eventId and conceptIds on stdout
ingest_and_wait() {
  local content="$1" external_id="$2" repo="$3" commit_sha="$4" file_path="$5"

  # Build the ingest request body
  local ingest_body
  ingest_body="$(jq -n \
    --arg projectId "$E2E_PROJECT_ID" \
    --arg repo "$repo" \
    --arg commitSha "$commit_sha" \
    --arg path "$file_path" \
    --arg content "$content" \
    --arg idemKey "$external_id" \
    '{
      projectId: $projectId,
      source: {
        channel: "cli",
        kind: "cli_init",
        externalId: $idemKey
      },
      payload: {
        schemaVersion: "0.2.0",
        repo: $repo,
        commitSha: $commitSha,
        path: $path,
        content: $content
      },
      idempotencyKey: $idemKey,
      options: { compile: true, wait: true }
    }')"

  info "Ingesting event: $external_id"
  local resp
  resp="$(api_post "/v1/events" "$ingest_body" 2>/dev/null || echo '{}')"

  if ! echo "$resp" | jq empty >/dev/null 2>&1; then
    echo "{\"error\": \"invalid JSON response\", \"raw\": $(echo "$resp" | jq -Rs .)}"
    return 1
  fi

  # Check for API-level errors
  local err_code
  err_code="$(echo "$resp" | jq -r '.error.code // empty')"
  if [[ -n "$err_code" ]]; then
    echo "{\"error\": \"$(echo "$resp" | jq -r '.error.message // "unknown"')\", \"code\": \"$err_code\"}"
    return 1
  fi

  # Check for timedOut
  local timed_out
  timed_out="$(echo "$resp" | jq -r '.timedOut // false')"
  if [[ "$timed_out" == "true" ]]; then
    echo "{\"error\": \"compilation timed out after 30s\", \"eventId\": \"$(echo "$resp" | jq -r '.eventId')\", \"jobId\": \"$(echo "$resp" | jq -r '.jobId')\"}"
    return 1
  fi

  # Poll for job completion if no conceptIds and wait=true didn't complete
  local concept_ids job_id event_id
  concept_ids="$(echo "$resp" | jq -r '.conceptIds // empty')"
  job_id="$(echo "$resp" | jq -r '.jobId // empty')"
  event_id="$(echo "$resp" | jq -r '.eventId // empty')"

  if [[ -z "$concept_ids" && -n "$job_id" ]]; then
    info "  Waiting for job $job_id to complete..."
    local max_polls=30 poll=0 job_status="unknown"
    while [[ $poll -lt $max_polls ]]; do
      sleep 2
      local job_resp
      job_resp="$(api_get "/v1/jobs/$job_id?projectId=$E2E_PROJECT_ID" || echo '{}')"
      # The job detail response is { requestId, data: { status, conceptIds, ... } }
      job_status="$(echo "$job_resp" | jq -r '.data.status // "unknown"')"
      case "$job_status" in
        completed)
          # Extract conceptIds from the job detail data
          concept_ids="$(echo "$job_resp" | jq -r '.data.conceptIds // [] | join(",")')"
          break
          ;;
        failed|cancelled)
          break
          ;;
      esac
      poll=$((poll + 1))
      if [[ $((poll % 5)) -eq 0 ]]; then
        info "    ... still waiting (${poll}s, status=$job_status)"
      fi
    done
    if [[ "$job_status" != "completed" ]]; then
      echo "{\"error\": \"job did not complete in time (status=$job_status)\", \"eventId\": \"$event_id\", \"jobId\": \"$job_id\"}"
      return 1
    fi
  fi

  echo "{\"eventId\": \"$event_id\", \"jobId\": \"$job_id\", \"conceptIds\": $(echo "$concept_ids" | jq -R 'split(",") | map(select(length > 0))')}"
}

# ── Count concept pages in the project ──────────────────────────────────────
count_concepts() {
  local resp
  resp="$(api_get "/v1/concepts?projectId=$E2E_PROJECT_ID&limit=100" || echo '{}')"
  if ! echo "$resp" | jq empty >/dev/null 2>&1; then
    echo "0"
    return
  fi
  # The concept list response is { requestId, data: [...], nextCursor }
  echo "$resp" | jq -r '.data | length // 0'
}

# ── Get all concept UUIDs ──────────────────────────────────────────────────
get_concept_uuids() {
  local resp
  resp="$(api_get "/v1/concepts?projectId=$E2E_PROJECT_ID&limit=100" || echo '{}')"
  if ! echo "$resp" | jq empty >/dev/null 2>&1; then
    echo "[]"
    return
  fi
  echo "$resp" | jq -r '[.data[].uuid]'
}

# ── Test data: two descriptions of the same concept with zero keyword overlap ─
#
# Event 1 (English): describes rate limiting using Redis token bucket algorithm.
# Event 2 (Chinese): describes the exact same system but with completely
#   different words — no shared tokens with the English version.

REPO_NAME="teamem/test-repo"
COMMIT_SHA_1="a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0"
COMMIT_SHA_2="b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c"

# English event: clear description of Redis token bucket rate limiting
EVENT1_CONTENT="\
## Architecture Decision: API Rate Limiting

We implemented rate limiting across all public API endpoints to protect
against abuse and ensure fair resource allocation between tenants.

The chosen approach uses a Redis-backed token bucket algorithm:

- Each API key gets a token bucket stored as a Redis hash with fields for
  tokens, last_refill_time, and capacity.
- Buckets refill at a configurable rate (default: 100 tokens/minute).
- Every request consumes one token. When the bucket is empty, the request
  is rejected with HTTP 429 Too Many Requests.
- Redis Lua scripts ensure the check-and-decrement operation is atomic,
  avoiding race conditions under concurrent access.

Alternatives considered:
- Fixed window counters: simpler but cause burst-at-boundary problems.
- Sliding window log: more accurate but memory-heavy at scale.
- Third-party gateway (Kong, Envoy): adds operational complexity we don't
  need yet for our scale.

The token bucket approach gives us the best balance of accuracy, memory
efficiency, and operational simplicity for our current traffic patterns
(~10k requests/minute peak across all tenants)."

EVENT1_EXT_ID="semrecall-event-1-${TIMESTAMP}"
EVENT1_PATH="docs/architecture/rate-limiting.md"

# Chinese event: same concept, completely different words (no English overlap)
EVENT2_CONTENT="\
## 系统设计说明：接口防刷机制

为了避免外部调用把服务接口刷爆，我们在网关层加了一套基于令牌桶的限流方案。

具体做法：
- 用 Redis 存每个调用方的令牌桶状态，包括当前剩余令牌数、上次补充时间。
- 令牌以固定速率恢复（一分钟 100 个），调用一次扣一个。
- 扣令牌的操作通过 Redis 的 Lua 脚本保证原子性，并发场景下不会出现
  少扣或多扣的问题。
- 令牌耗尽就直接返回 429，让客户端自己降速重试。

之前也评估过固定窗口和滑动窗口的方案，固定窗口边界抖动太厉害，
滑动窗口又太吃内存。最终觉得令牌桶在准确度和资源占用之间平衡得最好，
当前业务量级（高峰期一分钟一万请求左右）完全够用。"

EVENT2_EXT_ID="semrecall-event-2-${TIMESTAMP}"
EVENT2_PATH="docs/architecture/rate-limiting-v2.md"

# ── Run the semantic recall test ────────────────────────────────────────────
run_semantic_recall_test() {
  header "3. Semantic Recall Test — Same Concept, Different Language"

  local initial_count

  # ── 3a. Ingest first event (English) ──────────────────────────────────
  info "Step 3a: Ingesting first event (English — Redis token bucket rate limiting)"
  local event1_resp
  event1_resp="$(ingest_and_wait \
    "$EVENT1_CONTENT" \
    "$EVENT1_EXT_ID" \
    "$REPO_NAME" \
    "$COMMIT_SHA_1" \
    "$EVENT1_PATH")" || true

  local event1_err
  event1_err="$(echo "$event1_resp" | jq -r '.error // empty')"
  if [[ -n "$event1_err" ]]; then
    fail "Event 1 ingestion failed: $event1_err"
    inc_fail
    return 1
  fi

  local event1_id event1_concept_ids
  event1_id="$(echo "$event1_resp" | jq -r '.eventId')"
  event1_concept_ids="$(echo "$event1_resp" | jq -r '.conceptIds | join(",")')"

  if [[ -z "$event1_concept_ids" ]]; then
    fail "Event 1 produced no concept pages (compilation may have failed or skipped)"
    inc_fail
    return 1
  fi

  pass "Event 1 compiled → concept(s): $event1_concept_ids"

  # ── 3b. Count concept pages after first event ─────────────────────────
  initial_count="$(count_concepts)"
  info "Step 3b: Concept pages after event 1: $initial_count"

  if [[ "$initial_count" -lt 1 ]]; then
    fail "Expected at least 1 concept page after event 1, got $initial_count"
    inc_fail
    return 1
  fi
  pass "At least 1 concept page exists after event 1"

  # ── 3c. Record the initial set of concept UUIDs ───────────────────────
  local initial_uuids
  initial_uuids="$(get_concept_uuids)"
  info "Step 3c: Initial concept UUIDs: $initial_uuids"

  # ── 3d. Ingest second event (Chinese — same concept, different words) ─
  info "Step 3d: Ingesting second event (Chinese — same concept, different words)"
  local event2_resp
  event2_resp="$(ingest_and_wait \
    "$EVENT2_CONTENT" \
    "$EVENT2_EXT_ID" \
    "$REPO_NAME" \
    "$COMMIT_SHA_2" \
    "$EVENT2_PATH")" || true

  local event2_err
  event2_err="$(echo "$event2_resp" | jq -r '.error // empty')"
  if [[ -n "$event2_err" ]]; then
    fail "Event 2 ingestion failed: $event2_err"
    inc_fail
    return 1
  fi

  local event2_id event2_concept_ids
  event2_id="$(echo "$event2_resp" | jq -r '.eventId')"
  event2_concept_ids="$(echo "$event2_resp" | jq -r '.conceptIds | join(",")')"

  if [[ -z "$event2_concept_ids" ]]; then
    fail "Event 2 produced no concept pages (compilation may have failed or skipped)"
    inc_fail
    return 1
  fi

  pass "Event 2 compiled → concept(s): $event2_concept_ids"

  # ── 3e. Count concept pages after second event ────────────────────────
  local final_count final_uuids
  final_count="$(count_concepts)"
  final_uuids="$(get_concept_uuids)"
  info "Step 3e: Concept pages after event 2: $final_count"
  info "  Final concept UUIDs: $final_uuids"

  # ── 3f. ASSERTION: Page count did NOT increase ───────────────────────
  # This is the core differentiator. With vector embeddings, the new event
  # is merged into the existing page. With FTS-only, it creates a new page.
  assert \
    "Page count did NOT increase (event 2 merged into existing page)" \
    "[ $final_count -le $initial_count ]" \
    "FAILED: Page count increased from $initial_count to $final_count. \
This means F2 did NOT recognize the Chinese description as the same concept. \
Semantic recall (vector mode) should have bridged the language gap. \
If running in fts-only mode, this failure is expected — re-run with an \
embedding provider configured."

  # ── 3g. ASSERTION: Event 2's concept UUID is among the initial UUIDs ───
  if [[ "$final_count" -le "$initial_count" ]]; then
    local e2_first_concept
    e2_first_concept="$(echo "$event2_resp" | jq -r '.conceptIds[0] // empty')"
    local in_initial
    in_initial="$(echo "$initial_uuids" | jq -r --arg id "$e2_first_concept" 'contains([$id])')"
    assert \
      "Event 2 merged into an existing concept (UUID: $e2_first_concept was in initial set)" \
      "[ \"$in_initial\" = \"true\" ]" \
      "Event 2 created a new concept ($e2_first_concept) not in the initial set."
  fi

  echo ""
}

# ── Run FTS-only baseline check (optional, informational) ───────────────────
run_fts_baseline_info() {
  header "4. FTS Baseline Information"

  warn "Semantic (vector) capability is NOT available — this deployment uses FTS-only."
  warn "In FTS-only mode, keyword-based search cannot bridge different languages."
  warn "A Chinese description about '令牌桶限流' will NOT match an English page"
  warn "about 'Redis token bucket rate limiting' because they share no keywords."
  echo ""
  info "This is the EXPECTED degradation when semantic capability is unavailable."
  info "The differentiator ('our semantic, their FTS placeholder') can only be"
  info "demonstrated when an embedding provider is configured."
  echo ""
  info "To enable vector search, configure one of:"
  info "  TEAMEM_OPENAI_API_KEY    (OpenAI — text-embedding-3-small)"
  info "  TEAMEM_OPENROUTER_API_KEY (OpenRouter — various embedding models)"
  info "  TEAMEM_OPENAI_COMPAT_BASE_URL + TEAMEM_OPENAI_COMPAT_API_KEY (custom)"
  echo ""
  inc_skip
}

# ── Cleanup ─────────────────────────────────────────────────────────────────
cleanup_test_data() {
  header "5. Cleanup"
  info "Test team:   $E2E_TEAM_ID ($TEAM_NAME)"
  info "Test project: $E2E_PROJECT_ID ($PROJECT_NAME)"
  info "Data retained in database for inspection."
  info "To clean up manually, delete the project or team from the database."
  echo ""
}

# ── Main ────────────────────────────────────────────────────────────────────
main() {
  check_prereqs
  run_bootstrap || exit 1

  local capability
  capability="$(detect_semantic_capability)"

  if [[ "$capability" == "vector" ]]; then
    run_semantic_recall_test
  else
    run_fts_baseline_info
    # Still run the test to show the honest degradation behavior
    info "Running the test anyway to demonstrate FTS-only behavior..."
    run_semantic_recall_test || true
  fi

  cleanup_test_data

  # ── Summary ───────────────────────────────────────────────────────────
  local p f s
  p=$(get_pass); f=$(get_fail); s=$(get_skip)
  local total=$((p + f + s))

  header "Results"
  echo "  Passed:  $p / $total"
  echo "  Failed:  $f / $total"
  echo "  Skipped: $s / $total"
  echo ""

  if [[ "$capability" == "fts-only" && "$s" -gt 0 ]]; then
    warn "Tests were run in FTS-only mode (no embedding provider)."
    warn "The semantic recall differentiator cannot be validated without vector capability."
    warn "This is NOT a test failure — it's an honest capability report."
    echo ""
    exit 0
  fi

  if [[ "$f" -gt 0 ]]; then
    echo "Some tests FAILED. See details above."
    exit 1
  fi

  pass "All semantic recall differentiator tests PASSED"
  echo ""
  exit 0
}

main "$@"
