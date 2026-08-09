#!/usr/bin/env bash
# M3 E2E — One-command real end-to-end (DUA-256, AGPL-3.0-only)
#
# Verifies the whole product loop in a single command:
#
#     up → ingest → compile → MCP search → cleanup
#
#   1. up          — build + start the real compose stack (postgres + server
#                    [+ worker in standard mode]) on an isolated compose
#                    project, then wait for liveness and readiness.
#   2. ingest      — bootstrap an isolated team/project/API key and submit a
#                    real cli_init event (compile=true) whose repo_file evidence
#                    is anchored to a real durable artifact in THIS repository
#                    (docs/adr/001-…md) at a real immutable commit SHA.
#   3. compile     — wait for the pg-boss compile job; a concept page must be
#                    produced (job state completed + ≥1 concept).
#   4. MCP search  — call the /mcp search tool; the compiled concept must be
#                    retrievable (its UUID must appear in the index rows).
#   5. cleanup     — tear the stack down (--volumes) so the run is repeatable.
#
# This is a HARD M3 exit check (AGENTS.md §10–§11): the script is green only
# when the full loop has been observed working end to end. Failures are never
# swallowed — no `|| true` on the critical path, no warnings turned into
# passes.
#
# Exit codes:
#   0  GREEN — full loop verified end to end (up → ingest → compile →
#              MCP search → cleanup).
#   1  RED   — a step failed; details are printed above. The M3 exit check
#              is NOT green.
#   2  SKIP  — the environment cannot satisfy the check (docker/compose
#              missing, POSTGRES_PASSWORD missing/weak, or no LLM provider
#              key configured). A SKIP is NOT a green result: the check did
#              not run and the exit fails the gate.
#
# Prerequisites: docker (+ compose plugin), curl, jq, git.
#
# One-command usage (secrets from .env — gitignored, see .env.example):
#   cp .env.example .env     # then fill in ONE provider key
#   ./scripts/e2e.sh
#   # or: pnpm e2e
#
# POSTGRES_PASSWORD is OPTIONAL: when unset (and not in .env), the script
# mints a strong ephemeral per-run password — no insecure default is ever
# shipped or persisted. An LLM provider key (TEAMEM_ANTHROPIC_API_KEY /
# TEAMEM_OPENAI_API_KEY / TEAMEM_OPENROUTER_API_KEY /
# TEAMEM_OPENAI_COMPAT_API_KEY) is still REQUIRED: F1/F2 compilation is the
# green gate and there is deliberately no fake/default key.
#
# Options / environment (all TEAMEM_-prefixed, AGENTS.md §4):
#   --mode standard|all-in-one   topology (default: standard = 3 containers;
#                                all-in-one = 2 containers, embedded worker)
#   --keep-stack                 keep the stack running after the run
#                                (TEAMEM_E2E_KEEP_STACK=true)
#   --skip-build                 reuse an existing image, do not rebuild
#                                (SKIP_COMPOSE_BUILD=true)
#   TEAMEM_E2E_COMPOSE_PROJECT   compose project name (default: teamem-e2e —
#                                never touches a running `teamem` dev stack)
#   TEAMEM_PORT / TEAMEM_PG_PORT host ports (defaults 8080 / 5432)
#   TEAMEM_BASE_URL              server URL (default http://127.0.0.1:${TEAMEM_PORT})
#   TEAMEM_E2E_COMPILE_TIMEOUT   max seconds to wait for the compile job
#                                (default: 180)
#
# Env-var spelling note: the functional prefix in this repository is
# TEAMEM_ (server config, docker-compose interpolation, .env.example,
# AGENTS.md §4). A few prose comments spell it TEEMEM_ — the code reads
# TEAMEM_, and so does this script.

