#!/usr/bin/env bash
# M3-QA-01 OKF export round-trip live acceptance driver (DUA-260).
#
# Reproducible acceptance of "memory you can take with you": portal export →
# real okf-skills validator passes → push to a REAL GitHub repo → confirm
# markdown renders, `teamem://` links are clickable relative links, and
# frontmatter preserves the canonical UUID (round-trip). Negative cases
# (missing inline-link target, cross-team export indistinguishable, no
# payload leakage) are asserted by the helper script.
#
# This is READ-ONLY acceptance: no production code is changed. It uses the
# server's OWN bootstrap + repositories + renderer to seed a representative
# project and render the real bundle, then the REAL okf-skills validator to
# check it, then pushes to a real (throwaway) GitHub repo with `gh`.
#
# Prerequisites: docker (Postgres up + migrated), uv (okf-skills runtime),
# gh (authenticated, `repo` scope), jq, node + pnpm (deps installed).
#
# Usage:
#   export TEST_DATABASE_URL='postgres://...'   # required
#   ./scripts/m3-okf-roundtrip.sh
#
# Optional env vars:
#   M3_OKF_RESULTS_DIR     results directory (default scripts/m3-okf-roundtrip-results)
#   M3_OKF_GITHUB_OWNER    target GitHub owner (default: gh auth account)
#   M3_OKF_REPO_PRIVATE    set to 1 to create the throwaway repo as private
#   SKIP_GH_PUSH           set to 1 to skip pushing to GitHub (report as not verified)
#
# Exit codes: 0 = all checks passed; 1 = a check failed; 2 = the whole stack
# could not be brought up.

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

FAILED=0

# ── Prerequisites ──────────────────────────────────────────────────────────
info 'Phase 0 — prerequisites'
for cmd in docker uv gh jq node pnpm; do
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
info 'Phase 1 — running live acceptance helper (seed → render → real okf-skills validator → negative cases)'
if ! TEST_DATABASE_URL="$TEST_DATABASE_URL" M3_OKF_RESULTS_DIR="$RESULTS_ROOT" \
     pnpm --filter @teamem/server exec tsx "$REPO_ROOT/scripts/m3-okf-roundtrip.ts"; then
  fail 'live acceptance helper'
  # keep going so any produced evidence is still inspected
fi

LATEST="$(ls -1dt "$RESULTS_ROOT"/run-* 2>/dev/null | head -1 || true)"
if [ -z "$LATEST" ]; then
  fail 'acceptance run directory produced'
  exit 1
fi
BUNDLE_DIR="$LATEST/bundle"
pass "bundle rendered at $BUNDLE_DIR"

# ── Phase 2 — push the bundle to a REAL GitHub repo ────────────────────────
info 'Phase 2 — push bundle to a real GitHub repo'
if [ "${SKIP_GH_PUSH:-0}" = "1" ] || ! gh auth status >/dev/null 2>&1; then
  warn 'GitHub push skipped or gh unauthenticated — markdown render / clickable-link / GitHub rendering = NOT VERIFIED'
else
  OWNER="${M3_OKF_GITHUB_OWNER:-$(gh api user --jq .login)}"
  REPO_NAME="teamem-m3-okf-roundtrip-$(date +%Y%m%d%H%M%S)"
  VISIBILITY="--public"
  if [ "${M3_OKF_REPO_PRIVATE:-0}" = "1" ]; then VISIBILITY="--private"; fi
  # Use the bundle directory as its own throwaway git repo, then push it.
  (
    cd "$BUNDLE_DIR"
    rm -rf .git
    git init -q -b main
    git add -A
    git -c user.name='teamem QA' -c user.email='qa@teamem.local' commit -q -m "M3-QA-01 OKF export round-trip bundle"
  )
  if ! gh repo create "$OWNER/$REPO_NAME" $VISIBILITY --source "$BUNDLE_DIR" --push \
       --description 'M3-QA-01: OKF export round-trip acceptance (portal export → okf-skills validator → GitHub render)'; then
    fail "push bundle to real GitHub repo ($OWNER/$REPO_NAME)"
    FAILED=1
  else
    REPO_URL="https://github.com/$OWNER/$REPO_NAME"
    pass "pushed bundle to real GitHub repo $REPO_URL"
    info "GitHub rendering evidence (markdown renders + relative links clickable):"
    info "  index.md  → $REPO_URL/blob/main/index.md"
    info "  decision  → $REPO_URL/blob/main/$(cd "$BUNDLE_DIR" && ls decisions 2>/dev/null | head -1)"
    info "  gotcha    → $REPO_URL/blob/main/$(cd "$BUNDLE_DIR" && ls gotchas 2>/dev/null | head -1)"
  fi
fi

# ── Phase 3 — summary ──────────────────────────────────────────────────────
info 'Phase 3 — evidence summary'
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
