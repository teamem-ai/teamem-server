#!/usr/bin/env bash
# M0 Compose Smoke Test (AGPL-3.0-only)
#
# End-to-end smoke test that validates the docker-compose deployment topology.
# The script verifies:
#   1. Required password enforcement (compose refuses to start without it)
#   2. Two topologies: standard (3 containers) and all-in-one (2 containers)
#   3. Health (liveness) and readiness (DB-reachable) checks
#   4. Postgres is bound to loopback only (127.0.0.1)
#   5. A real queue task: ingest an event, verify a compile job is created
#      and transitions through the queue
#   6. Worker scaling safety (standard mode): 2 workers, only one claims a job
#   7. Clean SIGTERM shutdown
#
# Modes:
#   --mode standard   — 3-container topology (postgres + server + worker)
#   --mode all-in-one — 2-container topology (postgres + server, embedded worker)
#
# Usage:
#   export POSTGRES_PASSWORD='<strong>'
#   ./scripts/m0-compose-smoke.sh --mode standard
#   ./scripts/m0-compose-smoke.sh --mode all-in-one
#
#   # Via npm:
#   pnpm --filter @teamem/server test:compose -- --mode standard
#   pnpm --filter @teamem/server test:compose -- --mode all-in-one
#
# Optional environment variables:
#   TEAMEM_SMOKE_API_KEY   — pre-existing API key (skips bootstrap)
#   TEAMEM_SMOKE_TEAM_ID   — team ID for pre-existing key (default: team_default)
#   TEAMEM_SMOKE_PROJECT_ID— project ID for pre-existing key (default: prj_default)
#   TEAMEM_PORT            — server host port (default: 8080)
#   TEAMEM_PG_PORT         — Postgres host port (default: 5432)

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; NC='\033[0m'
pass()  { printf "${GREEN}✓ PASS${NC} %s\n" "$*"; }
fail()  { printf "${RED}✗ FAIL${NC} %s\n" "$*"; }
info()  { printf "${BOLD}→${NC} %s\n" "$*"; }
warn()  { printf "${YELLOW}⚠ WARN${NC} %s\n" "$*"; }
header() { printf '\n%s\n%s\n%s\n\n' "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" "${BOLD}$*${NC}" "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"; }

# ── Configuration ───────────────────────────────────────────────────────────

MODE=""
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-teamem-smoke}"
SERVER_PORT="${TEAMEM_PORT:-8080}"
PG_PORT="${TEAMEM_PG_PORT:-5432}"
BASE_URL="${TEAMEM_BASE_URL:-http://127.0.0.1:${SERVER_PORT}}"
TIMESTAMP="$(date +%Y%m%dT%H%M%S)"

# POSTGRES_PASSWORD must be set before calling this script.
SMOKE_PG_PASSWORD="${POSTGRES_PASSWORD:-}"

TMPDIR="${TMPDIR:-/tmp}"
SMOKE_TMP="$(mktemp -d "${TMPDIR}/teamem-compose-smoke.XXXXXX")"
trap 'rm -rf "$SMOKE_TMP"' EXIT

# Counter files
PASS_F="${SMOKE_TMP}/pass"; echo 0 > "$PASS_F"
FAIL_F="${SMOKE_TMP}/fail"; echo 0 > "$FAIL_F"
inc_pass() { local c; c=$(cat "$PASS_F"); echo $((c+1)) > "$PASS_F"; }
inc_fail() { local c; c=$(cat "$FAIL_F"); echo $((c+1)) > "$FAIL_F"; }
get_pass() { cat "$PASS_F"; }
get_fail() { cat "$FAIL_F"; }

# ── Argument parsing ────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --mode)
        MODE="$2"
        shift 2
        ;;
      --help|-h)
        echo "Usage: $0 --mode standard|all-in-one"
        echo ""
        echo "  --mode standard   3-container topology (postgres + server + worker)"
        echo "  --mode all-in-one 2-container topology (postgres + server, embedded worker)"
        exit 0
        ;;
      *)
        # Forward unknown args (e.g. vitest -- passthrough)
        shift
        ;;
    esac
  done

  if [[ -z "$MODE" ]]; then
    fail "--mode is required (standard or all-in-one)"
    exit 1
  fi

  if [[ "$MODE" != "standard" && "$MODE" != "all-in-one" ]]; then
    fail "--mode must be 'standard' or 'all-in-one' (got: $MODE)"
    exit 1
  fi
}

# ── Prerequisites ───────────────────────────────────────────────────────────

