#!/usr/bin/env bash
# M2-AUTH-02 Integration Test Runner
#
# Starts a throwaway Postgres container, applies all migrations, and runs
# the GitHub OAuth auth integration tests against real PostgreSQL.
#
# Prerequisites: docker, pnpm
#
# Usage:
#   ./scripts/test-auth-integration.sh
#
# Environment variables (all optional):
#   TEAMEM_TEST_PG_PASSWORD  — Postgres password (default: testpass_ci)
#   TEAMEM_TEST_PG_PORT      — Postgres host port  (default: 54399)
#
# The script cleans up the container after the test run.

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; BOLD='\033[1m'; NC='\033[0m'
pass()  { printf "${GREEN}✓ PASS${NC} %s\n" "$*"; }
fail()  { printf "${RED}✗ FAIL${NC} %s\n" "$*"; }
info()  { printf "${BOLD}→${NC} %s\n" "$*"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVER_DIR="$REPO_ROOT/apps/server"

PG_PASSWORD="${TEAMEM_TEST_PG_PASSWORD:-testpass_ci}"
PG_PORT="${TEAMEM_TEST_PG_PORT:-54399}"
PG_USER="teamem"
PG_DB="teamem"
CONTAINER_NAME="teamem-auth-test-pg"

TEST_DATABASE_URL="postgres://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/${PG_DB}"

cleanup() {
  info "Cleaning up Postgres container..."
  docker rm -f "$CONTAINER_NAME" 2>/dev/null || true
}

trap cleanup EXIT

# ── Check prerequisites ─────────────────────────────────────────────────────

info "M2-AUTH-02 Integration Test Runner"
info "==================================="

for cmd in docker pnpm; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    fail "Missing required command: $cmd"
    exit 1
  fi
done

# ── Start Postgres ──────────────────────────────────────────────────────────

info "Starting throwaway Postgres container on port $PG_PORT..."
docker rm -f "$CONTAINER_NAME" 2>/dev/null || true

docker run -d \
  --name "$CONTAINER_NAME" \
  -e "POSTGRES_USER=$PG_USER" \
  -e "POSTGRES_PASSWORD=$PG_PASSWORD" \
  -e "POSTGRES_DB=$PG_DB" \
  -p "127.0.0.1:${PG_PORT}:5432" \
  pgvector/pgvector:pg17 \
  -c max_connections=50 \
  2>&1

# Wait for Postgres to be ready.
info "Waiting for Postgres to be ready..."
for i in $(seq 1 30); do
  if docker exec "$CONTAINER_NAME" pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1; then
    pass "Postgres is ready"
    break
  fi
  if [[ $i -eq 30 ]]; then
    fail "Postgres did not become ready within 30s"
    docker logs "$CONTAINER_NAME" 2>&1 | tail -20
    exit 1
  fi
  sleep 1
done

# ── Apply migrations ────────────────────────────────────────────────────────

info "Applying database migrations..."
for migration in "$SERVER_DIR/drizzle"/*.sql; do
  info "  Running $(basename "$migration")..."
  if ! docker exec -i "$CONTAINER_NAME" psql \
    -U "$PG_USER" -d "$PG_DB" \
    < "$migration" >/dev/null 2>&1; then
    fail "Migration $(basename "$migration") failed"
    exit 1
  fi
done
pass "All migrations applied"

# ── Run integration tests ───────────────────────────────────────────────────

info "Running M2-AUTH-02 integration tests..."
info ""
info "Test database: postgres://${PG_USER}:***@127.0.0.1:${PG_PORT}/${PG_DB}"
info ""

cd "$SERVER_DIR"

TEST_DATABASE_URL="$TEST_DATABASE_URL" \
  npx vitest run \
    --config vitest.integration.config.ts \
    src/http/routes/auth.integration.test.ts \
    2>&1

TEST_EXIT=$?

echo ""
if [[ $TEST_EXIT -eq 0 ]]; then
  pass "All auth integration tests passed against real PostgreSQL"
else
  fail "Auth integration tests failed (exit code: $TEST_EXIT)"
fi

exit $TEST_EXIT
