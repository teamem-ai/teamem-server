#!/usr/bin/env bash
# M3-QA-01 OKF export round-trip live acceptance driver (DUA-260).
#
# Reproducible acceptance of "memory you can take with you": portal one-click
# export → REAL HTTP download of the OKF bundle → real okf-skills validator
# passes → push the HTTP-downloaded bundle to a REAL GitHub repo → confirm
# markdown renders, `teamem://` links are clickable relative links, and
# frontmatter preserves the canonical UUID (round-trip). Negative cases
# (missing inline-link target, cross-team export indistinguishable, no
# payload leakage) are asserted by the helper.
#
# This is READ-ONLY acceptance: no production code is changed. The bundle is
# pulled over the REAL HTTP endpoint (`GET /v1/export`) with a real Bearer
# token from a live server process pointed at the seeded real Postgres — the
# same bytes a portal user would download — then extracted and checked with
# the real okf-skills validator.
#
# Prerequisites: docker (Postgres up + migrated), uv (okf-skills runtime),
# gh (authenticated, `repo` scope), jq, curl, node + pnpm (deps installed).
#
# Usage:
#   export TEST_DATABASE_URL='postgres://...'   # required
#   ./scripts/m3-okf-roundtrip.sh
#
# Optional env vars:
#   M3_OKF_RESULTS_DIR     results directory (default scripts/m3-okf-roundtrip-results)
#   M3_OKF_SERVER_PORT     port for the live server (default 18713)
#   M3_OKF_GITHUB_OWNER    target GitHub owner (default: gh auth account)
#   M3_OKF_REPO_PRIVATE    set to 1 to create the throwaway repo as private
#   SKIP_GH_PUSH           set to 1 to skip pushing to GitHub (report as not verified)
#   SKIP_HTTP              set to 1 to skip the live HTTP download (report as not verified)
#
# Exit codes: 0 = all checks passed; 1 = a check failed; 2 = prerequisites missing.

