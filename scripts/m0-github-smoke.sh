#!/usr/bin/env bash
# M0 GitHub Webhook Smoke Test (AGPL-3.0-only)
#
# End-to-end smoke test that exercises the real GitHub → teamem webhook
# HTTP path. Creates real GitHub events (push, PR, issue, PR review
# comment) in a test repository, delivers them as webhooks to the running
# teamem server via curl, and verifies stored events through both the
# /v1/events API and direct PostgreSQL queries.
#
# Prerequisites:
#   - teamem server running with webhook routes enabled
#   - gh CLI authenticated with repo scope
#   - jq, curl, psql installed
#
# Configuration (all via environment variables):
#   TEAMEM_BASE_URL            — teamem server base URL (default: http://127.0.0.1:8080)
#   TEAMEM_GITHUB_REPO         — target repo in owner/name format (required)
#   TEAMEM_GITHUB_TOKEN        — GitHub PAT with repo scope (required for API calls)
#   TEAMEM_DATABASE_URL        — Postgres connection string (required for psql)
#   TEAMEM_WEBHOOK_SECRET      — webhook secret for HMAC signature (optional)
#   TEAMEM_SMOKE_KEEP_DATA     — keep DB rows after test (default: false)
#
# Safety:
#   - Creates events on a dedicated smoke-test branch to avoid pollution.
#   - PR, issue, and review are closed immediately after creation.
#   - Database rows use explicit smoke-test team/project IDs.
#
# Exit codes: 0 = all checks passed, 1 = failures detected.

set -euo pipefail