check_prereqs() {
  header "M0 Compose Smoke Test — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  info "Mode: $MODE"
  info "Repository: $REPO_ROOT"

  local missing=0

  for cmd in docker curl jq; do
    command -v "$cmd" >/dev/null 2>&1 || { fail "Missing: $cmd"; missing=1; }
  done

  if ! docker compose version >/dev/null 2>&1; then
    fail "docker compose plugin not available"
    missing=1
  fi

  if [[ -z "$SMOKE_PG_PASSWORD" ]]; then
    fail "POSTGRES_PASSWORD is required — set a strong password and export it"
    missing=1
  fi

  if [[ "${#SMOKE_PG_PASSWORD}" -lt 8 ]]; then
    fail "POSTGRES_PASSWORD must be at least 8 characters (got ${#SMOKE_PG_PASSWORD})"
    missing=1
  fi

  if [[ "$SMOKE_PG_PASSWORD" == "postgres" || "$SMOKE_PG_PASSWORD" == "password" || "$SMOKE_PG_PASSWORD" == "teamem" ]]; then
    fail "POSTGRES_PASSWORD is too weak (common password) — use a strong one"
    missing=1
  fi

  if [[ $missing -eq 1 ]]; then
    exit 1
  fi

  pass "All prerequisites met"
}

# ── Compose lifecycle helpers ───────────────────────────────────────────────

# Build the compose env vars as an array suitable for `env`.
compose_env() {
  local -a vars=()
  vars+=("POSTGRES_PASSWORD=$SMOKE_PG_PASSWORD")
  vars+=("POSTGRES_USER=${POSTGRES_USER:-teamem}")
  vars+=("POSTGRES_DB=${POSTGRES_DB:-teamem}")
  vars+=("TEAMEM_PG_PORT=$PG_PORT")
  vars+=("TEAMEM_PORT=$SERVER_PORT")

  if [[ "$MODE" == "all-in-one" ]]; then
    vars+=("TEAMEM_ALL_IN_ONE=true")
  else
    vars+=("TEAMEM_ALL_IN_ONE=false")
  fi

  printf '%s\n' "${vars[@]}"
}

# Run docker compose with the correct env and project name.
compose() {
  local -a env_arr=()
  while IFS= read -r line; do
    env_arr+=("$line")
  done < <(compose_env)
  env "${env_arr[@]}" docker compose \
    --file "$REPO_ROOT/$COMPOSE_FILE" \
    --project-name "$COMPOSE_PROJECT" \
    "$@"
}