# NOTE on `set -eo pipefail`: this script deliberately uses `set -uo pipefail`
# (no -e). It is an orchestrator whose every failure path is handled
# explicitly with counters + a final exit code, so implicit exit-on-error
# would abort mid-phase and silently skip cleanup. RC discipline is explicit:
# every phase returns 0/1 and main() decides the verdict.
set -uo pipefail

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'; CYAN=$'\033[0;36m'; BOLD=$'\033[1m'; NC=$'\033[0m'
pass()  { printf "${GREEN}✓ PASS${NC} %s\n" "$*"; }
fail()  { printf "${RED}✗ FAIL${NC} %s\n" "$*"; }
warn()  { printf "${YELLOW}⚠ WARN${NC} %s\n" "$*"; }
skip()  { printf "${CYAN}⊘ SKIP${NC} %s\n" "$*"; }
info()  { printf "${BOLD}→${NC} %s\n" "$*"; }
header() { printf '\n%s\n%s\n%s\n\n' "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" "${BOLD}$*${NC}" "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"; }

# ── Configuration ───────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── .env discovery (opt-in, gitignored) ─────────────────────────────────────
# If the operator keeps secrets in $REPO_ROOT/.env (gitignored), read the keys
# this script understands from it. An explicitly exported variable always
# wins; .env only fills unset values. Setup is then just:
#   cp .env.example .env   # + fill POSTGRES_PASSWORD / TEAMEM_*_API_KEY
#   ./scripts/e2e.sh
load_repo_env() {
  local env_file="${TEAMEM_E2E_DOTENV:-$REPO_ROOT/.env}"
  [[ -f "$env_file" ]] || return 0
  local key val
  while IFS='=' read -r key val; do
    [[ -z "$key" || "$key" == \#* ]] && continue
    key="${key// /}"
    case "$key" in
      POSTGRES_PASSWORD|POSTGRES_USER|POSTGRES_DB|TEAMEM_PORT|TEAMEM_PG_PORT|TEAMEM_ALL_IN_ONE|TEAMEM_BASE_URL|TEAMEM_ANTHROPIC_API_KEY|TEAMEM_OPENAI_API_KEY|TEAMEM_OPENROUTER_API_KEY|TEAMEM_OPENAI_COMPAT_BASE_URL|TEAMEM_OPENAI_COMPAT_API_KEY|TEAMEM_LLM_DEBUG|TEAMEM_E2E_*)
        if [[ -z "${!key:-}" ]]; then
          val="${val%\"}" # strip trailing quote
          val="${val%\'}"
          val="${val#\"}"
          val="${val#\'}"
          printf -v "$key" '%s' "$val"
          export "$key"
        fi
        ;;
    esac
  done < "$env_file"
}
load_repo_env

MODE=""                       # set by parse_args: standard | all-in-one
KEEP_STACK=false
SKIP_BUILD=false

COMPOSE_FILE="${COMPOSE_FILE:-$REPO_ROOT/docker-compose.yml}"
COMPOSE_PROJECT="${TEAMEM_E2E_COMPOSE_PROJECT:-teamem-e2e}"
SERVER_PORT="${TEAMEM_PORT:-8080}"
PG_PORT="${TEAMEM_PG_PORT:-5432}"
BASE_URL="${TEAMEM_BASE_URL:-http://127.0.0.1:${SERVER_PORT}}"
COMPILE_TIMEOUT="${TEAMEM_E2E_COMPILE_TIMEOUT:-180}"
PG_PASSWORD="${POSTGRES_PASSWORD:-}"
TIMESTAMP="$(date +%Y%m%dT%H%M%S)"

# ── Run-local state ─────────────────────────────────────────────────────────

TMPDIR="${TMPDIR:-/tmp}"
E2E_TMP="$(mktemp -d "${TMPDIR}/teamem-e2e.XXXXXX")"

PASS_F="${E2E_TMP}/pass"; echo 0 > "$PASS_F"
FAIL_F="${E2E_TMP}/fail"; echo 0 > "$FAIL_F"
inc_pass() { local c; c=$(cat "$PASS_F"); echo $((c+1)) > "$PASS_F"; }
inc_fail() { local c; c=$(cat "$FAIL_F"); echo $((c+1)) > "$FAIL_F"; }
get_pass() { cat "$PASS_F"; }
get_fail() { cat "$FAIL_F"; }

STACK_UP=false      # a compose stack exists that this run must tear down
CLEANUP_DONE=false  # teardown already performed by the cleanup phase

# Per-run artifacts (populated by the phases).
TEAM_ID=""
PROJECT_ID=""
API_KEY=""
EVENT_ID=""
JOB_ID=""
CONCEPT_UUID=""
CONCEPT_TITLE=""
SEARCH_DEGRADED=false

# ── Argument parsing ────────────────────────────────────────────────────────

usage() {
  sed -n '2,65p' "$0" | sed 's/^# \{0,1\}//'
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --mode)
        MODE="$2"; shift 2 ;;
      --keep-stack)
        KEEP_STACK=true; shift ;;
      --skip-build)
        SKIP_BUILD=true; shift ;;
      --help|-h)
        usage; exit 0 ;;
      *)
        echo "Unknown argument: $1 (see --help)" >&2
        exit 2 ;;
    esac
  done

  if [[ -z "$MODE" ]]; then
    # Environment escape hatch, else the canonical deployment default.
    if [[ "${TEAMEM_ALL_IN_ONE:-false}" == "true" ]]; then
      MODE="all-in-one"
    else
      MODE="standard"
    fi
  fi

  case "$MODE" in
    standard|all-in-one) ;;
    *)
      echo "--mode must be 'standard' or 'all-in-one' (got: $MODE)" >&2
      exit 2 ;;
  esac

  [[ "${TEAMEM_E2E_KEEP_STACK:-false}" == "true" ]] && KEEP_STACK=true
  [[ "${SKIP_COMPOSE_BUILD:-false}" == "true" ]] && SKIP_BUILD=true
}

# ── Helpers ─────────────────────────────────────────────────────────────────

