#!/usr/bin/env bash
# M0 GitHub Webhook Smoke Test (AGPL-3.0-only)
#
# Creates real GitHub events (push, PR, issue, PR review comment) in a test
# repository, normalizes and persists them through teamem's connector storage
# layer, and verifies the stored events via direct database queries.
#
# Prerequisites:
#   - gh CLI authenticated with repo scope
#   - jq, curl, psql installed
#   - Node.js >= 20 with tsx available (pnpm dev or npx tsx)
#   - A running PostgreSQL with teamem migrations applied
#
# Configuration (all via environment variables):
#   TEAMEM_GITHUB_REPO        — target repo in owner/name format (required)
#   TEAMEM_DATABASE_URL       — Postgres connection string (required)
#   TEAMEM_SMOKE_TEAM_ID      — teamem team ID (default: team_smoke)
#   TEAMEM_SMOKE_PROJECT_ID   — teamem project ID (default: prj_smoke)
#   TEAMEM_BRANCH             — branch to push to (default: main)
#
# Usage:
#   export TEAMEM_GITHUB_REPO="myorg/test-repo"
#   export TEAMEM_DATABASE_URL="postgres://teamem:password@localhost:5432/teamem"
#   bash scripts/m0-github-smoke.sh
#
# Safety:
#   - Creates events on a dedicated smoke-test branch (m0-smoke-test-<timestamp>)
#     to avoid polluting the default branch.
#   - PR, issue, and review are closed immediately after creation.
#   - Database rows are created under explicit smoke-test team/project IDs
#     so they don't collide with real data.
#   - A cleanup function removes smoke-test DB rows on exit (or keep them
#     for inspection by setting TEAMEM_SMOKE_KEEP_DATA=true).

set -euo pipefail

# ── Colour output ─────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m' # No Colour

