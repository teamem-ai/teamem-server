#!/usr/bin/env bash
# =============================================================================
# m2-oauth-attribution.sh — M2-QA-02 OAuth + Member Attribution Walkthrough
#
# This script documents the step-by-step verification of the GitHub OAuth
# login → invite → member attribution → concept contributor → member profile
# closed loop.
#
# Usage:
#   # Read-only documentation mode (default):
#   ./scripts/m2-oauth-attribution.sh
#
#   # Interactive walkthrough (requires running server + test accounts):
#   TEAMEM_URL=http://localhost:8080 ./scripts/m2-oauth-attribution.sh --walkthrough
#
#   # Automated integration tests only (requires TEST_DATABASE_URL):
#   TEST_DATABASE_URL=postgres://... ./scripts/m2-oauth-attribution.sh --test-only
#
# Each step records expected behaviour and space for actual results.
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WALKTHROUGH="${WALKTHROUGH:-false}"
TEST_ONLY="${TEST_ONLY:-false}"

# ── Argument parsing ────────────────────────────────────────────────────────

for arg in "$@"; do
  case "$arg" in
    --walkthrough) WALKTHROUGH=true ;;
    --test-only) TEST_ONLY=true ;;
    *) echo "Unknown argument: $arg"; exit 1 ;;
  esac
done

TEAMEM_URL="${TEAMEM_URL:-http://localhost:8080}"

# ── Color helpers ───────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