# Strong ephemeral secret for Postgres (hex only, 32 chars, no URL-hostile
# characters, never predictable). Uses openssl when available.
generate_strong_password() {
  if command -v openssl >/dev/null 2>&1; then
    local p
    p="$(openssl rand -hex 16 2>/dev/null || true)"
    [[ -n "$p" ]] && echo "$p" && return 0
  fi
  local p
  p="$(LC_ALL=C head -c 24 /dev/urandom 2>/dev/null | od -An -tx1 | tr -d ' \n')"
  if [[ -n "$p" ]]; then
    echo "$p"
    return 0
  fi
  echo "E2e-$(date +%s)-$$-$RANDOM$RANDOM$RANDOM"   # last-resort (≥8 chars, hex/numeric)
}

# ── Compose helpers ─────────────────────────────────────────────────────────

# Build the compose environment explicitly. Variable names MUST match the
# `${TEAMEM_*}` placeholders in docker-compose.yml (and the TEAMEM_ prefix
# the server reads, AGENTS.md §4) — a mismatch silently falls back to the
# compose file's defaults.
compose_env() {
  printf 'POSTGRES_PASSWORD=%s\n' "$PG_PASSWORD"
  printf 'POSTGRES_USER=%s\n' "${POSTGRES_USER:-teamem}"
  printf 'POSTGRES_DB=%s\n' "${POSTGRES_DB:-teamem}"
  if [[ "$MODE" == "all-in-one" ]]; then
    printf 'TEAMEM_ALL_IN_ONE=true\n'
  else
    printf 'TEAMEM_ALL_IN_ONE=false\n'
  fi
  printf 'TEAMEM_PG_PORT=%s\n' "$PG_PORT"
  printf 'TEAMEM_PORT=%s\n' "$SERVER_PORT"
  printf 'TEAMEM_BASE_URL=%s\n' "${TEAMEM_BASE_URL:-}"
  # LLM provider passthrough (compile + worker containers read these —
  # the server resolves TEAMEM_* from its own environment).
  printf 'TEAMEM_ANTHROPIC_API_KEY=%s\n' "${TEAMEM_ANTHROPIC_API_KEY:-}"
  printf 'TEAMEM_OPENAI_API_KEY=%s\n' "${TEAMEM_OPENAI_API_KEY:-}"
  printf 'TEAMEM_OPENROUTER_API_KEY=%s\n' "${TEAMEM_OPENROUTER_API_KEY:-}"
  printf 'TEAMEM_OPENAI_COMPAT_BASE_URL=%s\n' "${TEAMEM_OPENAI_COMPAT_BASE_URL:-}"
  printf 'TEAMEM_OPENAI_COMPAT_API_KEY=%s\n' "${TEAMEM_OPENAI_COMPAT_API_KEY:-}"
  printf 'TEAMEM_LLM_DEBUG=%s\n' "${TEAMEM_LLM_DEBUG:-}"
}

compose() {
  local -a env_arr=()
  while IFS= read -r line; do
    env_arr+=("$line")
  done < <(compose_env)
  env "${env_arr[@]}" docker compose \
    --file "$COMPOSE_FILE" \
    --project-name "$COMPOSE_PROJECT" \
    "$@"
}

# ── Honesty gate (exit 2: the environment cannot satisfy the check) ────────