# ── Colour & output ────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; NC='\033[0m'
pass()  { printf "${GREEN}✓ PASS${NC} %s\n" "$*"; }
fail()  { printf "${RED}✗ FAIL${NC} %s\n" "$*"; }
info()  { printf "${BOLD}→${NC} %s\n" "$*"; }
warn()  { printf "${YELLOW}⚠ WARN${NC} %s\n" "$*"; }
header() {
  printf '\n%s\n' "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  printf "${BOLD}%s${NC}\n" "$*"
  printf '%s\n\n' "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

# ── Configuration ──────────────────────────────────────────────────────────
BASE_URL="${TEAMEM_BASE_URL:-http://127.0.0.1:8080}"
GITHUB_REPO="${TEAMEM_GITHUB_REPO:-}"
GITHUB_TOKEN="${TEAMEM_GITHUB_TOKEN:-}"
DATABASE_URL="${TEAMEM_DATABASE_URL:-}"
WEBHOOK_SECRET="${TEAMEM_WEBHOOK_SECRET:-}"
KEEP_DATA="${TEAMEM_SMOKE_KEEP_DATA:-false}"
TIMESTAMP="$(date +%Y%m%dT%H%M%S)"
SMOKE_BRANCH="m0-smoke-test-${TIMESTAMP}"

TMPDIR="${TMPDIR:-/tmp}"
SMOKE_TMP="$(mktemp -d "${TMPDIR}/teamem-smoke.XXXXXX")"
trap 'rm -rf "$SMOKE_TMP"' EXIT

# Counter files (avoid subshell issues with pipe-based counting)
PASS_FILE="${SMOKE_TMP}/pass-count"
FAIL_FILE="${SMOKE_TMP}/fail-count"
echo 0 > "$PASS_FILE"
echo 0 > "$FAIL_FILE"

inc_pass() { local c; c=$(cat "$PASS_FILE"); echo $((c + 1)) > "$PASS_FILE"; }
inc_fail() { local c; c=$(cat "$FAIL_FILE"); echo $((c + 1)) > "$FAIL_FILE"; }
get_pass() { cat "$PASS_FILE"; }
get_fail() { cat "$FAIL_FILE"; }

# ── Prerequisite checks ────────────────────────────────────────────────────
check_prereqs() {
  header "M0 GitHub Webhook Smoke Test — $(date -u +%Y-%m-%dT%H:%M:%SZ)"

  local missing=0
  for cmd in gh jq curl psql; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      fail "Required command not found: $cmd"
      missing=1
    else
      info "Found: $cmd"
    fi
  done

  if [[ -z "$GITHUB_REPO" ]]; then
    fail "TEAMEM_GITHUB_REPO is not set (required: owner/repo format)"
    missing=1
  else
    info "Target repository: $GITHUB_REPO"
  fi

  if [[ -z "$GITHUB_TOKEN" ]]; then
    fail "TEAMEM_GITHUB_TOKEN is not set (required: GitHub PAT with repo scope)"
    missing=1
  else
    info "GitHub token: ${GITHUB_TOKEN:0:8}..."
  fi

  if [[ -z "$DATABASE_URL" ]]; then
    fail "TEAMEM_DATABASE_URL is not set (required)"
    missing=1
  else
    info "Database URL: ${DATABASE_URL%%@*}@***"
  fi

  # Check server is reachable
  if ! curl -fsS "${BASE_URL}/healthz" >/dev/null 2>&1; then
    fail "Server not reachable at ${BASE_URL}/healthz — start the teamem server first"
    missing=1
  else
    pass "Server reachable at ${BASE_URL}"
  fi

  # Check webhook endpoint exists
  local wh_status
  wh_status="$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/v1/events/github" -X POST -d '{}' -H 'Content-Type: application/json' 2>/dev/null || echo '000')"
  if [[ "$wh_status" == "404" ]]; then
    fail "Webhook endpoint ${BASE_URL}/v1/events/github returned 404 — webhook route may not be enabled"
    missing=1
  else
    info "Webhook endpoint status (dry POST): ${wh_status}"
  fi

  # Check database connectivity
  if ! psql "$DATABASE_URL" -c 'SELECT 1' >/dev/null 2>&1; then
    fail "Cannot connect to database"
    missing=1
  else
    pass "Database connectivity verified"
  fi

  # Verify gh is authenticated
  export GH_TOKEN="$GITHUB_TOKEN"
  if ! gh repo view "$GITHUB_REPO" >/dev/null 2>&1; then
    fail "Cannot access repository '$GITHUB_REPO' via gh CLI"
    missing=1
  else
    pass "gh CLI authenticated and can access $GITHUB_REPO"
  fi

  if [[ "$missing" -ne 0 ]]; then
    echo ""
    echo "Fix the failures above and re-run."
    exit 1
  fi

  # Derive webhook signing info
  if [[ -n "$WEBHOOK_SECRET" ]]; then
    info "Webhook signature verification: ENABLED"
  else
    info "Webhook signature verification: DISABLED (no TEAMEM_WEBHOOK_SECRET set)"
    info "  → actor provenance will be 'unknown' (not 'webhook_verified') — this is expected."
    info "  → Set TEAMEM_WEBHOOK_SECRET to test the full signature-verified path."
  fi

  info "All prerequisites met"
  echo ""
}

# ── Compute HMAC-SHA256 signature for GitHub webhook ──────────────────────
# Usage: sign_webhook <secret> <payload-file>
# Output: sha256=<hex>
sign_webhook() {
  local secret="$1"
  local payload_file="$2"
  local raw_sig
  raw_sig="$(openssl dgst -sha256 -hmac "$secret" -binary "$payload_file" | xxd -p -c 256)"
  echo "sha256=${raw_sig}"
}

# ── Deliver a webhook payload to the server ────────────────────────────────
# Usage: deliver_webhook <event-type> <delivery-id> <payload-file>
# Output: JSON response from server on stdout
deliver_webhook() {
  local github_event="$1"
  local delivery_id="$2"
  local payload_file="$3"

  local curl_args=(
    -s -w '\n%{http_code}'
    -X POST "${BASE_URL}/v1/events/github"
    -H "Content-Type: application/json"
    -H "X-GitHub-Event: ${github_event}"
    -H "X-GitHub-Delivery: ${delivery_id}"
    --data-binary "@${payload_file}"
  )

  if [[ -n "$WEBHOOK_SECRET" ]]; then
    local sig
    sig="$(sign_webhook "$WEBHOOK_SECRET" "$payload_file")"
    curl_args+=(-H "X-Hub-Signature-256: ${sig}")
  fi

  curl "${curl_args[@]}" 2>/dev/null
}

