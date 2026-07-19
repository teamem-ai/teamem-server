#!/usr/bin/env bash
# M0 GitHub Webhook Smoke Test (AGPL-3.0-only)
#
# End-to-end smoke test that validates real GitHub webhook delivery into
# teamem. The script:
#   1. Creates a temporary GitHub webhook on the target repository.
#   2. Creates four real GitHub events (push, issue, PR, PR review).
#   3. Fetches the ACTUAL webhook payloads from GitHub's delivery log.
#   4. Feeds those payloads into teamem through the real HTTP webhook endpoint.
#   5. Verifies stored events through curl /v1/events and PostgreSQL.
#   6. Tests idempotent replay and idempotency conflict rejection.
#   7. Verifies job/job_events rows for the delivered events.
#   8. Cleans up the temporary webhook and database rows.
#
# Prerequisites:
#   - teamem server with /v1/events/github and /v1/events endpoints
#   - gh CLI authenticated with admin:repo_hook scope
#   - jq, curl, psql, openssl, xxd installed
#
# Configuration (all via environment variables):
#   TEAMEM_BASE_URL            — server base URL (default: http://127.0.0.1:8080)
#   TEAMEM_GITHUB_REPO         — target repo (required)
#   TEAMEM_GITHUB_TOKEN        — GitHub PAT with repo + webhook scope (required)
#   TEAMEM_WEBHOOK_SECRET      — webhook secret ≥16 chars (REQUIRED)
#   TEAMEM_DATABASE_URL        — Postgres connection string (required)
#   TEAMEM_SMOKE_KEEP_DATA     — keep rows after test (default: false)
#   TEAMEM_SMOKE_TEAM_ID       — team ID for event scope (default: TEAMEM_WEBHOOK_TEAM_ID or team_default)
#   TEAMEM_SMOKE_PROJECT_ID    — project ID for event scope (default: TEAMEM_WEBHOOK_PROJECT_ID or prj_default)
#   TEAMEM_SMOKE_WEBHOOK_URL   — webhook target URL (default: uses example.com + delivery-log fetch)

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; NC='\033[0m'
pass()  { printf "${GREEN}✓ PASS${NC} %s\n" "$*"; }
fail()  { printf "${RED}✗ FAIL${NC} %s\n" "$*"; }
info()  { printf "${BOLD}→${NC} %s\n" "$*"; }
warn()  { printf "${YELLOW}⚠ WARN${NC} %s\n" "$*"; }
header() { printf '\n%s\n%s\n%s\n\n' "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" "${BOLD}$*${NC}" "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"; }

BASE_URL="${TEAMEM_BASE_URL:-http://127.0.0.1:8080}"
GITHUB_REPO="${TEAMEM_GITHUB_REPO:-}"
GITHUB_TOKEN="${TEAMEM_GITHUB_TOKEN:-}"
WEBHOOK_SECRET="${TEAMEM_WEBHOOK_SECRET:-}"
DATABASE_URL="${TEAMEM_DATABASE_URL:-}"
KEEP_DATA="${TEAMEM_SMOKE_KEEP_DATA:-false}"
SMOKE_TEAM="${TEAMEM_SMOKE_TEAM_ID:-${TEAMEM_WEBHOOK_TEAM_ID:-team_default}}"
SMOKE_PROJECT="${TEAMEM_SMOKE_PROJECT_ID:-${TEAMEM_WEBHOOK_PROJECT_ID:-prj_default}}"
TIMESTAMP="$(date +%Y%m%dT%H%M%S)"
SMOKE_BRANCH="smoke-test-${TIMESTAMP}"

TMPDIR="${TMPDIR:-/tmp}"
SMOKE_TMP="$(mktemp -d "${TMPDIR}/teamem-smoke.XXXXXX")"
trap 'rm -rf "$SMOKE_TMP"' EXIT

# Counter files — survive subshell pipes
PASS_F="${SMOKE_TMP}/pass"; echo 0 > "$PASS_F"
FAIL_F="${SMOKE_TMP}/fail"; echo 0 > "$FAIL_F"
inc_pass() { local c; c=$(cat "$PASS_F"); echo $((c+1)) > "$PASS_F"; }
inc_fail() { local c; c=$(cat "$FAIL_F"); echo $((c+1)) > "$FAIL_F"; }
get_pass() { cat "$PASS_F"; }
get_fail() { cat "$FAIL_F"; }