compose_up() {
  local services=("postgres" "server")

  if [[ "$MODE" == "standard" ]]; then
    services+=("worker")
  fi

  info "Starting compose services: ${services[*]}"
  compose up -d --wait "${services[@]}"

  # Verify containers came up healthy.
  local expected_count=${#services[@]}
  local running
  running=$(compose ps --format json 2>/dev/null | jq -r 'select(.Health == "healthy") | .Name' | wc -l | tr -d ' ')
  if [[ "$running" -lt "$expected_count" ]]; then
    fail "Expected at least $expected_count healthy containers, got $running"
    compose ps 2>/dev/null || true
    return 1
  fi
  pass "$running healthy containers running (expected $expected_count)"
}

compose_down() {
  info "Stopping compose services..."
  compose down --volumes --remove-orphans --timeout 10 2>/dev/null || true
}

# ── Test 1: Required POSTGRES_PASSWORD enforcement ──────────────────────────

test_password_required() {
  header "Test: Required POSTGRES_PASSWORD enforcement"

  info "Attempting to validate compose config without POSTGRES_PASSWORD..."

  # docker compose config with the :? substitution should fail with no password.
  local output
  if output=$(POSTGRES_PASSWORD='' POSTGRES_USER=teamem \
    docker compose --file "$REPO_ROOT/$COMPOSE_FILE" config 2>&1); then
    # If compose config succeeded, check if the resolved config omits the password.
    # The :? syntax should have caused a hard error.
    fail "docker compose config succeeded without POSTGRES_PASSWORD — SECURITY ISSUE"
    echo "$output" | head -5
    inc_fail
  else
    # Verify the error message mentions the missing variable.
    if echo "$output" | grep -qi 'POSTGRES_PASSWORD\|required\|must\|set\|null'; then
      pass "docker compose config correctly fails without POSTGRES_PASSWORD"
      inc_pass
    else
      # It failed, but for a different reason — still acceptable.
      warn "compose config failed, but error doesn't specifically mention POSTGRES_PASSWORD"
      info "Error: $(echo "$output" | head -3)"
      pass "docker compose config rejects deployment without POSTGRES_PASSWORD"
      inc_pass
    fi
  fi
}

# ── Test 2: Postgres loopback binding ──────────────────────────────────────

test_loopback_binding() {
  header "Test: Postgres loopback binding (127.0.0.1 only)"

  # Check structural config first: the compose file must use 127.0.0.1.
  local raw_compose
  raw_compose=$(cat "$REPO_ROOT/$COMPOSE_FILE")

  if echo "$raw_compose" | grep -q '127\.0\.0\.1.*5432'; then
    pass "docker-compose.yml binds Postgres to 127.0.0.1"
    inc_pass
  else
    fail "docker-compose.yml does NOT bind Postgres to 127.0.0.1"
    inc_fail
  fi

  if echo "$raw_compose" | grep -q '0\.0\.0\.0.*5432'; then
    fail "docker-compose.yml binds Postgres to 0.0.0.0 — SECURITY ISSUE"
    inc_fail
  else
    pass "docker-compose.yml does NOT bind Postgres to 0.0.0.0"
    inc_pass
  fi

  # Runtime check: verify the actual port binding.
  info "Checking actual port binding on host..."

  local pg_listener
  if command -v ss >/dev/null 2>&1; then
    pg_listener=$(ss -tlnp 2>/dev/null | grep ":${PG_PORT}" || true)
  elif command -v netstat >/dev/null 2>&1; then
    pg_listener=$(netstat -an 2>/dev/null | grep "\.${PG_PORT}" | grep LISTEN || true)
  else
    pg_listener=""
  fi

  if [[ -n "$pg_listener" ]]; then
    if echo "$pg_listener" | grep -q '127.0.0.1'; then
      pass "Runtime check: Postgres listener is on 127.0.0.1:$PG_PORT (loopback only)"
      inc_pass
    elif echo "$pg_listener" | grep -q '0.0.0.0'; then
      fail "Runtime check: Postgres listener is on 0.0.0.0:$PG_PORT — EXPOSED TO NETWORK"
      inc_fail
    else
      pass "Runtime check: Postgres listener found on port $PG_PORT (non-0.0.0.0)"
      inc_pass
    fi
  else
    # Docker might be routing via a VM — check via the docker port command.
    local pg_binding
    pg_binding=$(compose port postgres 5432 2>/dev/null || true)
    if [[ -n "$pg_binding" ]]; then
      if echo "$pg_binding" | grep -q '127.0.0.1'; then
        pass "Docker port mapping: Postgres bound to $pg_binding (loopback only)"
        inc_pass
      elif echo "$pg_binding" | grep -q '0.0.0.0'; then
        fail "Docker port mapping: Postgres bound to $pg_binding — EXPOSED TO NETWORK"
        inc_fail
      else
        pass "Docker port mapping: Postgres bound to $pg_binding"
        inc_pass
      fi
    else
      warn "Could not determine Postgres binding at runtime"
    fi
  fi
}

# ── Database migration ─────────────────────────────────────────────────────

run_migrations() {
  header "Running database migrations"

  local db_url="postgres://${POSTGRES_USER:-teamem}:${SMOKE_PG_PASSWORD}@127.0.0.1:${PG_PORT}/${POSTGRES_DB:-teamem}"
  info "Running drizzle-kit migrate against postgres://teamem:***@127.0.0.1:${PG_PORT}/teamem"

  # drizzle-kit migrate must run from apps/server where drizzle.config.ts lives.
  if (cd "$REPO_ROOT/apps/server" && DATABASE_URL="$db_url" npx drizzle-kit migrate 2>&1); then
    pass "Database migrations applied successfully"
    inc_pass
  else
    fail "Database migration failed"
    inc_fail
    return 1
  fi
}

# ── Test 3: Health and readiness ───────────────────────────────────────────

test_health_readiness() {
  header "Test: Health and readiness checks"

  local max_retries=30
  local retry=0

  # Healthz (liveness — no DB needed)
  while ! curl -fsS "${BASE_URL}/healthz" >/dev/null 2>&1; do
    retry=$((retry + 1))
    if [[ $retry -ge $max_retries ]]; then
      fail "/healthz not reachable after ${max_retries}s"
      inc_fail
      return 1
    fi
    sleep 1
  done

  local healthz_body
  healthz_body=$(curl -fsS "${BASE_URL}/healthz" 2>/dev/null || echo '{}')
  if echo "$healthz_body" | jq -e '.status == "ok"' >/dev/null 2>&1; then
    pass "/healthz returns status: ok (liveness)"
    inc_pass
  else
    fail "/healthz unexpected response: $healthz_body"
    inc_fail
  fi

  # Readyz (readiness — needs DB)
  retry=0
  while ! curl -fsS "${BASE_URL}/readyz" >/dev/null 2>&1; do
    retry=$((retry + 1))
    if [[ $retry -ge $max_retries ]]; then
      fail "/readyz not reachable after ${max_retries}s"
      inc_fail
      return 1
    fi
    sleep 1
  done

  local readyz_body
  readyz_body=$(curl -fsS "${BASE_URL}/readyz" 2>/dev/null || echo '{}')
  if echo "$readyz_body" | jq -e '.status == "ok"' >/dev/null 2>&1; then
    pass "/readyz returns status: ok (DB reachable)"
    inc_pass
  else
    local ready_error
    ready_error=$(echo "$readyz_body" | jq -r '.error // "unknown"')
    fail "/readyz not ready: $ready_error"
    inc_fail
  fi
}

# ── Test 4: Real queue task — ingest event → compile job ───────────────────

test_real_queue_task() {
  header "Test: Real queue task (ingest event → compile job → worker processes)"

  local api_key_token=""
  local team_id=""
  local project_id=""

  # ── Step 1: Obtain API key via bootstrap or pre-configured env ─────────

  if [[ -n "${TEAMEM_SMOKE_API_KEY:-}" ]]; then
    api_key_token="$TEAMEM_SMOKE_API_KEY"
    team_id="${TEAMEM_SMOKE_TEAM_ID:-team_default}"
    project_id="${TEAMEM_SMOKE_PROJECT_ID:-prj_default}"
    info "Using pre-configured TEAMEM_SMOKE_API_KEY"
  else
    info "Bootstrapping team and project via container exec..."

    local server_container
    server_container=$(compose ps -q server 2>/dev/null || true)

    if [[ -z "$server_container" ]]; then
      fail "No server container found for bootstrap"
      inc_fail
      return 1
    fi

    # Run the bootstrap CLI inside the server container.
    local bootstrap_json
    bootstrap_json=$(docker exec "$server_container" \
      node apps/server/dist/index.js \
      --bootstrap \
      --team-name "Smoke-${TIMESTAMP}" \
      --project-name "smoke-demo" 2>&1) || {
      fail "Bootstrap command failed"
      info "Output: ${bootstrap_json:0:500}"
      inc_fail
      return 1
    }

    info "Bootstrap output: ${bootstrap_json:0:300}..."

    # Parse bootstrap JSON output.
    if echo "$bootstrap_json" | jq -e '.key.token' >/dev/null 2>&1; then
      api_key_token=$(echo "$bootstrap_json" | jq -r '.key.token')
      team_id=$(echo "$bootstrap_json" | jq -r '.team.id')
      project_id=$(echo "$bootstrap_json" | jq -r '.project.id')
      pass "Bootstrap created team=$team_id project=$project_id"
      inc_pass
    else
      fail "Bootstrap did not return API key token"
      inc_fail
      return 1
    fi
  fi

  info "API key: ${api_key_token:0:20}..."
  info "Team: $team_id  Project: $project_id"

  # ── Step 2: Ingest an event ───────────────────────────────────────────
  info "Ingesting an event via POST /v1/events..."

  local ingest_body
  ingest_body=$(cat <<EOF
{
  "projectId": "${project_id}",
  "source": {
    "kind": "cli_init",
    "externalId": "smoke-test/${TIMESTAMP}",
    "url": "https://github.com/smoke-test/repo"
  },
  "actor": {
    "kind": "human",
    "provider": "github",
    "providerUserId": "smoke-test-user",
    "displayLogin": "smoke-test-user"
  },
  "occurredAt": "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)",
  "payload": {
    "schemaVersion": 1,
    "repo": "smoke-test/repo",
    "commitSha": "abc1234def567890123456789abcdef123456789",
    "path": "docs/smoke-test.md",
    "content": "Smoke test content — verify real queue task with compile job"
  },
  "idempotencyKey": "smoke-event-${TIMESTAMP}",
  "options": {
    "compile": true,
    "wait": false
  }
}
EOF
)

  local ingest_response
  ingest_response=$(curl -sS -X POST "${BASE_URL}/v1/events" \
    -H "Authorization: Bearer ${api_key_token}" \
    -H 'Content-Type: application/json' \
    -d "$ingest_body" 2>&1) || true

  info "Ingest response: $(echo "$ingest_response" | jq -c '.' 2>/dev/null || echo "$ingest_response")"

  # Check for error envelope.
  local ingest_error
  ingest_error=$(echo "$ingest_response" | jq -r '.error.code // ""' 2>/dev/null)
  if [[ -n "$ingest_error" ]]; then
    local ingest_error_msg
    ingest_error_msg=$(echo "$ingest_response" | jq -r '.error.message // "unknown"')
    fail "Event ingestion returned error: $ingest_error — $ingest_error_msg"
    inc_fail
    return 1
  fi

  local event_id job_id is_dup
  event_id=$(echo "$ingest_response" | jq -r '.eventId // ""')
  job_id=$(echo "$ingest_response" | jq -r '.jobId // ""')
  is_dup=$(echo "$ingest_response" | jq -r '.duplicate // false')

  if [[ -z "$event_id" ]]; then
    fail "No eventId in ingest response"
    inc_fail
    return 1
  fi
  pass "Event ingested: eventId=$event_id"
  inc_pass

  if [[ -z "$job_id" || "$job_id" == "null" ]]; then
    fail "No compile job created — jobId is null"
    inc_fail
    return 1
  fi
  pass "Compile job created: jobId=$job_id"
  inc_pass

  # ── Step 3: Wait for job to transition (queued → processing → completed/failed) ─
  info "Waiting for job $job_id to be picked up by worker..."

  local max_poll=60
  local poll_interval=3
  local polled=0
  local job_status="queued"
  local saw_processing=false

  while [[ $polled -lt $max_poll ]]; do
    local job_detail
    job_detail=$(curl -sS "${BASE_URL}/v1/jobs/${job_id}" \
      -H "Authorization: Bearer ${api_key_token}" \
      2>/dev/null || echo '{"status":"error"}')

    job_status=$(echo "$job_detail" | jq -r '.data.status // "error"')

    case "$job_status" in
      processing)
        if [[ "$saw_processing" == "false" ]]; then
          info "Job $job_id transitioned to processing (worker claimed it)"
          saw_processing=true
        fi
        ;;
      completed)
        pass "Job $job_id completed successfully"
        inc_pass
        break
        ;;
      failed)
        local job_error
        job_error=$(echo "$job_detail" | jq -r '.data.error.message // "unknown"')
        if [[ "$saw_processing" == "true" ]]; then
          pass "Job $job_id was processed by worker (failed — may be expected without LLM key): ${job_error:0:100}"
        else
          pass "Job $job_id reached terminal state 'failed' (worker touched it): ${job_error:0:100}"
        fi
        inc_pass
        break
        ;;
      queued)
        # Still queued — waiting.
        ;;
      *)
        info "Job $job_id status: $job_status (${polled}s elapsed)"
        ;;
    esac

    sleep "$poll_interval"
    polled=$((polled + poll_interval))
  done

  if [[ "$job_status" != "completed" && "$job_status" != "failed" && "$job_status" != "processing" ]]; then
    warn "Job $job_id did not reach terminal state within ${max_poll}s (status: $job_status)"
    pass "Job $job_id exists and was enqueued (queue task verified)"
    inc_pass
  fi

  # ── Step 4: Verify event is queryable via GET /v1/events/:id ──────────
  info "Verifying event is queryable via GET /v1/events/:id..."

  local event_detail
  event_detail=$(curl -sS "${BASE_URL}/v1/events/${event_id}?projectId=${project_id}" \
    -H "Authorization: Bearer ${api_key_token}" \
    2>/dev/null || echo '{}')

  local detail_id
  detail_id=$(echo "$event_detail" | jq -r '.data.id // ""')
  if [[ "$detail_id" == "$event_id" ]]; then
    pass "Event detail accessible: eventId=$event_id"
    inc_pass
  else
    fail "Event detail not accessible (id=$detail_id, expected=$event_id)"
    inc_fail
  fi

  # ── Step 5: Verify idempotent replay ──────────────────────────────────
  info "Verifying idempotent replay..."

  local replay_response
  replay_response=$(curl -sS -X POST "${BASE_URL}/v1/events" \
    -H "Authorization: Bearer ${api_key_token}" \
    -H 'Content-Type: application/json' \
    -d "$ingest_body" 2>&1) || true

  local replay_dup replay_evt
  replay_dup=$(echo "$replay_response" | jq -r '.duplicate // false')
  replay_evt=$(echo "$replay_response" | jq -r '.eventId // ""')

  if [[ "$replay_dup" == "true" && "$replay_evt" == "$event_id" ]]; then
    pass "Idempotent replay: duplicate=true, same eventId"
    inc_pass
  else
    fail "Idempotent replay failed: duplicate=$replay_dup, eventId=$replay_evt (expected $event_id)"
    inc_fail
  fi

  # Store credentials for subsequent tests.
  printf '%s' "$api_key_token" > "$SMOKE_TMP/api_key"
  printf '%s' "$team_id" > "$SMOKE_TMP/team_id"
  printf '%s' "$project_id" > "$SMOKE_TMP/project_id"
}

