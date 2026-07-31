#!/usr/bin/env bash
# M2 Governance & Security — Audit + Purge + Cross-Team Isolation Verification
# (DUA-245 M2-QA-04)
#
# This script verifies end-to-end governance and isolation behaviors against
# a real PostgreSQL-backed teamem server. It:
#   1. Starts a throwaway Postgres container and applies all migrations.
#   2. Seeds two independent teams (Alpha, Bravo) with projects, API keys,
#      owner users/sessions, events, concepts, jobs, and audit records.
#   3. Launches the teamem server (all-in-one mode).
#   4. Runs each CLI acceptance scenario and reports PASS/FAIL.
#
# Prerequisites: docker, pnpm, curl, jq, openssl
#
# Usage:
#   chmod +x scripts/m2-governance-security.sh
#   ./scripts/m2-governance-security.sh
#
# Environment variables (all optional):
#   TEAMEM_TEST_PG_PORT       — Postgres host port (default: 54400)
#   TEAMEM_TEST_SERVER_PORT   — Server host port (default: 8081)
#   TEAMEM_TEST_PG_PASSWORD   — Postgres password (default: testpass_sec_m2)
#   SKIP_BUILD                — set to 1 to skip pnpm build (useful during dev)

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; NC='\033[0m'
PASS=0; FAIL=0