# ── Prerequisites ────────────────────────────────────────────────────────────
check_prereqs() {
  header "M0 GitHub Webhook Smoke Test — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local missing=0

  for cmd in gh jq curl psql openssl xxd; do
    command -v "$cmd" >/dev/null 2>&1 || { fail "Missing: $cmd"; missing=1; }
  done

  [[ -z "$GITHUB_REPO" ]] && { fail "TEAMEM_GITHUB_REPO not set"; missing=1; }
  [[ -z "$GITHUB_TOKEN" ]] && { fail "TEAMEM_GITHUB_TOKEN not set"; missing=1; }
  [[ -z "$DATABASE_URL" ]] && { fail "TEAMEM_DATABASE_URL not set"; missing=1; }

  # REQUIRED: webhook secret must be set to produce webhook_verified provenance
  if [[ -z "$WEBHOOK_SECRET" ]]; then
    fail "TEAMEM_WEBHOOK_SECRET is REQUIRED — the smoke test must verify trusted actor claims"
    fail "Set a ≥16 character secret: export TEAMEM_WEBHOOK_SECRET='...'"
    missing=1
  elif [[ "${#WEBHOOK_SECRET}" -lt 16 ]]; then
    fail "TEAMEM_WEBHOOK_SECRET must be ≥16 characters (got ${#WEBHOOK_SECRET})"
    missing=1
  else
    info "Webhook secret: configured (${#WEBHOOK_SECRET} chars)"
    export TEAMEM_WEBHOOK_SECRET
  fi

  export GH_TOKEN="$GITHUB_TOKEN"
  gh repo view "$GITHUB_REPO" >/dev/null 2>&1 || { fail "Cannot access $GITHUB_REPO"; missing=1; }
  psql "$DATABASE_URL" -c 'SELECT 1' >/dev/null 2>&1 || { fail "Cannot connect to database"; missing=1; }

  # Check server reachability and which endpoints are available
  if curl -fsS "${BASE_URL}/healthz" >/dev/null 2>&1; then
    info "Server: ${BASE_URL} reachable (/healthz OK)"
    detect_http_endpoint
  else
    fail "Server not reachable at ${BASE_URL}; the smoke test requires the real HTTP webhook path"
    missing=1
  fi

  if [[ "$HAS_HTTP_ENDPOINT" != "true" ]]; then
    fail "Required webhook endpoint missing: ${BASE_URL}/v1/events/github"
    missing=1
  fi

  local events_status
  events_status="$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/v1/events?limit=1" 2>/dev/null || true)"
  events_status="${events_status:-000}"
  if [[ "$events_status" == "404" || "$events_status" == "000" ]]; then
    fail "Required events list endpoint missing: ${BASE_URL}/v1/events (HTTP ${events_status})"
    missing=1
  else
    info "Events list endpoint available at ${BASE_URL}/v1/events (HTTP ${events_status})"
  fi

  # Ensure seed data exists
  psql "$DATABASE_URL" -c "
    INSERT INTO teams (id, name) VALUES ('${SMOKE_TEAM}', 'Smoke Test Team') ON CONFLICT (id) DO NOTHING;
    INSERT INTO projects (id, team_id, name) VALUES ('${SMOKE_PROJECT}', '${SMOKE_TEAM}', 'Smoke Test Project') ON CONFLICT (id) DO NOTHING;
  " >/dev/null 2>&1

  if [[ "$missing" -ne 0 ]]; then echo; echo "Fix the failures above and re-run."; exit 1; fi
  pass "All prerequisites met"
  echo ""
}

# ── Deliver payload to teamem ────────────────────────────────────────────────
# Delivers a webhook payload to the teamem server via the real HTTP endpoint
# (POST /v1/events/github with HMAC signature).

# Pre-check: can we reach the HTTP endpoint?
HAS_HTTP_ENDPOINT=false
detect_http_endpoint() {
  local http_code
  http_code="$(curl -s -o /dev/null -w '%{http_code}' \
    -X POST "${BASE_URL}/v1/events/github" \
    -H 'Content-Type: application/json' \
    -H 'X-GitHub-Event: ping' \
    -H 'X-GitHub-Delivery: probe' \
    -d '{}' 2>/dev/null || true)"
  http_code="${http_code:-000}"
  if [[ "$http_code" != "000" && "$http_code" != "404" ]]; then
    HAS_HTTP_ENDPOINT=true
    info "Webhook endpoint available at ${BASE_URL}/v1/events/github (HTTP $http_code)"
  else
    info "Webhook endpoint not available (HTTP $http_code)"
  fi
}

DELIVER_BODY=""
DELIVER_HTTP_CODE="000"
deliver_payload() {
  local event_type="$1" delivery_id="$2" payload_file="$3"

  local sig
  sig="sha256=$(openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" -binary "$payload_file" | xxd -p -c 256)"

  local resp
  resp="$(curl -s -w '\n%{http_code}' -X POST "${BASE_URL}/v1/events/github" \
    -H "Content-Type: application/json" \
    -H "X-GitHub-Event: ${event_type}" \
    -H "X-GitHub-Delivery: ${delivery_id}" \
    -H "X-Hub-Signature-256: ${sig}" \
    --data-binary "@${payload_file}" 2>/dev/null || true)"
  DELIVER_HTTP_CODE="$(echo "$resp" | tail -1)"
  DELIVER_BODY="$(echo "$resp" | sed '$d')"
}

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

# ── 1. Create temporary GitHub webhook ──────────────────────────────────────
create_temp_webhook() {
  header "1. Creating Temporary GitHub Webhook"

  # If TEAMEM_SMOKE_WEBHOOK_URL is set, use it as the webhook target.
  # Otherwise use a fake URL — deliveries will fail but the payloads are
  # recorded in GitHub's delivery log, which we fetch the ACTUAL webhook
  # payload from. The script then delivers those real payloads through the
  # teamem HTTP endpoint with proper HMAC headers, exercising the same
  # code path as a live GitHub delivery.
  local webhook_url="${TEAMEM_SMOKE_WEBHOOK_URL:-https://example.com/teamem-smoke-test-webhook-${TIMESTAMP}}"

  info "Creating webhook on ${GITHUB_REPO}..."
  local wh_resp
  wh_resp="$(jq -n --arg url "$webhook_url" --arg secret "$WEBHOOK_SECRET" \
    '{name:"web",active:true,config:{url:$url,content_type:"json",secret:$secret},events:["push","issues","pull_request","pull_request_review","pull_request_review_comment","issue_comment"]}' \
    | gh api "repos/${GITHUB_REPO}/hooks" --input - 2>/dev/null)"

  HOOK_ID="$(echo "$wh_resp" | jq -r '.id // empty')"
  if [[ -z "$HOOK_ID" ]]; then
    fail "Could not create webhook — response: $(echo "$wh_resp" | jq -c '.')"
    exit 1
  fi
  info "  Webhook ID: $HOOK_ID"
  pass "Temporary webhook created (deliveries to: $webhook_url)"
  inc_pass
  echo ""
}

# We store HOOK_ID here; set by create_temp_webhook
HOOK_ID=""