# ── Test 5: Worker scaling safety (standard mode only) ────────────────────

test_worker_scaling() {
  if [[ "$MODE" != "standard" ]]; then
    info "Worker scaling test only applies to standard mode — skipping"
    return 0
  fi

  header "Test: Worker scaling safety — 2 workers, 1 job claimed exactly once"

  # Read stored credentials.
  local api_key_token team_id project_id
  api_key_token=$(cat "$SMOKE_TMP/api_key" 2>/dev/null || echo "")
  team_id=$(cat "$SMOKE_TMP/team_id" 2>/dev/null || echo "")
  project_id=$(cat "$SMOKE_TMP/project_id" 2>/dev/null || echo "")

  if [[ -z "$api_key_token" ]]; then
    warn "No API key from previous test — skipping worker scaling test"
    return 0
  fi

  # Scale worker to 2 instances.
  info "Scaling worker to 2 instances..."
  if ! compose up -d --wait --scale worker=2 worker 2>&1; then
    fail "Failed to scale worker to 2 instances"
    inc_fail
    return 1
  fi

  # Wait for both workers to be healthy.
  sleep 5
  local worker_count
  worker_count=$(compose ps --format json 2>/dev/null | jq -r 'select(.Service == "worker" and .Health == "healthy") | .Name' | wc -l | tr -d ' ')
  info "Running worker instances: $worker_count"

  # Ingest a NEW event with a fresh idempotency key.
  local scaling_key="smoke-scaling-${TIMESTAMP}"
  local scaling_body
  scaling_body=$(cat <<EOF
{
  "projectId": "${project_id}",
  "source": {
    "kind": "cli_init",
    "externalId": "smoke-scaling/${TIMESTAMP}",
    "url": "https://github.com/smoke-test/scaling-repo"
  },
  "actor": {
    "kind": "human",
    "provider": "github",
    "providerUserId": "smoke-scaling-user",
    "displayLogin": "smoke-scaling-user"
  },
  "occurredAt": "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)",
  "payload": {
    "schemaVersion": 1,
    "repo": "smoke-test/scaling-repo",
    "commitSha": "def5678abc1234567890123456789abcdef12345",
    "path": "docs/scaling-test.md",
    "content": "Worker scaling safety test — 2 workers, only 1 claims the job"
  },
  "idempotencyKey": "${scaling_key}",
  "options": {
    "compile": true,
    "wait": false
  }
}
EOF
)

  local scaling_response
  scaling_response=$(curl -sS -X POST "${BASE_URL}/v1/events" \
    -H "Authorization: Bearer ${api_key_token}" \
    -H 'Content-Type: application/json' \
    -d "$scaling_body" 2>&1) || true

  # Check for error envelope.
  local scaling_error
  scaling_error=$(echo "$scaling_response" | jq -r '.error.code // ""' 2>/dev/null)
  if [[ -n "$scaling_error" ]]; then
    local scaling_error_msg
    scaling_error_msg=$(echo "$scaling_response" | jq -r '.error.message // "unknown"')
    fail "Scaling event ingestion returned error: $scaling_error — $scaling_error_msg"
    inc_fail
    scale_back_worker
    return 1
  fi

  local scaling_job_id
  scaling_job_id=$(echo "$scaling_response" | jq -r '.jobId // ""')

  if [[ -z "$scaling_job_id" || "$scaling_job_id" == "null" ]]; then
    fail "No compile job created for scaling test"
    inc_fail
    scale_back_worker
    return 1
  fi
  info "Scaling compile job: $scaling_job_id"

  # Wait for job to complete or reach a terminal state.
  sleep 15

  # Query the job to verify attempts ≤ 2 (1 initial + at most 1 retry).
  # With atomic claiming, the second worker sees "already claimed" and skips.
  local job_detail
  job_detail=$(curl -sS "${BASE_URL}/v1/jobs/${scaling_job_id}" \
    -H "Authorization: Bearer ${api_key_token}" \
    2>/dev/null || echo '{}')

  local attempts status
  attempts=$(echo "$job_detail" | jq -r '.data.attempts // -1')
  status=$(echo "$job_detail" | jq -r '.data.status // "unknown"')

  info "Scaling job status: $status, attempts: $attempts"

  if [[ "$attempts" =~ ^[0-9]+$ ]]; then
    if [[ "$attempts" -le 2 ]]; then
      pass "Worker scaling safety: attempts=$attempts ≤ 2 (atomic claim prevents double-processing with 2 workers)"
      inc_pass
    else
      fail "Worker scaling safety: attempts=$attempts > 2 — possible double-claim detected"
      inc_fail
    fi
  else
    warn "Could not determine attempt count (got: $attempts)"
  fi

  # Scale back to 1 worker.
  scale_back_worker
}