check_prereqs() {
  header "M3 E2E — one-command real end-to-end — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  info "Mode: $MODE ($( [[ "$MODE" == "all-in-one" ]] && echo '2 containers, embedded worker' || echo '3 containers: postgres + server + worker' ))"
  info "Compose project: '$COMPOSE_PROJECT' (isolated — never touches a running 'teamem' dev stack)"
  info "Server: $BASE_URL"

  local missing=0

  for cmd in docker curl jq; do
    command -v "$cmd" >/dev/null 2>&1 || { fail "Missing command: $cmd"; missing=1; }
  done

  if ! docker compose version >/dev/null 2>&1; then
    fail "docker compose plugin is not available"
    missing=1
  fi

  if [[ -z "$PG_PASSWORD" ]]; then
    # The compose file deliberately has no default password; the script mints a
    # strong, ephemeral, per-run secret instead (never persisted, never logged,
    # not predictable). Operators can still pin one via POSTGRES_PASSWORD or
    # .env for persistent debugging.
    PG_PASSWORD="$(generate_strong_password)"
    info "POSTGRES_PASSWORD not set — generated a strong ephemeral password for this run (override via POSTGRES_PASSWORD or .env)"
    if [[ -z "$PG_PASSWORD" ]]; then
      fail "Could not generate a strong POSTGRES_PASSWORD — set POSTGRES_PASSWORD explicitly"
      missing=1
    fi
  elif [[ "${#PG_PASSWORD}" -lt 8 || "$PG_PASSWORD" == "postgres" || "$PG_PASSWORD" == "password" || "$PG_PASSWORD" == "teamem" ]]; then
    fail "POSTGRES_PASSWORD is too weak (need ≥8 chars, not a common password)"
    missing=1
  elif local bad_char=""
       for ch in '#' '@' '%' ' ' '"' "'" '\\'; do
         if [[ "$PG_PASSWORD" == *"$ch"* ]]; then bad_char="$ch"; break; fi
       done
       [[ -n "$bad_char" ]]; then
    fail "POSTGRES_PASSWORD contains '#', '@', '%', space, quote or backslash — those break the compose DATABASE_URL; pick a different password"
    missing=1
  fi

  # LLM provider: at least one BYO key is required for F1/F2. Without one the
  # compile job fails with no_llm_provider — which is itself honest, but the
  # green gate ("compile into a concept") can never pass. SKIP is not green.
  local has_provider=0
  [[ -n "${TEAMEM_ANTHROPIC_API_KEY:-}" ]] && has_provider=1
  [[ -n "${TEAMEM_OPENAI_API_KEY:-}" ]] && has_provider=1
  [[ -n "${TEAMEM_OPENROUTER_API_KEY:-}" ]] && has_provider=1
  [[ -n "${TEAMEM_OPENAI_COMPAT_API_KEY:-}" ]] && has_provider=1

  if [[ "$has_provider" -eq 0 ]]; then
    echo
    skip "No LLM provider key is configured — SKIP, not green."
    printf '%s\n' \
      "Compilation (F1/F2) would fail with no_llm_provider, so this run cannot" \
      "verify the up → ingest → compile → MCP search loop." \
      "Set at least one of: TEAMEM_ANTHROPIC_API_KEY / TEAMEM_OPENAI_API_KEY /" \
      "TEAMEM_OPENROUTER_API_KEY / TEAMEM_OPENAI_COMPAT_API_KEY, then re-run." \
      "${BOLD}SKIP is NOT green — the M3 E2E exit check is left unverified.${NC}"
    echo
    exit 2
  fi

  if [[ "$missing" -ne 0 ]]; then
    echo
    fail "Prerequisites missing — cannot run the E2E check (SKIP, not green)."
    exit 2
  fi

  pass "All prerequisites met (docker, compose, curl, jq, password, LLM provider)"
  echo ""
}

# ── Phase 1: UP ─────────────────────────────────────────────────────────────

phase_up() {
  header "1. UP — Build & start the compose stack"

  info "Pre-cleaning stale '$COMPOSE_PROJECT' state (idempotent/repeatable)..."
  if compose down --volumes --remove-orphans --timeout 10 >/dev/null 2>&1; then
    pass "Stale '$COMPOSE_PROJECT' stack removed (if any)"
    inc_pass
  else
    warn "Pre-clean could not run (nothing to clean or daemon hiccup) — continuing; 'up' remains the gate"
  fi

  local services=("postgres" "server")
  if [[ "$MODE" == "standard" ]]; then
    services+=("worker")
  fi

  if [[ "$SKIP_BUILD" == "true" ]]; then
    info "SKIP_COMPOSE_BUILD=true — verifying images exist instead of building..."
    local img missing_img=0
    while IFS= read -r img; do
      [[ -z "$img" ]] && continue
      if ! docker image inspect "$img" >/dev/null 2>&1; then
        fail "Image $img is missing — drop --skip-build (or SKIP_COMPOSE_BUILD) to build it"
        missing_img=1
      fi
    done < <(compose config --images 2>/dev/null || true)
    if [[ "$missing_img" -ne 0 ]]; then
      inc_fail
      echo ""
      return 1
    fi
    pass "Images present (build skipped)"
    inc_pass
  else
    info "Building Docker image..."
    if ! compose build >/dev/null 2>&1; then
      fail "docker compose build failed — see the errors with: docker compose build"
      inc_fail
      echo ""
      return 1
    fi
    pass "Docker image built"
    inc_pass
  fi

  info "Starting services: ${services[*]}"
  STACK_UP=true   # from here on, any failure must tear the stack down again
  if ! compose up -d --wait "${services[@]}" 2>&1; then
    fail "compose up failed — top of the stack state:"
    compose ps 2>/dev/null || true
    compose logs --tail=30 server postgres 2>/dev/null | tail -30 || true
    inc_fail
    echo ""
    return 1
  fi
  pass "compose up: ${services[*]} started"
  inc_pass

  # Topology verification (honest: the running set must match the mode).
  local comp_json
  comp_json="$(compose ps --format json 2>/dev/null || true)"
  local has_pg has_server has_worker
  has_pg="$(printf '%s' "$comp_json" | jq -r 'select(.Service == "postgres") | .Name' | wc -l | tr -d ' ')"
  has_server="$(printf '%s' "$comp_json" | jq -r 'select(.Service == "server") | .Name' | wc -l | tr -d ' ')"
  has_worker="$(printf '%s' "$comp_json" | jq -r 'select(.Service == "worker") | .Name' | wc -l | tr -d ' ')"

  if [[ "$MODE" == "all-in-one" ]]; then
    if [[ "$has_pg" -ge 1 && "$has_server" -ge 1 && "$has_worker" -eq 0 ]]; then
      pass "Topology: postgres + server, no standalone worker (all-in-one)"
      inc_pass
    else
      fail "Topology mismatch (all-in-one expected): postgres=$has_pg server=$has_server worker=$has_worker"
      inc_fail
    fi
  else
    if [[ "$has_pg" -ge 1 && "$has_server" -ge 1 && "$has_worker" -ge 1 ]]; then
      pass "Topology: postgres + server + worker (standard)"
      inc_pass
    else
      fail "Topology mismatch (standard expected): postgres=$has_pg server=$has_server worker=$has_worker"
      inc_fail
    fi
  fi

  # Health: liveness then readiness (DB reachable → migrations have run).
  local hz rz
  hz="$(wait_for_http "/healthz" "liveness" 30)"
  rz="$(wait_for_http "/readyz" "readiness (DB reachable)" 30)"

  if [[ "$hz" == "ok" ]]; then
    pass "/healthz → ok (liveness)"
    inc_pass
  else
    fail "/healthz not ok (${hz:-unreachable})"
    compose logs --tail=30 server 2>/dev/null | tail -30 || true
    inc_fail
  fi

  if [[ "$rz" == "ok" ]]; then
    pass "/readyz → ok (readiness)"
    inc_pass
  else
    fail "/readyz not ok (${rz:-unreachable}) — server not ready to serve traffic"
    inc_fail
  fi

  echo ""
  if [[ "$(get_fail)" -ne 0 ]]; then
    return 1
  fi
  return 0
}