# ── 2. Create real GitHub events ────────────────────────────────────────────
create_events() {
  header "2. Creating Real GitHub Events"

  local default_branch base_sha repo_data
  default_branch="$(gh api "repos/${GITHUB_REPO}" --jq '.default_branch')"
  base_sha="$(gh api "repos/${GITHUB_REPO}/git/refs/heads/${default_branch}" --jq '.object.sha')"
  repo_data="$(gh api "repos/${GITHUB_REPO}")"
  info "Default branch: $default_branch ($base_sha)"

  local gh_user
  gh_user="$(gh api user --jq '{login: .login, id: (.id | tonumber), type: "User"}')"
  info "GitHub user: $(echo "$gh_user" | jq -r '.login')"

  # ── 2a. Push ──────────────────────────────────────────────────────────
  info "Creating push on branch '${SMOKE_BRANCH}'..."
  local blob_sha tree_sha commit_sha base_tree_sha
  # Get the tree SHA of the base commit (needed for git tree creation)
  base_tree_sha="$(gh api "repos/${GITHUB_REPO}/git/commits/${base_sha}" --jq '.tree.sha')"
  # Create blob via JSON input
  blob_sha="$(jq -n --arg content "smoke test ${TIMESTAMP}" \
    '{content:$content,encoding:"utf-8"}' \
    | gh api "repos/${GITHUB_REPO}/git/blobs" --input - --jq '.sha')"
  # Create tree via JSON input
  tree_sha="$(jq -n --arg base_tree "$base_tree_sha" --arg path "smoke-${TIMESTAMP}.md" --arg sha "$blob_sha" \
    '{base_tree:$base_tree,tree:[{path:$path,mode:"100644",type:"blob",sha:$sha}]}' \
    | gh api "repos/${GITHUB_REPO}/git/trees" --input - --jq '.sha')"
  # Create commit via JSON input
  commit_sha="$(jq -n --arg message "smoke test commit ${TIMESTAMP}" --arg tree "$tree_sha" --arg parent "$base_sha" \
    '{message:$message,tree:$tree,parents:[$parent]}' \
    | gh api "repos/${GITHUB_REPO}/git/commits" --input - --jq '.sha')"
  # Create ref via JSON input
  jq -n --arg ref "refs/heads/${SMOKE_BRANCH}" --arg sha "$commit_sha" \
    '{ref:$ref,sha:$sha}' \
    | gh api "repos/${GITHUB_REPO}/git/refs" --input - >/dev/null 2>&1
  info "  Commit: ${commit_sha:0:8}"

  # ── 2b. Issue ─────────────────────────────────────────────────────────
  info "Creating issue..."
  gh issue create --repo "$GITHUB_REPO" \
    --title "Smoke Test Issue ${TIMESTAMP}" \
    --body "Smoke test issue for teamem webhook verification." \
    --label "bug" >/dev/null 2>&1
  ISSUE_NUMBER="$(gh issue list --repo "$GITHUB_REPO" \
    --search "Smoke Test Issue ${TIMESTAMP}" --json number --jq '.[0].number')"
  info "  Issue: #${ISSUE_NUMBER}"

  # ── 2c. Pull Request ──────────────────────────────────────────────────
  info "Creating PR from ${SMOKE_BRANCH}..."
  local pr_url
  pr_url="$(gh pr create --repo "$GITHUB_REPO" --head "$SMOKE_BRANCH" \
    --base "$default_branch" --title "Smoke Test PR ${TIMESTAMP}" \
    --body "Smoke test PR for teamem webhook verification." 2>/dev/null)" || true
  PR_NUMBER="$(echo "$pr_url" | grep -oE '[0-9]+$' || echo "")"
  [[ -z "$PR_NUMBER" ]] && PR_NUMBER="$(gh pr list --repo "$GITHUB_REPO" \
    --head "$SMOKE_BRANCH" --json number --jq '.[0].number' 2>/dev/null || echo "")"
  if [[ -z "$PR_NUMBER" ]]; then
    fail "Could not create PR"; inc_fail; PR_NUMBER=""
  else
    info "  PR: #${PR_NUMBER}"
  fi

  # ── 2d. PR Review ─────────────────────────────────────────────────────
  if [[ -n "$PR_NUMBER" ]]; then
    info "Creating PR review on #${PR_NUMBER}..."
    local review_resp
    review_resp="$(gh api "repos/${GITHUB_REPO}/pulls/${PR_NUMBER}/reviews" \
      -f event="COMMENT" -f body="Smoke test review ${TIMESTAMP}" 2>/dev/null)" || true
    REVIEW_ID="$(echo "$review_resp" | jq -r '.id // empty')"
    if [[ -z "$REVIEW_ID" ]]; then
      fail "Could not create PR review — REQUIRED for smoke test"; inc_fail; REVIEW_ID=""
    else
      info "  Review ID: $REVIEW_ID"
    fi
    gh pr close "$PR_NUMBER" --repo "$GITHUB_REPO" >/dev/null 2>&1 || true
  else
    REVIEW_ID=""
  fi

  gh issue close "$ISSUE_NUMBER" --repo "$GITHUB_REPO" >/dev/null 2>&1 || true
  echo ""
}

ISSUE_NUMBER=""
PR_NUMBER=""
REVIEW_ID=""
PUSH_DELIVERY_ID=""
ISSUE_DELIVERY_ID=""
PR_DELIVERY_ID=""
REVIEW_DELIVERY_ID=""