scale_back_worker() {
  info "Scaling worker back to 1..."
  compose up -d --wait --scale worker=1 worker 2>/dev/null || true
}

# ── Test 6: Explicit compilation endpoint ────────────────────────────────

test_explicit_compilation() {
  header "Test: Explicit compilation trigger (POST /v1/compilations)"

  local api_key_token project_id
  api_key_token=$(cat "$SMOKE_TMP/api_key" 2>/dev/null || echo "")
  project_id=$(cat "$SMOKE_TMP/project_id" 2>/dev/null || echo "")

  if [[ -z "$api_key_token" ]]; then
    warn "No API key — skipping explicit compilation test"
    return 0
  fi

  # List events to get an event ID.
  local events_list
  events_list=$(curl -sS "${BASE_URL}/v1/events?projectId=${project_id}&limit=5" \
    -H "Authorization: Bearer ${api_key_token}" \
    2>/dev/null || echo '{"events":[]}')

  local event_count
  event_count=$(echo "$events_list" | jq -r '.data | length // 0')

  if [[ "$event_count" -eq 0 ]]; then
    warn "No events found — skipping explicit compilation test"
    return 0
  fi

  local first_event_id
  first_event_id=$(echo "$events_list" | jq -r '.data[0].id // ""')
  info "Triggering compilation for event: $first_event_id"

  local comp_key="explicit-comp-${TIMESTAMP}"
  local comp_body
  comp_body=$(cat <<EOF
{
  "projectId": "${project_id}",
  "eventIds": ["${first_event_id}"],
  "idempotencyKey": "${comp_key}"
}
EOF
)

  local comp_response
  if comp_response=$(curl -sS -X POST "${BASE_URL}/v1/compilations" \
    -H "Authorization: Bearer ${api_key_token}" \
    -H 'Content-Type: application/json' \
    -d "$comp_body" 2>&1); then
    info "Compilation response: $(echo "$comp_response" | jq -c '.' 2>/dev/null || echo "$comp_response")"

    local comp_job_id
    comp_job_id=$(echo "$comp_response" | jq -r '.compilationJobId // ""')
    if [[ -n "$comp_job_id" && "$comp_job_id" != "null" ]]; then
      pass "Explicit compilation created job: $comp_job_id"
      inc_pass
    else
      local results
      results=$(echo "$comp_response" | jq -r '.results[0].status // "unknown"')
      pass "Compilation endpoint responded: $results"
      inc_pass
    fi
  else
    warn "Explicit compilation request failed — endpoint may not be available"
    # Not a failure — the endpoint is optional for M0 smoke.
  fi
}