# Poll an endpoint until it reports {"status":"ok"} or a timeout (seconds).
wait_for_http() {
  local path="$1" desc="$2" seconds="${3:-30}"
  local deadline=$(( $(date +%s) + seconds ))
  local body=""
  while :; do
    body="$(curl -fsS "${BASE_URL}${path}" 2>/dev/null || true)"
    if echo "$body" | jq -e '.status == "ok"' >/dev/null 2>&1; then
      echo "ok"
      return 0
    fi
    if [[ "$(date +%s)" -ge "$deadline" ]]; then
      echo "$body"
      return 1
    fi
    sleep 2
  done
}

# ── Phase 2: INGEST — bootstrap ─────────────────────────────────────────────

phase_bootstrap() {
  header "2. INGEST — Bootstrap an isolated team / project / API key"

  info "Running bootstrap inside the server container..."
  local out
  out="$(compose exec -T server node apps/server/dist/index.js --bootstrap \
    --team-name "E2E-${TIMESTAMP}" \
    --project-name "e2e-${TIMESTAMP}" \
    --principal-name "e2e-script" 2>&1)" || {
    fail "Bootstrap command failed"
    info "Output: $(echo "$out" | head -5)"
    inc_fail
    echo ""
    return 1
  }

  if ! echo "$out" | jq empty >/dev/null 2>&1; then
    fail "Bootstrap output is not valid JSON"
    info "Output: $(echo "$out" | head -5)"
    inc_fail
    echo ""
    return 1
  fi

  TEAM_ID="$(echo "$out" | jq -r '.team.id // empty')"
  PROJECT_ID="$(echo "$out" | jq -r '.project.id // empty')"
  API_KEY="$(echo "$out" | jq -r '.key.token // empty')"

  if [[ -z "$TEAM_ID" || -z "$PROJECT_ID" ]]; then
    fail "Bootstrap did not produce team/project IDs"
    inc_fail
    echo ""
    return 1
  fi
  if [[ -z "$API_KEY" || ( "$API_KEY" != tok_* && "$API_KEY" != tm_* ) ]]; then
    fail "Bootstrap did not produce a valid API key (tok_… / legacy tm_…)"
    inc_fail
    echo ""
    return 1
  fi

  pass "Team: $TEAM_ID"
  pass "Project: $PROJECT_ID"
  pass "API key: created (token masked)"
  inc_pass
  echo ""
}

# ── Phase 3: INGEST — real event ────────────────────────────────────────────