# ── 3. Fetch real webhook deliveries from GitHub ────────────────────────────
fetch_deliveries() {
  header "3. Fetching Real Webhook Deliveries from GitHub"

  # Wait for webhook deliveries to be recorded (GitHub is fast but not instant)
  info "Waiting for webhook deliveries to be recorded by GitHub..."
  sleep 5

  # List recent deliveries for our webhook
  local deliveries
  deliveries="$(gh api "repos/${GITHUB_REPO}/hooks/${HOOK_ID}/deliveries?per_page=30" \
    2>/dev/null)" || { fail "Could not fetch webhook deliveries"; inc_fail; return; }

  local total_deliveries
  total_deliveries="$(echo "$deliveries" | jq -r 'length // 0')"
  info "  Total deliveries found: $total_deliveries"

  if [[ "$total_deliveries" -eq 0 ]]; then
    warn "  No deliveries yet — GitHub may still be processing. Waiting 10 more seconds..."
    sleep 10
    deliveries="$(gh api "repos/${GITHUB_REPO}/hooks/${HOOK_ID}/deliveries?per_page=30" 2>/dev/null)" || true
    total_deliveries="$(echo "$deliveries" | jq -r 'length // 0')"
    info "  Deliveries after wait: $total_deliveries"
  fi

  # Map: event type → delivery ID + delivery GUID
  # GitHub delivery log has: guid, event, action, delivered_at
  # We fetch the FULL payload for each delivery via the delivery GUID

  local count_fetched=0

  # Find the push delivery
  local push_id
  push_id="$(echo "$deliveries" | jq -r '.[] | select(.event == "push") | .id' | head -1)"
  if [[ -n "$push_id" ]]; then
    PUSH_DELIVERY_ID="$push_id"
    info "Fetching push delivery: $push_id"
    gh api "repos/${GITHUB_REPO}/hooks/${HOOK_ID}/deliveries/${push_id}" \
      --jq '.request.payload' > "${SMOKE_TMP}/delivery-push.json" 2>/dev/null || true
    if jq empty "${SMOKE_TMP}/delivery-push.json" >/dev/null 2>&1; then
      pass "Fetched real push webhook payload ($(wc -c < "${SMOKE_TMP}/delivery-push.json") bytes)"
      inc_pass; count_fetched=$((count_fetched + 1))
    else
      fail "Push delivery payload is not valid JSON"
      inc_fail
    fi
  else
    fail "No push delivery found in GitHub's webhook log"
    inc_fail
  fi

  # Find the issues delivery
  local issue_id
  issue_id="$(echo "$deliveries" | jq -r '.[] | select(.event == "issues") | .id' | head -1)"
  if [[ -n "$issue_id" ]]; then
    ISSUE_DELIVERY_ID="$issue_id"
    info "Fetching issues delivery: $issue_id"
    gh api "repos/${GITHUB_REPO}/hooks/${HOOK_ID}/deliveries/${issue_id}" \
      --jq '.request.payload' > "${SMOKE_TMP}/delivery-issues.json" 2>/dev/null || true
    if jq empty "${SMOKE_TMP}/delivery-issues.json" >/dev/null 2>&1; then
      pass "Fetched real issues webhook payload ($(wc -c < "${SMOKE_TMP}/delivery-issues.json") bytes)"
      inc_pass; count_fetched=$((count_fetched + 1))
    else
      fail "Issues delivery payload is not valid JSON"
      inc_fail
    fi
  else
    fail "No issues delivery found in GitHub's webhook log"
    inc_fail
  fi

  # Find the pull_request delivery
  local pr_id
  pr_id="$(echo "$deliveries" | jq -r '.[] | select(.event == "pull_request") | .id' | head -1)"
  if [[ -n "$pr_id" ]]; then
    PR_DELIVERY_ID="$pr_id"
    info "Fetching pull_request delivery: $pr_id"
    gh api "repos/${GITHUB_REPO}/hooks/${HOOK_ID}/deliveries/${pr_id}" \
      --jq '.request.payload' > "${SMOKE_TMP}/delivery-pr.json" 2>/dev/null || true
    if jq empty "${SMOKE_TMP}/delivery-pr.json" >/dev/null 2>&1; then
      pass "Fetched real pull_request webhook payload ($(wc -c < "${SMOKE_TMP}/delivery-pr.json") bytes)"
      inc_pass; count_fetched=$((count_fetched + 1))
    else
      fail "Pull request delivery payload is not valid JSON"
      inc_fail
    fi
  else
    fail "No pull_request delivery found in GitHub's webhook log"
    inc_fail
  fi

  # Find the pull_request_review delivery
  local review_id
  review_id="$(echo "$deliveries" | jq -r '.[] | select(.event == "pull_request_review") | .id' | head -1)"
  if [[ -z "$review_id" ]]; then
    # Fallback to issue_comment
    review_id="$(echo "$deliveries" | jq -r '.[] | select(.event == "issue_comment") | .id' | head -1)"
  fi
  if [[ -n "$review_id" ]]; then
    REVIEW_DELIVERY_ID="$review_id"
    info "Fetching review/comment delivery: $review_id"
    gh api "repos/${GITHUB_REPO}/hooks/${HOOK_ID}/deliveries/${review_id}" \
      --jq '.request.payload' > "${SMOKE_TMP}/delivery-review.json" 2>/dev/null || true
    if jq empty "${SMOKE_TMP}/delivery-review.json" >/dev/null 2>&1; then
      pass "Fetched real review/comment webhook payload ($(wc -c < "${SMOKE_TMP}/delivery-review.json") bytes)"
      inc_pass; count_fetched=$((count_fetched + 1))
    else
      fail "Review/comment delivery payload is not valid JSON"
      inc_fail
    fi
  else
    fail "No pull_request_review or issue_comment delivery found in GitHub's webhook log"
    inc_fail
  fi

  echo ""
  info "Successfully fetched $count_fetched/4 real webhook payloads from GitHub"
  echo ""
}