# ── Verify an assertion ────────────────────────────────────────────────────
assert() {
  local description="$1"
  local condition="$2"
  local detail="${3:-}"

  if eval "$condition"; then
    pass "$description"
    inc_pass
  else
    fail "$description"
    if [[ -n "$detail" ]]; then
      printf "    ${RED}Detail: %s${NC}\n" "$detail"
    fi
    inc_fail
  fi
}

# ── Query events via API ──────────────────────────────────────────────────
query_api() {
  local kind_filter="${1:-}"
  local url="${BASE_URL}/v1/events?limit=50"
  if [[ -n "$kind_filter" ]]; then
    url="${url}&kind=${kind_filter}"
  fi
  curl -s "$url" 2>/dev/null
}

# ── Query events via psql ─────────────────────────────────────────────────
query_psql() {
  psql "$DATABASE_URL" -t -A -F'|' -c "$1" 2>/dev/null
}

# ── Get the authenticated GitHub user info ─────────────────────────────────
get_github_user() {
  gh api user --jq '{login: .login, id: (.id | tonumber), type: "User"}'
}

# ── 1. Create real GitHub events and deliver as webhooks ───────────────────
create_and_deliver_events() {
  header "1. Creating Real GitHub Events & Delivering Webhooks"

  local github_user
  github_user="$(get_github_user)"
  info "Authenticated GitHub user: $(echo "$github_user" | jq -r '.login')"

  local default_branch base_sha
  default_branch="$(gh api "repos/${GITHUB_REPO}" --jq '.default_branch')"
  base_sha="$(gh api "repos/${GITHUB_REPO}/git/refs/heads/${default_branch}" --jq '.object.sha')"
  info "Default branch: $default_branch ($base_sha)"

  # ── 1a. Push webhook ──────────────────────────────────────────────────
  info "Creating push on smoke-test branch '${SMOKE_BRANCH}'..."

  # Create blob → tree → commit → ref
  local blob_sha tree_sha commit_sha
  blob_sha="$(gh api "repos/${GITHUB_REPO}/git/blobs" \
    -f content="M0 smoke test commit ${TIMESTAMP}" \
    -f encoding=utf-8 --jq '.sha')"

  tree_sha="$(gh api "repos/${GITHUB_REPO}/git/trees" \
    -f "tree[0][path]=m0-smoke-test-${TIMESTAMP}.md" \
    -f "tree[0][mode]=100644" -f "tree[0][type]=blob" -f "tree[0][sha]=${blob_sha}" \
    -f "base_tree=${base_sha}" --jq '.sha')"

  commit_sha="$(gh api "repos/${GITHUB_REPO}/git/commits" \
    -f message="M0 smoke test commit — ${TIMESTAMP}" \
    -f "tree=${tree_sha}" -f "parents[]=${base_sha}" --jq '.sha')"

  gh api "repos/${GITHUB_REPO}/git/refs" \
    -f "ref=refs/heads/${SMOKE_BRANCH}" -f "sha=${commit_sha}" >/dev/null 2>&1

  # Get commit details for a real push payload shape
  local commit_data repo_data
  commit_data="$(gh api "repos/${GITHUB_REPO}/git/commits/${commit_sha}")"
  repo_data="$(gh api "repos/${GITHUB_REPO}")"

  local commit_date
  commit_date="$(echo "$commit_data" | jq -r '.committer.date')"

  # Build the push webhook payload — this IS the shape GitHub sends
  jq -n \
    --arg ref "refs/heads/${SMOKE_BRANCH}" \
    --arg before "$base_sha" \
    --arg after "$commit_sha" \
    --argjson repo "$repo_data" \
    --argjson sender "$github_user" \
    --arg sha "$commit_sha" \
    --arg message "M0 smoke test commit — ${TIMESTAMP}" \
    --arg timestamp "$commit_date" \
    '{
      ref: $ref,
      before: $before,
      after: $after,
      created: false, deleted: false, forced: false,
      repository: $repo,
      sender: $sender,
      pusher: { name: $sender.login, email: ($sender.login + "@users.noreply.github.com") },
      commits: [{
        id: $sha,
        timestamp: $timestamp,
        message: $message,
        url: ("https://github.com/" + $repo.full_name + "/commit/" + $sha),
        author: { name: $sender.login, email: ($sender.login + "@users.noreply.github.com"), username: $sender.login },
        committer: { name: $sender.login, email: ($sender.login + "@users.noreply.github.com"), username: $sender.login },
        distinct: true
      }],
      head_commit: {
        id: $sha, timestamp: $timestamp, message: $message,
        url: ("https://github.com/" + $repo.full_name + "/commit/" + $sha),
        author: { name: $sender.login, email: ($sender.login + "@users.noreply.github.com"), username: $sender.login },
        committer: { name: $sender.login, email: ($sender.login + "@users.noreply.github.com"), username: $sender.login }
      }
    }' > "${SMOKE_TMP}/push-payload.json"

  local push_delivery="smoke-push-${TIMESTAMP}"
  local push_response push_http_code
  push_response="$(deliver_webhook "push" "$push_delivery" "${SMOKE_TMP}/push-payload.json")"
  push_http_code="$(echo "$push_response" | tail -1)"
  push_response="$(echo "$push_response" | sed '$d')"

  if [[ "$push_http_code" == "200" ]]; then
    local push_count
    push_count="$(echo "$push_response" | jq -r '.events | length // 0')"
    pass "Push webhook: HTTP $push_http_code, $push_count event(s) ingested"
    inc_pass
    echo "$push_response" | jq '.events[] | "    eventId=\(.eventId) status=\(.status) channel=\(.channel) kind=\(.kind)"' -r
  else
    fail "Push webhook: HTTP $push_http_code"
    echo "    Response: $push_response"
    inc_fail
  fi
  echo ""

  # ── 1b. Issue webhook ─────────────────────────────────────────────────
  info "Creating issue..."
  local issue_number
  gh issue create --repo "$GITHUB_REPO" \
    --title "M0 Smoke Test Issue — ${TIMESTAMP}" \
    --body "Smoke test issue for teamem webhook verification." \
    --label "bug" >/dev/null 2>&1

  issue_number="$(gh issue list --repo "$GITHUB_REPO" \
    --search "M0 Smoke Test Issue — ${TIMESTAMP}" \
    --json number --jq '.[0].number')"
  info "  Issue: #${issue_number}"

  local issue_data
  issue_data="$(gh api "repos/${GITHUB_REPO}/issues/${issue_number}")"

  # Build issues webhook payload
  jq -n \
    --arg action "opened" \
    --argjson issue "$issue_data" \
    --argjson repository "$repo_data" \
    --argjson sender "$github_user" \
    '{ action: $action, issue: $issue, repository: $repository, sender: $sender }' \
    > "${SMOKE_TMP}/issues-payload.json"

  local issue_delivery="smoke-issue-${TIMESTAMP}"
  local issue_response issue_http_code
  issue_response="$(deliver_webhook "issues" "$issue_delivery" "${SMOKE_TMP}/issues-payload.json")"
  issue_http_code="$(echo "$issue_response" | tail -1)"
  issue_response="$(echo "$issue_response" | sed '$d')"

  if [[ "$issue_http_code" == "200" ]]; then
    pass "Issue webhook: HTTP $issue_http_code"
    inc_pass
    echo "$issue_response" | jq '.events[] | "    eventId=\(.eventId) status=\(.status) kind=\(.kind)"' -r
  else
    fail "Issue webhook: HTTP $issue_http_code"
    echo "    Response: $issue_response"
    inc_fail
  fi
  gh issue close "$issue_number" --repo "$GITHUB_REPO" >/dev/null 2>&1 || true
  echo ""

  # ── 1c. Pull Request webhook ──────────────────────────────────────────
  info "Creating PR from ${SMOKE_BRANCH} to ${default_branch}..."
  local pr_number pr_url
  pr_url="$(gh pr create --repo "$GITHUB_REPO" \
    --head "$SMOKE_BRANCH" --base "$default_branch" \
    --title "M0 Smoke Test PR — ${TIMESTAMP}" \
    --body "Smoke test PR for teamem webhook verification." 2>/dev/null)" || true

  pr_number="$(echo "$pr_url" | grep -oE '[0-9]+$' || echo "")"
  if [[ -z "$pr_number" ]]; then
    pr_number="$(gh pr list --repo "$GITHUB_REPO" --head "$SMOKE_BRANCH" --json number --jq '.[0].number' 2>/dev/null || echo "")"
  fi
  if [[ -z "$pr_number" ]]; then
    fail "PR: could not create or find PR"
    inc_fail
  else
    info "  PR: #${pr_number}"
    local pr_data
    pr_data="$(gh api "repos/${GITHUB_REPO}/pulls/${pr_number}")"

    jq -n \
      --arg action "opened" \
      --argjson pull_request "$pr_data" \
      --argjson repository "$repo_data" \
      --argjson sender "$github_user" \
      '{ action: $action, pull_request: $pull_request, repository: $repository, sender: $sender }' \
      > "${SMOKE_TMP}/pr-payload.json"

    local pr_delivery="smoke-pr-${TIMESTAMP}"
    local pr_response pr_http_code
    pr_response="$(deliver_webhook "pull_request" "$pr_delivery" "${SMOKE_TMP}/pr-payload.json")"
    pr_http_code="$(echo "$pr_response" | tail -1)"
    pr_response="$(echo "$pr_response" | sed '$d')"

    if [[ "$pr_http_code" == "200" ]]; then
      pass "PR webhook: HTTP $pr_http_code"
      inc_pass
      echo "$pr_response" | jq '.events[] | "    eventId=\(.eventId) status=\(.status) kind=\(.kind)"' -r
    else
      fail "PR webhook: HTTP $pr_http_code"
      echo "    Response: $pr_response"
      inc_fail
    fi
  fi
  echo ""

  # ── 1d. PR Review webhook ─────────────────────────────────────────────
  if [[ -n "${pr_number:-}" ]]; then
    info "Creating PR review on #${pr_number}..."
    local review_result review_id
    review_result="$(gh api "repos/${GITHUB_REPO}/pulls/${pr_number}/reviews" \
      -f event="COMMENT" \
      -f body="M0 smoke test review — ${TIMESTAMP}" 2>/dev/null)" || true

    review_id="$(echo "$review_result" | jq -r '.id // empty')"

    if [[ -n "$review_id" ]]; then
      info "  Review ID: $review_id"
      local review_data
      review_data="$(gh api "repos/${GITHUB_REPO}/pulls/${pr_number}/reviews/${review_id}")"

      jq -n \
        --arg action "submitted" \
        --argjson review "$review_data" \
        --argjson pull_request "$(gh api "repos/${GITHUB_REPO}/pulls/${pr_number}")" \
        --argjson repository "$repo_data" \
        --argjson sender "$github_user" \
        '{ action: $action, review: $review, pull_request: $pull_request, repository: $repository, sender: $sender }' \
        > "${SMOKE_TMP}/review-payload.json"

      local review_delivery="smoke-review-${TIMESTAMP}"
      local review_response review_http_code
      review_response="$(deliver_webhook "pull_request_review" "$review_delivery" "${SMOKE_TMP}/review-payload.json")"
      review_http_code="$(echo "$review_response" | tail -1)"
      review_response="$(echo "$review_response" | sed '$d')"

      if [[ "$review_http_code" == "200" ]]; then
        pass "PR review webhook: HTTP $review_http_code"
        inc_pass
        echo "$review_response" | jq '.events[] | "    eventId=\(.eventId) status=\(.status) kind=\(.kind)"' -r
      else
        fail "PR review webhook: HTTP $review_http_code"
        echo "    Response: $review_response"
        inc_fail
      fi
    else
      fail "PR review: could not create review (this is required for the smoke test)"
      inc_fail
    fi

    gh pr close "$pr_number" --repo "$GITHUB_REPO" >/dev/null 2>&1 || true
  else
    fail "PR review: skipped because no PR was created"
    inc_fail
  fi
  echo ""

  # Clean up the smoke test branch
  if [[ -n "${SMOKE_BRANCH:-}" ]]; then
    info "Cleaning up smoke test branch '${SMOKE_BRANCH}'..."
    gh api --method DELETE "repos/${GITHUB_REPO}/git/refs/heads/${SMOKE_BRANCH}" >/dev/null 2>&1 || true
  fi
}