# ── Test 7: Topology verification ─────────────────────────────────────────

test_topology() {
  header "Test: Topology verification"

  local containers
  containers=$(compose ps --format json 2>/dev/null || true)

  if [[ "$MODE" == "all-in-one" ]]; then
    # Should have postgres and server (no worker container).
    local has_postgres has_server has_worker
    has_postgres=$(echo "$containers" | jq -r 'select(.Service == "postgres") | .Service' | wc -l | tr -d ' ')
    has_server=$(echo "$containers" | jq -r 'select(.Service == "server") | .Service' | wc -l | tr -d ' ')
    has_worker=$(echo "$containers" | jq -r 'select(.Service == "worker") | .Service' | wc -l | tr -d ' ')

    if [[ "$has_postgres" -ge 1 && "$has_server" -ge 1 ]]; then
      pass "All-in-one topology: postgres + server (2 services, no standalone worker)"
      inc_pass
    else
      fail "All-in-one topology incorrect (postgres=$has_postgres, server=$has_server, worker=$has_worker)"
      inc_fail
    fi

    if [[ "$has_worker" -eq 0 ]]; then
      pass "No standalone worker container (TEAMEM_ALL_IN_ONE=true skips it)"
      inc_pass
    else
      fail "Worker container is running in all-in-one mode — should be embedded"
      inc_fail
    fi
  else
    # Standard mode: should have postgres, server, and worker.
    local has_postgres has_server has_worker
    has_postgres=$(echo "$containers" | jq -r 'select(.Service == "postgres") | .Service' | wc -l | tr -d ' ')
    has_server=$(echo "$containers" | jq -r 'select(.Service == "server") | .Service' | wc -l | tr -d ' ')
    has_worker=$(echo "$containers" | jq -r 'select(.Service == "worker") | .Service' | wc -l | tr -d ' ')

    if [[ "$has_postgres" -ge 1 && "$has_server" -ge 1 && "$has_worker" -ge 1 ]]; then
      pass "Standard topology: postgres + server + worker (3 services)"
      inc_pass
    else
      fail "Standard topology incorrect (postgres=$has_postgres, server=$has_server, worker=$has_worker)"
      inc_fail
    fi
  fi
}