phase_ingest() {
  header "3. INGEST — Submit a real cli_init event (compile=true)"

  # Real, durable artifact anchor (AGENTS.md §1/§5.1/§6.1): the frozen
  # decision ADR committed to THIS repository. repo + immutable commit SHA +
  # path + content are all resolved from the git object database (never
  # fabricated, never from the working tree), so the repo_file evidence is
  # genuinely durable and re-resolvable.
  local artifact_repo="teamem-ai/teamem-server"
  local artifact_path="${TEAMEM_E2E_ARTIFACT_PATH:-docs/adr/001-http-runtime-and-dev-scripts.md}"
  local artifact_commit="${TEAMEM_E2E_ARTIFACT_COMMIT:-141c05b0dd01ce5ddf944f919b37134db1c2a21a}"

  # The artifact must resolve at that exact commit; otherwise we refuse to
  # ingest a fictional anchor (the original defect this replaces).
  if ! ( cd "$REPO_ROOT" && git cat-file -e "${artifact_commit}:${artifact_path}" >/dev/null 2>&1 ); then
    fail "Durable artifact not resolvable at ${artifact_commit}:${artifact_path} — refusing a fabricated anchor"
    inc_fail
    echo ""
    return 1
  fi
  if ! ( cd "$REPO_ROOT" && git cat-file -e "${artifact_commit}^{commit}" >/dev/null 2>&1 ); then
    fail "Commit ${artifact_commit} is not a real commit — refusing a fabricated anchor"
    inc_fail
    echo ""
    return 1
  fi

  local artifact_content artifact_url
  artifact_content="$(cd "$REPO_ROOT" && git show "${artifact_commit}:${artifact_path}")"
  artifact_url="https://github.com/${artifact_repo}/blob/${artifact_commit}/${artifact_path}"
  pass "Durable artifact anchored: ${artifact_path} @ ${artifact_commit} (immutable, tracked)"
  inc_pass

  local payload
  payload="$(jq -n \
    --arg projectId "$PROJECT_ID" \
    --arg ts "$TIMESTAMP" \
    --arg repo "$artifact_repo" \
    --arg sha "$artifact_commit" \
    --arg path "$artifact_path" \
    --arg url "$artifact_url" \
    --arg content "$artifact_content" \
    '{
      projectId: $projectId,
      source: {
        kind: "cli_init",
        externalId: ($repo + "/" + $path),
        url: $url
      },
      idempotencyKey: ("m3-e2e-" + $ts),
      options: { compile: true, wait: false },
      payload: {
        schemaVersion: 1,
        repo: $repo,
        commitSha: $sha,
        path: $path,
        content: $content
      }
    }')"

  local body_f="$E2E_TMP/ingest.json"
  local code
  code="$(curl -sS -o "$body_f" -w '%{http_code}' -X POST "${BASE_URL}/v1/events" \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer ${API_KEY}" \
    -d "$payload" 2>/dev/null || true)"
  code="${code:-000}"

  if [[ "$code" != "202" ]]; then
    fail "POST /v1/events returned HTTP $code (expected 202)"
    if jq -e '.error' "$body_f" >/dev/null 2>&1; then
      info "API error: $(jq -r '.error.code // "unknown"' "$body_f") — $(jq -r '.error.message // ""' "$body_f")"
    else
      info "Body: $(head -c 400 "$body_f")"
    fi
    inc_fail
    echo ""
    return 1
  fi

  EVENT_ID="$(jq -r '.eventId // empty' "$body_f")"
  JOB_ID="$(jq -r '.jobId // empty' "$body_f")"

  if [[ -z "$EVENT_ID" || "$EVENT_ID" != evt_* ]]; then
    fail "No valid eventId in the 202 response"
    inc_fail
    echo ""
    return 1
  fi
  if [[ -z "$JOB_ID" || "$JOB_ID" == "null" ]]; then
    fail "jobId is null — a compile job was not created (options.compile ignored?)"
    inc_fail
    echo ""
    return 1
  fi

  pass "Event accepted: eventId=$EVENT_ID"
  pass "Compile job created: jobId=$JOB_ID"
  inc_pass
  echo ""
}

# ── Phase 4: COMPILE ────────────────────────────────────────────────────────

phase_compile() {
  header "4. COMPILE — Wait for the concept page (timeout ${COMPILE_TIMEOUT}s)"

  local deadline=$(( $(date +%s) + COMPILE_TIMEOUT ))
  local status=""
  local attempt=0

  while :; do
    attempt=$((attempt + 1))
    local body_f="$E2E_TMP/job.json"
    local code
    code="$(curl -sS -o "$body_f" -w '%{http_code}' -H "Authorization: Bearer ${API_KEY}" \
      "${BASE_URL}/v1/jobs/${JOB_ID}" 2>/dev/null || true)"
    code="${code:-000}"

    if [[ "$code" == "200" ]] && jq empty "$body_f" >/dev/null 2>&1; then
      status="$(jq -r '.data.status // empty' "$body_f")"
    else
      status=""
      [[ $((attempt % 10)) -eq 1 ]] && warn "  job poll: HTTP $code or non-JSON (attempt $attempt) — retrying"
    fi

    case "$status" in
      completed)
        local concept_ids count
        concept_ids="$(jq -r '.data.conceptIds // []' "$body_f")"
        count="$(echo "$concept_ids" | jq -r 'length // 0')"
        if [[ "$count" -lt 1 ]]; then
          fail "Job completed but produced 0 concepts — compilation yielded no concept page"
          inc_fail
          echo ""
          return 1
        fi
        CONCEPT_UUID="$(echo "$concept_ids" | jq -r '.[0] // empty')"
        pass "Compile job ${JOB_ID} → completed ($count concept page(s))"
        pass "Concept UUID: $CONCEPT_UUID"
        inc_pass
        echo ""
        return 0
        ;;
      failed)
        local jerr jevents
        jerr="$(jq -c '.data.error // {}' "$body_f")"
        jevents="$(jq -c '.data.events // []' "$body_f")"
        fail "Compile job ${JOB_ID} failed: $jerr"
        info "Per-event outcomes: $jevents"
        inc_fail
        echo ""
        return 1
        ;;
      processing|queued)
        sleep 3
        ;;
      *)
        if [[ "$(date +%s)" -ge "$deadline" ]]; then
          break
        fi
        sleep 3
        ;;
    esac

    if [[ "$(date +%s)" -ge "$deadline" ]]; then
      break
    fi
  done

  fail "Compile job ${JOB_ID} did not reach a terminal state within ${COMPILE_TIMEOUT}s (last status: ${status:-unknown}) — worker not processing?"
  inc_fail
  echo ""
  return 1
}