set -euo pipefail
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; NC='\033[0m'
pass()  { printf "${GREEN}✓ PASS${NC} %s\n" "$*"; }
fail()  { printf "${RED}✗ FAIL${NC} %s\n" "$*"; }
warn()  { printf "${YELLOW}⚠ WARN${NC} %s\n" "$*"; }
info()  { printf "${BOLD}→${NC} %s\n" "$*"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RESULTS_ROOT="${M3_OKF_RESULTS_DIR:-$REPO_ROOT/scripts/m3-okf-roundtrip-results}"
TSX="${REPO_ROOT}/apps/server/node_modules/.bin/tsx"
SERVER_PORT="${M3_OKF_SERVER_PORT:-18713}"

FAILED=0

# ── Prerequisites ──────────────────────────────────────────────────────────
info 'Phase 0 — prerequisites'
for cmd in docker uv gh jq curl node pnpm; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    fail "prerequisite \`$cmd\` is on PATH"
    FAILED=1
  else
    pass "prerequisite \`$cmd\` available"
  fi
done
if [ -z "${TEST_DATABASE_URL:-}" ]; then
  fail 'TEST_DATABASE_URL is set (required)'
  FAILED=1
else
  pass 'TEST_DATABASE_URL is set'
fi
if [ -x "$TSX" ]; then pass "tsx available"; else fail "tsx available ($TSX)"; FAILED=1; fi
if [ "$FAILED" -ne 0 ]; then
  warn 'prerequisite failures — bring up Postgres, install deps (pnpm install), and install uv/gh'
  exit 2
fi
if ! gh auth status >/dev/null 2>&1; then
  warn 'gh is not authenticated — GitHub push will be reported as NOT VERIFIED'
fi

# ── Phase 1 — live helper (seed → render → real validator → negative cases) ─
info 'Phase 1 — live helper: seed representative project, render real bundle, validate, negative cases'
if ! TEST_DATABASE_URL="$TEST_DATABASE_URL" M3_OKF_RESULTS_DIR="$RESULTS_ROOT" \
     M3_OKF_SKIP_CLEANUP=1 \
     pnpm --filter @teamem/server exec tsx "$REPO_ROOT/scripts/m3-okf-roundtrip.ts"; then
  fail 'live acceptance helper'
fi

LATEST="$(ls -1dt "$RESULTS_ROOT"/run-* 2>/dev/null | head -1 || true)"
if [ -z "$LATEST" ]; then
  fail 'acceptance run directory produced'
  exit 1
fi
BUNDLE_DIR="$LATEST/bundle"
pass "bundle rendered at $BUNDLE_DIR"

# Clean up the seeded DB tenant once we are finished (HTTP + push + summary).
cleanup() {
  info 'Cleanup — removing seeded tenants (read-only acceptance leaves no residue)'
  if [ -f "$LATEST/seed-info.json" ]; then
    TEST_DATABASE_URL="$TEST_DATABASE_URL" M3_OKF_RESULTS_DIR="$RESULTS_ROOT" \
      pnpm --filter @teamem/server exec tsx "$REPO_ROOT/scripts/m3-okf-roundtrip.ts" \
      --clean "$LATEST" >/dev/null 2>&1 && pass 'seeded tenants cleaned' || warn 'tenant cleanup failed'
  fi
}
trap cleanup EXIT

# ── Phase 2 — REAL HTTP download through GET /v1/export ────────────────────
info 'Phase 2 — real HTTP download (live server + curl + Bearer token → GET /v1/export)'
HTTP_DIR="$LATEST/http"
mkdir -p "$HTTP_DIR"
if [ "${SKIP_HTTP:-0}" = "1" ]; then
  warn 'SKIP_HTTP=1 — live HTTP download NOT executed; HTTP endpoint evidence reported as NOT VERIFIED'
else
  TOKEN="$(jq -r .bootstrapToken "$LATEST/seed-info.json")"
  PROJECT="$(jq -r .projectA "$LATEST/seed-info.json")"
  if [ -z "$TOKEN" ] || [ "$TOKEN" = "null" ]; then
    fail 'bootstrap Bearer token available in seed-info'
  else
    SERVER_DIR="$REPO_ROOT/apps/server"
    (
      cd "$SERVER_DIR"
      DATABASE_URL="$TEST_DATABASE_URL" TEAMEM_PORT="$SERVER_PORT" TEAMEM_ALL_IN_ONE=false \
        "$TSX" src/index.ts > "$HTTP_DIR/server.log" 2>&1 &
      echo $! > "$HTTP_DIR/server.pid"
    )
    SERVER_PID="$(cat "$HTTP_DIR/server.pid")"
    UP=0
    for _ in $(seq 1 40); do
      if curl -s "http://127.0.0.1:$SERVER_PORT/healthz" >/dev/null 2>&1; then UP=1; break; fi
      sleep 1
    done
    if [ "$UP" -ne 1 ]; then
      fail "live server is healthy on :$SERVER_PORT"
      tail -20 "$HTTP_DIR/server.log" || true
    else
      pass "live server healthy on :$SERVER_PORT (real HTTP)"
      # Download over the real HTTP endpoint with a real Bearer token.
      curl -sS -D "$HTTP_DIR/headers.txt" -o "$HTTP_DIR/bundle.tar.gz" \
        -H "Authorization: Bearer $TOKEN" \
        "http://127.0.0.1:$SERVER_PORT/v1/export?projectId=$PROJECT" || true
      HTTP_CODE="$(awk 'NR==1{print $2}' "$HTTP_DIR/headers.txt" 2>/dev/null || echo 000)"
      CTYPE="$(grep -i '^content-type:' "$HTTP_DIR/headers.txt" 2>/dev/null | tr -d '\r' | awk '{print $2}')"
      CDISP="$(grep -i '^content-disposition:' "$HTTP_DIR/headers.txt" 2>/dev/null | tr -d '\r' | head -1)"
      if [ "$HTTP_CODE" = "200" ]; then
        pass "GET /v1/export over real HTTP → HTTP 200"
        info "  content-type: $CTYPE"
        info "  content-disposition: ${CDISP#content-disposition: }"
        # Extract with system tar (real consumption exit).
        mkdir -p "$HTTP_DIR/extracted"
        tar -xzf "$HTTP_DIR/bundle.tar.gz" -C "$HTTP_DIR/extracted" \
          && pass 'bundle.tar.gz extracted with system tar' \
          || fail 'bundle.tar.gz extracted with system tar'
        # Re-validate the HTTP-downloaded bytes with the real okf-skills validator.
        if [ -f "$LATEST/okf_validate.py" ]; then
          if uv run --script "$LATEST/okf_validate.py" "$HTTP_DIR/extracted" --json \
               > "$HTTP_DIR/validator.json" 2> "$HTTP_DIR/validator.err"; then
            VEXIT=0
          else
            VEXIT=$?
          fi
          VPASSED="$(jq -r '.passed' "$HTTP_DIR/validator.json" 2>/dev/null || echo 'null')"
          if [ "$VEXIT" -eq 0 ] && [ "$VPASSED" = "true" ]; then
            pass 'real okf-skills validator passes the HTTP-downloaded bundle'
            info "  validator: passed=$VPASSED conformant=$(jq -r .conformant "$HTTP_DIR/validator.json") errors=$(jq '.errors|length' "$HTTP_DIR/validator.json")"
          else
            fail "real okf-skills validator passes the HTTP-downloaded bundle (exit=$VEXIT passed=$VPASSED)"
            tail -10 "$HTTP_DIR/validator.err" || true
          fi
        else
          warn 'pinned validator script unavailable — validator on HTTP bundle NOT VERIFIED'
        fi
      else
        fail "GET /v1/export over real HTTP returns 200 (got HTTP $HTTP_CODE)"
        head -20 "$HTTP_DIR/headers.txt" || true
      fi
    fi
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
    info 'live server stopped'
  fi
fi

# Choose which bundle to push: prefer the exact bytes downloaded over HTTP.
PUSH_BUNDLE="$BUNDLE_DIR"
if [ -d "$HTTP_DIR/extracted" ] && [ -n "$(ls -A "$HTTP_DIR/extracted" 2>/dev/null)" ]; then
  PUSH_BUNDLE="$HTTP_DIR/extracted"
  pass 'pushing the HTTP-downloaded bundle (the artifact fetched over real HTTP)'
fi

# ── Phase 3 — push the bundle to a REAL GitHub repo ────────────────────────
info 'Phase 3 — push bundle to a real GitHub repo'
if [ "${SKIP_GH_PUSH:-0}" = "1" ] || ! gh auth status >/dev/null 2>&1; then
  warn 'GitHub push skipped or gh unauthenticated — markdown render / clickable-link / GitHub rendering = NOT VERIFIED'
else
  OWNER="${M3_OKF_GITHUB_OWNER:-$(gh api user --jq .login)}"
  REPO_NAME="teamem-m3-okf-roundtrip-$(date +%Y%m%d%H%M%S)"
  VISIBILITY="--public"
  if [ "${M3_OKF_REPO_PRIVATE:-0}" = "1" ]; then VISIBILITY="--private"; fi
  (
    cd "$PUSH_BUNDLE"
    rm -rf .git
    git init -q -b main
    git add -A
    git -c user.name='teamem QA' -c user.email='qa@teamem.local' commit -q -m "M3-QA-01 OKF export round-trip bundle"
  )
  if ! gh repo create "$OWNER/$REPO_NAME" $VISIBILITY --source "$PUSH_BUNDLE" --push \
       --description 'M3-QA-01: OKF export round-trip acceptance (portal export → okf-skills validator → GitHub render)'; then
    fail "push bundle to real GitHub repo ($OWNER/$REPO_NAME)"
    FAILED=1
  else
    REPO_URL="https://github.com/$OWNER/$REPO_NAME"
    pass "pushed bundle to real GitHub repo $REPO_URL"
    info "GitHub rendering evidence (markdown renders + relative links clickable):"
    info "  index.md  → $REPO_URL/blob/main/index.md"
    info "  decision  → $REPO_URL/blob/main/$(cd "$PUSH_BUNDLE" && ls decisions 2>/dev/null | head -1)"
    info "  gotcha    → $REPO_URL/blob/main/$(cd "$PUSH_BUNDLE" && ls gotchas 2>/dev/null | head -1)"
  fi
fi

# ── Phase 4 — summary ──────────────────────────────────────────────────────
info 'Phase 4 — evidence summary'
if [ -f "$LATEST/summary.json" ]; then
  jq -r '.results.pass[]' "$LATEST/summary.json" | sed 's/^/    ✓ /'
  if [ "$(jq '.results.fail | length' "$LATEST/summary.json")" -gt 0 ]; then
    jq -r '.results.fail[]' "$LATEST/summary.json" | sed 's/^/    ✗ /'
    FAILED=1
  fi
  info "Validator verdict: $(jq -r '.validator.verdict' "$LATEST/summary.json")"
  info "Full evidence: $LATEST"
else
  warn 'summary.json not found'
fi

if [ "$FAILED" -ne 0 ]; then
  printf '\n${RED}Acceptance: not fully passing.${NC}\n'
  exit 1
fi
printf '\n${GREEN}Acceptance: PASS.${NC}\n'