# ── 4. Ingest payloads into teamem ──────────────────────────────────────────
ingest_payloads() {
  header "4. Ingesting Real Webhook Payloads into teamem"

  local ingested=0

  # Push
  if [[ -f "${SMOKE_TMP}/delivery-push.json" ]]; then
    local push_delivery="$PUSH_DELIVERY_ID"
    info "Delivering push payload (delivery: $push_delivery)..."
    local resp http_code
    deliver_payload "push" "$push_delivery" "${SMOKE_TMP}/delivery-push.json"
    resp="$DELIVER_BODY"
    http_code="$DELIVER_HTTP_CODE"
    if [[ "$http_code" == "200" ]]; then
      local n; n="$(echo "$resp" | jq -r '.events | length // 0')"
      if [[ "$n" -gt 0 ]]; then
        pass "Push: ingested $n event(s) (HTTP $http_code)"
        inc_pass; ingested=$((ingested + 1))
      else
        fail "Push: HTTP $http_code but produced 0 event(s)"
        inc_fail
      fi
    else
      fail "Push: HTTP $http_code — $(echo "$resp" | jq -c '.error // .' 2>/dev/null || echo "$resp")"
      inc_fail
    fi
  fi

  # Issues
  if [[ -f "${SMOKE_TMP}/delivery-issues.json" ]]; then
    local issue_delivery="$ISSUE_DELIVERY_ID"
    info "Delivering issues payload (delivery: $issue_delivery)..."
    local resp http_code
    deliver_payload "issues" "$issue_delivery" "${SMOKE_TMP}/delivery-issues.json"
    resp="$DELIVER_BODY"
    http_code="$DELIVER_HTTP_CODE"
    if [[ "$http_code" == "200" ]]; then
      local n; n="$(echo "$resp" | jq -r '.events | length // 0')"
      if [[ "$n" -gt 0 ]]; then
        pass "Issue: ingested $n event(s) (HTTP $http_code)"
        inc_pass; ingested=$((ingested + 1))
      else
        fail "Issue: HTTP $http_code but produced 0 event(s)"
        inc_fail
      fi
    else
      fail "Issue: HTTP $http_code"
      inc_fail
    fi
  fi

  # Pull Request
  if [[ -f "${SMOKE_TMP}/delivery-pr.json" ]]; then
    local pr_delivery="$PR_DELIVERY_ID"
    info "Delivering pull_request payload (delivery: $pr_delivery)..."
    local resp http_code
    deliver_payload "pull_request" "$pr_delivery" "${SMOKE_TMP}/delivery-pr.json"
    resp="$DELIVER_BODY"
    http_code="$DELIVER_HTTP_CODE"
    if [[ "$http_code" == "200" ]]; then
      local n; n="$(echo "$resp" | jq -r '.events | length // 0')"
      if [[ "$n" -gt 0 ]]; then
        pass "PR: ingested $n event(s) (HTTP $http_code)"
        inc_pass; ingested=$((ingested + 1))
      else
        fail "PR: HTTP $http_code but produced 0 event(s)"
        inc_fail
      fi
    else
      fail "PR: HTTP $http_code"
      inc_fail
    fi
  fi

  # Review/Comment
  if [[ -f "${SMOKE_TMP}/delivery-review.json" ]]; then
    local review_delivery="$REVIEW_DELIVERY_ID"
    # Determine the actual event type from the payload
    local review_event_type="pull_request_review"
    if jq -e '.comment' "${SMOKE_TMP}/delivery-review.json" >/dev/null 2>&1; then
      review_event_type="issue_comment"
    fi
    info "Delivering ${review_event_type} payload (delivery: $review_delivery)..."
    local resp http_code
    deliver_payload "$review_event_type" "$review_delivery" "${SMOKE_TMP}/delivery-review.json"
    resp="$DELIVER_BODY"
    http_code="$DELIVER_HTTP_CODE"
    if [[ "$http_code" == "200" ]]; then
      local n; n="$(echo "$resp" | jq -r '.events | length // 0')"
      if [[ "$n" -gt 0 ]]; then
        pass "Review/Comment: ingested $n event(s) (HTTP $http_code)"
        inc_pass; ingested=$((ingested + 1))
      else
        fail "Review/Comment: HTTP $http_code but produced 0 event(s)"
        inc_fail
      fi
    else
      fail "Review/Comment: HTTP $http_code"
      inc_fail
    fi
  fi

  echo ""
  info "Successfully ingested $ingested/4 event types"
  echo ""
}

# ── 5. Verify via /v1/events API ────────────────────────────────────────────
verify_api() {
  header "5. Verification via ${BASE_URL}/v1/events"

  local api_resp api_total
  api_resp="$(curl -fsS "${BASE_URL}/v1/events?limit=50" 2>/dev/null)" || {
    fail "API: /v1/events request failed"
    inc_fail
    return
  }
  if ! echo "$api_resp" | jq empty >/dev/null 2>&1; then
    fail "API: /v1/events did not return JSON"
    inc_fail
    return
  fi
  api_total="$(echo "$api_resp" | jq -r '.total // 0')"

  if [[ "$api_total" -eq 0 ]]; then
    fail "API: /v1/events returned 0 events"
    inc_fail
    return
  fi

  info "Total events via API: $api_total"
  pass "API: /v1/events returned $api_total event(s)"
  inc_pass

  for kind in github_commit github_issue github_pr github_pr_comment; do
    local expected_delivery
    case "$kind" in
      github_commit) expected_delivery="$PUSH_DELIVERY_ID" ;;
      github_issue) expected_delivery="$ISSUE_DELIVERY_ID" ;;
      github_pr) expected_delivery="$PR_DELIVERY_ID" ;;
      github_pr_comment) expected_delivery="$REVIEW_DELIVERY_ID" ;;
      *) expected_delivery="" ;;
    esac
    local kr
    kr="$(curl -fsS "${BASE_URL}/v1/events?kind=${kind}&limit=5" 2>/dev/null)" || {
      fail "API: ${kind} request failed"
      inc_fail
      continue
    }
    local kc; kc="$(echo "$kr" | jq -r '.total // 0' 2>/dev/null || echo '0')"
    if [[ "$kc" -gt 0 ]]; then
      pass "API: ${kind} — $kc event(s)"
      inc_pass
      local first; first="$(echo "$kr" | jq -c --arg delivery "$expected_delivery" '.events[] | select(.deliveryId == $delivery)' 2>/dev/null | head -1)"
      local has_delivery
      has_delivery="$(echo "$kr" | jq --arg delivery "$expected_delivery" -r '[.events[]? | select(.deliveryId == $delivery)] | length')"
      assert "  includes this smoke delivery" "[ \"$has_delivery\" -gt 0 ]" "deliveryId=$expected_delivery"
      assert "  channel=github" \
        "[ \"$(echo "$first" | jq -r '.channel')\" = \"github\" ]"
      assert "  actorProvenance=webhook_verified" \
        "[ \"$(echo "$first" | jq -r '.actorProvenance')\" = \"webhook_verified\" ]"
      assert "  url is present" \
        "[ -n \"$(echo "$first" | jq -r '.url // ""')\" ]"
    else
      fail "API: ${kind} — 0 events (expected ≥1)"
      inc_fail
    fi
  done
  echo ""
}