# ── Phase 5: MCP SEARCH ─────────────────────────────────────────────────────

# Raw /mcp JSON-RPC call. Prints the HTTP code and writes the body.
mcp_call() {
  local req_json="$1" out="$2"
  local code
  code="$(curl -sS -o "$out" -w '%{http_code}' -X POST "${BASE_URL}/mcp" \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer ${API_KEY}" \
    -d "$req_json" 2>/dev/null || true)"
  code="${code:-000}"
  printf '%s' "$code"
}

phase_mcp_search() {
  header "5. MCP SEARCH — Retrieve the compiled concept via /mcp"

  if [[ -z "$CONCEPT_UUID" ]]; then
    skip "No concept UUID (compile did not produce one) — MCP search cannot be verified; run is already RED"
    echo ""
    return 1
  fi

  # 5a. Initialize handshake (protocol correctness).
  local init_resp="$E2E_TMP/mcp-init.json"
  local init_code
  init_code="$(mcp_call '{"jsonrpc":"2.0","id":"e2e-init","method":"initialize","params":{}}' "$init_resp")"
  if [[ "$init_code" == "200" ]] && [[ "$(jq -r '.result.serverInfo.name // ""' "$init_resp")" == "teamem" ]]; then
    pass "MCP initialize: serverInfo.name=teamem"
    inc_pass
  else
    fail "MCP initialize failed (HTTP $init_code): $(head -c 300 "$init_resp")"
    inc_fail
    echo ""
    return 1
  fi

  # 5b. tools/list — the search tool must be part of the MCP surface.
  local tools_resp="$E2E_TMP/mcp-tools.json"
  local tools_code
  tools_code="$(mcp_call '{"jsonrpc":"2.0","id":"e2e-tools","method":"tools/list","params":{}}' "$tools_resp")"
  if [[ "$tools_code" == "200" ]] && jq -e '[.result.tools[].name] | index("search")' "$tools_resp" >/dev/null 2>&1; then
    pass "MCP tools/list exposes the search tool"
    inc_pass
  else
    fail "MCP tools/list did not expose 'search' (HTTP $tools_code)"
    inc_fail
    echo ""
    return 1
  fi

  # 5c. tools/call search — the compiled concept MUST be retrievable.
  # The concept F1 extracts from the ADR is about Hono/Node.js — search for a
  # distinctive term the compiled page body will contain (FTS 'simple' config).
  local search_args query="hono"
  search_args="$(jq -nc --arg projectId "$PROJECT_ID" --arg query "$query" \
    '{projectId: $projectId, query: $query}')"
  local req
  req="$(jq -nc --argjson args "$search_args" \
    '{jsonrpc:"2.0", id:"e2e-search", method:"tools/call", params:{name:"search", arguments:$args}}')"

  local search_resp="$E2E_TMP/mcp-search.json"
  local search_code
  search_code="$(mcp_call "$req" "$search_resp")"

  if [[ "$search_code" != "200" ]] || ! jq empty "$search_resp" >/dev/null 2>&1; then
    fail "MCP search: HTTP $search_code or non-JSON response"
    inc_fail
    echo ""
    return 1
  fi

  if jq -e '.error' "$search_resp" >/dev/null 2>&1; then
    fail "MCP search: JSON-RPC error: $(jq -r '.error.message // "unknown"' "$search_resp")"
    inc_fail
    echo ""
    return 1
  fi

  if jq -e '.result.isError == true' "$search_resp" >/dev/null 2>&1; then
    fail "MCP search tool error: $(jq -r '.result.content[0].text // "unknown"' "$search_resp")"
    inc_fail
    echo ""
    return 1
  fi

  local result_text results_array
  result_text="$(jq -r '.result.content[0].text // ""' "$search_resp")"
  if [[ -z "$result_text" ]] || ! echo "$result_text" | jq empty >/dev/null 2>&1; then
    fail "MCP search returned no JSON result content"
    inc_fail
    echo ""
    return 1
  fi

  results_array="$(echo "$result_text" | jq -r '.results // []')"
  SEARCH_DEGRADED="$(echo "$result_text" | jq -r '.degraded // false')"
  local result_count
  result_count="$(echo "$results_array" | jq -r 'length // 0')"
  info "Search \"$query\" returned $result_count result(s)"

  if [[ "$SEARCH_DEGRADED" == "true" ]]; then
    # Honest FTS fallback (§5.5): still a real retrieval — but never
    # pretend vector search worked.
    warn "Search is degraded (FTS-only — no embedding capability); retrieval is via full-text search"
  fi

  local row
  row="$(echo "$results_array" | jq -c --arg uuid "$CONCEPT_UUID" \
    '.[] | select(.uuid == $uuid)')"

  if [[ -z "$row" ]]; then
    fail "MCP search did NOT return the compiled concept $CONCEPT_UUID (query \"$query\")"
    info "Returned: $(echo "$results_array" | jq -c '[.[] | {uuid, title, type}]')"
    inc_fail
    echo ""
    return 1
  fi

  CONCEPT_TITLE="$(echo "$row" | jq -r '.title // ""')"
  local row_type
  row_type="$(echo "$row" | jq -r '.type // ""')"

  pass "MCP search: compiled concept $CONCEPT_UUID found via /mcp"
  pass "  title: $CONCEPT_TITLE | type: $row_type"
  inc_pass
  echo ""
  return 0
}