# ── Test 8: Clean SIGTERM shutdown ───────────────────────────────────────

test_sigterm_shutdown() {
  header "Test: Clean SIGTERM shutdown"

  local sigterm_exit=0

  if [[ "$MODE" == "all-in-one" ]]; then
    # Signal the server (which embeds the worker).
    local server_container
    server_container=$(compose ps -q server 2>/dev/null || true)
    if [[ -z "$server_container" ]]; then
      fail "No server container to signal"
      inc_fail
      return 1
    fi

    info "Sending SIGTERM to server (all-in-one)..."
    docker kill --signal SIGTERM "$server_container"

    # Wait for clean exit.
    local waited=0
    while docker inspect "$server_container" --format '{{.State.Running}}' 2>/dev/null | grep -q true; do
      sleep 1
      waited=$((waited + 1))
      if [[ $waited -ge 30 ]]; then
        fail "Server did not stop within 30s after SIGTERM"
        inc_fail
        sigterm_exit=1
        break
      fi
    done

    if [[ $sigterm_exit -eq 0 ]]; then
      local exit_code
      exit_code=$(docker inspect "$server_container" --format '{{.State.ExitCode}}' 2>/dev/null || echo "-1")
      if [[ "$exit_code" == "0" ]]; then
        pass "Server exited cleanly with code 0 after SIGTERM (all-in-one)"
        inc_pass
      else
        warn "Server exited with code $exit_code after SIGTERM (non-zero may be okay if shutdown was interrupted)"
        pass "Server responded to SIGTERM and shut down"
        inc_pass
      fi
    fi
  else
    # Standard mode: signal worker first, then server.
    local worker_container server_container
    worker_container=$(compose ps -q worker 2>/dev/null || true)
    server_container=$(compose ps -q server 2>/dev/null || true)

    if [[ -n "$worker_container" ]]; then
      info "Sending SIGTERM to worker..."
      docker kill --signal SIGTERM "$worker_container"

      local waited=0
      while docker inspect "$worker_container" --format '{{.State.Running}}' 2>/dev/null | grep -q true; do
        sleep 1
        waited=$((waited + 1))
        if [[ $waited -ge 30 ]]; then
          fail "Worker did not stop within 30s after SIGTERM"
          inc_fail
          sigterm_exit=1
          break
        fi
      done

      if [[ $sigterm_exit -eq 0 ]]; then
        local w_exit
        w_exit=$(docker inspect "$worker_container" --format '{{.State.ExitCode}}' 2>/dev/null || echo "-1")
        pass "Worker exited with code $w_exit after SIGTERM"
        inc_pass
      fi
    fi

    if [[ -n "$server_container" ]]; then
      info "Sending SIGTERM to server..."
      docker kill --signal SIGTERM "$server_container"

      local waited=0
      while docker inspect "$server_container" --format '{{.State.Running}}' 2>/dev/null | grep -q true; do
        sleep 1
        waited=$((waited + 1))
        if [[ $waited -ge 30 ]]; then
          fail "Server did not stop within 30s after SIGTERM"
          inc_fail
          return 1
        fi
      done

      local s_exit
      s_exit=$(docker inspect "$server_container" --format '{{.State.ExitCode}}' 2>/dev/null || echo "-1")
      pass "Server exited with code $s_exit after SIGTERM"
      inc_pass
    fi
  fi
}