# ── 6. Verify via PostgreSQL ────────────────────────────────────────────────
verify_psql() {
  header "6. Verification via PostgreSQL"

  local counts
  if ! counts="$(psql "$DATABASE_URL" -t -A -F'|' -c "
    SELECT kind, count(*)::text FROM events
    WHERE project_id = '${SMOKE_PROJECT}' AND team_id = '${SMOKE_TEAM}'
      AND delivery_id IN (
        '${PUSH_DELIVERY_ID}',
        '${ISSUE_DELIVERY_ID}',
        '${PR_DELIVERY_ID}',
        '${REVIEW_DELIVERY_ID}'
      )
    GROUP BY kind ORDER BY kind
  " 2>/dev/null)"; then
    fail "psql query failed — cannot verify events"
    inc_fail
    return
  fi

  if [[ -z "$counts" ]]; then
    fail "psql: no events found in database"
    inc_fail
    return
  fi

  info "Event counts:"
  echo "$counts" | while IFS='|' read -r k c; do info "  $k: $c"; done
  echo ""

  # Verify each event kind
  local row_query="SELECT id, channel, kind, source_event, source_action,
    delivery_id, item_key, external_id, url,
    actor_provenance, occurred_at_provenance
    FROM events
    WHERE project_id = '${SMOKE_PROJECT}' AND team_id = '${SMOKE_TEAM}'
      AND kind = \$1
    ORDER BY created_at DESC LIMIT 3"

  for kind in github_commit github_issue github_pr github_pr_comment; do
    local rows
    local delivery_id
    case "$kind" in
      github_commit) delivery_id="$PUSH_DELIVERY_ID" ;;
      github_issue) delivery_id="$ISSUE_DELIVERY_ID" ;;
      github_pr) delivery_id="$PR_DELIVERY_ID" ;;
      github_pr_comment) delivery_id="$REVIEW_DELIVERY_ID" ;;
      *) delivery_id="" ;;
    esac
    rows="$(psql "$DATABASE_URL" -t -A -F'|' -c "
      SELECT id, channel, kind, source_event, source_action,
        delivery_id, item_key, external_id, url,
        actor_provenance, occurred_at_provenance
      FROM events
      WHERE project_id = '${SMOKE_PROJECT}' AND team_id = '${SMOKE_TEAM}'
        AND kind = '${kind}'
        AND delivery_id = '${delivery_id}'
      ORDER BY created_at DESC LIMIT 3
    " 2>/dev/null)" || rows=""

    if [[ -z "$rows" ]]; then
      fail "psql: no ${kind} events found"
      inc_fail
      continue
    fi

    echo "$rows" | while IFS='|' read -r id ch k se sa did ik eid url apro ovpro; do
      assert "${kind}: channel=github ($id)" "[ \"$ch\" = \"github\" ]"
      assert "${kind}: actorProvenance=webhook_verified ($id)" \
        "[ \"$apro\" = \"webhook_verified\" ]" "got: $apro"
      assert "${kind}: url is set ($id)" "[ -n \"$url\" ]"

      case "$k" in
        github_commit)
          assert "  source_event=push" "[ \"$se\" = \"push\" ]"
          assert "  occurred_at_provenance=provider" "[ \"$ovpro\" = \"provider\" ]"
          assert "  itemKey is commit SHA (≥40 chars)" "[ \${#ik} -ge 40 ]"
          ;;
        github_issue)
          assert "  source_event=issues" "[ \"$se\" = \"issues\" ]"
          assert "  source_action is set" "[ -n \"$sa\" ]"
          ;;
        github_pr)
          assert "  source_event=pull_request" "[ \"$se\" = \"pull_request\" ]"
          assert "  source_action is set" "[ -n \"$sa\" ]"
          ;;
        github_pr_comment)
          assert "  source_event is set" "[ -n \"$se\" ]"
          assert "  source_action is set" "[ -n \"$sa\" ]"
          assert "  url has # fragment" "[[ \"$url\" == *\"#\"* ]]"
          ;;
      esac
    done
  done
  echo ""
}