# ── Phase 6: CLEANUP ────────────────────────────────────────────────────────

phase_cleanup() {
  header "6. CLEANUP"

  if [[ "$KEEP_STACK" == "true" ]]; then
    skip "Stack left running by explicit request (--keep-stack) — this run's data remains; a later run pre-cleans it"
    echo ""
    return 0
  fi

  info "Tearing the '$COMPOSE_PROJECT' stack down (--volumes)..."
  if compose down --volumes --remove-orphans --timeout 15 >/dev/null 2>&1; then
    CLEANUP_DONE=true
    pass "Stack torn down — volumes removed (repeatable next run)"
    inc_pass
    echo ""
    return 0
  fi

  fail "compose down failed — remove the stack manually: docker compose -p '$COMPOSE_PROJECT' down --volumes"
  inc_fail
  echo ""
  return 1
}

# ── Exit trap: guaranteed teardown + temp hygiene ───────────────────────────

on_exit() {
  rm -rf "$E2E_TMP"
  if [[ "$STACK_UP" == "true" && "$KEEP_STACK" != "true" && "$CLEANUP_DONE" != "true" ]]; then
    warn "Teardown on exit (a phase failed before the cleanup phase)..."
    if compose down --volumes --remove-orphans --timeout 15 >/dev/null 2>&1; then
      warn "  stack torn down"
    else
      warn "  teardown failed — remove manually: docker compose -p '$COMPOSE_PROJECT' down --volumes"
    fi
  fi
}
trap on_exit EXIT

# ── Summary + verdict ───────────────────────────────────────────────────────

print_summary() {
  local rc="$1"
  local p f
  p="$(get_pass)"; f="$(get_fail)"

  header "M3 E2E — Summary ($( [[ "$rc" -eq 0 ]] && echo GREEN || echo NOT-GREEN ))"
  echo "  Phases verified: up → ingest → compile → MCP search → cleanup"
  printf "  ${GREEN}PASS: %s${NC}\n" "$p"
  printf "  ${RED}FAIL: %s${NC}\n" "$f"

  if [[ "$rc" -eq 0 ]]; then
    echo ""
    pass "GREEN — full loop verified end to end:"
    info "  up:         '${COMPOSE_PROJECT}' ($MODE) healthy"
    info "  ingest:     event ${EVENT_ID} → job ${JOB_ID}"
    info "  compile:    concept ${CONCEPT_UUID} (${CONCEPT_TITLE:-title unknown})"
    info "  MCP search: retrieved via /mcp search (degraded=${SEARCH_DEGRADED})"
    info "  cleanup:    stack torn down (--volumes)"
    echo ""
    exit 0
  fi

  echo ""
  fail "RED — the M3 E2E exit check is NOT green."
  if [[ "$f" -eq 0 ]]; then
    # RED with zero counted fails: a phase returned 1 without inc_fail
    # (e.g. MCP search skipped because compile could not produce a concept).
    fail "The loop did not complete end to end; see the phase output above."
  fi
  echo ""
  exit 1
}

# ── Main ────────────────────────────────────────────────────────────────────

main() {
  parse_args "$@"
  check_prereqs

  local rc=0
  phase_up        || rc=1
  phase_bootstrap || rc=1
  phase_ingest    || rc=1
  phase_compile   || rc=1
  phase_mcp_search || rc=1
  phase_cleanup   || rc=1

  print_summary "$rc"
}

main "$@"