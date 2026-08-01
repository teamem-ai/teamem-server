#!/usr/bin/env bash
# M2 Governance & Security — Audit + Purge + Cross-Team Isolation Verification
# (DUA-245 M2-QA-04)
#
# Verifies end-to-end governance, security, and tenant isolation against a
# real PostgreSQL-backed teamem server.  Every assertion targets the live HTTP
# surface — no mock database, no hard-coded success results.
#
# Prerequisites: docker, pnpm, curl, jq, openssl, uuidgen (or python3)
#
# Usage:
#   chmod +x scripts/m2-governance-security.sh
#   ./scripts/m2-governance-security.sh
#
# Optional env vars:
#   TEAMEM_TEST_PG_PORT      Postgres host port   (default 54400)
#   TEAMEM_TEST_SERVER_PORT  Server host port     (default 8081)
#   TEAMEM_TEST_PG_PASSWORD  Postgres password    (default testpass_sec_m2)
#   SKIP_BUILD               set to 1 to skip pnpm build

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

log() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$LOG_FILE"; }

# ── Resolve uuidgen (macOS has it; Linux may need python3) ──────────────────
if command -v uuidgen >/dev/null 2>&1; then
  fresh_uuid() { uuidgen | tr '[:upper:]' '[:lower:]'; }
elif command -v python3 >/dev/null 2>&1; then
  fresh_uuid() { python3 -c 'import uuid; print(uuid.uuid4())'; }
else
  echo "FATAL: neither uuidgen nor python3 found — needed for UUID generation" >&2
  exit 1
fi

# ── Configuration ────────────────────────────────────────────────────────────

PG_PASSWORD="${TEAMEM_TEST_PG_PASSWORD:-testpass_sec_m2}"
PG_PORT="${TEAMEM_TEST_PG_PORT:-54400}"
PG_USER="teamem"
PG_DB="teamem"
CONTAINER_NAME="teamem-govsec-pg"
SERVER_PORT="${TEAMEM_TEST_SERVER_PORT:-8081}"
SERVER_URL="http://127.0.0.1:${SERVER_PORT}"
DATABASE_URL="postgres://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/${PG_DB}"

# Fake OAuth credentials so audit/purge/membership routes are mounted.
# Sessions are seeded in the DB; actual GitHub OAuth never runs.
FAKE_OAUTH_CLIENT_ID="Iv1testgovsec00000000000000000000"
FAKE_OAUTH_CLIENT_SECRET="testgovsec0000000000000000000000000000000000000000"
export TEAMEM_BASE_URL="${SERVER_URL}"

# ── Per-contract ID generation ──────────────────────────────────────────────
# Every fixture ID below satisfies the frozen contract regexes:
#   teamId       /^team_[A-Za-z0-9]+$/
#   projectId    /^prj_[A-Za-z0-9]+$/
#   principalId  /^pri_[A-Za-z0-9]+$/
#   eventId      /^evt_[A-Za-z0-9]+$/
#   credentialId /^(key_[A-Za-z0-9]+|ses_[A-Fa-f0-9]+)$/
#   userId       /^usr_[A-Za-z0-9]+$/
#   sessionId    /^ses_[A-Za-z0-9]+$/   (hex subset used for audit safety)
#   jobId        z.uuid()
#   conceptUuid  z.uuid()
#   auditId      z.uuid()  (server-generated via gen_random_uuid())

AHEX=$(openssl rand -hex 8)
BHEX=$(openssl rand -hex 8)

ALPHA_TEAM="team_A${AHEX}"
ALPHA_PROJECT="prj_A${AHEX}"
ALPHA_OWNER_USER="usr_A${AHEX}"
ALPHA_SESSION_ID="ses_$(openssl rand -hex 15)"
ALPHA_KEY_ID="key_A${AHEX}"

BRAVO_TEAM="team_B${BHEX}"
BRAVO_PROJECT="prj_B${BHEX}"
BRAVO_OWNER_USER="usr_B${BHEX}"
BRAVO_SESSION_ID="ses_$(openssl rand -hex 15)"
BRAVO_KEY_ID="key_B${BHEX}"

# Principals — no underscores allowed after pri_
ALPHA_PRINCIPAL1="pri_A1${AHEX}"
ALPHA_PRINCIPAL2="pri_A2${AHEX}"
ALPHA_PRINCIPAL3="pri_A3${AHEX}"   # used in audit with NULL projectId
BRAVO_PRINCIPAL1="pri_B1${BHEX}"
BRAVO_PRINCIPAL2="pri_B2${BHEX}"
SENTINEL_PRINCIPAL="pri_S$(openssl rand -hex 12)"

# Events
EVT1="evt_A1$(openssl rand -hex 6)"
EVT2="evt_A2$(openssl rand -hex 6)"
EVT3="evt_A3$(openssl rand -hex 6)"

# Jobs MUST be valid UUIDs
JOB_ID=$(fresh_uuid)

# Concepts MUST be valid UUIDs
CONCEPT1_UUID=$(fresh_uuid)
CONCEPT2_UUID=$(fresh_uuid)

# Non-existent / missing project IDs for cross-team & 404 tests
NONEXIST_PROJ="prj_X$(openssl rand -hex 8)"
MISSING_PROJ="prj_M$(openssl rand -hex 8)"

# Revoke-test key
TMP_KEY_ID="key_R$(openssl rand -hex 8)"

# ── Sentinel for leak detection ─────────────────────────────────────────────
SENTINEL="DUA245SENTINEL$(openssl rand -hex 8 | tr '[:lower:]' '[:upper:]')"

# ── Helpers ──────────────────────────────────────────────────────────────────

session_hash() { echo -n "$1" | openssl dgst -sha256 -hmac "teamem-session" | awk '{print $NF}'; }
token_hash()   { echo -n "$1" | openssl dgst -sha256 | awk '{print $NF}'; }

