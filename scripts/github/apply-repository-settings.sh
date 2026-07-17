#!/usr/bin/env bash

set -euo pipefail

apply=false
if [[ "${1:-}" == "--apply" ]]; then
  apply=true
elif [[ $# -ne 0 ]]; then
  echo "Usage: $0 [--apply]" >&2
  exit 2
fi

for command in gh jq; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Required command not found: $command" >&2
    exit 1
  fi
done

repo="${TEAMEM_GITHUB_REPOSITORY:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"
default_branch="${TEAMEM_DEFAULT_BRANCH:-main}"
required_approvals="${TEAMEM_REQUIRED_APPROVALS:-0}"
governance_checks_verified="${TEAMEM_GOVERNANCE_CHECKS_VERIFIED:-false}"
api_version="2026-03-10"

if [[ ! "$required_approvals" =~ ^[01]$ ]]; then
  echo "TEAMEM_REQUIRED_APPROVALS must be 0 or 1." >&2
  exit 2
fi

api() {
  gh api -H "X-GitHub-Api-Version: $api_version" "$@"
}

mutate() {
  if [[ "$apply" == true ]]; then
    api "$@" >/dev/null
  else
    printf 'DRY RUN: gh api'
    printf ' %q' "$@"
    printf '\n'
  fi
}

upsert_label() {
  local name="$1"
  local color="$2"
  local description="$3"
  local encoded_name
  encoded_name="$(jq -rn --arg value "$name" '$value|@uri')"

  if api "repos/$repo/labels/$encoded_name" >/dev/null 2>&1; then
    mutate --method PATCH "repos/$repo/labels/$encoded_name" \
      -f new_name="$name" \
      -f color="$color" \
      -f description="$description"
  else
    mutate --method POST "repos/$repo/labels" \
      -f name="$name" \
      -f color="$color" \
      -f description="$description"
  fi
}

upsert_ruleset() {
  local name="$1"
  local payload_file="$2"
  local ruleset_id
  ruleset_id="$(api --paginate "repos/$repo/rulesets" --jq ".[] | select(.name == \"$name\" and .source_type == \"Repository\") | .id" | head -n 1)"

  if [[ -n "$ruleset_id" ]]; then
    mutate --method PUT "repos/$repo/rulesets/$ruleset_id" --input "$payload_file"
  else
    mutate --method POST "repos/$repo/rulesets" --input "$payload_file"
  fi
}

verify_workflows_on_default_branch() {
  local workflow
  local workflows=(
    ci.yml
    dco.yml
    dependency-review.yml
    pr-policy.yml
  )

  for workflow in "${workflows[@]}"; do
    if ! api "repos/$repo/contents/.github/workflows/$workflow?ref=$default_branch" >/dev/null 2>&1; then
      echo "Refusing to apply: .github/workflows/$workflow is not on $default_branch." >&2
      echo "Merge the governance workflows first, then run this script again." >&2
      exit 1
    fi
  done
}

temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/teamem-github-settings.XXXXXX")"
trap 'rm -rf "$temp_dir"' EXIT

main_ruleset="$temp_dir/main-ruleset.json"
tag_ruleset="$temp_dir/release-tag-ruleset.json"

jq -n \
  --arg branch "refs/heads/$default_branch" \
  --argjson approvals "$required_approvals" \
  '{
    name: "protected main",
    target: "branch",
    enforcement: "active",
    bypass_actors: [],
    conditions: {
      ref_name: {
        include: [$branch],
        exclude: []
      }
    },
    rules: [
      {type: "deletion"},
      {type: "non_fast_forward"},
      {type: "required_linear_history"},
      {
        type: "pull_request",
        parameters: {
          allowed_merge_methods: ["squash"],
          dismiss_stale_reviews_on_push: true,
          require_code_owner_review: false,
          require_last_push_approval: ($approvals > 0),
          required_approving_review_count: $approvals,
          required_review_thread_resolution: true
        }
      },
      {
        type: "required_status_checks",
        parameters: {
          do_not_enforce_on_create: true,
          strict_required_status_checks_policy: true,
          required_status_checks: [
            {context: "required / pr-policy"},
            {context: "required / dco"},
            {context: "required / lint"},
            {context: "required / typecheck"},
            {context: "required / unit (node 20)"},
            {context: "required / unit (node 22)"},
            {context: "required / postgres"},
            {context: "required / dependency-review"}
          ]
        }
      }
    ]
  }' >"$main_ruleset"

jq -n '{
  name: "immutable release tags",
  target: "tag",
  enforcement: "active",
  bypass_actors: [],
  conditions: {
    ref_name: {
      include: ["refs/tags/v*"],
      exclude: []
    }
  },
  rules: [
    {type: "deletion"},
    {type: "update"}
  ]
}' >"$tag_ruleset"