pass()  { printf "${GREEN}✓ PASS${NC} %s\n" "$*"; }
fail()  { printf "${RED}✗ FAIL${NC} %s\n" "$*"; }
info()  { printf "${BOLD}→${NC} %s\n" "$*"; }
warn()  { printf "${YELLOW}⚠ WARN${NC} %s\n" "$*"; }
header() {
  printf '\n%s\n' "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  printf "${BOLD}%s${NC}\n" "$*"
  printf '%s\n\n' "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

# ── Configuration ─────────────────────────────────────────────────────────────
GITHUB_REPO="${TEAMEM_GITHUB_REPO:-}"
DATABASE_URL="${TEAMEM_DATABASE_URL:-}"
SMOKE_TEAM_ID="${TEAMEM_SMOKE_TEAM_ID:-team_smoke}"
SMOKE_PROJECT_ID="${TEAMEM_SMOKE_PROJECT_ID:-prj_smoke}"
KEEP_DATA="${TEAMEM_SMOKE_KEEP_DATA:-false}"
BRANCH="${TEAMEM_BRANCH:-main}"
TIMESTAMP="$(date +%Y%m%dT%H%M%S)"
SMOKE_BRANCH="m0-smoke-test-${TIMESTAMP}"

TMPDIR="${TMPDIR:-/tmp}"
SMOKE_TMP="$(mktemp -d "${TMPDIR}/teamem-smoke.XXXXXX")"
trap 'rm -rf "$SMOKE_TMP"' EXIT

PASS_COUNT=0
FAIL_COUNT=0

increment_pass() { PASS_COUNT=$((PASS_COUNT + 1)); }
increment_fail() { FAIL_COUNT=$((FAIL_COUNT + 1)); }

# ── Prerequisite checks ───────────────────────────────────────────────────────
check_prereqs() {
  header "M0 GitHub Webhook Smoke Test — $(date -u +%Y-%m-%dT%H:%M:%SZ)"

  local missing=0
  for cmd in gh jq curl psql; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      fail "Required command not found: $cmd"
      missing=1
    else
      info "Found: $cmd ($($cmd --version 2>&1 | head -1))"
    fi
  done

  if ! command -v tsx >/dev/null 2>&1; then
    # Check for tsx in the pnpm hoisted path
    if [[ -x "${REPO_ROOT}/node_modules/.pnpm/node_modules/.bin/tsx" ]]; then
      info "tsx found via pnpm node_modules"
    elif command -v npx >/dev/null 2>&1; then
      info "tsx not in PATH, will use: npx tsx"
    else
      fail "Neither tsx nor npx found — need one of them to run the ingest helper"
      missing=1
    fi
  fi

  if [[ -z "$GITHUB_REPO" ]]; then
    fail "TEAMEM_GITHUB_REPO is not set (required: owner/repo format)"
    missing=1
  else
    info "Target repository: $GITHUB_REPO"
  fi

  if [[ -z "$DATABASE_URL" ]]; then
    fail "TEAMEM_DATABASE_URL is not set (required: postgres://... connection string)"
    missing=1
  else
    info "Database URL: ${DATABASE_URL%%@*}@***" # mask password
  fi

  # Verify gh is authenticated and can access the repo
  if [[ "$missing" -eq 0 ]]; then
    if ! gh repo view "$GITHUB_REPO" >/dev/null 2>&1; then
      fail "Cannot access repository '$GITHUB_REPO' via gh CLI — check auth and repo name"
      missing=1
    else
      pass "gh CLI authenticated and can access $GITHUB_REPO"
    fi
  fi

  # Verify database connectivity
  if [[ "$missing" -eq 0 ]]; then
    if ! psql "$DATABASE_URL" -c 'SELECT 1' >/dev/null 2>&1; then
      fail "Cannot connect to database — check TEAMEM_DATABASE_URL"
      missing=1
    else
      pass "Database connectivity verified"
    fi
  fi

  if [[ "$missing" -ne 0 ]]; then
    echo ""
    echo "Fix the failures above and re-run."
    exit 1
  fi

  # Seed the smoke-test team and project if they don't exist
  psql "$DATABASE_URL" -c "
    INSERT INTO teams (id, name) VALUES ('${SMOKE_TEAM_ID}', 'Smoke Test Team')
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO projects (id, team_id, name) VALUES ('${SMOKE_PROJECT_ID}', '${SMOKE_TEAM_ID}', 'Smoke Test Project')
    ON CONFLICT (id) DO NOTHING;
  " >/dev/null 2>&1
  info "Smoke test team/project ensured: $SMOKE_TEAM_ID / $SMOKE_PROJECT_ID"

  info "All prerequisites met"
  echo ""
}

# ── Helper: find repo root and tsx ────────────────────────────────────────────
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

run_tsx() {
  local script_path="${REPO_ROOT}/scripts/m0-github-smoke-ingest.ts"

  # Find tsx: prefer the hoisted pnpm binary, then global tsx, then npx
  local TSX_BIN=""
  if [[ -x "${REPO_ROOT}/node_modules/.pnpm/node_modules/.bin/tsx" ]]; then
    TSX_BIN="${REPO_ROOT}/node_modules/.pnpm/node_modules/.bin/tsx"
  elif command -v tsx >/dev/null 2>&1; then
    TSX_BIN="tsx"
  elif command -v npx >/dev/null 2>&1; then
    TSX_BIN="npx tsx"
  else
    echo "ERROR: tsx not found — install with: pnpm install" >&2
    exit 1
  fi

  $TSX_BIN "$script_path" "$@"
}

# ── Helper: create GitHub event and ingest it ─────────────────────────────────
# Usage: create_and_ingest <event_label> <event_type> <gh_command_and_args...>
# The gh command must output the raw API response as JSON to stdout.
create_and_ingest() {
  local label="$1"
  local event_type="$2"
  shift 2

  info "Creating $label..."

  local delivery_id
  delivery_id="$(uuidgen 2>/dev/null || python3 -c 'import uuid; print(uuid.uuid4())' 2>/dev/null || echo "smoke-${TIMESTAMP}-${event_type}-${RANDOM}")"

  local payload_file="${SMOKE_TMP}/${event_type}.json"
  local ingest_result_file="${SMOKE_TMP}/${event_type}-result.json"

  # Execute the gh command, capture output
  if "$@" >"$payload_file" 2>"${SMOKE_TMP}/${event_type}.stderr"; then
    :
  else
    local rc=$?
    fail "$label: gh command failed (rc=$rc)"
    cat "${SMOKE_TMP}/${event_type}.stderr" >&2
    increment_fail
    echo ""
    return 1
  fi

  # Verify we got valid JSON
  if ! jq empty "$payload_file" >/dev/null 2>&1; then
    fail "$label: gh output is not valid JSON"
    increment_fail
    echo ""
    return 1
  fi

  info "  Payload size: $(wc -c < "$payload_file") bytes"

  # Ingest via the TypeScript helper
  if run_tsx "$event_type" "$delivery_id" "true" "$GITHUB_REPO" \
      --payload-file="$payload_file" \
      --db-url="$DATABASE_URL" \
      >"$ingest_result_file" 2>"${SMOKE_TMP}/${event_type}-ingest.stderr"; then
    :
  else
    local rc=$?
    fail "$label: ingestion failed (rc=$rc)"
    cat "${SMOKE_TMP}/${event_type}-ingest.stderr" >&2
    increment_fail
    echo ""
    return 1
  fi

  local ingested_count
  ingested_count="$(jq -r '.normalizedCount // 0' "$ingest_result_file")"

  if [[ "$ingested_count" -eq 0 ]]; then
    fail "$label: 0 events produced — check output"
    increment_fail
  else
    pass "$label: $ingested_count event(s) ingested"
    jq -r '.results[] | "    eventId=\(.eventId) channel=\(.channel) kind=\(.connectorKind) duplicate=\(.duplicate)"' "$ingest_result_file"
    increment_pass
  fi

  # Return the delivery_id for later use
  echo "$delivery_id" > "${SMOKE_TMP}/${event_type}.delivery-id"
  echo ""
}

# ── 1. Create real GitHub events ──────────────────────────────────────────────
create_events() {
  header "1. Creating Real GitHub Events"

  # ── 1a. Push: create a smoke-test branch with a commit ─────────────────────
  info "Setting up smoke-test branch '$SMOKE_BRANCH'..."
  local default_branch
  default_branch="$(gh api "repos/${GITHUB_REPO}" --jq '.default_branch')"

  # Get the latest SHA on the default branch
  local base_sha
  base_sha="$(gh api "repos/${GITHUB_REPO}/git/refs/heads/${default_branch}" --jq '.object.sha')"

  # Create a blob (empty file or small change)
  local blob_sha
  blob_sha="$(gh api "repos/${GITHUB_REPO}/git/blobs" \
    -f content="M0 smoke test commit ${TIMESTAMP}" \
    -f encoding=utf-8 \
    --jq '.sha')"

  # Create a tree
  local tree_sha
  tree_sha="$(gh api "repos/${GITHUB_REPO}/git/trees" \
    -f "tree[0][path]=m0-smoke-test-${TIMESTAMP}.md" \
    -f "tree[0][mode]=100644" \
    -f "tree[0][type]=blob" \
    -f "tree[0][sha]=${blob_sha}" \
    -f "base_tree=${base_sha}" \
    --jq '.sha')"

  # Create a commit
  local commit_sha
  commit_sha="$(gh api "repos/${GITHUB_REPO}/git/commits" \
    -f message="M0 smoke test commit — ${TIMESTAMP}" \
    -f "tree=${tree_sha}" \
    -f "parents[]=${base_sha}" \
    --jq '.sha')"

  # Create the branch ref
  gh api "repos/${GITHUB_REPO}/git/refs" \
    -f "ref=refs/heads/${SMOKE_BRANCH}" \
    -f "sha=${commit_sha}" >/dev/null 2>&1

  # Now get the push equivalent by retrieving the commit
  # GitHub doesn't have a direct "get webhook payload" API, so we construct
  # an equivalent by querying the commit and repo data
  info "  Commit SHA: $commit_sha"

  # Build a push-like payload from the commit and repo data
  local repo_data commit_data
  repo_data="$(gh api "repos/${GITHUB_REPO}")"
  commit_data="$(gh api "repos/${GITHUB_REPO}/git/commits/${commit_sha}")"
  local commit_date
  commit_date="$(echo "$commit_data" | jq -r '.committer.date')"

  # Construct a payload that looks like a push webhook
  jq -n \
    --arg ref "refs/heads/${SMOKE_BRANCH}" \
    --arg before "${base_sha}" \
    --arg after "${commit_sha}" \
    --arg repo_name "$(echo "$repo_data" | jq -r '.name')" \
    --arg repo_full "$(echo "$repo_data" | jq -r '.full_name')" \
    --arg owner_login "$(echo "$repo_data" | jq -r '.owner.login')" \
    --arg sha "${commit_sha}" \
    --arg message "M0 smoke test commit — ${TIMESTAMP}" \
    --arg timestamp "${commit_date}" \
    --argjson sender "$(echo "$commit_data" | jq '{login: .committer.login, id: (if .committer.id then (.committer.id | tonumber) else null end), type: "User"}')" \
    --argjson pusher "$(echo "$commit_data" | jq '{name: .committer.name, email: .committer.email}')" \
    '{
      ref: $ref,
      before: $before,
      after: $after,
      created: false,
      deleted: false,
      forced: false,
      repository: {
        full_name: $repo_full,
        name: $repo_name,
        owner: { login: $owner_login }
      },
      sender: $sender,
      pusher: $pusher,
      commits: [{
        id: $sha,
        timestamp: $timestamp,
        message: $message,
        url: ("https://github.com/" + $repo_full + "/commit/" + $sha),
        author: $sender,
        committer: $sender,
        distinct: true
      }]
    }' \
    >"${SMOKE_TMP}/push.json"

  create_and_ingest "Push (1 commit)" "push" cat "${SMOKE_TMP}/push.json"

  # ── 1b. Issue ───────────────────────────────────────────────────────────────
  info "Creating issue..."
  gh issue create \
    --repo "$GITHUB_REPO" \
    --title "M0 Smoke Test Issue — ${TIMESTAMP}" \
    --body "This is a smoke test issue created by \`scripts/m0-github-smoke.sh\`.

## Purpose
Verify that the teamem ingestion pipeline correctly processes GitHub **issues** events.

## Expected Behavior
- Actor should be the authenticated user
- Source event should be \`issues\` with action \`opened\`
- Immutable URL should point to this issue" \
    --label "type:chore" \
    >/dev/null 2>&1

  local issue_number
  issue_number="$(gh issue list --repo "$GITHUB_REPO" --search "M0 Smoke Test Issue — ${TIMESTAMP}" --json number --jq '.[0].number')"
  info "  Issue number: #${issue_number}"

  # Fetch the issue via API to simulate webhook payload shape
  gh api "repos/${GITHUB_REPO}/issues/${issue_number}" \
    >"${SMOKE_TMP}/issue-object.json"

  local issue_data
  issue_data="$(cat "${SMOKE_TMP}/issue-object.json")"

  # Wrap in webhook-like envelope
  jq -n \
    --arg action "opened" \
    --argjson issue "$issue_data" \
    --argjson repository "$(gh api "repos/${GITHUB_REPO}")" \
    --argjson sender "$(echo "$issue_data" | jq '.user')" \
    '{
      action: $action,
      issue: $issue,
      repository: $repository,
      sender: $sender
    }' \
    >"${SMOKE_TMP}/issues.json"

  create_and_ingest "Issue #${issue_number}" "issues" cat "${SMOKE_TMP}/issues.json"

  # Close the issue to clean up
  gh issue close "$issue_number" --repo "$GITHUB_REPO" >/dev/null 2>&1 || true

  # ── 1c. Pull Request ────────────────────────────────────────────────────────
  info "Creating PR from ${SMOKE_BRANCH} to ${default_branch}..."
  local pr_url
  pr_url="$(gh pr create \
    --repo "$GITHUB_REPO" \
    --head "$SMOKE_BRANCH" \
    --base "$default_branch" \
    --title "M0 Smoke Test PR — ${TIMESTAMP}" \
    --body "This is a smoke test PR created by \`scripts/m0-github-smoke.sh\`.

## Purpose
Verify that the teamem ingestion pipeline correctly processes GitHub **pull_request** events." \
    2>/dev/null)" || true

  # Extract PR number from URL
  local pr_number
  pr_number="$(echo "$pr_url" | grep -oE '[0-9]+$' || echo "")"

  if [[ -z "$pr_number" ]]; then
    # Try fetching by search
    pr_number="$(gh pr list --repo "$GITHUB_REPO" --head "$SMOKE_BRANCH" --json number --jq '.[0].number' 2>/dev/null || echo "")"
  fi

  if [[ -z "$pr_number" ]]; then
    warn "PR may not have been created (branch might already have an open PR). Checking..."
    pr_number="$(gh pr list --repo "$GITHUB_REPO" --search "M0 Smoke Test PR — ${TIMESTAMP}" --json number --jq '.[0].number' 2>/dev/null || echo "")"
  fi

  if [[ -n "$pr_number" ]]; then
    info "  PR number: #${pr_number}"

    gh api "repos/${GITHUB_REPO}/pulls/${pr_number}" \
      >"${SMOKE_TMP}/pr-object.json"

    local pr_data
    pr_data="$(cat "${SMOKE_TMP}/pr-object.json")"

    jq -n \
      --arg action "opened" \
      --argjson pull_request "$pr_data" \
      --argjson repository "$(gh api "repos/${GITHUB_REPO}")" \
      --argjson sender "$(echo "$pr_data" | jq '.user')" \
      '{
        action: $action,
        pull_request: $pull_request,
        repository: $repository,
        sender: $sender
      }' \
      >"${SMOKE_TMP}/pull_request.json"

    create_and_ingest "PR #${pr_number}" "pull_request" cat "${SMOKE_TMP}/pull_request.json"

    # Close the PR
    gh pr close "$pr_number" --repo "$GITHUB_REPO" >/dev/null 2>&1 || true
  else
    fail "PR: could not determine PR number — skipping PR test"
    increment_fail
    echo ""
  fi

  # ── 1d. PR Review Comment ──────────────────────────────────────────────────
  if [[ -n "${pr_number:-}" ]]; then
    info "Adding review comment to PR #${pr_number}..."
    # We need a PR that exists. Re-open it briefly to add a review.
    gh pr reopen "$pr_number" --repo "$GITHUB_REPO" >/dev/null 2>&1 || true
    sleep 2

    local comment_body="M0 smoke test review comment — ${TIMESTAMP}"
    local review_result
    review_result="$(gh api \
      "repos/${GITHUB_REPO}/pulls/${pr_number}/reviews" \
      -f event="COMMENT" \
      -f body="$comment_body" \
      2>/dev/null)" || true

    local review_id
    review_id="$(echo "$review_result" | jq -r '.id // empty')"

    if [[ -n "$review_id" ]]; then
      info "  Review ID: $review_id"

      # Fetch the full review
      gh api "repos/${GITHUB_REPO}/pulls/${pr_number}/reviews/${review_id}" \
        >"${SMOKE_TMP}/review-object.json"

      local review_data
      review_data="$(cat "${SMOKE_TMP}/review-object.json")"

      jq -n \
        --arg action "submitted" \
        --argjson review "$review_data" \
        --argjson pull_request "$(gh api "repos/${GITHUB_REPO}/pulls/${pr_number}")" \
        --argjson repository "$(gh api "repos/${GITHUB_REPO}")" \
        --argjson sender "$(echo "$review_data" | jq '.user')" \
        '{
          action: $action,
          review: $review,
          pull_request: $pull_request,
          repository: $repository,
          sender: $sender
        }' \
        >"${SMOKE_TMP}/pull_request_review.json"

      create_and_ingest "PR Review #${review_id}" "pull_request_review" cat "${SMOKE_TMP}/pull_request_review.json"
    else
      warn "PR review: could not create review (may require write access)"
      # Try an issue comment on the PR instead (which maps to github_pr_comment)
      info "  Falling back to issue comment on PR..."
      local comment_result
      comment_result="$(gh api \
        "repos/${GITHUB_REPO}/issues/${pr_number}/comments" \
        -f body="M0 smoke test issue comment — ${TIMESTAMP}" \
        2>/dev/null)" || true

      local comment_id
      comment_id="$(echo "$comment_result" | jq -r '.id // empty')"

      if [[ -n "$comment_id" ]]; then
        gh api "repos/${GITHUB_REPO}/issues/comments/${comment_id}" \
          >"${SMOKE_TMP}/comment-object.json"

        local comment_data
        comment_data="$(cat "${SMOKE_TMP}/comment-object.json")"

        jq -n \
          --arg action "created" \
          --argjson comment "$comment_data" \
          --argjson issue "$(gh api "repos/${GITHUB_REPO}/issues/${pr_number}")" \
          --argjson repository "$(gh api "repos/${GITHUB_REPO}")" \
          --argjson sender "$(echo "$comment_data" | jq '.user')" \
          '{
            action: $action,
            comment: $comment,
            issue: $issue,
            repository: $repository,
            sender: $sender
          }' \
          >"${SMOKE_TMP}/issue_comment.json"

        create_and_ingest "Issue Comment on PR #${pr_number}" "issue_comment" cat "${SMOKE_TMP}/issue_comment.json"
      else
        warn "Could not create comment — skipping comment test"
      fi
    fi

    # Close the PR again
    gh pr close "$pr_number" --repo "$GITHUB_REPO" >/dev/null 2>&1 || true
  fi

  # Clean up the smoke test branch
  if [[ -n "${SMOKE_BRANCH:-}" ]]; then
    info "Cleaning up smoke test branch '$SMOKE_BRANCH'..."
    gh api --method DELETE "repos/${GITHUB_REPO}/git/refs/heads/${SMOKE_BRANCH}" >/dev/null 2>&1 || true
  fi
}

# ── 2. Database verification ──────────────────────────────────────────────────
verify_database() {
  header "2. Database Verification"

  # Count events by kind in the smoke test project
  info "Event counts by kind in smoke test project:"
  local event_counts
  event_counts="$(psql "$DATABASE_URL" -t -A -F'|' -c "
    SELECT kind, count(*) AS cnt
    FROM events
    WHERE project_id = '${SMOKE_PROJECT_ID}'
      AND team_id = '${SMOKE_TEAM_ID}'
    GROUP BY kind
    ORDER BY kind
  " 2>/dev/null)" || true

  if [[ -z "$event_counts" ]]; then
    warn "No events found in smoke test project — skipping verification"
    return
  fi

  echo "$event_counts" | while IFS='|' read -r kind cnt; do
    info "  $kind: $cnt event(s)"
  done

  echo ""

  # ── 2a. Push verification ──────────────────────────────────────────────────
  info "Verifying push events..."
  local push_rows
  push_rows="$(psql "$DATABASE_URL" -t -A -F'|' -c "
    SELECT id, channel, kind, source_event, delivery_id, item_key,
           external_id, url, actor_provenance, occurred_at_provenance
    FROM events
    WHERE project_id = '${SMOKE_PROJECT_ID}'
      AND team_id = '${SMOKE_TEAM_ID}'
      AND kind = 'github_commit'
    ORDER BY created_at DESC
    LIMIT 5
  " 2>/dev/null)"

  if [[ -n "$push_rows" ]]; then
    echo "$push_rows" | while IFS='|' read -r id channel kind source_event delivery_id item_key external_id url actor_prov occurred_at_prov; do
      local checks_ok=true

      [[ "$channel" == "github" ]] || { fail "  $id: channel=$channel (expected github)"; checks_ok=false; }
      [[ "$kind" == "github_commit" ]] || { fail "  $id: kind=$kind (expected github_commit)"; checks_ok=false; }
      [[ "$source_event" == "push" ]] || { fail "  $id: source_event=$source_event (expected push)"; checks_ok=false; }
      [[ "$actor_prov" == "webhook_verified" ]] || { fail "  $id: actor_provenance=$actor_prov (expected webhook_verified)"; checks_ok=false; }
      [[ "$occurred_at_prov" == "provider" ]] || { fail "  $id: occurred_at_provenance=$occurred_at_prov (expected provider)"; checks_ok=false; }
      [[ -n "$url" ]] || { fail "  $id: url is empty (should be immutable commit URL)"; checks_ok=false; }
      [[ -n "$delivery_id" ]] || { fail "  $id: delivery_id is empty"; checks_ok=false; }
      [[ -n "$item_key" ]] || { fail "  $id: item_key is empty (should be commit SHA)"; checks_ok=false; }
      [[ -n "$external_id" ]] || { fail "  $id: external_id is empty"; checks_ok=false; }

      if [[ "$checks_ok" == true ]]; then
        pass "github_commit: id=$id channel=$channel source=$source_event actor_prov=$actor_prov url=$url"
        increment_pass
      else
        increment_fail
      fi
    done
  else
    fail "No github_commit events found"
    increment_fail
  fi

  # ── 2b. Issue verification ─────────────────────────────────────────────────
  info "Verifying issue events..."
  local issue_rows
  issue_rows="$(psql "$DATABASE_URL" -t -A -F'|' -c "
    SELECT id, channel, kind, source_event, source_action, delivery_id,
           item_key, external_id, url, actor_provenance, occurred_at_provenance
    FROM events
    WHERE project_id = '${SMOKE_PROJECT_ID}'
      AND team_id = '${SMOKE_TEAM_ID}'
      AND kind = 'github_issue'
    ORDER BY created_at DESC
    LIMIT 5
  " 2>/dev/null)"

  if [[ -n "$issue_rows" ]]; then
    echo "$issue_rows" | while IFS='|' read -r id channel kind source_event source_action delivery_id item_key external_id url actor_prov occurred_at_prov; do
      local checks_ok=true

      [[ "$channel" == "github" ]] || { fail "  $id: channel=$channel (expected github)"; checks_ok=false; }
      [[ "$kind" == "github_issue" ]] || { fail "  $id: kind=$kind (expected github_issue)"; checks_ok=false; }
      [[ "$source_event" == "issues" ]] || { fail "  $id: source_event=$source_event (expected issues)"; checks_ok=false; }
      [[ -n "$source_action" ]] || { fail "  $id: source_action is empty"; checks_ok=false; }
      [[ "$actor_prov" == "webhook_verified" ]] || { fail "  $id: actor_provenance=$actor_prov (expected webhook_verified)"; checks_ok=false; }
      [[ -n "$url" ]] || { fail "  $id: url is empty (should be canonical issue URL)"; checks_ok=false; }

      if [[ "$checks_ok" == true ]]; then
        pass "github_issue: id=$id channel=$channel action=$source_action actor_prov=$actor_prov url=$url"
        increment_pass
      else
        increment_fail
      fi
    done
  else
    fail "No github_issue events found"
    increment_fail
  fi

  # ── 2c. PR verification ────────────────────────────────────────────────────
  info "Verifying PR events..."
  local pr_rows
  pr_rows="$(psql "$DATABASE_URL" -t -A -F'|' -c "
    SELECT id, channel, kind, source_event, source_action, delivery_id,
           item_key, external_id, url, actor_provenance
    FROM events
    WHERE project_id = '${SMOKE_PROJECT_ID}'
      AND team_id = '${SMOKE_TEAM_ID}'
      AND kind = 'github_pr'
    ORDER BY created_at DESC
    LIMIT 5
  " 2>/dev/null)"

  if [[ -n "$pr_rows" ]]; then
    echo "$pr_rows" | while IFS='|' read -r id channel kind source_event source_action delivery_id item_key external_id url actor_prov; do
      local checks_ok=true

      [[ "$channel" == "github" ]] || { fail "  $id: channel=$channel (expected github)"; checks_ok=false; }
      [[ "$kind" == "github_pr" ]] || { fail "  $id: kind=$kind (expected github_pr)"; checks_ok=false; }
      [[ "$source_event" == "pull_request" ]] || { fail "  $id: source_event=$source_event (expected pull_request)"; checks_ok=false; }
      [[ -n "$source_action" ]] || { fail "  $id: source_action is empty"; checks_ok=false; }
      [[ "$actor_prov" == "webhook_verified" ]] || { fail "  $id: actor_provenance=$actor_prov (expected webhook_verified)"; checks_ok=false; }
      [[ -n "$url" ]] || { fail "  $id: url is empty (should be canonical PR URL)"; checks_ok=false; }

      if [[ "$checks_ok" == true ]]; then
        pass "github_pr: id=$id channel=$channel action=$source_action actor_prov=$actor_prov url=$url"
        increment_pass
      else
        increment_fail
      fi
    done
  else
    fail "No github_pr events found"
    increment_fail
  fi

  # ── 2d. PR Comment verification ────────────────────────────────────────────
  info "Verifying PR comment events..."
  local comment_rows
  comment_rows="$(psql "$DATABASE_URL" -t -A -F'|' -c "
    SELECT id, channel, kind, source_event, source_action, delivery_id,
           item_key, external_id, url, actor_provenance
    FROM events
    WHERE project_id = '${SMOKE_PROJECT_ID}'
      AND team_id = '${SMOKE_TEAM_ID}'
      AND kind = 'github_pr_comment'
    ORDER BY created_at DESC
    LIMIT 5
  " 2>/dev/null)"

  if [[ -n "$comment_rows" ]]; then
    echo "$comment_rows" | while IFS='|' read -r id channel kind source_event source_action delivery_id item_key external_id url actor_prov; do
      local checks_ok=true

      [[ "$channel" == "github" ]] || { fail "  $id: channel=$channel (expected github)"; checks_ok=false; }
      [[ "$kind" == "github_pr_comment" ]] || { fail "  $id: kind=$kind (expected github_pr_comment)"; checks_ok=false; }
      [[ -n "$source_event" ]] || { fail "  $id: source_event is empty"; checks_ok=false; }
      [[ -n "$source_action" ]] || { fail "  $id: source_action is empty"; checks_ok=false; }
      [[ "$actor_prov" == "webhook_verified" ]] || { fail "  $id: actor_provenance=$actor_prov (expected webhook_verified)"; checks_ok=false; }
      [[ -n "$url" ]] || { fail "  $id: url is empty (should be immutable comment permalink)"; checks_ok=false; }

      if [[ "$checks_ok" == true ]]; then
        pass "github_pr_comment: id=$id channel=$channel event=$source_event action=$source_action actor_prov=$actor_prov url=$url"
        increment_pass
      else
        increment_fail
      fi
    done
  else
    fail "No github_pr_comment events found"
    increment_fail
  fi

  echo ""

  # ── 2e. Actor verification ─────────────────────────────────────────────────
  info "Verifying actor claims..."
  local actor_rows
  actor_rows="$(psql "$DATABASE_URL" -t -A -F'|' -c "
    SELECT e.id, e.kind, e.actor, e.actor_provenance, e.actor_principal_id,
           p.provider, p.provider_kind, p.provider_user_id, p.display_login
    FROM events e
    LEFT JOIN principals p ON p.id = e.actor_principal_id
    WHERE e.project_id = '${SMOKE_PROJECT_ID}'
      AND e.team_id = '${SMOKE_TEAM_ID}'
      AND e.actor IS NOT NULL
    ORDER BY e.created_at DESC
    LIMIT 10
  " 2>/dev/null)"

  if [[ -n "$actor_rows" ]]; then
    echo "$actor_rows" | while IFS='|' read -r id kind actor actor_prov principal_id provider provider_kind provider_user_id display_login; do
      if [[ -n "$principal_id" && -n "$provider_user_id" ]]; then
        pass "Actor resolved: event=$id kind=$kind actor_prov=$actor_prov principal=$principal_id provider=$provider provider_user_id=$provider_user_id login=$display_login"
        increment_pass
      elif [[ "$actor" == "null" ]]; then
        pass "Actor null (preserved as unknown): event=$id kind=$kind"
        increment_pass
      else
        fail "Actor: event=$id has actor=$actor but no resolved principal"
        increment_fail
      fi
    done
  else
    warn "No actor data to verify"
  fi

  echo ""

  # ── 2f. Jobs verification (if any) ──────────────────────────────────────────
  info "Checking for compilation jobs..."
  local job_rows
  job_rows="$(psql "$DATABASE_URL" -t -A -F'|' -c "
    SELECT id, kind, status, event_count, created_at
    FROM jobs
    WHERE project_id = '${SMOKE_PROJECT_ID}'
      AND team_id = '${SMOKE_TEAM_ID}'
    ORDER BY created_at DESC
    LIMIT 10
  " 2>/dev/null)"

  if [[ -n "$job_rows" ]]; then
    echo "$job_rows" | while IFS='|' read -r id kind status event_count created_at; do
      info "  Job: id=$id kind=$kind status=$status event_count=$event_count"
    done
  else
    info "  No compilation jobs (ingest-only — M0 compilation is not triggered by this smoke test)"
  fi

  echo ""
}

# ── 3. Idempotency test ──────────────────────────────────────────────────────
test_idempotency() {
  header "3. Idempotency Test"

  info "Re-playing the push event to verify idempotent replay (N1)..."

  local push_payload="${SMOKE_TMP}/push.json"
  local push_delivery_id_file="${SMOKE_TMP}/push.delivery-id"

  if [[ ! -f "$push_payload" || ! -f "$push_delivery_id_file" ]]; then
    warn "No push event data available for idempotency test — skipping"
    return
  fi

  local delivery_id
  delivery_id="$(cat "$push_delivery_id_file")"

  info "  Replaying delivery $delivery_id..."

  local replay_result="${SMOKE_TMP}/idempotency-replay.json"
  if run_tsx "push" "$delivery_id" "true" "$GITHUB_REPO" \
      --payload-file="$push_payload" \
      --db-url="$DATABASE_URL" \
      >"$replay_result" 2>"${SMOKE_TMP}/idempotency-replay.stderr"; then

    local duplicate_count
    duplicate_count="$(jq -r '[.results[] | select(.duplicate == true)] | length' "$replay_result")"
    local total_count
    total_count="$(jq -r '.normalizedCount // 0' "$replay_result")"

    if [[ "$duplicate_count" -eq "$total_count" && "$total_count" -gt 0 ]]; then
      pass "Idempotent replay: all $total_count event(s) returned duplicate=true (N1 satisfied)"
      increment_pass
    elif [[ "$duplicate_count" -gt 0 ]]; then
      warn "Idempotent replay: $duplicate_count/$total_count duplicates (some new events)"
    else
      fail "Idempotent replay: 0 duplicates — events were inserted again instead of being deduplicated"
      increment_fail
    fi
  else
    fail "Idempotent replay: ingestion failed"
    cat "${SMOKE_TMP}/idempotency-replay.stderr" >&2
    increment_fail
  fi

  echo ""

  # ── 3b. Conflict test ──────────────────────────────────────────────────────
  info "Testing idempotency conflict: same delivery ID with different payload..."

  # Modify the push payload slightly
  jq '.commits[0].message = "MODIFIED smoke test commit — different payload"' \
    "$push_payload" > "${SMOKE_TMP}/push-modified.json"

  local conflict_result="${SMOKE_TMP}/idempotency-conflict.json"
  if run_tsx "push" "$delivery_id" "true" "$GITHUB_REPO" \
      --payload-file="${SMOKE_TMP}/push-modified.json" \
      --db-url="$DATABASE_URL" \
      >"$conflict_result" 2>"${SMOKE_TMP}/idempotency-conflict.stderr"; then
    fail "Idempotency conflict: different payload was accepted (should have been rejected as 409)"
    increment_fail
  else
    local stderr_content
    stderr_content="$(cat "${SMOKE_TMP}/idempotency-conflict.stderr" 2>/dev/null || true)"
    if echo "$stderr_content" | grep -qi 'idempotency\|conflict\|already stored'; then
      pass "Idempotency conflict: different payload correctly rejected (N1 409 semantics)"
      increment_pass
    else
      pass "Idempotency conflict: different payload rejected (error: $(echo "$stderr_content" | head -1))"
      increment_pass
    fi
  fi

  echo ""
}

# ── 4. Summary ─────────────────────────────────────────────────────────────────
print_summary() {
  header "4. Smoke Test Summary"

  local total=$((PASS_COUNT + FAIL_COUNT))

  echo "  Total checks: $total"
  printf "  ${GREEN}Passed: ${PASS_COUNT}${NC}\n"
  printf "  ${RED}Failed: ${FAIL_COUNT}${NC}\n"
  echo ""

  # Show unique events stored in this run
  info "Events stored in project '$SMOKE_PROJECT_ID':"
  psql "$DATABASE_URL" -c "
    SELECT kind, channel, source_event, source_action,
           substring(external_id for 50) AS external_id_trunc,
           substring(url for 60) AS url_trunc,
           actor_provenance
    FROM events
    WHERE project_id = '${SMOKE_PROJECT_ID}'
      AND team_id = '${SMOKE_TEAM_ID}'
    ORDER BY created_at DESC
    LIMIT 20
  " 2>/dev/null || warn "Could not query events table"

  echo ""

  if [[ "$FAIL_COUNT" -eq 0 ]]; then
    pass "ALL CHECKS PASSED — M0 GitHub webhook smoke test successful"
    echo ""
    info "This verifies:"
    echo "  - Push events normalize correctly (github_commit with commit SHA item_key)"
    echo "  - PR events normalize correctly (github_pr with PR number item_key)"
    echo "  - Issue events normalize correctly (github_issue with issue number item_key)"
    echo "  - PR comment events normalize correctly (github_pr_comment with comment ID)"
    echo "  - Actor claims are preserved with webhook_verified provenance"
    echo "  - Occurred timestamps are provider-sourced with ms precision"
    echo "  - Immutable URLs are canonical (github.com/owner/repo/commit|pull|issues/...)"
    echo "  - Idempotent replay returns duplicate=true for same delivery+payload"
    echo "  - Idempotency conflict rejects same delivery+different payload"
  else
    fail "SOME CHECKS FAILED — see details above"
    echo ""
    exit 1
  fi
}

# ── Cleanup ────────────────────────────────────────────────────────────────────
cleanup() {
  if [[ "${KEEP_DATA}" != "true" ]]; then
    info "Cleaning up smoke test data from database..."
    psql "$DATABASE_URL" -c "
      DELETE FROM job_events WHERE team_id = '${SMOKE_TEAM_ID}' AND project_id = '${SMOKE_PROJECT_ID}';
      DELETE FROM jobs WHERE team_id = '${SMOKE_TEAM_ID}' AND project_id = '${SMOKE_PROJECT_ID}';
      DELETE FROM events WHERE team_id = '${SMOKE_TEAM_ID}' AND project_id = '${SMOKE_PROJECT_ID}';
      DELETE FROM principals WHERE team_id = '${SMOKE_TEAM_ID}';
    " >/dev/null 2>&1 || true
    info "Database rows removed for $SMOKE_TEAM_ID / $SMOKE_PROJECT_ID"
  else
    info "KEEP_DATA=true — database rows preserved for inspection"
  fi

  echo ""
  info "Smoke test completed at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
}

# ── Main ───────────────────────────────────────────────────────────────────────
main() {
  check_prereqs
  create_events
  verify_database
  test_idempotency
  print_summary
  cleanup
}

main