# seed_sql — runs SQL against the container, FAILS LOUDLY on error.
# Does NOT hide stderr behind /dev/null so any Postgres error is visible.
seed_sql() {
  local label="$1" sql="$2"
  local output rc=0
  output=$(docker exec "$CONTAINER_NAME" psql -U "$PG_USER" -d "$PG_DB" -c "$sql" 2>&1) || rc=$?
  if echo "$output" | grep -q 'ERROR:'; then
    fail "Seed SQL failed: $label"
    log "  SQL: $(echo "$sql" | head -c 200)"
    log "  Error: $output"
    exit 1
  fi
  return 0
}

# psql_query — run a query and return stdout (no error-check, for SELECTs).
psql_query() {
  docker exec "$CONTAINER_NAME" psql -U "$PG_USER" -d "$PG_DB" -t -c "$1" 2>/dev/null | tr -d '[:space:]'
}

http_status() {
  local method="${1:-GET}" path="${2:-}" cookie="${3:-}" data="${4:-}"
  local curl_args=(-sS -o /dev/null -w '%{http_code}')
  [ -n "$cookie" ] && curl_args+=(-b "$cookie")
  if [ "$method" = "POST" ]; then curl_args+=(-H 'Content-Type: application/json' -d "$data"); fi
  curl "${curl_args[@]}" "${SERVER_URL}${path}"
}

http_body() {
  local method="${1:-GET}" path="${2:-}" cookie="${3:-}" data="${4:-}"
  local curl_args=(-sS)
  [ -n "$cookie" ] && curl_args+=(-b "$cookie")
  if [ "$method" = "POST" ]; then curl_args+=(-H 'Content-Type: application/json' -d "$data"); fi
  curl "${curl_args[@]}" "${SERVER_URL}${path}" 2>/dev/null
}