# ── 2. Verify stored events via API ──────────────────────────────────────
verify_via_api() {
  header "2. Verification via ${BASE_URL}/v1/events"

  info "Fetching all events via API..."
  local api_response
  api_response="$(query_api)"
  local api_total
  api_total="$(echo "$api_response" | jq -r '.total // 0')"
  info "  Total events: $api_total"

  if [[ "$api_total" -eq 0 ]]; then
    fail "API returned 0 events — webhook delivery may have failed"
    inc_fail
    return
  fi

  # Verify each expected kind
  for expected_kind in github_commit github_issue github_pr github_pr_comment; do
    local kind_response kind_count
    kind_response="$(query_api "$expected_kind")"
    kind_count="$(echo "$kind_response" | jq -r '.total // 0')"

    if [[ "$kind_count" -gt 0 ]]; then
      pass "API: found $kind_count ${expected_kind} event(s)"
      inc_pass

      # Verify structure of first event
      local first_event
      first_event="$(echo "$kind_response" | jq '.events[0]')"

      assert "  ${expected_kind}: channel is set" \
        "[ \"$(echo "$first_event" | jq -r '.channel')\" = \"github\" ]" \
        "channel=$(echo "$first_event" | jq -r '.channel')"

      assert "  ${expected_kind}: kind matches" \
        "[ \"$(echo "$first_event" | jq -r '.kind')\" = \"${expected_kind}\" ]"

      assert "  ${expected_kind}: url is not empty" \
        "[ -n \"$(echo "$first_event" | jq -r '.url // ""')\" ]" \
        "url=$(echo "$first_event" | jq -r '.url')"

      assert "  ${expected_kind}: deliveryId is not empty" \
        "[ -n \"$(echo "$first_event" | jq -r '.deliveryId // ""')\" ]"

      assert "  ${expected_kind}: itemKey is not empty" \
        "[ -n \"$(echo "$first_event" | jq -r '.itemKey // ""')\" ]"

      assert "  ${expected_kind}: externalId is not empty" \
        "[ -n \"$(echo "$first_event" | jq -r '.externalId // ""')\" ]"

      # Actor provenance: webhook_verified if secret was configured, else unknown
      local expected_prov
      expected_prov="unknown"
      if [[ -n "$WEBHOOK_SECRET" ]]; then
        expected_prov="webhook_verified"
      fi
      assert "  ${expected_kind}: actorProvenance is ${expected_prov}" \
        "[ \"$(echo "$first_event" | jq -r '.actorProvenance')\" = \"${expected_prov}\" ]" \
        "actual=$(echo "$first_event" | jq -r '.actorProvenance')"

    else
      fail "API: no ${expected_kind} events found"
      inc_fail
    fi
  done
  echo ""
}