echo "Repository: $repo"
echo "Default branch: $default_branch"
echo "Required approving reviews: $required_approvals"
if [[ "$apply" == false ]]; then
  echo "Mode: dry run (pass --apply to make changes)"
  echo
fi

if [[ "$apply" == true ]]; then
  if [[ "$governance_checks_verified" != "true" ]]; then
    echo "Refusing to apply required checks without bootstrap evidence." >&2
    echo "Open a temporary PR after the workflows land on $default_branch, verify every required check, then set:" >&2
    echo "  TEAMEM_GOVERNANCE_CHECKS_VERIFIED=true" >&2
    exit 1
  fi
  verify_workflows_on_default_branch
fi

mutate --method PATCH "repos/$repo" \
  -F allow_auto_merge=true \
  -F allow_merge_commit=false \
  -F allow_rebase_merge=false \
  -F allow_squash_merge=true \
  -F allow_update_branch=true \
  -F delete_branch_on_merge=true \
  -F has_discussions=true \
  -F has_issues=true \
  -F has_wiki=false \
  -F squash_merge_commit_message=PR_BODY \
  -F squash_merge_commit_title=PR_TITLE \
  -F web_commit_signoff_required=true

mutate --method PUT "repos/$repo/actions/permissions" \
  -F enabled=true \
  -f allowed_actions=all \
  -F sha_pinning_required=true

mutate --method PUT "repos/$repo/actions/permissions/workflow" \
  -f default_workflow_permissions=read \
  -F can_approve_pull_request_reviews=false

mutate --method PUT "repos/$repo/vulnerability-alerts"
mutate --method PUT "repos/$repo/automated-security-fixes"
mutate --method PATCH "repos/$repo" \
  -f 'security_and_analysis[secret_scanning][status]=enabled' \
  -f 'security_and_analysis[secret_scanning_push_protection][status]=enabled'

upsert_label "semver:major" "b60205" "Determines the next release as a major version."
upsert_label "semver:minor" "0e8a16" "Determines the next release as a minor version."
upsert_label "semver:patch" "1d76db" "Determines the next release as a patch version."
upsert_label "semver:none" "ededed" "Does not determine the next release version."
upsert_label "type:feature" "0e8a16" "Adds a user-visible capability."
upsert_label "type:fix" "d73a4a" "Fixes a defect or regression."
upsert_label "type:security" "b60205" "Changes a security boundary or fixes a vulnerability."
upsert_label "type:docs" "0075ca" "Changes documentation only."
upsert_label "type:chore" "cfd3d7" "Performs maintenance without product behavior changes."
upsert_label "area:server" "5319e7" "Touches the server or worker."
upsert_label "area:web" "7057ff" "Touches the Web UI."
upsert_label "area:schema" "d4c5f9" "Touches the shared contract package."
upsert_label "area:infra" "f9d0c4" "Touches CI, containers, releases, or repository automation."
upsert_label "dependencies" "0366d6" "Updates a dependency."
upsert_label "skip-changelog" "ffffff" "Intentionally omitted from user-facing release notes."

upsert_ruleset "protected main" "$main_ruleset"
upsert_ruleset "immutable release tags" "$tag_ruleset"

if [[ "$apply" == true ]]; then
  echo
  echo "Applied repository settings. Current repository rulesets:"
  api "repos/$repo/rulesets" --jq '.[] | [.name, .target, .enforcement] | @tsv'
else
  echo
  echo "No remote settings changed. Review the commands above, merge the workflows to main, then run:"
  echo "  TEAMEM_GOVERNANCE_CHECKS_VERIFIED=true TEAMEM_REQUIRED_APPROVALS=$required_approvals $0 --apply"
fi