# ── 7. Verify jobs ─────────────────────────────────────────────────────────
verify_jobs() {
  header "7. Verification via PostgreSQL — jobs"

  local stats
  stats="$(psql "$DATABASE_URL" -t -A -F'|' -c "
    WITH smoke_events AS (
      SELECT id
      FROM events
      WHERE team_id = '${SMOKE_TEAM}'
        AND project_id = '${SMOKE_PROJECT}'
        AND delivery_id IN (
          '${PUSH_DELIVERY_ID}',
          '${ISSUE_DELIVERY_ID}',
          '${PR_DELIVERY_ID}',
          '${REVIEW_DELIVERY_ID}'
        )
    )
    SELECT
      count(DISTINCT e.id)::text AS event_count,
      count(DISTINCT je.event_id)::text AS linked_event_count,
      count(DISTINCT j.id)::text AS job_count
    FROM smoke_events e
    LEFT JOIN job_events je
      ON je.team_id = '${SMOKE_TEAM}'
     AND je.project_id = '${SMOKE_PROJECT}'
     AND je.event_id = e.id
    LEFT JOIN jobs j
      ON j.team_id = je.team_id
     AND j.project_id = je.project_id
     AND j.id = je.job_id;
  " 2>/dev/null)" || {
    fail "psql job query failed — cannot verify task/job creation"
    inc_fail
    return
  }

  local event_count linked_event_count job_count
  IFS='|' read -r event_count linked_event_count job_count <<< "$stats"

  assert "jobs: smoke events are present" "[ \"$event_count\" -gt 0 ]" "got: $event_count"
  assert "jobs: at least one job is present" "[ \"$job_count\" -gt 0 ]" "got: $job_count"
  assert "jobs: every smoke event is linked through job_events" \
    "[ \"$linked_event_count\" -eq \"$event_count\" ]" \
    "events=$event_count linked=$linked_event_count"

  info "Job rows linked to smoke events:"
  psql "$DATABASE_URL" -c "
    SELECT j.id, j.kind, j.status, j.event_count, je.status AS event_status, je.event_id
    FROM events e
    JOIN job_events je
      ON je.team_id = e.team_id
     AND je.project_id = e.project_id
     AND je.event_id = e.id
    JOIN jobs j
      ON j.team_id = je.team_id
     AND j.project_id = je.project_id
     AND j.id = je.job_id
    WHERE e.team_id = '${SMOKE_TEAM}'
      AND e.project_id = '${SMOKE_PROJECT}'
      AND e.delivery_id IN (
        '${PUSH_DELIVERY_ID}',
        '${ISSUE_DELIVERY_ID}',
        '${PR_DELIVERY_ID}',
        '${REVIEW_DELIVERY_ID}'
      )
    ORDER BY j.created_at DESC, je.event_id
    LIMIT 20
  " 2>/dev/null || echo "  (query failed)"
  echo ""
}

# ── 8. Idempotency test ────────────────────────────────────────────────────
test_idempotency() {
  header "8. Idempotency Test"

  local payload_file="${SMOKE_TMP}/delivery-push.json"
  if [[ ! -f "$payload_file" ]]; then
    fail "No push payload for idempotency test"; inc_fail; return
  fi

  # 7a. Replay same payload → duplicate
  info "Replaying same push payload (idempotent replay)..."
  local push_delivery="$PUSH_DELIVERY_ID"
  local resp http_code
  deliver_payload "push" "$push_delivery" "$payload_file"
  resp="$DELIVER_BODY"
  http_code="$DELIVER_HTTP_CODE"
  if [[ "$http_code" == "200" ]]; then
    local dup; dup="$(echo "$resp" | jq -r '[.events[] | select(.status == "duplicate")] | length // 0')"
    local tot; tot="$(echo "$resp" | jq -r '.events | length // 0')"
    if [[ "$dup" -eq "$tot" && "$tot" -gt 0 ]]; then
      pass "Idempotent replay: $tot/$tot events returned status=duplicate (N1)"
      inc_pass
    else
      fail "Idempotent replay: $dup/$tot duplicates — expected all duplicates"
      inc_fail
    fi
  else
    fail "Idempotent replay: HTTP $http_code"
    inc_fail
  fi

  # 7b. Modified payload → conflict
  # Must modify a field the push normalizer includes in its stored payload
  # (commits[].message, not head_commit.message which the normalizer ignores).
  info "Testing idempotency conflict (modified payload)..."
  local modified="${SMOKE_TMP}/push-modified.json"
  jq 'if .commits and (.commits | length) > 0 then .commits[0].message = "MODIFIED — conflict test" else .head_commit.message = "MODIFIED" end' "$payload_file" > "$modified"

  deliver_payload "push" "$push_delivery" "$modified"
  resp="$DELIVER_BODY"
  http_code="$DELIVER_HTTP_CODE"
  if [[ "$http_code" == "409" ]]; then
    pass "Idempotency conflict: HTTP 409 (N1 — different hash correctly rejected)"
    inc_pass
  elif [[ "$http_code" == "200" ]]; then
    local dup2; dup2="$(echo "$resp" | jq -r '[.events[] | select(.status == "duplicate")] | length // 0')"
    fail "Idempotency conflict: HTTP 200 with $dup2 duplicate event(s) — expected HTTP 409"
    inc_fail
  else
    fail "Idempotency conflict: HTTP $http_code"
    inc_fail
  fi
  echo ""
}