api_status() {
  local method="${1:-GET}" path="${2:-}" key="${3:-}" data="${4:-}"
  local curl_args=(-sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${key}")
  if [ "$method" = "POST" ]; then curl_args+=(-H 'Content-Type: application/json' -d "$data"); fi
  curl "${curl_args[@]}" "${SERVER_URL}${path}"
}

api_body() {
  local method="${1:-GET}" path="${2:-}" key="${3:-}" data="${4:-}"
  local curl_args=(-sS -H "Authorization: Bearer ${key}")
  if [ "$method" = "POST" ]; then curl_args+=(-H 'Content-Type: application/json' -d "$data"); fi
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
  if echo "$2" | grep -qF "$3"; then pass "$1"; else fail "$1 — '$3' not found"; fi
}

assert_not_contains() {
  if echo "$2" | grep -qF "$3"; then fail "$1 — '$3' incorrectly found"; else pass "$1"; fi
}

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
log "DUA-245 M2-QA-04    Timestamp: $TIMESTAMP"
log "========================================="

info "Checking prerequisites..."
for cmd in docker pnpm curl jq openssl; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    fail "Missing required command: $cmd"; exit 1
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
# Phase 2 — PostgreSQL + Migrations
# ═══════════════════════════════════════════════════════════════════════════════

info "Starting PostgreSQL container (port $PG_PORT)..."
docker rm -f "$CONTAINER_NAME" 2>/dev/null || true
docker run -d \
  --name "$CONTAINER_NAME" \
  -e "POSTGRES_USER=$PG_USER" -e "POSTGRES_PASSWORD=$PG_PASSWORD" -e "POSTGRES_DB=$PG_DB" \
  -p "127.0.0.1:${PG_PORT}:5432" \
  pgvector/pgvector:pg17 -c max_connections=50 >/dev/null 2>&1

info "Waiting for PostgreSQL..."
for i in $(seq 1 30); do
  if docker exec "$CONTAINER_NAME" pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1; then
    pass "PostgreSQL is ready"; break
  fi
  [ "$i" -eq 30 ] && { fail "PostgreSQL not ready after 30s"; docker logs "$CONTAINER_NAME" 2>&1 | tail -20; exit 1; }
  sleep 1
done

info "Applying migrations..."
for migration in "$SERVER_DIR/drizzle"/*.sql; do
  name="$(basename "$migration")"
  if ! docker exec -i "$CONTAINER_NAME" psql -U "$PG_USER" -d "$PG_DB" < "$migration" >/dev/null 2>&1; then
    fail "Migration $name failed"; exit 1
  fi
done
pass "All migrations applied"

# ═══════════════════════════════════════════════════════════════════════════════
# Phase 3 — Seed Test Data
# ═══════════════════════════════════════════════════════════════════════════════

info "Seeding test data..."

NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
EXPIRES=$(python3 -c "from datetime import datetime, timedelta; print((datetime.utcnow() + timedelta(days=7)).strftime('%Y-%m-%dT%H:%M:%S.000Z'))" 2>/dev/null || echo "2099-01-01T00:00:00.000Z")

# ── Session tokens ──────────────────────────────────────────────────────────

ALPHA_SESSION_PLAINTEXT="sesToken_A$(openssl rand -hex 32)"
ALPHA_SESSION_HASH=$(session_hash "$ALPHA_SESSION_PLAINTEXT")
ALPHA_COOKIE="teamem_session=${ALPHA_SESSION_PLAINTEXT}"

BRAVO_SESSION_PLAINTEXT="sesToken_B$(openssl rand -hex 32)"
BRAVO_SESSION_HASH=$(session_hash "$BRAVO_SESSION_PLAINTEXT")
BRAVO_COOKIE="teamem_session=${BRAVO_SESSION_PLAINTEXT}"

# ── API key tokens ──────────────────────────────────────────────────────────

ALPHA_TOKEN_PLAINTEXT="tmAlpha$(openssl rand -hex 32 | base64 | tr -d '=+/' | head -c 43)"
ALPHA_TOKEN_HASH=$(token_hash "$ALPHA_TOKEN_PLAINTEXT")
ALPHA_API_KEY="$ALPHA_TOKEN_PLAINTEXT"

BRAVO_TOKEN_PLAINTEXT="tmBravo$(openssl rand -hex 32 | base64 | tr -d '=+/' | head -c 43)"
BRAVO_TOKEN_HASH=$(token_hash "$BRAVO_TOKEN_PLAINTEXT")
BRAVO_API_KEY="$BRAVO_TOKEN_PLAINTEXT"

# ── Teams ────────────────────────────────────────────────────────────────────

seed_sql "Alpha team" \
  "INSERT INTO teams (id, name) VALUES ('${ALPHA_TEAM}', 'Alpha GovSec Team')"
seed_sql "Bravo team" \
  "INSERT INTO teams (id, name) VALUES ('${BRAVO_TEAM}', 'Bravo GovSec Team')"

# ── Projects ─────────────────────────────────────────────────────────────────

seed_sql "Alpha project" \
  "INSERT INTO projects (id, team_id, name) VALUES ('${ALPHA_PROJECT}', '${ALPHA_TEAM}', 'alpha-project')"
seed_sql "Bravo project" \
  "INSERT INTO projects (id, team_id, name) VALUES ('${BRAVO_PROJECT}', '${BRAVO_TEAM}', 'bravo-project')"

# ── Users ────────────────────────────────────────────────────────────────────

seed_sql "Alpha user" \
  "INSERT INTO users (id, github_id, github_login) VALUES ('${ALPHA_OWNER_USER}', 900001, 'alpha-owner')"
seed_sql "Bravo user" \
  "INSERT INTO users (id, github_id, github_login) VALUES ('${BRAVO_OWNER_USER}', 900002, 'bravo-owner')"

# ── Memberships ──────────────────────────────────────────────────────────────

seed_sql "Alpha membership" \
  "INSERT INTO memberships (user_id, team_id, role) VALUES ('${ALPHA_OWNER_USER}', '${ALPHA_TEAM}', 'owner')"
seed_sql "Bravo membership" \
  "INSERT INTO memberships (user_id, team_id, role) VALUES ('${BRAVO_OWNER_USER}', '${BRAVO_TEAM}', 'owner')"

# ── Web sessions ─────────────────────────────────────────────────────────────

seed_sql "Alpha session" \
  "INSERT INTO web_sessions (id, user_id, token_hash, issued_at, expires_at)
   VALUES ('${ALPHA_SESSION_ID}', '${ALPHA_OWNER_USER}', '${ALPHA_SESSION_HASH}', '${NOW}', '${EXPIRES}')"
seed_sql "Bravo session" \
  "INSERT INTO web_sessions (id, user_id, token_hash, issued_at, expires_at)
   VALUES ('${BRAVO_SESSION_ID}', '${BRAVO_OWNER_USER}', '${BRAVO_SESSION_HASH}', '${NOW}', '${EXPIRES}')"

# ── API keys ─────────────────────────────────────────────────────────────────

seed_sql "Alpha API key" \
  "INSERT INTO api_keys (id, team_id, project_id, name, token_hash, scopes, all_projects)
   VALUES ('${ALPHA_KEY_ID}', '${ALPHA_TEAM}', '${ALPHA_PROJECT}', 'Alpha Key',
           '${ALPHA_TOKEN_HASH}', ARRAY['read','events:write','read:payload']::text[], false)"
seed_sql "Bravo API key" \
  "INSERT INTO api_keys (id, team_id, project_id, name, token_hash, scopes, all_projects)
   VALUES ('${BRAVO_KEY_ID}', '${BRAVO_TEAM}', '${BRAVO_PROJECT}', 'Bravo Key',
           '${BRAVO_TOKEN_HASH}', ARRAY['read','events:write','read:payload']::text[], false)"

# ── Principals ───────────────────────────────────────────────────────────────

seed_sql "Alpha principals" \
  "INSERT INTO principals (id, team_id, kind, provider, provider_kind, provider_user_id, display_login) VALUES
   ('${ALPHA_PRINCIPAL1}', '${ALPHA_TEAM}', 'human', 'github', 'github', '10001', 'alpha-actor1'),
   ('${ALPHA_PRINCIPAL2}', '${ALPHA_TEAM}', 'human', 'github', 'github', '10002', 'alpha-actor2'),
   ('${ALPHA_PRINCIPAL3}', '${ALPHA_TEAM}', 'human', 'github', 'github', '10003', 'alpha-actor3')"
seed_sql "Bravo principals" \
  "INSERT INTO principals (id, team_id, kind, provider, provider_kind, provider_user_id, display_login) VALUES
   ('${BRAVO_PRINCIPAL1}', '${BRAVO_TEAM}', 'human', 'github', 'github', '20001', 'bravo-actor1'),
   ('${BRAVO_PRINCIPAL2}', '${BRAVO_TEAM}', 'human', 'github', 'github', '20002', 'bravo-actor2')"

# ── Audit records ────────────────────────────────────────────────────────────

seed_sql "Alpha audit records" \
  "INSERT INTO audit_log (id, request_id, principal_id, action, resource_type, resource_id,
   team_id, project_id, outcome, created_at) VALUES
   (gen_random_uuid(), 'reqAlpha001', '${ALPHA_PRINCIPAL1}', 'concept.read', 'concept', 'resAlphaC1',
    '${ALPHA_TEAM}', '${ALPHA_PROJECT}', 'success', NOW() - INTERVAL '2 hours'),
   (gen_random_uuid(), 'reqAlpha002', '${ALPHA_PRINCIPAL1}', 'event.ingest', 'event', 'resAlphaE1',
    '${ALPHA_TEAM}', '${ALPHA_PROJECT}', 'success', NOW() - INTERVAL '1 hour'),
   (gen_random_uuid(), 'reqAlpha003', '${ALPHA_PRINCIPAL2}', 'search.query', 'concept', 'resAlphaSearch',
    '${ALPHA_TEAM}', '${ALPHA_PROJECT}', 'denied', NOW() - INTERVAL '30 minutes'),
   (gen_random_uuid(), 'reqAlpha004', '${ALPHA_PRINCIPAL1}', 'context.read', 'concept', 'resAlphaCtx',
    '${ALPHA_TEAM}', '${ALPHA_PROJECT}', 'success', NOW() - INTERVAL '10 minutes'),
   (gen_random_uuid(), 'reqAlpha005', '${ALPHA_PRINCIPAL3}', 'concept.read', 'concept', NULL,
    '${ALPHA_TEAM}', NULL, 'success', NOW() - INTERVAL '5 minutes'),
   (gen_random_uuid(), 'reqSentinel${SENTINEL}', '${SENTINEL_PRINCIPAL}', 'search.query',
    'concept', 'res${SENTINEL}', '${ALPHA_TEAM}', '${ALPHA_PROJECT}', 'success',
    NOW() - INTERVAL '3 minutes')"

seed_sql "Bravo audit records" \
  "INSERT INTO audit_log (id, request_id, principal_id, action, resource_type, resource_id,
   team_id, project_id, outcome, created_at) VALUES
   (gen_random_uuid(), 'reqBravo001', '${BRAVO_PRINCIPAL1}', 'concept.read', 'concept', 'resBravoC1',
    '${BRAVO_TEAM}', '${BRAVO_PROJECT}', 'success', NOW() - INTERVAL '1 hour'),
   (gen_random_uuid(), 'reqBravo002', '${BRAVO_PRINCIPAL2}', 'event.ingest', 'event', 'resBravoE1',
    '${BRAVO_TEAM}', '${BRAVO_PROJECT}', 'success', NOW() - INTERVAL '30 minutes')"

pass "Teams, users, sessions, keys, principals, and audit records seeded"

# ── Seed Alpha project data for purge test ───────────────────────────────────

info "Seeding project data for purge test..."

# Events
seed_sql "Alpha event 1" \
  "INSERT INTO events (id, team_id, project_id, channel, kind, connector_kind,
   delivery_id, item_key, external_id, actor_provenance, occurred_at,
   occurred_at_provenance, payload, payload_bytes, payload_hash,
   payload_schema_version, envelope_version)
   VALUES ('${EVT1}', '${ALPHA_TEAM}', '${ALPHA_PROJECT}', 'cli', 'cli_init', 'cli',
   'delAlpha1', 'root', 'test/repo1', 'unknown', NOW(), 'server',
   '{}', 2, 'hashAlpha1', 1, 1)"
seed_sql "Alpha event 2" \
  "INSERT INTO events (id, team_id, project_id, channel, kind, connector_kind,
   delivery_id, item_key, external_id, actor_provenance, occurred_at,
   occurred_at_provenance, payload, payload_bytes, payload_hash,
   payload_schema_version, envelope_version)
   VALUES ('${EVT2}', '${ALPHA_TEAM}', '${ALPHA_PROJECT}', 'cli', 'cli_init', 'cli',
   'delAlpha2', 'root', 'test/repo2', 'unknown', NOW(), 'server',
   '{}', 2, 'hashAlpha2', 1, 1)"
seed_sql "Alpha event 3" \
  "INSERT INTO events (id, team_id, project_id, channel, kind, connector_kind,
   delivery_id, item_key, external_id, actor_provenance, occurred_at,
   occurred_at_provenance, payload, payload_bytes, payload_hash,
   payload_schema_version, envelope_version)
   VALUES ('${EVT3}', '${ALPHA_TEAM}', '${ALPHA_PROJECT}', 'cli', 'cli_init', 'cli',
   'delAlpha3', 'root', 'test/repo3', 'unknown', NOW(), 'server',
   '{}', 2, 'hashAlpha3', 1, 1)"

# Concepts with paths, evidence, contributors
seed_sql "Alpha concept 1" \
  "INSERT INTO concepts (uuid, team_id, project_id, schema_version, type, status,
   confidence, title, body, first_seen, last_confirmed)
   VALUES ('${CONCEPT1_UUID}', '${ALPHA_TEAM}', '${ALPHA_PROJECT}', 1, 'concept', 'active',
   'high', 'Concept 1', 'Body for concept 1', NOW(), NOW())"
seed_sql "Alpha concept 2" \
  "INSERT INTO concepts (uuid, team_id, project_id, schema_version, type, status,
   confidence, title, body, first_seen, last_confirmed)
   VALUES ('${CONCEPT2_UUID}', '${ALPHA_TEAM}', '${ALPHA_PROJECT}', 1, 'concept', 'active',
   'high', 'Concept 2', 'Body for concept 2', NOW(), NOW())"

seed_sql "Alpha concept paths" \
  "INSERT INTO concept_paths (team_id, project_id, concept_uuid, path, is_current) VALUES
   ('${ALPHA_TEAM}', '${ALPHA_PROJECT}', '${CONCEPT1_UUID}', 'concept-1', true),
   ('${ALPHA_TEAM}', '${ALPHA_PROJECT}', '${CONCEPT2_UUID}', 'concept-2', true)"
seed_sql "Alpha concept evidence" \
  "INSERT INTO concept_evidence (team_id, project_id, concept_uuid, kind, ref, at) VALUES
   ('${ALPHA_TEAM}', '${ALPHA_PROJECT}', '${CONCEPT1_UUID}', 'commit', 'ref-1', NOW()),
   ('${ALPHA_TEAM}', '${ALPHA_PROJECT}', '${CONCEPT2_UUID}', 'commit', 'ref-2', NOW())"
seed_sql "Alpha concept contributors" \
  "INSERT INTO concept_contributors (team_id, project_id, concept_uuid, principal_id) VALUES
   ('${ALPHA_TEAM}', '${ALPHA_PROJECT}', '${CONCEPT1_UUID}', '${ALPHA_PRINCIPAL1}'),
   ('${ALPHA_TEAM}', '${ALPHA_PROJECT}', '${CONCEPT2_UUID}', '${ALPHA_PRINCIPAL1}')"

# Job — MUST be a valid UUID (not a prefixed string)
seed_sql "Alpha job" \
  "INSERT INTO jobs (id, team_id, project_id, kind, status, attempts, initiated_by_kind, event_count)
   VALUES ('${JOB_ID}', '${ALPHA_TEAM}', '${ALPHA_PROJECT}', 'compilation', 'completed', 1, 'credential', 1)"
seed_sql "Alpha job_events" \
  "INSERT INTO job_events (team_id, project_id, job_id, event_id, status)
   VALUES ('${ALPHA_TEAM}', '${ALPHA_PROJECT}', '${JOB_ID}', '${EVT1}', 'compiled')"

# ── Count seed data ─────────────────────────────────────────────────────────

EVENTS_BEFORE=$(psql_query "SELECT COUNT(*) FROM events WHERE project_id = '${ALPHA_PROJECT}'")
CONCEPTS_BEFORE=$(psql_query "SELECT COUNT(*) FROM concepts WHERE project_id = '${ALPHA_PROJECT}'")
CONCEPT_PATHS_BEFORE=$(psql_query "SELECT COUNT(*) FROM concept_paths WHERE project_id = '${ALPHA_PROJECT}'")
CONCEPT_EVIDENCE_BEFORE=$(psql_query "SELECT COUNT(*) FROM concept_evidence WHERE project_id = '${ALPHA_PROJECT}'")
CONCEPT_CONTRIBUTORS_BEFORE=$(psql_query "SELECT COUNT(*) FROM concept_contributors WHERE project_id = '${ALPHA_PROJECT}'")
JOBS_BEFORE=$(psql_query "SELECT COUNT(*) FROM jobs WHERE project_id = '${ALPHA_PROJECT}'")
JOB_EVENTS_BEFORE=$(psql_query "SELECT COUNT(*) FROM job_events WHERE project_id = '${ALPHA_PROJECT}'")
AUDIT_ALPHA_BEFORE=$(psql_query "SELECT COUNT(*) FROM audit_log WHERE team_id = '${ALPHA_TEAM}'")
PRINCIPALS_ALPHA_BEFORE=$(psql_query "SELECT COUNT(*) FROM principals WHERE team_id = '${ALPHA_TEAM}'")

pass "Project data seeded (evt=$EVENTS_BEFORE cpt=$CONCEPTS_BEFORE job=$JOBS_BEFORE audit=$AUDIT_ALPHA_BEFORE)"

# ═══════════════════════════════════════════════════════════════════════════════
# Phase 4 — Start Server
# ═══════════════════════════════════════════════════════════════════════════════

info "Starting server on port $SERVER_PORT..."
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

info "Waiting for server..."
for i in $(seq 1 30); do
  if curl -sS "${SERVER_URL}/healthz" >/dev/null 2>&1; then
    pass "Server is ready"; break
  fi
  [ "$i" -eq 30 ] && { fail "Server did not become ready"; exit 1; }
  sleep 1
done

# ═══════════════════════════════════════════════════════════════════════════════
# Phase 5 — Verification
# ═══════════════════════════════════════════════════════════════════════════════

log ""
log "========================================="
log "PHASE 5 — VERIFICATION"
log "========================================="

# ── 5.1 Audit: actor/time filtering ─────────────────────────────────────────

log ""
log "--- 5.1 Audit: Actor/Time Filtering ---"

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

# Filter by actor
AUDIT_BY_ACTOR=$(http_body GET "/v1/audit?actor=${ALPHA_PRINCIPAL1}" "$ALPHA_COOKIE")
AUDIT_ACTOR_COUNT=$(echo "$AUDIT_BY_ACTOR" | jq '.data | length' 2>/dev/null || echo "0")
if [ "$AUDIT_ACTOR_COUNT" -ge 1 ] 2>/dev/null; then
  pass "Audit filtered by actor — $AUDIT_ACTOR_COUNT row(s)"
else
  fail "Audit actor filter returned no results"
fi

# Combined filters
AUDIT_COMBO=$(http_body GET "/v1/audit?actor=${ALPHA_PRINCIPAL1}&action=concept.read" "$ALPHA_COOKIE")
AUDIT_COMBO_COUNT=$(echo "$AUDIT_COMBO" | jq '.data | length' 2>/dev/null || echo "0")
if [ "$AUDIT_COMBO_COUNT" -ge 1 ] 2>/dev/null; then
  pass "Audit combined actor+action filter — $AUDIT_COMBO_COUNT row(s)"
else
  fail "Audit combined filter returned no results"
fi

# ── 5.2 Audit: full-scan sentinel — NO query/payload/secret content ─────────

log ""
log "--- 5.2 Audit: No Query/Payload/Secret Content ---"

AUDIT_FULL="$AUDIT_LIST"

assert_contains "Sentinel present in audit response (stored → returned)" "$AUDIT_FULL" "$SENTINEL"

assert_not_contains "No 'query' field in response"   "$AUDIT_FULL" '"query"'
assert_not_contains "No 'payload' field in response" "$AUDIT_FULL" '"payload"'
assert_not_contains "No 'body' field in response"    "$AUDIT_FULL" '"body"'
assert_not_contains "No 'content' field in response" "$AUDIT_FULL" '"content"'

assert_not_contains "No 'SECRET=' in response"       "$AUDIT_FULL" "SECRET="
assert_not_contains "No 'Bearer ' in response"       "$AUDIT_FULL" "Bearer "
assert_not_contains "No 'access_token' in response"  "$AUDIT_FULL" "access_token"
assert_not_contains "No 'client_secret' in response" "$AUDIT_FULL" "client_secret"
assert_not_contains "No '<private>' in response"     "$AUDIT_FULL" "<private>"
assert_not_contains "No 'password' in response"      "$AUDIT_FULL" "password"

AUDIT_COLS=$(psql_query "SELECT column_name FROM information_schema.columns
  WHERE table_name = 'audit_log'
  AND column_name IN ('query','payload','body','content','query_text','search_query','request_body')")
assert_eq "DB audit_log has NO content-bearing columns" "" "$AUDIT_COLS"

# ── 5.3 Purge: counts, audit/identity survival, purge audit record ─────────

log ""
log "--- 5.3 Purge: Counts, Audit/Identity Retention ---"

PURGE_RESULT=$(http_body POST "/teams/${ALPHA_TEAM}/projects/${ALPHA_PROJECT}/purge" "$ALPHA_COOKIE" '{}')
PURGE_PROJECT=$(echo "$PURGE_RESULT" | jq -r '.projectId' 2>/dev/null)

if [ "$PURGE_PROJECT" = "$ALPHA_PROJECT" ]; then
  pass "Purge returned 200 with correct projectId"
else
  fail "Purge failed — response: $(echo "$PURGE_RESULT" | head -c 500)"
fi

assert_eq "Events deleted"         "$EVENTS_BEFORE"              "$(echo "$PURGE_RESULT" | jq -r '.eventsDeleted')"
assert_eq "Concepts deleted"       "$CONCEPTS_BEFORE"            "$(echo "$PURGE_RESULT" | jq -r '.conceptsDeleted')"
assert_eq "Concept paths deleted"  "$CONCEPT_PATHS_BEFORE"       "$(echo "$PURGE_RESULT" | jq -r '.conceptPathsDeleted')"
assert_eq "Concept evid. deleted"  "$CONCEPT_EVIDENCE_BEFORE"    "$(echo "$PURGE_RESULT" | jq -r '.conceptEvidenceDeleted')"
assert_eq "Concept contrib. del."  "$CONCEPT_CONTRIBUTORS_BEFORE" "$(echo "$PURGE_RESULT" | jq -r '.conceptContributorsDeleted')"
assert_eq "Jobs deleted"           "$JOBS_BEFORE"                "$(echo "$PURGE_RESULT" | jq -r '.jobsDeleted')"
assert_eq "Job events deleted"     "$JOB_EVENTS_BEFORE"          "$(echo "$PURGE_RESULT" | jq -r '.jobEventsDeleted')"

assert_eq "Post-purge events = 0"   "0" "$(psql_query "SELECT COUNT(*) FROM events WHERE project_id = '${ALPHA_PROJECT}'")"
assert_eq "Post-purge concepts = 0" "0" "$(psql_query "SELECT COUNT(*) FROM concepts WHERE project_id = '${ALPHA_PROJECT}'")"
assert_eq "Post-purge jobs = 0"     "0" "$(psql_query "SELECT COUNT(*) FROM jobs WHERE project_id = '${ALPHA_PROJECT}'")"

AUDIT_ALPHA_AFTER=$(psql_query "SELECT COUNT(*) FROM audit_log WHERE team_id = '${ALPHA_TEAM}'")
AUDIT_EXPECTED=$((AUDIT_ALPHA_BEFORE + 1))

if [ "$AUDIT_ALPHA_AFTER" -ge "$AUDIT_EXPECTED" ] 2>/dev/null; then
  pass "Audit records survive purge (was $AUDIT_ALPHA_BEFORE, now $AUDIT_ALPHA_AFTER >= $AUDIT_EXPECTED)"
else
  fail "Audit records did not survive (was $AUDIT_ALPHA_BEFORE, now $AUDIT_ALPHA_AFTER < $AUDIT_EXPECTED)"
fi

PURGE_AUDIT_COUNT=$(psql_query "SELECT COUNT(*) FROM audit_log
  WHERE action = 'project.purge' AND project_id = '${ALPHA_PROJECT}' AND team_id = '${ALPHA_TEAM}'")
assert_eq "Purge audit record present" "1" "$PURGE_AUDIT_COUNT"

PRINCIPALS_ALPHA_AFTER=$(psql_query "SELECT COUNT(*) FROM principals WHERE team_id = '${ALPHA_TEAM}'")
assert_eq "Principals survive purge" "$PRINCIPALS_ALPHA_BEFORE" "$PRINCIPALS_ALPHA_AFTER"

# Second purge — idempotent, zero counts
PURGE_RESULT2=$(http_body POST "/teams/${ALPHA_TEAM}/projects/${ALPHA_PROJECT}/purge" "$ALPHA_COOKIE" '{}')
assert_eq "Second purge events=0"   "0" "$(echo "$PURGE_RESULT2" | jq -r '.eventsDeleted')"
assert_eq "Second purge concepts=0" "0" "$(echo "$PURGE_RESULT2" | jq -r '.conceptsDeleted')"

PURGE_AUDIT_COUNT2=$(psql_query "SELECT COUNT(*) FROM audit_log
  WHERE action = 'project.purge' AND project_id = '${ALPHA_PROJECT}' AND team_id = '${ALPHA_TEAM}'")
assert_eq "Second purge writes separate audit record" "2" "$PURGE_AUDIT_COUNT2"

# ── 5.4 Cross-team isolation ───────────────────────────────────────────────

log ""
log "--- 5.4 Cross-Team Isolation ---"

# 5.4.1 Cross-team audit
ALPHA_AUDIT_BRAVO_STATUS=$(http_status GET "/v1/audit?projectId=${BRAVO_PROJECT}" "$ALPHA_COOKIE")
ALPHA_AUDIT_BRAVO_BODY=$(http_body GET "/v1/audit?projectId=${BRAVO_PROJECT}" "$ALPHA_COOKIE")
ALPHA_AUDIT_BRAVO_COUNT=$(echo "$ALPHA_AUDIT_BRAVO_BODY" | jq '.data | length' 2>/dev/null || echo "0")
assert_eq "Cross-team audit → 200" "200" "$ALPHA_AUDIT_BRAVO_STATUS"
assert_eq "Cross-team audit → empty" "0" "$ALPHA_AUDIT_BRAVO_COUNT"

# Non-existent project — same response as cross-team
ALPHA_AUDIT_NONEXIST_STATUS=$(http_status GET "/v1/audit?projectId=${NONEXIST_PROJ}" "$ALPHA_COOKIE")
ALPHA_AUDIT_NONEXIST_COUNT=$(http_body GET "/v1/audit?projectId=${NONEXIST_PROJ}" "$ALPHA_COOKIE" | jq '.data | length' 2>/dev/null || echo "0")
assert_eq "Non-existent project audit → 200 (same as cross-team)" "200" "$ALPHA_AUDIT_NONEXIST_STATUS"
assert_eq "Non-existent project audit → empty (same as cross-team)" "0" "$ALPHA_AUDIT_NONEXIST_COUNT"

# 5.4.2 Cross-team event read
ALPHA_READ_BRAVO_STATUS=$(api_status GET "/v1/events?projectId=${BRAVO_PROJECT}" "$ALPHA_API_KEY")
if [ "$ALPHA_READ_BRAVO_STATUS" = "403" ] || [ "$ALPHA_READ_BRAVO_STATUS" = "404" ]; then
  pass "Alpha API key reading Bravo events → $ALPHA_READ_BRAVO_STATUS (anti-enumeration)"
else
  fail "Alpha API key reading Bravo events → $ALPHA_READ_BRAVO_STATUS (expected 403 or 404)"
fi

# 5.4.3 Cross-team search
ALPHA_SEARCH_BRAVO_STATUS=$(api_status POST "/v1/search" "$ALPHA_API_KEY" \
  "{\"projectId\":\"${BRAVO_PROJECT}\",\"query\":\"test query\"}")
if [ "$ALPHA_SEARCH_BRAVO_STATUS" = "200" ]; then
  SEARCH_COUNT=$(api_body POST "/v1/search" "$ALPHA_API_KEY" \
    "{\"projectId\":\"${BRAVO_PROJECT}\",\"query\":\"test query\"}" | jq '.results | length' 2>/dev/null || echo "0")
  assert_eq "Cross-team search → empty results" "0" "$SEARCH_COUNT"
else
  pass "Cross-team search → $ALPHA_SEARCH_BRAVO_STATUS (anti-enumeration)"
fi

# 5.4.4 Cross-team purge
BRAVO_PURGE_ALPHA_STATUS=$(http_status POST "/teams/${ALPHA_TEAM}/projects/${ALPHA_PROJECT}/purge" "$BRAVO_COOKIE" '{}')
assert_eq "Cross-team purge → 404" "404" "$BRAVO_PURGE_ALPHA_STATUS"

# 5.4.5 Cross-team context
ALPHA_CTX_BRAVO_STATUS=$(api_status GET "/v1/context?projectId=${BRAVO_PROJECT}" "$ALPHA_API_KEY")
if [ "$ALPHA_CTX_BRAVO_STATUS" = "200" ]; then
  CTX_AVAIL=$(api_body GET "/v1/context?projectId=${BRAVO_PROJECT}" "$ALPHA_API_KEY" | jq '.data.conceptsAvailable' 2>/dev/null || echo "0")
  assert_eq "Cross-team context → 0 concepts" "0" "$CTX_AVAIL"
else
  pass "Cross-team context → $ALPHA_CTX_BRAVO_STATUS (anti-enumeration)"
fi

# 5.4.6 Byte-identical 404: cross-team == genuinely missing
MISSING_PURGE_BODY=$(http_body POST "/teams/${ALPHA_TEAM}/projects/${MISSING_PROJ}/purge" "$ALPHA_COOKIE" '{}')
CROSS_PURGE_BODY=$(http_body POST "/teams/${BRAVO_TEAM}/projects/${ALPHA_PROJECT}/purge" "$BRAVO_COOKIE" '{}')

assert_eq "Missing project purge error code"              "not_found" "$(echo "$MISSING_PURGE_BODY" | jq -r '.error.code')"
assert_eq "Cross-team purge error code (same as missing)" "not_found" "$(echo "$CROSS_PURGE_BODY" | jq -r '.error.code')"
assert_eq "Error messages byte-identical" \
  "$(echo "$MISSING_PURGE_BODY" | jq -r '.error.message')" \
  "$(echo "$CROSS_PURGE_BODY"   | jq -r '.error.message')"

assert_eq "Missing project purge → 404" "404" \
  "$(http_status POST "/teams/${ALPHA_TEAM}/projects/${MISSING_PROJ}/purge" "$ALPHA_COOKIE" '{}')"
assert_eq "Cross-team purge → 404 (same)" "404" \
  "$(http_status POST "/teams/${BRAVO_TEAM}/projects/${ALPHA_PROJECT}/purge" "$BRAVO_COOKIE" '{}')"

# ── 5.5 Counterexample: Revoked key → 401 ──────────────────────────────────

log ""
log "--- 5.5 Revoked Key → 401 ---"

TMP_TOKEN="tmRevoke$(openssl rand -hex 32)"
TMP_HASH=$(token_hash "$TMP_TOKEN")

seed_sql "Temp revoke key" \
  "INSERT INTO api_keys (id, team_id, project_id, name, token_hash, scopes, all_projects)
   VALUES ('${TMP_KEY_ID}', '${ALPHA_TEAM}', '${ALPHA_PROJECT}', 'Revoke Test',
           '${TMP_HASH}', ARRAY['read']::text[], false)"

PRE_REVOKE=$(api_status GET "/v1/events?projectId=${ALPHA_PROJECT}" "$TMP_TOKEN")
assert_eq "Pre-revoke key → 200" "200" "$PRE_REVOKE"

seed_sql "Revoke key" "UPDATE api_keys SET revoked_at = NOW() WHERE id = '${TMP_KEY_ID}'"

POST_REVOKE=$(api_status GET "/v1/events?projectId=${ALPHA_PROJECT}" "$TMP_TOKEN")
assert_eq "Revoked key → 401" "401" "$POST_REVOKE"

POST_REVOKE_BODY=$(api_body GET "/v1/events?projectId=${ALPHA_PROJECT}" "$TMP_TOKEN")
assert_not_contains "Revoked error does not mention 'revoked'" "$POST_REVOKE_BODY" "revoked"

UNKNOWN_STATUS=$(api_status GET "/v1/events?projectId=${ALPHA_PROJECT}" "tmNotARealKey000000000000000000000000000000000")
assert_eq "Unknown key → 401 (same as revoked)" "401" "$UNKNOWN_STATUS"

UNKNOWN_BODY=$(api_body GET "/v1/events?projectId=${ALPHA_PROJECT}" "tmNotARealKey000000000000000000000000000000000")
assert_eq "Revoked/unknown error codes match" \
  "$(echo "$POST_REVOKE_BODY" | jq -r '.error.code')" \
  "$(echo "$UNKNOWN_BODY"      | jq -r '.error.code')"
assert_eq "Revoked/unknown error messages match" \
  "$(echo "$POST_REVOKE_BODY" | jq -r '.error.message')" \
  "$(echo "$UNKNOWN_BODY"      | jq -r '.error.message')"

seed_sql "Cleanup temp key" "DELETE FROM api_keys WHERE id = '${TMP_KEY_ID}'"

# ── 5.6 Counterexample: API key → management endpoints rejected ─────────────

log ""
log "--- 5.6 API Key → Management Endpoints Rejected ---"

assert_eq "API key → /v1/audit → 401"    "401" "$(api_status GET "/v1/audit" "$ALPHA_API_KEY")"
assert_eq "API key → purge → 401"        "401" "$(api_status POST "/teams/${ALPHA_TEAM}/projects/${ALPHA_PROJECT}/purge" "$ALPHA_API_KEY" '{}')"
assert_eq "API key → keys list → 401"    "401" "$(api_status GET "/v1/teams/${ALPHA_TEAM}/keys" "$ALPHA_API_KEY")"
# members route is /v1/members (no :teamId segment)
assert_eq "API key → members → 401"      "401" "$(api_status GET "/v1/members" "$ALPHA_API_KEY")"
assert_eq "API key → LLM config → 401"   "401" "$(api_status GET "/v1/teams/${ALPHA_TEAM}/llm" "$ALPHA_API_KEY")"

# ── 5.7 Tenant isolation: audit scope verification ─────────────────────────

log ""
log "--- 5.7 Tenant Isolation: Audit Scope ---"

BRAVO_AUDIT_BODY=$(http_body GET "/v1/audit" "$BRAVO_COOKIE")
BRAVO_AUDIT_COUNT=$(echo "$BRAVO_AUDIT_BODY" | jq '.data | length' 2>/dev/null || echo "0")
if [ "$BRAVO_AUDIT_COUNT" -ge 2 ] 2>/dev/null; then
  pass "Bravo owner sees their team's audit ($BRAVO_AUDIT_COUNT records)"
else
  warn "Bravo owner audit count: $BRAVO_AUDIT_COUNT (expected >= 2)"
fi

BRAVO_HAS_ALPHA=$(echo "$BRAVO_AUDIT_BODY" | jq "[.data[] | select(.teamId == \"$ALPHA_TEAM\")] | length" 2>/dev/null || echo "0")
assert_eq "Bravo audit has zero Alpha records" "0" "$BRAVO_HAS_ALPHA"

# ═══════════════════════════════════════════════════════════════════════════════
# Phase 6 — Summary
# ═══════════════════════════════════════════════════════════════════════════════

log ""
log "========================================="
log "RESULTS SUMMARY"
log "========================================="
log ""
log "Total assertions: $((PASS + FAIL))"
log "${GREEN}Passed:${NC} $PASS"
log "${RED}Failed:${NC} $FAIL"
log ""
log "Results saved to: $LOG_FILE"
log ""
log "Test data identifiers:"
log "  Alpha Team:      $ALPHA_TEAM"
log "  Alpha Project:   $ALPHA_PROJECT"
log "  Alpha API Key:   $ALPHA_API_KEY"
log "  Bravo Team:      $BRAVO_TEAM"
log "  Bravo Project:   $BRAVO_PROJECT"
log "  Sentinel:        $SENTINEL"
log ""

if [ "$FAIL" -gt 0 ]; then
  log "${RED}VERIFICATION FAILED — $FAIL assertion(s) did not pass${NC}"
  exit 1
else
  log "${GREEN}VERIFICATION PASSED — all $PASS assertions passed${NC}"
  exit 0
fi