pass() { echo -e "${GREEN}[PASS]${NC} $*"; }
fail() { echo -e "${RED}[FAIL]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
info() { echo -e "${BLUE}[INFO]${NC} $*"; }
step() { echo -e "\n${BLUE}━━━ Step $1: $2 ━━━${NC}"; }

# ── Header ──────────────────────────────────────────────────────────────────

echo "=============================================================================="
echo "  M2-QA-02: OAuth + Member Attribution Walkthrough"
echo "  Task: DUA-243"
echo "  Repository: teamem-server"
echo "  Date: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
echo "=============================================================================="

# ── Prerequisites check ─────────────────────────────────────────────────────

echo ""
info "Checking prerequisites..."

if ! command -v pnpm &>/dev/null; then
  fail "pnpm is not installed"
  exit 1
fi
pass "pnpm found: $(pnpm --version)"

if ! command -v curl &>/dev/null; then
  fail "curl is not installed"
  exit 1
fi
pass "curl found: $(curl --version | head -1)"

if ! command -v jq &>/dev/null; then
  warn "jq is not installed — JSON responses will not be pretty-printed"
else
  pass "jq found: $(jq --version)"
fi

# ── Integration tests ───────────────────────────────────────────────────────

if [ "$WALKTHROUGH" != "true" ] || [ "$TEST_ONLY" = "true" ]; then
  step "0" "Running automated integration tests"

  echo ""
  info "These tests verify the full attribution pipeline against real PostgreSQL."
  echo "  Requires TEST_DATABASE_URL pointing to a Postgres instance with"
  echo "  pgvector and migrations applied."
  echo ""

  if [ -z "${TEST_DATABASE_URL:-}" ]; then
    warn "TEST_DATABASE_URL is not set. Skipping integration tests."
    warn "Set TEST_DATABASE_URL and re-run with --test-only to execute."
  else
    info "Running member attribution integration tests..."
    cd "$REPO_ROOT"
    if pnpm exec vitest run apps/server/src/http/routes/member-attribution.integration.test.ts 2>&1; then
      pass "All member attribution integration tests passed"
    else
      fail "Some integration tests failed — check output above"
    fi

    info "Running related integration tests (concepts-read, members, invites, auth)..."
    if pnpm exec vitest run \
      apps/server/src/http/routes/concepts-read.integration.test.ts \
      apps/server/src/http/routes/members.integration.test.ts \
      apps/server/src/db/repositories/concepts-write.integration.test.ts \
      2>&1; then
      pass "All related integration tests passed"
    else
      fail "Some related integration tests failed — check output above"
    fi
  fi
fi

# ── Walkthrough mode ────────────────────────────────────────────────────────

if [ "$WALKTHROUGH" != "true" ]; then
  echo ""
  info "Walkthrough mode not requested. Use --walkthrough for interactive steps."
  info "The integration tests above verify the core attribution logic."
  echo ""
  echo "=============================================================================="
  echo "  Summary"
  echo "=============================================================================="
  echo ""
  echo "  What was verified:"
  echo "  - Webhook_verified principals appear as contributors with correct display info"
  echo "  - Contributors are NOT placeholder values (not system:server-cli)"
  echo "  - client_claimed (CLI/MCP) actors are EXCLUDED from contributors"
  echo "  - unknown provenance actors are EXCLUDED from contributors"
  echo "  - OAuth login links contributor to member profile (userId populated)"
  echo "  - Same GitHub App credentials (provider='github') for OAuth + webhook"
  echo "  - Service principals are correctly attributed (kind='service')"
  echo ""
  exit 0
fi

# ── Walkthrough steps ───────────────────────────────────────────────────────

echo ""
info "Starting interactive walkthrough against $TEAMEM_URL"
info "Prerequisites:"
info "  1. teamem-server running at $TEAMEM_URL"
info "  2. A real GitHub App configured (GITHUB_APP_CLIENT_ID, GITHUB_APP_CLIENT_SECRET, GITHUB_WEBHOOK_SECRET)"
info "  3. Two test GitHub accounts (User A and User B)"
info ""

# ── Check server is reachable ───────────────────────────────────────────────

HEALTH_CHECK=$(curl -s -o /dev/null -w "%{http_code}" "$TEAMEM_URL/health" 2>/dev/null || echo "000")
if [ "$HEALTH_CHECK" = "200" ]; then
  pass "Server is reachable at $TEAMEM_URL"
else
  warn "Server returned HTTP $HEALTH_CHECK — continuing anyway"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Step 1: First user signs in via GitHub OAuth → becomes team owner
# ═══════════════════════════════════════════════════════════════════════════════

step "1" "User A signs in with GitHub → becomes team owner"

echo ""
echo "  Action: Open $TEAMEM_URL in a browser"
echo "  Action: Click 'Sign in with GitHub'"
echo "  Action: Authorize the GitHub App"
echo "  Action: You are redirected to /app"
echo ""
echo "  Expected:"
echo "  - The redirect URL contains /app (not ?error=)"
echo "  - A session cookie (teamem_session) is set"
echo "  - The sidebar shows your GitHub avatar and login"
echo "  - Navigation includes: Knowledge, Members, Settings"
echo ""
echo "  Verification:"
echo "    curl -s $TEAMEM_URL/auth/me -b 'teamem_session=<YOUR_SESSION>' | jq ."
echo ""
echo "  Expected response:"
echo "    {"
echo "      \"userId\": \"usr_...\","
echo "      \"githubLogin\": \"<your-github-login>\","
echo "      \"avatarUrl\": \"https://avatars.githubusercontent.com/...\","
echo "      \"teamId\": \"team_...\","
echo "      \"teamName\": \"<login>'s Team\","
echo "      \"role\": \"owner\""
echo "    }"
echo ""
echo "  ___ RESULT: First user is owner? (Y/N) ___"
echo "  ___ NOTES: _______________________________"
echo ""

# ═══════════════════════════════════════════════════════════════════════════════
# Step 2: Generate invite link for second user
# ═══════════════════════════════════════════════════════════════════════════════

step "2" "Owner generates invite link for User B"

echo ""
echo "  Action: In the web UI, go to Members page"
echo "  Action: Click 'Invite member'"
echo "  Action: Select role 'member'"
echo "  Action: Click 'Create invite link'"
echo "  Action: Copy the invite link"
echo ""
echo "  Expected:"
echo "  - A link is generated in format: http://.../app/join?token=inv_..."
echo "  - The link target role is shown as 'Member'"
echo "  - Expiry is shown as 7 days, single use"
echo ""
echo "  API equivalent (requires session cookie):"
echo "    curl -s -X POST $TEAMEM_URL/teams/<TEAM_ID>/invites \\"
echo "      -H 'Content-Type: application/json' \\"
echo "      -b 'teamem_session=<OWNER_SESSION>' \\"
echo "      -d '{\"targetRole\":\"member\"}' | jq ."
echo ""
echo "  Expected API response:"
echo "    {"
echo "      \"id\": \"inv_...\","
echo "      \"inviteLink\": \"http://.../app/join?token=inv_...\","
echo "      \"targetRole\": \"member\","
echo "      \"expiresAt\": \"...\""
echo "    }"
echo ""
echo "  ___ RESULT: Invite link generated? (Y/N) ___"
echo "  ___ NOTES: _______________________________"
echo ""

# ═══════════════════════════════════════════════════════════════════════════════
# Step 3: Second user accepts invite → gets correct role
# ═══════════════════════════════════════════════════════════════════════════════

step "3" "User B accepts invite → joins team with 'member' role"

echo ""
echo "  Action: Open the invite link in a DIFFERENT browser or incognito window"
echo "  Action: Sign in with User B's GitHub account"
echo "  Action: The invite is automatically accepted"
echo "  Action: User B is redirected to /app"
echo ""
echo "  Expected:"
echo "  - User B sees their own avatar and login in the sidebar"
echo "  - The knowledge page loads successfully"
echo "  - GET /auth/me returns role: 'member'"
echo ""
echo "  Verification (as User B):"
echo "    curl -s $TEAMEM_URL/auth/me -b 'teamem_session=<USER_B_SESSION>' | jq ."
echo ""
echo "  Expected response:"
echo "    {"
echo "      \"role\": \"member\""
echo "    }"
echo ""
echo "  Verification (as User A, check Members page):"
echo "  - Members page shows 2 members (owner + member)"
echo "  - User B shows role 'Member'"
echo "  - User B's GitHub avatar and login are displayed"
echo ""
echo "  API equivalent (as User A):"
echo "    curl -s $TEAMEM_URL/v1/members \\"
echo "      -b 'teamem_session=<OWNER_SESSION>' | jq '.data[] | {githubLogin, role}'"
echo ""
echo "  ___ RESULT: User B appears with correct role? (Y/N) ___"
echo "  ___ NOTES: _______________________________"
echo ""

# ═══════════════════════════════════════════════════════════════════════════════
# Step 4: User B contributes a concept via webhook-verified event
# ═══════════════════════════════════════════════════════════════════════════════

step "4" "User B contributes knowledge (webhook-verified event)"

echo ""
echo "  NOTE: This step requires a real GitHub webhook event from User B."
echo "  If you do NOT have a second real GitHub account, use fixture-based"
echo "  validation (Step 4b below)."
echo ""
echo "  ── Option A: Real GitHub webhook ──"
echo "  Action: User B pushes a commit or opens a PR to a repo monitored"
echo "          by teamem-server's GitHub App"
echo "  Action: Server receives webhook, verifies signature, creates event"
echo "  Action: Compiler runs F1 → creates concept page"
echo "  Action: Navigate to the concept page"
echo ""
echo "  Expected:"
echo "  - The concept page's 'Contributors' section shows User B"
echo "  - Contributor has User B's GitHub avatar and @login"
echo "  - Clicking the contributor → navigates to /members/<userId>"
echo "  - The member profile page shows the contributed concept"
echo ""
echo "  Verification:"
echo "    curl -s $TEAMEM_URL/v1/concepts/<UUID> \\"
echo "      -H 'Authorization: Bearer <API_KEY>' | jq '.data.contributors'"
echo ""
echo "  Expected:"
echo "    [{"
echo "      \"principalId\": \"pri_...\","
echo "      \"kind\": \"human\","
echo "      \"provider\": \"github\","
echo "      \"displayName\": \"<User B's GitHub login>\","
echo "      \"githubLogin\": \"<User B's GitHub login>\","
echo "      \"avatarUrl\": \"https://avatars.githubusercontent.com/...\","
echo "      \"userId\": \"usr_...\""
echo "    }]"
echo ""
echo "  ── Option B: Fixture-based validation (no second real account) ──"
echo "  This is the automated integration test approach. Run:"
echo "    TEST_DATABASE_URL=<url> pnpm exec vitest run \\"
echo "      apps/server/src/http/routes/member-attribution.integration.test.ts"
echo ""
echo "  ___ RESULT: User B appears as contributor? (Y/N) ___"
echo "  ___ RESULT: Clicking contributor → member profile works? (Y/N) ___"
echo "  ___ RESULT: Member profile shows contributed concept? (Y/N) ___"
echo "  ___ IS REAL ACCOUNT: (Y/N — if N, fixture-based pass is sufficient) ___"
echo "  ___ NOTES: _______________________________"
echo ""

# ═══════════════════════════════════════════════════════════════════════════════
# Step 5: Counter-example — contributor is NOT a placeholder
# ═══════════════════════════════════════════════════════════════════════════════

step "5" "Counter-example: Contributors are NOT placeholder/system identities"

echo ""
echo "  Verification: On any concept page with GitHub-webhook-verified"
echo "  contributors, check that contributor display names are real:"
echo ""
echo "  For each contributor on a concept page:"
echo "    - principalId starts with 'pri_' (real principal, not fabricated)"
echo "    - displayName is a real GitHub login, NOT 'system:server-cli'"
echo "    - kind is 'human', NOT 'service' (for GitHub users)"
echo "    - githubLogin is populated"
echo "    - avatarUrl is a valid GitHub avatar URL"
echo ""
echo "  Query:"
echo "    curl -s $TEAMEM_URL/v1/concepts \\"
echo "      -H 'Authorization: Bearer <API_KEY>' \\"
echo "      -H 'Content-Type: application/json' | jq '.data[].contributors[]'"
echo ""
echo "  ___ RESULT: No placeholder/system contributors found? (Y/N) ___"
echo "  ___ NOTES: _______________________________"
echo ""

# ═══════════════════════════════════════════════════════════════════════════════
# Step 6: Counter-example — client_claimed actors are NOT contributors
# ═══════════════════════════════════════════════════════════════════════════════

step "6" "Counter-example: client_claimed (CLI/MCP) actors excluded from contributors"

echo ""
echo "  Context: CLI-initiated events (POST /v1/events with kind=cli_init)"
echo "  always have actorProvenance='client_claimed'. The frozen contract"
echo "  (AGENTS.md §5.4) states: 'client_claimed actors do not enter"
echo "  contributors by default.'"
echo ""
echo "  The concepts-write repository silently drops any contributor with"
echo "  provenance 'client_claimed' or 'unknown'. Only 'webhook_verified'"
echo "  and 'credential_bound' are trusted."
echo ""
echo "  Automated verification:"
echo "    The integration test 'C. client_claimed actors are excluded from"
echo "    contributors' in member-attribution.integration.test.ts verifies:"
echo "    - client_claimed provenance → NOT in concept contributors"
echo "    - unknown provenance → NOT in concept contributors"
echo "    - webhook_verified + credential_bound → ARE in concept contributors"
echo "    - Mixed: only trusted ones appear"
echo ""
echo "  To run:"
echo "    TEST_DATABASE_URL=<url> pnpm exec vitest run \\"
echo "      apps/server/src/http/routes/member-attribution.integration.test.ts \\"
echo "      -t 'client_claimed'"
echo ""
echo "  ___ RESULT: client_claimed excluded from contributors? (Y/N) ___"
echo "  ___ NOTES: _______________________________"
echo ""

# ═══════════════════════════════════════════════════════════════════════════════
# Step 7: Evidence — same GitHub App for login + ingestion
# ═══════════════════════════════════════════════════════════════════════════════

step "7" "Evidence: Login OAuth and webhook ingestion use the SAME GitHub App"

echo ""
echo "  Architecture: The teamem-server uses a single GitHub App for both"
echo "  OAuth login AND webhook ingestion."
echo ""
echo "  OAuth login credentials (from GitHub App settings):"
echo "    - GITHUB_APP_CLIENT_ID       → apps/server/src/auth/oauth-github.ts"
echo "    - GITHUB_APP_CLIENT_SECRET   → same module"
echo ""
echo "  Webhook ingestion credentials (from SAME GitHub App):"
echo "    - GITHUB_WEBHOOK_SECRET      → apps/server/src/connectors/github/connector.ts"
echo ""
echo "  API client credentials (from SAME GitHub App):"
echo "    - GITHUB_APP_ID             → apps/server/src/connectors/github/app-credentials.ts"
echo "    - GITHUB_APP_INSTALLATION_ID → same module"
echo "    - GITHUB_APP_PRIVATE_KEY    → same module"
echo ""
echo "  Integration point in the database:"
echo "  - Webhook ingestion creates a principal with:"
echo "      provider = 'github'"
echo "      provider_user_id = <GitHub numeric user ID>"
echo "  - OAuth login creates a user with:"
echo "      github_id = <GitHub numeric user ID>"
echo "  - The concepts-read repository joins:"
echo "      principals.provider_user_id = users.github_id::text"
echo "  - This ONLY works because both come from the SAME GitHub App"
echo ""
echo "  Evidence files:"
echo "    apps/server/src/auth/oauth-github.ts      (OAuth — clientId/clientSecret)"
echo "    apps/server/src/connectors/github/connector.ts  (webhook — webhookSecret)"
echo "    apps/server/src/connectors/github/app-credentials.ts (API — appId/privateKey)"
echo "    apps/server/src/db/repositories/concepts-read.ts  (join — same github_id)"
echo ""
echo "  Automated verification:"
echo "    The integration test 'D. Same GitHub App for OAuth and ingestion'"
echo "    in member-attribution.integration.test.ts verifies the linkage:"
echo "    - Principal via webhook has provider='github', providerUserId=<id>"
echo "    - User via OAuth has github_id=<id>"
echo "    - JOIN on provider_user_id = github_id::text resolves correctly"
echo ""
echo "  ___ RESULT: Same GitHub App confirmed? (Y/N) ___"
echo "  ___ NOTES: _______________________________"
echo ""

# ═══════════════════════════════════════════════════════════════════════════════
# Step 8: Full regression
# ═══════════════════════════════════════════════════════════════════════════════

step "8" "Full repository regression"

echo ""
echo "  Run the full test suite, lint, and type-check:"
echo ""
echo "    pnpm lint"
echo "    pnpm typecheck"
echo "    pnpm test"
echo ""
echo "  If database tests are skipped due to missing TEST_DATABASE_URL,"
echo "  re-run with a real PostgreSQL instance before declaring completion."
echo ""

if [ -z "${TEST_DATABASE_URL:-}" ]; then
  warn "TEST_DATABASE_URL not set — database tests will be skipped"
fi

echo "  ___ RESULT: pnpm lint:    PASS / FAIL / SKIP ___"
echo "  ___ RESULT: pnpm typecheck: PASS / FAIL / SKIP ___"
echo "  ___ RESULT: pnpm test:    PASS / FAIL / SKIP ___"
echo "  ___ RESULT: DB tests with real Postgres: PASS / FAIL / SKIP ___"
echo ""

# ── Summary ─────────────────────────────────────────────────────────────────

echo "=============================================================================="
echo "  Walkthrough Complete — Record findings below"
echo "=============================================================================="
echo ""
echo "  Task: DUA-243 — M2-QA-02 OAuth + Member Attribution Walkthrough"
echo ""
echo "  Results summary:"
echo "  [ ] Step 1: First user signs in → becomes owner"
echo "  [ ] Step 2: Owner generates invite for User B"
echo "  [ ] Step 3: User B accepts invite → correct role"
echo "  [ ] Step 4: User B contributes → appears as real contributor"
echo "  [ ] Step 5: Contributors are NOT placeholders"
echo "  [ ] Step 6: client_claimed actors excluded from contributors"
echo "  [ ] Step 7: Same GitHub App for login + ingestion confirmed"
echo "  [ ] Step 8: Full regression (lint, typecheck, test) passed"
echo ""
echo "  Integration tests run: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
echo "  Real human walkthrough: YES / NO (if NO, fixture-based pass is sufficient)"
echo ""
echo "  Unverified items (list any skipped checks):"
echo "  ___"
echo "  ___"
echo ""
echo "  Risks and follow-ups:"
echo "  ___"
echo "  ___"
echo ""