# ── 8b. Redaction test (§5.3) ──────────────────────────────────────────────
# Verifies that <private> content is stripped before persistence.
# Uses a pull_request_review payload because the comment normalizer does NOT
# self-redact (unlike push/issue normalizers). This tests the actual redaction
# pipeline (red line 5.3: receive → validate → stripPrivateTags → persist).
test_redaction() {
  header "8b. Redaction Verification (§5.3)"

  if [[ "$HAS_HTTP_ENDPOINT" != "true" ]]; then
    warn "Redaction test skipped — HTTP webhook endpoint not available"
    info "This test validates the persist→stripPrivateTags pipeline (red line 5.3)"
    return
  fi

  local redact_ts="redact-${TIMESTAMP}"
  local redact_payload="${SMOKE_TMP}/redact-payload.json"

  # Synthetic pull_request_review payload with <private> content in the
  # review body. The comment normalizer (comments.ts) does NOT self-redact —
  # it relies on the ingestion pipeline's stripPrivateTags step (§5.3).
  # If <private> content leaks into the stored payload, redaction is broken.
  jq -n --arg ts "$redact_ts" '{
    action: "submitted",
    pull_request: {
      number: 99999,
      title: "Test PR",
      html_url: "https://github.com/test/repo/pull/99999",
      user: { login: "pr-author", id: 11111, type: "User" }
    },
    review: {
      id: 88888,
      body: "Public review start <private>SECRET_TOKEN=xyz789</private> public review end",
      html_url: "https://github.com/test/repo/pull/99999#pullrequestreview-88888",
      submitted_at: "2026-07-19T00:00:00Z",
      user: { login: "reviewer", id: 22222, type: "User" }
    },
    repository: {
      full_name: "test/repo",
      owner: { login: "test" },
      name: "repo"
    },
    sender: { login: "reviewer", id: 22222, type: "User" }
  }' > "$redact_payload"

  info "Delivering synthetic PR review payload with <private> tags..."
  deliver_payload "pull_request_review" "$redact_ts" "$redact_payload"
  local http_code="$DELIVER_HTTP_CODE"

  if [[ "$http_code" != "200" ]]; then
    fail "Redaction test: HTTP $http_code — cannot verify"
    inc_fail
    return
  fi

  local ingested_id
  ingested_id="$(echo "$DELIVER_BODY" | jq -r '.events[0].eventId // empty')"
  if [[ -z "$ingested_id" ]]; then
    fail "Redaction test: no event produced (may need pull_request_review support in endpoint)"
    inc_fail
    return
  fi

  info "  Event ID: $ingested_id"

  # Check via psql that <private> content was stripped from the stored payload.
  # The comment normalizer stores the review body in the payload; the ingestion
  # pipeline must have stripped <private> sections before persist (§5.3).
  local stored_body
  stored_body="$(psql "$DATABASE_URL" -t -A -c \
    "SELECT payload->>'body' FROM events WHERE id = '${ingested_id}'" 2>/dev/null || echo '')"

  if echo "$stored_body" | grep -q '<private>'; then
    fail "Redaction (§5.3): <private> tag LEAKED in stored review body — redaction pipeline broken"
    inc_fail
  elif echo "$stored_body" | grep -q 'SECRET_TOKEN'; then
    fail "Redaction (§5.3): SECRET_TOKEN leaked in stored body"
    inc_fail
  else
    pass "Redaction (§5.3): <private> content stripped from review body"
    inc_pass
    # Also verify the public parts survived
    if echo "$stored_body" | grep -q 'Public review start' && echo "$stored_body" | grep -q 'public review end'; then
      pass "Redaction (§5.3): public content preserved in review body"
      inc_pass
    fi
  fi

  # Cleanup the synthetic test row
  psql "$DATABASE_URL" -c "DELETE FROM events WHERE id = '${ingested_id}'" >/dev/null 2>&1 || true
  echo ""
}

# ── 9. Summary ─────────────────────────────────────────────────────────────
print_summary() {
  header "9. Smoke Test Summary"

  local pass_c fail_c total
  pass_c="$(get_pass)"; fail_c="$(get_fail)"; total=$((pass_c + fail_c))

  echo "  Total assertions: $total"
  printf "  ${GREEN}Passed: ${pass_c}${NC}\n"
  printf "  ${RED}Failed: ${fail_c}${NC}\n"
  echo ""

  # Show stored events
  if [[ -n "$DATABASE_URL" ]]; then
    info "Events stored in project '${SMOKE_PROJECT}':"
    psql "$DATABASE_URL" -c "
      SELECT kind, channel, source_event, source_action, actor_provenance,
             substring(external_id for 50) AS external_id_trunc,
             substring(url for 70) AS url_trunc
      FROM events
      WHERE project_id = '${SMOKE_PROJECT}' AND team_id = '${SMOKE_TEAM}'
      ORDER BY created_at DESC LIMIT 20
    " 2>/dev/null || echo "  (query failed)"
  fi
  echo ""

  if [[ "$fail_c" -eq 0 ]]; then
    pass "ALL CHECKS PASSED — M0 GitHub webhook smoke test successful"
  else
    fail "SOME CHECKS FAILED — see details above"
    exit 1
  fi
}

# ── Cleanup ─────────────────────────────────────────────────────────────────
cleanup_all() {
  header "Cleanup"

  # Delete the temporary GitHub webhook
  if [[ -n "${HOOK_ID:-}" ]]; then
    info "Deleting temporary webhook (ID: $HOOK_ID)..."
    gh api --method DELETE "repos/${GITHUB_REPO}/hooks/${HOOK_ID}" >/dev/null 2>&1 || true
    pass "Webhook deleted"
  fi

  # Clean up smoke test branch
  if [[ -n "${SMOKE_BRANCH:-}" ]]; then
    info "Deleting smoke test branch '${SMOKE_BRANCH}'..."
    gh api --method DELETE "repos/${GITHUB_REPO}/git/refs/heads/${SMOKE_BRANCH}" >/dev/null 2>&1 || true
  fi

  # Clean database (unless KEEP_DATA is set)
  if [[ "${KEEP_DATA}" != "true" ]]; then
    info "Cleaning database rows..."
    psql "$DATABASE_URL" -c "
      DELETE FROM job_events WHERE team_id = '${SMOKE_TEAM}' AND project_id = '${SMOKE_PROJECT}';
      DELETE FROM jobs WHERE team_id = '${SMOKE_TEAM}' AND project_id = '${SMOKE_PROJECT}';
      DELETE FROM events WHERE team_id = '${SMOKE_TEAM}' AND project_id = '${SMOKE_PROJECT}';
      DELETE FROM principals WHERE team_id = '${SMOKE_TEAM}';
    " >/dev/null 2>&1 || true
  else
    info "KEEP_DATA=true — database rows preserved"
  fi

  info "Smoke test completed at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo ""
}

# ── Main ───────────────────────────────────────────────────────────────────
main() {
  check_prereqs
  create_temp_webhook
  create_events
  fetch_deliveries
  ingest_payloads
  verify_api
  verify_psql
  verify_jobs
  test_idempotency
  test_redaction
  print_summary
  cleanup_all
}

main