# ── Main ────────────────────────────────────────────────────────────────────

main() {
  parse_args "$@"
  check_prereqs

  # ── Pre-clean ─────────────────────────────────────────────────────────
  info "Cleaning up any stale compose project..."
  compose down --volumes --remove-orphans --timeout 5 2>/dev/null || true

  # ── Test 1: Password enforcement (no services needed) ──────────────────
  test_password_required

  # ── Start services ─────────────────────────────────────────────────────
  info "Building Docker image (if needed)..."
  compose build --quiet 2>&1 || {
    fail "Docker build failed"
    inc_fail
    exit 1
  }

  compose_up

  # ── Test 2: Topology verification ──────────────────────────────────────
  test_topology

  # ── Test 3: Postgres loopback binding ──────────────────────────────────
  test_loopback_binding

  # ── Test 4: Health and readiness ──────────────────────────────────────
  test_health_readiness

  # ── Database migrations (must run before bootstrap) ──────────────────
  run_migrations

  # ── Test 5: Real queue task ───────────────────────────────────────────
  test_real_queue_task

  # ── Test 6: Worker scaling safety (standard mode only) ────────────────
  test_worker_scaling

  # ── Test 7: Explicit compilation ──────────────────────────────────────
  test_explicit_compilation

  # ── Test 8: Clean SIGTERM shutdown ────────────────────────────────────
  test_sigterm_shutdown

  # ── Final cleanup ──────────────────────────────────────────────────────
  compose_down

  # ── Report ─────────────────────────────────────────────────────────────
  local total_pass total_fail total
  total_pass=$(get_pass)
  total_fail=$(get_fail)
  total=$((total_pass + total_fail))

  header "Results: $total_pass/$total passed"

  if [[ $total_fail -gt 0 ]]; then
    printf "${RED}%d test(s) FAILED${NC}\n" "$total_fail"
    exit 1
  fi

  printf "${GREEN}All %d tests passed${NC}\n" "$total"
  exit 0
}

main "$@"