# ── 3. Verify stored events via psql ──────────────────────────────────────
verify_via_psql() {
  header "3. Verification via PostgreSQL"

  info "Event counts by kind:"
  local psql_counts
  if ! psql_counts="$(query_psql "
    SELECT kind, count(*)::text AS cnt
    FROM events
    WHERE project_id = 'prj_default' AND team_id = 'team_default'
    GROUP BY kind ORDER BY kind
  ")"; then
    fail "psql query failed (event counts)"
    inc_fail
    return
  fi

  if [[ -z "$psql_counts" ]]; then
    fail "psql: no events found in database"
    inc_fail
    return
  fi

  echo "$psql_counts" | while IFS='|' read -r kind cnt; do
    info "  $kind: $cnt"
  done
  echo ""

  # Verify push events
  info "Verifying github_commit events..."
  local push_rows
  if push_rows="$(query_psql "
    SELECT id, channel, kind, source_event, delivery_id, item_key,
           external_id, url, actor_provenance, occurred_at_provenance,
           occurred_at, actor
    FROM events
    WHERE project_id = 'prj_default' AND team_id = 'team_default'
      AND kind = 'github_commit'
    ORDER BY created_at DESC LIMIT 3
  ")"; then

    if [[ -z "$push_rows" ]]; then
      fail "psql: no github_commit events"
      inc_fail
    else
      local expected_prov
      expected_prov="unknown"
      [[ -n "$WEBHOOK_SECRET" ]] && expected_prov="webhook_verified"

      echo "$push_rows" | while IFS='|' read -r id channel kind source_event delivery_id item_key external_id url actor_prov occurred_at_prov occurred_at actor; do
        assert "push: channel=github ($id)" "[ \"$channel\" = \"github\" ]"
        assert "push: source_event=push ($id)" "[ \"$source_event\" = \"push\" ]"
        assert "push: url starts with https://github.com ($id)" "[[ \"$url\" == https://github.com/* ]]"
        assert "push: item_key=commit SHA ($id)" "[ \"\${#item_key}\" -ge 40 ]"
        assert "push: actor_provenance=$expected_prov ($id)" "[ \"$actor_prov\" = \"$expected_prov\" ]"
        assert "push: occurred_at_provenance=provider ($id)" "[ \"$occurred_at_prov\" = \"provider\" ]"
      done
    fi
  else
    fail "psql query for github_commit failed"
    inc_fail
  fi

  # Verify issue events
  info "Verifying github_issue events..."
  local issue_rows
  if issue_rows="$(query_psql "
    SELECT id, channel, kind, source_event, source_action, url, actor_provenance
    FROM events
    WHERE project_id = 'prj_default' AND team_id = 'team_default'
      AND kind = 'github_issue'
    ORDER BY created_at DESC LIMIT 3
  ")"; then
    if [[ -z "$issue_rows" ]]; then
      fail "psql: no github_issue events"
      inc_fail
    else
      echo "$issue_rows" | while IFS='|' read -r id channel kind source_event source_action url actor_prov; do
        assert "issue: channel=github ($id)" "[ \"$channel\" = \"github\" ]"
        assert "issue: source_event=issues ($id)" "[ \"$source_event\" = \"issues\" ]"
        assert "issue: source_action is set ($id)" "[ -n \"$source_action\" ]"
        assert "issue: url points to issue ($id)" "[[ \"$url\" == */issues/* ]]"
      done
    fi
  else
    fail "psql query for github_issue failed"
    inc_fail
  fi

  # Verify PR events
  info "Verifying github_pr events..."
  local pr_rows
  if pr_rows="$(query_psql "
    SELECT id, channel, kind, source_event, source_action, url, actor_provenance
    FROM events
    WHERE project_id = 'prj_default' AND team_id = 'team_default'
      AND kind = 'github_pr'
    ORDER BY created_at DESC LIMIT 3
  ")"; then
    if [[ -z "$pr_rows" ]]; then
      fail "psql: no github_pr events"
      inc_fail
    else
      echo "$pr_rows" | while IFS='|' read -r id channel kind source_event source_action url actor_prov; do
        assert "pr: channel=github ($id)" "[ \"$channel\" = \"github\" ]"
        assert "pr: source_event=pull_request ($id)" "[ \"$source_event\" = \"pull_request\" ]"
        assert "pr: source_action is set ($id)" "[ -n \"$source_action\" ]"
        assert "pr: url points to PR ($id)" "[[ \"$url\" == */pull/* ]]"
      done
    fi
  else
    fail "psql query for github_pr failed"
    inc_fail
  fi

  # Verify PR comment events
  info "Verifying github_pr_comment events..."
  local comment_rows
  if comment_rows="$(query_psql "
    SELECT id, channel, kind, source_event, source_action, url, actor_provenance
    FROM events
    WHERE project_id = 'prj_default' AND team_id = 'team_default'
      AND kind = 'github_pr_comment'
    ORDER BY created_at DESC LIMIT 3
  ")"; then
    if [[ -z "$comment_rows" ]]; then
      fail "psql: no github_pr_comment events"
      inc_fail
    else
      echo "$comment_rows" | while IFS='|' read -r id channel kind source_event source_action url actor_prov; do
        assert "comment: channel=github ($id)" "[ \"$channel\" = \"github\" ]"
        assert "comment: source_event is set ($id)" "[ -n \"$source_event\" ]"
        assert "comment: source_action is set ($id)" "[ -n \"$source_action\" ]"
        assert "comment: url has # anchor ($id)" "[[ \"$url\" == *\"#\"* ]]"
      done
    fi
  else
    fail "psql query for github_pr_comment failed"
    inc_fail
  fi

  echo ""
}