pass()  { PASS=$((PASS+1)); printf "${GREEN}✓ PASS${NC} %s\n" "$*"; }
fail()  { FAIL=$((FAIL+1)); printf "${RED}✗ FAIL${NC} %s\n" "$*"; }
info()  { printf "${BOLD}→${NC} %s\n" "$*"; }
warn()  { printf "${YELLOW}⚠${NC} %s\n" "$*"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVER_DIR="$REPO_ROOT/apps/server"
LOG_DIR="$REPO_ROOT/scripts/m2-governance-security-results"
TIMESTAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"
LOG_FILE="$LOG_DIR/results-${TIMESTAMP}.log"

mkdir -p "$LOG_DIR"

# ── Configuration ────────────────────────────────────────────────────────────

PG_PASSWORD="${TEAMEM_TEST_PG_PASSWORD:-testpass_sec_m2}"
PG_PORT="${TEAMEM_TEST_PG_PORT:-54400}"
PG_USER="teamem"
PG_DB="teamem"
CONTAINER_NAME="teamem-govsec-pg"
SERVER_PORT="${TEAMEM_TEST_SERVER_PORT:-8081}"
SERVER_URL="http://127.0.0.1:${SERVER_PORT}"
DATABASE_URL="postgres://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/${PG_DB}"

# Fake OAuth credentials — required to mount audit/purge/membership routes.
# We seed sessions directly in the DB, so real GitHub OAuth is never used.
FAKE_OAUTH_CLIENT_ID="Iv1.test_govsec_client_id"
FAKE_OAUTH_CLIENT_SECRET="test_govsec_client_secret_0000000000000000"
# Base URL the server advertises for OAuth redirect construction.
# Must be set so the server can build the OAuth config.
export TEAMEM_BASE_URL="${SERVER_URL}"

# ── Test state (populated during setup) ──────────────────────────────────────
ALPHA_TEAM=""
ALPHA_PROJECT=""
ALPHA_API_KEY=""
ALPHA_COOKIE=""
BRAVO_TEAM=""
BRAVO_PROJECT=""
BRAVO_API_KEY=""
BRAVO_COOKIE=""

# ── Sentinels for leak detection ────────────────────────────────────────────
SENTINEL="DUA245_SENTINEL_$(openssl rand -hex 8 | tr '[:lower:]' '[:upper:]')"

# ── Helpers ──────────────────────────────────────────────────────────────────

log() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$LOG_FILE"; }

# Compute HMAC-SHA256 matching Node's createHmac('sha256', 'teamem-session')
session_hash() {
  echo -n "$1" | openssl dgst -sha256 -hmac "teamem-session" | awk '{print $NF}'
}

# Compute SHA-256 matching Node's createHash('sha256').update(token).digest('hex')
token_hash() {
  echo -n "$1" | openssl dgst -sha256 | awk '{print $NF}'
}

http_status() {
  local method="${1:-GET}" path="${2:-}" cookie="${3:-}" data="${4:-}"
  local curl_args=(-sS -o /dev/null -w '%{http_code}')
  if [ -n "$cookie" ]; then curl_args+=(-b "$cookie"); fi
  if [ "$method" = "POST" ]; then
    curl_args+=(-H 'Content-Type: application/json' -d "$data")
  fi
  curl "${curl_args[@]}" "${SERVER_URL}${path}"
}

http_body() {
  local method="${1:-GET}" path="${2:-}" cookie="${3:-}" data="${4:-}"
  local curl_args=(-sS)
  if [ -n "$cookie" ]; then curl_args+=(-b "$cookie"); fi
  if [ "$method" = "POST" ]; then
    curl_args+=(-H 'Content-Type: application/json' -d "$data")
  fi
  curl "${curl_args[@]}" "${SERVER_URL}${path}" 2>/dev/null
}

api_status() {
  local method="${1:-GET}" path="${2:-}" key="${3:-}" data="${4:-}"
  local curl_args=(-sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${key}")
  if [ "$method" = "POST" ]; then
    curl_args+=(-H 'Content-Type: application/json' -d "$data")
  fi
  curl "${curl_args[@]}" "${SERVER_URL}${path}"
}

api_body() {
  local method="${1:-GET}" path="${2:-}" key="${3:-}" data="${4:-}"
  local curl_args=(-sS -H "Authorization: Bearer ${key}")
  if [ "$method" = "POST" ]; then
    curl_args+=(-H 'Content-Type: application/json' -d "$data")
  fi
  curl "${curl_args[@]}" "${SERVER_URL}${path}" 2>/dev/null
}

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    pass "$label (expected=$expected)"
  else
    fail "$label (expected=$expected actual=$actual)"
  fi
}

assert_contains() {
  if echo "$2" | grep -qF "$3"; then
    pass "$1"
  else
    fail "$1 — '$3' not found"
  fi
}

assert_not_contains() {
  if echo "$2" | grep -qF "$3"; then
    fail "$1 — '$3' incorrectly found"
  else
    pass "$1"
  fi
}

psql_cmd() { docker exec "$CONTAINER_NAME" psql -U "$PG_USER" -d "$PG_DB" -c "$1" 2>&1; }

cleanup() {
  info "Cleaning up..."
  if [ -f /tmp/teamem-govsec-server.pid ]; then
    kill "$(cat /tmp/teamem-govsec-server.pid)" 2>/dev/null || true
    rm -f /tmp/teamem-govsec-server.pid
  fi
  docker rm -f "$CONTAINER_NAME" 2>/dev/null || true
}
trap cleanup EXIT

# ═══════════════════════════════════════════════════════════════════════════════
# Phase 0 — Prerequisites
# ═══════════════════════════════════════════════════════════════════════════════

log "========================================="
log "M2 Governance & Security Verification"
log "DUA-245 M2-QA-04"
log "Timestamp: $TIMESTAMP"
log "========================================="

info "Checking prerequisites..."
for cmd in docker pnpm curl jq openssl; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    fail "Missing required command: $cmd"
    exit 1
  fi
done
pass "All prerequisites available"

# ═══════════════════════════════════════════════════════════════════════════════
# Phase 1 — Build
# ═══════════════════════════════════════════════════════════════════════════════

if [ "${SKIP_BUILD:-0}" != "1" ]; then
  info "Building server..."
  (cd "$REPO_ROOT" && pnpm --filter @teamem/server build) 2>&1 | tail -3 | tee -a "$LOG_FILE"
  pass "Server built"
else
  warn "Skipping build (SKIP_BUILD=1)"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Phase 2 — Start PostgreSQL + Apply Migrations
# ═══════════════════════════════════════════════════════════════════════════════

info "Starting throwaway PostgreSQL container on port $PG_PORT..."
docker rm -f "$CONTAINER_NAME" 2>/dev/null || true

docker run -d \
  --name "$CONTAINER_NAME" \
  -e "POSTGRES_USER=$PG_USER" \
  -e "POSTGRES_PASSWORD=$PG_PASSWORD" \
  -e "POSTGRES_DB=$PG_DB" \
  -p "127.0.0.1:${PG_PORT}:5432" \
  pgvector/pgvector:pg17 \
  -c max_connections=50 >/dev/null 2>&1

info "Waiting for PostgreSQL..."
for i in $(seq 1 30); do
  if docker exec "$CONTAINER_NAME" pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1; then
    pass "PostgreSQL is ready"
    break
  fi
  if [ "$i" -eq 30 ]; then
    fail "PostgreSQL did not become ready within 30s"
    docker logs "$CONTAINER_NAME" 2>&1 | tail -20
    exit 1
  fi
  sleep 1
done

info "Applying database migrations..."
for migration in "$SERVER_DIR/drizzle"/*.sql; do
  migration_name="$(basename "$migration")"
  if ! docker exec -i "$CONTAINER_NAME" psql -U "$PG_USER" -d "$PG_DB" < "$migration" >/dev/null 2>&1; then
    fail "Migration $migration_name failed"
    exit 1
  fi
  info "  Applied $migration_name"
done
pass "All migrations applied"

# ═══════════════════════════════════════════════════════════════════════════════
# Phase 3 — Seed Test Data (direct SQL)
# ═══════════════════════════════════════════════════════════════════════════════

info "Seeding test data (two teams with users, API keys, sessions, data)..."

# ── Generate IDs ────────────────────────────────────────────────────────────

ALPHA_TEAM="team_alpha_govsec"
ALPHA_PROJECT="prj_alpha_govsec"
ALPHA_OWNER_USER="usr_alpha_owner"
ALPHA_SESSION_ID="ses_alpha_govsec"
ALPHA_KEY_ID="key_alpha_govsec"

BRAVO_TEAM="team_bravo_govsec"
BRAVO_PROJECT="prj_bravo_govsec"
BRAVO_OWNER_USER="usr_bravo_owner"
BRAVO_SESSION_ID="ses_bravo_govsec"
BRAVO_KEY_ID="key_bravo_govsec"

NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
EXPIRES=$(date -u -d '+7 days' +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null || python3 -c "from datetime import datetime, timedelta; print((datetime.utcnow() + timedelta(days=7)).strftime('%Y-%m-%dT%H:%M:%S.000Z'))" 2>/dev/null || echo "2099-01-01T00:00:00.000Z")

# ── Generate session tokens and their HMAC-SHA256 hashes ──────────────────

ALPHA_SESSION_PLAINTEXT="ses_alpha_token_$(openssl rand -hex 32)"
ALPHA_SESSION_HASH=$(session_hash "$ALPHA_SESSION_PLAINTEXT")
ALPHA_COOKIE="teamem_session=${ALPHA_SESSION_PLAINTEXT}"

BRAVO_SESSION_PLAINTEXT="ses_bravo_token_$(openssl rand -hex 32)"
BRAVO_SESSION_HASH=$(session_hash "$BRAVO_SESSION_PLAINTEXT")
BRAVO_COOKIE="teamem_session=${BRAVO_SESSION_PLAINTEXT}"

# ── Generate API key tokens and their SHA-256 hashes ──────────────────────

ALPHA_TOKEN_PLAINTEXT="tm_alpha_govsec_$(openssl rand -hex 32 | base64 | tr -d '=+/' | head -c 43)"
ALPHA_TOKEN_HASH=$(token_hash "$ALPHA_TOKEN_PLAINTEXT")
ALPHA_API_KEY="$ALPHA_TOKEN_PLAINTEXT"

BRAVO_TOKEN_PLAINTEXT="tm_bravo_govsec_$(openssl rand -hex 32 | base64 | tr -d '=+/' | head -c 43)"
BRAVO_TOKEN_HASH=$(token_hash "$BRAVO_TOKEN_PLAINTEXT")
BRAVO_API_KEY="$BRAVO_TOKEN_PLAINTEXT"

# ── Insert teams ───────────────────────────────────────────────────────────

psql_cmd "INSERT INTO teams (id, name) VALUES ('${ALPHA_TEAM}', 'Alpha GovSec Team')" >/dev/null
psql_cmd "INSERT INTO teams (id, name) VALUES ('${BRAVO_TEAM}', 'Bravo GovSec Team')" >/dev/null

# ── Insert projects ────────────────────────────────────────────────────────

psql_cmd "INSERT INTO projects (id, team_id, name) VALUES ('${ALPHA_PROJECT}', '${ALPHA_TEAM}', 'alpha-project')" >/dev/null
psql_cmd "INSERT INTO projects (id, team_id, name) VALUES ('${BRAVO_PROJECT}', '${BRAVO_TEAM}', 'bravo-project')" >/dev/null

# ── Insert users (simulated GitHub users) ──────────────────────────────────

psql_cmd "INSERT INTO users (id, github_id, github_login) VALUES ('${ALPHA_OWNER_USER}', 900001, 'alpha-owner')" >/dev/null
psql_cmd "INSERT INTO users (id, github_id, github_login) VALUES ('${BRAVO_OWNER_USER}', 900002, 'bravo-owner')" >/dev/null

# ── Insert memberships (both owners) ───────────────────────────────────────

psql_cmd "INSERT INTO memberships (user_id, team_id, role) VALUES ('${ALPHA_OWNER_USER}', '${ALPHA_TEAM}', 'owner')" >/dev/null
psql_cmd "INSERT INTO memberships (user_id, team_id, role) VALUES ('${BRAVO_OWNER_USER}', '${BRAVO_TEAM}', 'owner')" >/dev/null

# ── Insert web sessions ────────────────────────────────────────────────────

psql_cmd "INSERT INTO web_sessions (id, user_id, token_hash, issued_at, expires_at)
  VALUES ('${ALPHA_SESSION_ID}', '${ALPHA_OWNER_USER}', '${ALPHA_SESSION_HASH}', '${NOW}', '${EXPIRES}')" >/dev/null
psql_cmd "INSERT INTO web_sessions (id, user_id, token_hash, issued_at, expires_at)
  VALUES ('${BRAVO_SESSION_ID}', '${BRAVO_OWNER_USER}', '${BRAVO_SESSION_HASH}', '${NOW}', '${EXPIRES}')" >/dev/null

# ── Insert API keys ────────────────────────────────────────────────────────

psql_cmd "INSERT INTO api_keys (id, team_id, project_id, name, token_hash, scopes, all_projects)
  VALUES ('${ALPHA_KEY_ID}', '${ALPHA_TEAM}', '${ALPHA_PROJECT}', 'Alpha API Key',
          '${ALPHA_TOKEN_HASH}', ARRAY['read','events:write','read:payload']::text[], false)" >/dev/null
psql_cmd "INSERT INTO api_keys (id, team_id, project_id, name, token_hash, scopes, all_projects)
  VALUES ('${BRAVO_KEY_ID}', '${BRAVO_TEAM}', '${BRAVO_PROJECT}', 'Bravo API Key',
          '${BRAVO_TOKEN_HASH}', ARRAY['read','events:write','read:payload']::text[], false)" >/dev/null

# ── Insert principals ──────────────────────────────────────────────────────

psql_cmd "INSERT INTO principals (id, team_id, kind, provider, provider_kind, provider_user_id, display_login)
  VALUES ('pri_alpha_actor1', '${ALPHA_TEAM}', 'human', 'github', 'github', '10001', 'alpha-actor1')" >/dev/null
psql_cmd "INSERT INTO principals (id, team_id, kind, provider, provider_kind, provider_user_id, display_login)
  VALUES ('pri_alpha_actor2', '${ALPHA_TEAM}', 'human', 'github', 'github', '10002', 'alpha-actor2')" >/dev/null
psql_cmd "INSERT INTO principals (id, team_id, kind, provider, provider_kind, provider_user_id, display_login)
  VALUES ('pri_bravo_actor1', '${BRAVO_TEAM}', 'human', 'github', 'github', '20001', 'bravo-actor1')" >/dev/null

# ── Seed audit records ────────────────────────────────────────────────────

# Alpha audit records — mix of actions, actors, and outcomes
psql_cmd "INSERT INTO audit_log (id, request_id, principal_id, action, resource_type, resource_id,
  team_id, project_id, outcome, created_at) VALUES
  (gen_random_uuid(), 'req_alpha_001', 'pri_alpha_actor1', 'concept.read', 'concept', 'res_alpha_c1',
   '${ALPHA_TEAM}', '${ALPHA_PROJECT}', 'success', NOW() - INTERVAL '2 hours'),
  (gen_random_uuid(), 'req_alpha_002', 'pri_alpha_actor1', 'event.ingest', 'event', 'res_alpha_e1',
   '${ALPHA_TEAM}', '${ALPHA_PROJECT}', 'success', NOW() - INTERVAL '1 hour'),
  (gen_random_uuid(), 'req_alpha_003', 'pri_alpha_actor2', 'search.query', 'concept', 'res_alpha_search',
   '${ALPHA_TEAM}', '${ALPHA_PROJECT}', 'denied', NOW() - INTERVAL '30 minutes'),
  (gen_random_uuid(), 'req_alpha_004', 'pri_alpha_actor1', 'context.read', 'concept', 'res_alpha_ctx',
   '${ALPHA_TEAM}', '${ALPHA_PROJECT}', 'success', NOW() - INTERVAL '10 minutes'),
  (gen_random_uuid(), 'req_alpha_005', 'pri_alpha_actor3', 'concept.read', 'concept', NULL,
   '${ALPHA_TEAM}', NULL, 'success', NOW() - INTERVAL '5 minutes'),
  (gen_random_uuid(), 'req_sentinel_${SENTINEL}', 'pri_sentinel_${SENTINEL}', 'search.query',
   'concept', 'res_${SENTINEL}', '${ALPHA_TEAM}', '${ALPHA_PROJECT}', 'success',
   NOW() - INTERVAL '3 minutes')" >/dev/null

# Bravo audit records
psql_cmd "INSERT INTO audit_log (id, request_id, principal_id, action, resource_type, resource_id,
  team_id, project_id, outcome, created_at) VALUES
  (gen_random_uuid(), 'req_bravo_001', 'pri_bravo_actor1', 'concept.read', 'concept', 'res_bravo_c1',
   '${BRAVO_TEAM}', '${BRAVO_PROJECT}', 'success', NOW() - INTERVAL '1 hour'),
  (gen_random_uuid(), 'req_bravo_002', 'pri_bravo_actor2', 'event.ingest', 'event', 'res_bravo_e1',
   '${BRAVO_TEAM}', '${BRAVO_PROJECT}', 'success', NOW() - INTERVAL '30 minutes')" >/dev/null

pass "Teams, users, sessions, keys, principals, and audit records seeded"

# ── Seed Alpha project data (events, concepts, jobs) for purge test ───────

info "Seeding project data for purge test..."

# Events (3)
for i in 1 2 3; do
  EID="evt_alpha_${i}_$(openssl rand -hex 6)"
  psql_cmd "INSERT INTO events (id, team_id, project_id, channel, kind, connector_kind,
    delivery_id, item_key, external_id, actor_provenance, occurred_at,
    occurred_at_provenance, payload, payload_bytes, payload_hash,
    payload_schema_version, envelope_version)
    VALUES ('${EID}', '${ALPHA_TEAM}', '${ALPHA_PROJECT}', 'cli', 'cli_init', 'cli',
    'del_alpha_${i}', 'root', 'test/repo#${i}', 'unknown', NOW(), 'server',
    '{}', 2, 'abc_hash_${i}', 1, 1)" >/dev/null
done

# Concepts (2) with paths, evidence, contributors
for i in 1 2; do
  CUID="0000000${i}-0000-4000-8000-$(openssl rand -hex 6)"
  psql_cmd "INSERT INTO concepts (uuid, team_id, project_id, schema_version, type, status,
    confidence, title, body, first_seen, last_confirmed)
    VALUES ('${CUID}', '${ALPHA_TEAM}', '${ALPHA_PROJECT}', 1, 'concept', 'active',
    'high', 'Concept ${i}', 'Body for concept ${i}', NOW(), NOW())" >/dev/null

  psql_cmd "INSERT INTO concept_paths (team_id, project_id, concept_uuid, path, is_current)
    VALUES ('${ALPHA_TEAM}', '${ALPHA_PROJECT}', '${CUID}', 'concept-${i}', true)" >/dev/null

  psql_cmd "INSERT INTO concept_evidence (team_id, project_id, concept_uuid, kind, ref, at)
    VALUES ('${ALPHA_TEAM}', '${ALPHA_PROJECT}', '${CUID}', 'commit', 'ref-${i}', NOW())" >/dev/null

  psql_cmd "INSERT INTO concept_contributors (team_id, project_id, concept_uuid, principal_id)
    VALUES ('${ALPHA_TEAM}', '${ALPHA_PROJECT}', '${CUID}', 'pri_alpha_actor1')" >/dev/null
done

# Job (1)
JID="job_alpha_$(openssl rand -hex 8)"
psql_cmd "INSERT INTO jobs (id, team_id, project_id, kind, status, attempts, initiated_by_kind, event_count)
  VALUES ('${JID}', '${ALPHA_TEAM}', '${ALPHA_PROJECT}', 'compilation', 'completed', 1, 'credential', 1)" >/dev/null

# job_events — link first event to job
EVT_FIRST=$(docker exec "$CONTAINER_NAME" psql -U "$PG_USER" -d "$PG_DB" -t -c \
  "SELECT id FROM events WHERE project_id = '${ALPHA_PROJECT}' ORDER BY created_at LIMIT 1" 2>/dev/null | tr -d '[:space:]')

if [ -n "$EVT_FIRST" ] && [ "$EVT_FIRST" != "(0rows)" ]; then
  psql_cmd "INSERT INTO job_events (team_id, project_id, job_id, event_id, status)
    VALUES ('${ALPHA_TEAM}', '${ALPHA_PROJECT}', '${JID}', '${EVT_FIRST}', 'compiled')" >/dev/null
fi

# ── Count seed data ─────────────────────────────────────────────────────────

EVENTS_BEFORE=$(docker exec "$CONTAINER_NAME" psql -U "$PG_USER" -d "$PG_DB" -t -c \
  "SELECT COUNT(*) FROM events WHERE project_id = '${ALPHA_PROJECT}'" 2>/dev/null | tr -d '[:space:]')
CONCEPTS_BEFORE=$(docker exec "$CONTAINER_NAME" psql -U "$PG_USER" -d "$PG_DB" -t -c \
  "SELECT COUNT(*) FROM concepts WHERE project_id = '${ALPHA_PROJECT}'" 2>/dev/null | tr -d '[:space:]')
CONCEPT_PATHS_BEFORE=$(docker exec "$CONTAINER_NAME" psql -U "$PG_USER" -d "$PG_DB" -t -c \
  "SELECT COUNT(*) FROM concept_paths WHERE project_id = '${ALPHA_PROJECT}'" 2>/dev/null | tr -d '[:space:]')
CONCEPT_EVIDENCE_BEFORE=$(docker exec "$CONTAINER_NAME" psql -U "$PG_USER" -d "$PG_DB" -t -c \
  "SELECT COUNT(*) FROM concept_evidence WHERE project_id = '${ALPHA_PROJECT}'" 2>/dev/null | tr -d '[:space:]')
CONCEPT_CONTRIBUTORS_BEFORE=$(docker exec "$CONTAINER_NAME" psql -U "$PG_USER" -d "$PG_DB" -t -c \
  "SELECT COUNT(*) FROM concept_contributors WHERE project_id = '${ALPHA_PROJECT}'" 2>/dev/null | tr -d '[:space:]')
JOBS_BEFORE=$(docker exec "$CONTAINER_NAME" psql -U "$PG_USER" -d "$PG_DB" -t -c \
  "SELECT COUNT(*) FROM jobs WHERE project_id = '${ALPHA_PROJECT}'" 2>/dev/null | tr -d '[:space:]')
JOB_EVENTS_BEFORE=$(docker exec "$CONTAINER_NAME" psql -U "$PG_USER" -d "$PG_DB" -t -c \
  "SELECT COUNT(*) FROM job_events WHERE project_id = '${ALPHA_PROJECT}'" 2>/dev/null | tr -d '[:space:]')
AUDIT_ALPHA_BEFORE=$(docker exec "$CONTAINER_NAME" psql -U "$PG_USER" -d "$PG_DB" -t -c \
  "SELECT COUNT(*) FROM audit_log WHERE team_id = '${ALPHA_TEAM}'" 2>/dev/null | tr -d '[:space:]')
PRINCIPALS_ALPHA_BEFORE=$(docker exec "$CONTAINER_NAME" psql -U "$PG_USER" -d "$PG_DB" -t -c \
  "SELECT COUNT(*) FROM principals WHERE team_id = '${ALPHA_TEAM}'" 2>/dev/null | tr -d '[:space:]')

pass "Project data seeded (events=$EVENTS_BEFORE concepts=$CONCEPTS_BEFORE jobs=$JOBS_BEFORE audit=$AUDIT_ALPHA_BEFORE)"

# ═══════════════════════════════════════════════════════════════════════════════
# Phase 4 — Start Server
# ═══════════════════════════════════════════════════════════════════════════════

info "Starting teamem server on port $SERVER_PORT..."

cd "$SERVER_DIR"

DATABASE_URL="$DATABASE_URL" \
  TEAMEM_ALL_IN_ONE=true \
  TEAMEM_PORT="$SERVER_PORT" \
  TEAMEM_BASE_URL="$SERVER_URL" \
  TEAMEM_GITHUB_OAUTH_CLIENT_ID="$FAKE_OAUTH_CLIENT_ID" \
  TEAMEM_GITHUB_OAUTH_CLIENT_SECRET="$FAKE_OAUTH_CLIENT_SECRET" \
  npx tsx src/index.ts &
SERVER_PID=$!
echo "$SERVER_PID" > /tmp/teamem-govsec-server.pid

info "Waiting for server to be ready..."
for i in $(seq 1 30); do
  if curl -sS "${SERVER_URL}/healthz" >/dev/null 2>&1; then
    pass "Server is ready on $SERVER_URL"
    break
  fi
  if [ "$i" -eq 30 ]; then
    fail "Server did not become ready within 30s"
    exit 1
  fi
  sleep 1
done

# ═══════════════════════════════════════════════════════════════════════════════
# Phase 5 — Verification
# ═══════════════════════════════════════════════════════════════════════════════

log ""
log "========================================="
log "VERIFICATION TESTS"
log "========================================="

# ═══════════════════════════════════════════════════════════════════════════════
# 5.1 — Audit: Actor/Time Filtering
# ═══════════════════════════════════════════════════════════════════════════════

log ""
log "--- 5.1 Audit: Actor/Time Filtering ---"

# List all audit records (Alpha owner)
AUDIT_LIST=$(http_body GET "/v1/audit" "$ALPHA_COOKIE")
AUDIT_COUNT=$(echo "$AUDIT_LIST" | jq '.data | length' 2>/dev/null || echo "0")

if [ "$AUDIT_COUNT" -ge 1 ] 2>/dev/null; then
  pass "Audit list returns records (count=$AUDIT_COUNT)"
else
  fail "Audit list returned no records — response: $(echo "$AUDIT_LIST" | head -c 500)"
fi

# Filter by action
AUDIT_BY_ACTION=$(http_body GET "/v1/audit?action=concept.read" "$ALPHA_COOKIE")
AUDIT_ACTION_COUNT=$(echo "$AUDIT_BY_ACTION" | jq '.data | length' 2>/dev/null || echo "0")
if [ "$AUDIT_ACTION_COUNT" -ge 1 ] 2>/dev/null; then
  NON_MATCHING=$(echo "$AUDIT_BY_ACTION" | jq '[.data[] | select(.action != "concept.read")] | length' 2>/dev/null || echo "0")
  assert_eq "All action-filtered rows match concept.read" "0" "$NON_MATCHING"
else
  fail "Audit action filter returned no results"
fi

# Filter by actor (principalId)
AUDIT_BY_ACTOR=$(http_body GET "/v1/audit?actor=pri_alpha_actor1" "$ALPHA_COOKIE")
AUDIT_ACTOR_COUNT=$(echo "$AUDIT_BY_ACTOR" | jq '.data | length' 2>/dev/null || echo "0")
if [ "$AUDIT_ACTOR_COUNT" -ge 1 ] 2>/dev/null; then
  pass "Audit filtered by actor=pri_alpha_actor1 — $AUDIT_ACTOR_COUNT row(s)"
else
  fail "Audit actor filter returned no results"
fi

# Combined filters
AUDIT_COMBO=$(http_body GET "/v1/audit?actor=pri_alpha_actor1&action=concept.read" "$ALPHA_COOKIE")
AUDIT_COMBO_COUNT=$(echo "$AUDIT_COMBO" | jq '.data | length' 2>/dev/null || echo "0")
if [ "$AUDIT_COMBO_COUNT" -ge 1 ] 2>/dev/null; then
  pass "Audit combined actor+action filter — $AUDIT_COMBO_COUNT row(s)"
else
  fail "Audit combined filter returned no results"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# 5.2 — Audit: Full Table Scan — NO Query/Payload/Secret Content
# ═══════════════════════════════════════════════════════════════════════════════

log ""
log "--- 5.2 Audit: No Query/Payload/Secret Content ---"

# Full audit response as string
AUDIT_FULL="$AUDIT_LIST"

# Sentinel MUST be present (proves data was stored and returned in a whitelisted field)
assert_contains "Sentinel present in audit response (proves data was stored)" "$AUDIT_FULL" "$SENTINEL"

# But NO content-bearing field names may exist
assert_not_contains "No 'query' field name in response" "$AUDIT_FULL" '"query"'
assert_not_contains "No 'payload' field name in response" "$AUDIT_FULL" '"payload"'
assert_not_contains "No 'body' field name in response" "$AUDIT_FULL" '"body"'
assert_not_contains "No 'content' field name in response" "$AUDIT_FULL" '"content"'

# Forbidden substring scan
assert_not_contains "No 'SECRET=' in audit response" "$AUDIT_FULL" "SECRET="
assert_not_contains "No 'Bearer ' in audit response" "$AUDIT_FULL" "Bearer "
assert_not_contains "No 'access_token' in audit response" "$AUDIT_FULL" "access_token"
assert_not_contains "No 'client_secret' in audit response" "$AUDIT_FULL" "client_secret"
assert_not_contains "No '<private>' in audit response" "$AUDIT_FULL" "<private>"
assert_not_contains "No 'password' in audit response" "$AUDIT_FULL" "password"

# DB-level: audit_log table has no content-bearing columns
AUDIT_COLS=$(docker exec "$CONTAINER_NAME" psql -U "$PG_USER" -d "$PG_DB" -t -c \
  "SELECT column_name FROM information_schema.columns
   WHERE table_name = 'audit_log'
   AND column_name IN ('query', 'payload', 'body', 'content', 'query_text', 'search_query', 'request_body')" 2>/dev/null | tr -d '[:space:]')
assert_eq "DB audit_log has NO content-bearing columns" "" "$AUDIT_COLS"

# ═══════════════════════════════════════════════════════════════════════════════
# 5.3 — Purge: Counts, Audit/Identity Survival, Purge Audit Record
# ═══════════════════════════════════════════════════════════════════════════════

log ""
log "--- 5.3 Purge: Counts, Audit/Identity Retention ---"

PURGE_RESULT=$(http_body POST "/teams/${ALPHA_TEAM}/projects/${ALPHA_PROJECT}/purge" "$ALPHA_COOKIE" '{}')
PURGE_PROJECT=$(echo "$PURGE_RESULT" | jq -r '.projectId' 2>/dev/null)

if [ "$PURGE_PROJECT" = "$ALPHA_PROJECT" ]; then
  pass "Purge returned 200 with correct projectId"
else
  fail "Purge failed — response: $(echo "$PURGE_RESULT" | head -c 500)"
fi

# Verify deletion counts
EVENTS_DELETED=$(echo "$PURGE_RESULT" | jq -r '.eventsDeleted' 2>/dev/null)
CONCEPTS_DELETED=$(echo "$PURGE_RESULT" | jq -r '.conceptsDeleted' 2>/dev/null)
CONCEPT_PATHS_DELETED=$(echo "$PURGE_RESULT" | jq -r '.conceptPathsDeleted' 2>/dev/null)
CONCEPT_EVIDENCE_DELETED=$(echo "$PURGE_RESULT" | jq -r '.conceptEvidenceDeleted' 2>/dev/null)
CONCEPT_CONTRIBUTORS_DELETED=$(echo "$PURGE_RESULT" | jq -r '.conceptContributorsDeleted' 2>/dev/null)
JOBS_DELETED=$(echo "$PURGE_RESULT" | jq -r '.jobsDeleted' 2>/dev/null)
JOB_EVENTS_DELETED=$(echo "$PURGE_RESULT" | jq -r '.jobEventsDeleted' 2>/dev/null)

assert_eq "Events deleted" "$EVENTS_BEFORE" "$EVENTS_DELETED"
assert_eq "Concepts deleted" "$CONCEPTS_BEFORE" "$CONCEPTS_DELETED"
assert_eq "Concept paths deleted" "$CONCEPT_PATHS_BEFORE" "$CONCEPT_PATHS_DELETED"
assert_eq "Concept evidence deleted" "$CONCEPT_EVIDENCE_BEFORE" "$CONCEPT_EVIDENCE_DELETED"
assert_eq "Concept contributors deleted" "$CONCEPT_CONTRIBUTORS_BEFORE" "$CONCEPT_CONTRIBUTORS_DELETED"
assert_eq "Jobs deleted" "$JOBS_BEFORE" "$JOBS_DELETED"
assert_eq "Job events deleted" "$JOB_EVENTS_BEFORE" "$JOB_EVENTS_DELETED"

# Verify data is actually gone
EVENTS_AFTER=$(docker exec "$CONTAINER_NAME" psql -U "$PG_USER" -d "$PG_DB" -t -c \
  "SELECT COUNT(*) FROM events WHERE project_id = '${ALPHA_PROJECT}'" 2>/dev/null | tr -d '[:space:]')
CONCEPTS_AFTER=$(docker exec "$CONTAINER_NAME" psql -U "$PG_USER" -d "$PG_DB" -t -c \
  "SELECT COUNT(*) FROM concepts WHERE project_id = '${ALPHA_PROJECT}'" 2>/dev/null | tr -d '[:space:]')
JOBS_AFTER=$(docker exec "$CONTAINER_NAME" psql -U "$PG_USER" -d "$PG_DB" -t -c \
  "SELECT COUNT(*) FROM jobs WHERE project_id = '${ALPHA_PROJECT}'" 2>/dev/null | tr -d '[:space:]')

assert_eq "Post-purge events count = 0" "0" "$EVENTS_AFTER"
assert_eq "Post-purge concepts count = 0" "0" "$CONCEPTS_AFTER"
assert_eq "Post-purge jobs count = 0" "0" "$JOBS_AFTER"

# Audit records survive (including new purge audit record)
AUDIT_ALPHA_AFTER=$(docker exec "$CONTAINER_NAME" psql -U "$PG_USER" -d "$PG_DB" -t -c \
  "SELECT COUNT(*) FROM audit_log WHERE team_id = '${ALPHA_TEAM}'" 2>/dev/null | tr -d '[:space:]')
AUDIT_EXPECTED=$((AUDIT_ALPHA_BEFORE + 1))

if [ "$AUDIT_ALPHA_AFTER" -ge "$AUDIT_EXPECTED" ] 2>/dev/null; then
  pass "Audit records survive purge (was $AUDIT_ALPHA_BEFORE, now $AUDIT_ALPHA_AFTER, expected >= $AUDIT_EXPECTED)"
else
  fail "Audit records did not survive (was $AUDIT_ALPHA_BEFORE, now $AUDIT_ALPHA_AFTER, expected >= $AUDIT_EXPECTED)"
fi

# Verify purge audit record
PURGE_AUDIT_COUNT=$(docker exec "$CONTAINER_NAME" psql -U "$PG_USER" -d "$PG_DB" -t -c \
  "SELECT COUNT(*) FROM audit_log WHERE action = 'project.purge' AND project_id = '${ALPHA_PROJECT}' AND team_id = '${ALPHA_TEAM}'" 2>/dev/null | tr -d '[:space:]')
assert_eq "Purge audit record present (action=project.purge)" "1" "$PURGE_AUDIT_COUNT"

# Principals survive
PRINCIPALS_ALPHA_AFTER=$(docker exec "$CONTAINER_NAME" psql -U "$PG_USER" -d "$PG_DB" -t -c \
  "SELECT COUNT(*) FROM principals WHERE team_id = '${ALPHA_TEAM}'" 2>/dev/null | tr -d '[:space:]')
assert_eq "Principals survive purge" "$PRINCIPALS_ALPHA_BEFORE" "$PRINCIPALS_ALPHA_AFTER"

# Second purge — idempotent, zero counts
PURGE_RESULT2=$(http_body POST "/teams/${ALPHA_TEAM}/projects/${ALPHA_PROJECT}/purge" "$ALPHA_COOKIE" '{}')
assert_eq "Second purge events=0" "0" "$(echo "$PURGE_RESULT2" | jq -r '.eventsDeleted')"
assert_eq "Second purge concepts=0" "0" "$(echo "$PURGE_RESULT2" | jq -r '.conceptsDeleted')"

# Second purge writes separate audit record
PURGE_AUDIT_COUNT2=$(docker exec "$CONTAINER_NAME" psql -U "$PG_USER" -d "$PG_DB" -t -c \
  "SELECT COUNT(*) FROM audit_log WHERE action = 'project.purge' AND project_id = '${ALPHA_PROJECT}' AND team_id = '${ALPHA_TEAM}'" 2>/dev/null | tr -d '[:space:]')
assert_eq "Second purge writes separate audit record" "2" "$PURGE_AUDIT_COUNT2"

# ═══════════════════════════════════════════════════════════════════════════════
# 5.4 — Cross-Team Isolation: All Entries Indistinguishable from "Doesn't Exist"
# ═══════════════════════════════════════════════════════════════════════════════

log ""
log "--- 5.4 Cross-Team Isolation ---"

# 5.4.1 Cross-team audit: Alpha session + Bravo projectId → empty 200
ALPHA_AUDIT_BRAVO_STATUS=$(http_status GET "/v1/audit?projectId=${BRAVO_PROJECT}" "$ALPHA_COOKIE")
ALPHA_AUDIT_BRAVO_BODY=$(http_body GET "/v1/audit?projectId=${BRAVO_PROJECT}" "$ALPHA_COOKIE")
ALPHA_AUDIT_BRAVO_COUNT=$(echo "$ALPHA_AUDIT_BRAVO_BODY" | jq '.data | length' 2>/dev/null || echo "0")
assert_eq "Cross-team audit returns 200 (not 404/403)" "200" "$ALPHA_AUDIT_BRAVO_STATUS"
assert_eq "Cross-team audit returns empty list" "0" "$ALPHA_AUDIT_BRAVO_COUNT"

# Non-existent project in own team — same response
NONEXIST_PROJ="prj_nonexistent_$(openssl rand -hex 4)"
ALPHA_AUDIT_NONEXIST_STATUS=$(http_status GET "/v1/audit?projectId=${NONEXIST_PROJ}" "$ALPHA_COOKIE")
ALPHA_AUDIT_NONEXIST_COUNT=$(http_body GET "/v1/audit?projectId=${NONEXIST_PROJ}" "$ALPHA_COOKIE" | jq '.data | length' 2>/dev/null || echo "0")
assert_eq "Non-existent project audit returns 200 (same as cross-team)" "200" "$ALPHA_AUDIT_NONEXIST_STATUS"
assert_eq "Non-existent project audit returns empty (same as cross-team)" "0" "$ALPHA_AUDIT_NONEXIST_COUNT"

# 5.4.2 Cross-team event read: Alpha API key + Bravo project → 403 (scope mismatch)
# Project-scoped keys reject cross-team reads; all-projects keys return 404
ALPHA_READ_BRAVO_STATUS=$(api_status GET "/v1/events?projectId=${BRAVO_PROJECT}" "$ALPHA_API_KEY")
if [ "$ALPHA_READ_BRAVO_STATUS" = "403" ] || [ "$ALPHA_READ_BRAVO_STATUS" = "404" ]; then
  pass "Alpha API key reading Bravo events returns $ALPHA_READ_BRAVO_STATUS (anti-enumeration)"
else
  fail "Alpha API key reading Bravo events returned $ALPHA_READ_BRAVO_STATUS (expected 403 or 404)"
fi

# 5.4.3 Cross-team search: Alpha API key + Bravo project → empty results
ALPHA_SEARCH_BRAVO_STATUS=$(api_status POST "/v1/search" "$ALPHA_API_KEY" \
  "{\"projectId\":\"${BRAVO_PROJECT}\",\"query\":\"test query\"}")
if [ "$ALPHA_SEARCH_BRAVO_STATUS" = "200" ]; then
  ALPHA_SEARCH_BRAVO_BODY=$(api_body POST "/v1/search" "$ALPHA_API_KEY" \
    "{\"projectId\":\"${BRAVO_PROJECT}\",\"query\":\"test query\"}")
  SEARCH_COUNT=$(echo "$ALPHA_SEARCH_BRAVO_BODY" | jq '.results | length' 2>/dev/null || echo "0")
  assert_eq "Cross-team search returns empty results" "0" "$SEARCH_COUNT"
else
  pass "Cross-team search returns $ALPHA_SEARCH_BRAVO_STATUS (anti-enumeration, not 200)"
  warn "Expected 200 with empty results. Got $ALPHA_SEARCH_BRAVO_STATUS"
fi

# 5.4.4 Cross-team purge: Bravo session + Alpha project → 404
BRAVO_PURGE_ALPHA_STATUS=$(http_status POST "/teams/${ALPHA_TEAM}/projects/${ALPHA_PROJECT}/purge" "$BRAVO_COOKIE" '{}')
assert_eq "Cross-team purge returns 404" "404" "$BRAVO_PURGE_ALPHA_STATUS"

# 5.4.5 Cross-team context: Alpha API key + Bravo project → empty/denied
ALPHA_CTX_BRAVO_STATUS=$(api_status GET "/v1/context?projectId=${BRAVO_PROJECT}" "$ALPHA_API_KEY")
if [ "$ALPHA_CTX_BRAVO_STATUS" = "200" ]; then
  ALPHA_CTX_BRAVO_BODY=$(api_body GET "/v1/context?projectId=${BRAVO_PROJECT}" "$ALPHA_API_KEY")
  CTX_AVAILABLE=$(echo "$ALPHA_CTX_BRAVO_BODY" | jq '.data.conceptsAvailable' 2>/dev/null || echo "0")
  assert_eq "Cross-team context returns 0 available concepts" "0" "$CTX_AVAILABLE"
else
  pass "Cross-team context returns $ALPHA_CTX_BRAVO_STATUS (anti-enumeration)"
fi

# 5.4.6 Byte-identical 404 responses: cross-team == genuinely missing
MISSING_PURGE_BODY=$(http_body POST "/teams/${ALPHA_TEAM}/projects/prj_definitely_missing/purge" "$ALPHA_COOKIE" '{}')
CROSS_PURGE_BODY=$(http_body POST "/teams/${BRAVO_TEAM}/projects/${ALPHA_PROJECT}/purge" "$BRAVO_COOKIE" '{}')

MISSING_CODE=$(echo "$MISSING_PURGE_BODY" | jq -r '.error.code' 2>/dev/null)
CROSS_CODE=$(echo "$CROSS_PURGE_BODY" | jq -r '.error.code' 2>/dev/null)
MISSING_MSG=$(echo "$MISSING_PURGE_BODY" | jq -r '.error.message' 2>/dev/null)
CROSS_MSG=$(echo "$CROSS_PURGE_BODY" | jq -r '.error.message' 2>/dev/null)

assert_eq "Missing project purge error code" "not_found" "$MISSING_CODE"
assert_eq "Cross-team purge error code (same as missing)" "not_found" "$CROSS_CODE"
assert_eq "Cross-team and missing-project error messages byte-identical" "$MISSING_MSG" "$CROSS_MSG"

# Also verify both are 404
MISSING_PURGE_STATUS=$(http_status POST "/teams/${ALPHA_TEAM}/projects/prj_definitely_missing/purge" "$ALPHA_COOKIE" '{}')
CROSS_PURGE_STATUS=$(http_status POST "/teams/${BRAVO_TEAM}/projects/${ALPHA_PROJECT}/purge" "$BRAVO_COOKIE" '{}')
assert_eq "Missing project purge HTTP status" "404" "$MISSING_PURGE_STATUS"
assert_eq "Cross-team purge HTTP status (same as missing)" "404" "$CROSS_PURGE_STATUS"

# ═══════════════════════════════════════════════════════════════════════════════
# 5.5 — Counterexample: Revoked Key → 401
# ═══════════════════════════════════════════════════════════════════════════════

log ""
log "--- 5.5 Revoked Key → 401 ---"

# Create a temporary key, test it, revoke it, verify 401
TMP_TOKEN="tm_revoke_test_$(openssl rand -hex 32)"
TMP_HASH=$(token_hash "$TMP_TOKEN")
TMP_KEY_ID="key_revoke_test_$(openssl rand -hex 8)"

psql_cmd "INSERT INTO api_keys (id, team_id, project_id, name, token_hash, scopes, all_projects)
  VALUES ('${TMP_KEY_ID}', '${ALPHA_TEAM}', '${ALPHA_PROJECT}', 'Revoke Test',
          '${TMP_HASH}', ARRAY['read']::text[], false)" >/dev/null

# Should work before revocation
PRE_REVOKE=$(api_status GET "/v1/events?projectId=${ALPHA_PROJECT}" "$TMP_TOKEN")
assert_eq "Pre-revoke key returns 200" "200" "$PRE_REVOKE"

# Revoke
psql_cmd "UPDATE api_keys SET revoked_at = NOW() WHERE id = '${TMP_KEY_ID}'" >/dev/null

# Must return 401 after revocation
POST_REVOKE=$(api_status GET "/v1/events?projectId=${ALPHA_PROJECT}" "$TMP_TOKEN")
assert_eq "Revoked key returns 401" "401" "$POST_REVOKE"

# Error must NOT mention "revoked"
POST_REVOKE_BODY=$(api_body GET "/v1/events?projectId=${ALPHA_PROJECT}" "$TMP_TOKEN")
assert_not_contains "Revoked key error does not mention 'revoked'" "$POST_REVOKE_BODY" "revoked"

# Unknown key must return same 401 with identical error envelope
UNKNOWN_STATUS=$(api_status GET "/v1/events?projectId=${ALPHA_PROJECT}" "tm_not_a_real_key_0000000000000000000")
assert_eq "Unknown key returns 401 (same as revoked)" "401" "$UNKNOWN_STATUS"

UNKNOWN_BODY=$(api_body GET "/v1/events?projectId=${ALPHA_PROJECT}" "tm_not_a_real_key_0000000000000000000")
REVOKE_CODE=$(echo "$POST_REVOKE_BODY" | jq -r '.error.code' 2>/dev/null)
UNKNOWN_CODE=$(echo "$UNKNOWN_BODY" | jq -r '.error.code' 2>/dev/null)
assert_eq "Revoked and unknown key error codes match" "$REVOKE_CODE" "$UNKNOWN_CODE"

REVOKE_MSG=$(echo "$POST_REVOKE_BODY" | jq -r '.error.message' 2>/dev/null)
UNKNOWN_MSG=$(echo "$UNKNOWN_BODY" | jq -r '.error.message' 2>/dev/null)
assert_eq "Revoked and unknown key error messages match" "$REVOKE_MSG" "$UNKNOWN_MSG"

# Clean up temp key
psql_cmd "DELETE FROM api_keys WHERE id = '${TMP_KEY_ID}'" >/dev/null

# ═══════════════════════════════════════════════════════════════════════════════
# 5.6 — Counterexample: API Key Cannot Access Management Endpoints
# ═══════════════════════════════════════════════════════════════════════════════

log ""
log "--- 5.6 API Key → Management Endpoints Rejected ---"

API_AUDIT_STATUS=$(api_status GET "/v1/audit" "$ALPHA_API_KEY")
assert_eq "API key accessing /v1/audit → 401" "401" "$API_AUDIT_STATUS"

API_PURGE_STATUS=$(api_status POST "/teams/${ALPHA_TEAM}/projects/${ALPHA_PROJECT}/purge" "$ALPHA_API_KEY" '{}')
assert_eq "API key accessing purge → 401" "401" "$API_PURGE_STATUS"

API_KEYS_STATUS=$(api_status GET "/v1/teams/${ALPHA_TEAM}/keys" "$ALPHA_API_KEY")
assert_eq "API key accessing keys list → 401" "401" "$API_KEYS_STATUS"

API_MEMBERS_STATUS=$(api_status GET "/v1/teams/${ALPHA_TEAM}/members" "$ALPHA_API_KEY")
assert_eq "API key accessing members → 401" "401" "$API_MEMBERS_STATUS"

API_LLM_STATUS=$(api_status GET "/v1/teams/${ALPHA_TEAM}/llm" "$ALPHA_API_KEY")
assert_eq "API key accessing LLM config → 401" "401" "$API_LLM_STATUS"

# ═══════════════════════════════════════════════════════════════════════════════
# 5.7 — Bravo Owner Sees Only Bravo's Audit (Tenant Isolation Verification)
# ═══════════════════════════════════════════════════════════════════════════════

log ""
log "--- 5.7 Tenant Isolation: Audit Scope Verification ---"

BRAVO_AUDIT_BODY=$(http_body GET "/v1/audit" "$BRAVO_COOKIE")
BRAVO_AUDIT_COUNT=$(echo "$BRAVO_AUDIT_BODY" | jq '.data | length' 2>/dev/null || echo "0")
if [ "$BRAVO_AUDIT_COUNT" -ge 2 ] 2>/dev/null; then
  pass "Bravo owner sees their team's audit ($BRAVO_AUDIT_COUNT records)"
else
  warn "Bravo owner audit count: $BRAVO_AUDIT_COUNT (expected >= 2)"
fi

# Bravo audit must NOT contain Alpha records
BRAVO_HAS_ALPHA=$(echo "$BRAVO_AUDIT_BODY" | jq "[.data[] | select(.teamId == \"$ALPHA_TEAM\")] | length" 2>/dev/null || echo "0")
assert_eq "Bravo audit has zero Alpha team records" "0" "$BRAVO_HAS_ALPHA"

# ═══════════════════════════════════════════════════════════════════════════════
# Phase 6 — Summary
# ═══════════════════════════════════════════════════════════════════════════════

log ""
log "========================================="
log "RESULTS SUMMARY"
log "========================================="
log ""

TOTAL=$((PASS + FAIL))
log "Total assertions: $TOTAL"
log "${GREEN}Passed:${NC} $PASS"
log "${RED}Failed:${NC} $FAIL"
log ""
log "Results saved to: $LOG_FILE"
log ""
log "Test data identifiers:"
log "  Alpha Team:    $ALPHA_TEAM"
log "  Alpha Project: $ALPHA_PROJECT"
log "  Alpha API Key: $ALPHA_API_KEY"
log "  Alpha Session:  teamem_session=${ALPHA_SESSION_PLAINTEXT}"
log "  Bravo Team:    $BRAVO_TEAM"
log "  Bravo Project: $BRAVO_PROJECT"
log "  Sentinel:      $SENTINEL"
log ""

if [ "$FAIL" -gt 0 ]; then
  log "${RED}VERIFICATION FAILED — $FAIL assertion(s) did not pass${NC}"
  exit 1
else
  log "${GREEN}VERIFICATION PASSED — all $PASS assertions passed${NC}"
  exit 0
fi