# ── 4. Idempotency test ──────────────────────────────────────────────────
test_idempotency() {
  header "4. Idempotency Test"

  info "Re-delivering the same push webhook to verify idempotent replay (N1)..."

  local push_payload="${SMOKE_TMP}/push-payload.json"
  if [[ ! -f "$push_payload" ]]; then
    fail "No push payload for idempotency test"
    inc_fail
    return
  fi

  local push_delivery="smoke-push-${TIMESTAMP}"
  local replay_response replay_http_code
  replay_response="$(deliver_webhook "push" "$push_delivery" "$push_payload")"
  replay_http_code="$(echo "$replay_response" | tail -1)"
  replay_response="$(echo "$replay_response" | sed '$d')"

  if [[ "$replay_http_code" == "200" ]]; then
    local dup_count
    dup_count="$(echo "$replay_response" | jq -r '[.events[] | select(.status == "duplicate")] | length')"
    local total_count
    total_count="$(echo "$replay_response" | jq -r '.events | length')"

    if [[ "$dup_count" -eq "$total_count" && "$total_count" -gt 0 ]]; then
      pass "Idempotent replay: all $total_count event(s) returned status=duplicate (N1)"
      inc_pass
    else
      fail "Idempotent replay: $dup_count/$total_count duplicates — expected all duplicates"
      inc_fail
    fi
  else
    fail "Idempotent replay: HTTP $replay_http_code"
    echo "    Response: $replay_response"
    inc_fail
  fi

  # ── 4b. Conflict test ───────────────────────────────────────────────────
  info "Testing idempotency conflict: same delivery ID, modified payload..."

  jq '.commits[0].message = "MODIFIED — different payload for conflict test"' \
    "$push_payload" > "${SMOKE_TMP}/push-modified.json"

  local conflict_response conflict_http_code
  conflict_response="$(deliver_webhook "push" "$push_delivery" "${SMOKE_TMP}/push-modified.json")"
  conflict_http_code="$(echo "$conflict_response" | tail -1)"
  conflict_response="$(echo "$conflict_response" | sed '$d')"

  if [[ "$conflict_http_code" == "409" ]]; then
    pass "Idempotency conflict: HTTP 409 (N1 — different hash correctly rejected)"
    inc_pass
  else
    fail "Idempotency conflict: expected HTTP 409, got $conflict_http_code"
    echo "    Response: $conflict_response"
    inc_fail
  fi

  echo ""
}

# ── 5. Summary ────────────────────────────────────────────────────────────
print_summary() {
  header "5. Smoke Test Summary"

  local pass_c fail_c total
  pass_c="$(get_pass)"
  fail_c="$(get_fail)"
  total=$((pass_c + fail_c))

  echo "  Total assertions: $total"
  printf "  ${GREEN}Passed: ${pass_c}${NC}\n"
  printf "  ${RED}Failed: ${fail_c}${NC}\n"
  echo ""

  if [[ "$fail_c" -eq 0 ]]; then
    pass "ALL CHECKS PASSED — M0 GitHub webhook smoke test successful"
  else
    fail "SOME CHECKS FAILED — see details above"
    exit 1
  fi
}

# ── Cleanup ────────────────────────────────────────────────────────────────
cleanup_data() {
  if [[ "${KEEP_DATA}" != "true" ]]; then
    info "Cleaning up smoke test data from database..."
    psql "$DATABASE_URL" -c "
      DELETE FROM job_events WHERE team_id = 'team_default' AND project_id = 'prj_default';
      DELETE FROM jobs WHERE team_id = 'team_default' AND project_id = 'prj_default';
      DELETE FROM events WHERE team_id = 'team_default' AND project_id = 'prj_default';
      DELETE FROM principals WHERE team_id = 'team_default';
    " >/dev/null 2>&1 || true
  else
    info "KEEP_DATA=true — database rows preserved"
  fi
  echo ""
  info "Smoke test completed at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
}

# ── Main ───────────────────────────────────────────────────────────────────
main() {
  check_prereqs
  create_and_deliver_events
  verify_via_api
  verify_via_psql
  test_idempotency
  print_summary
  cleanup_data
}

main
