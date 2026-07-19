# M0 GitHub Webhook Smoke Test — Result Template

## Run Information

| Field | Value |
|---|---|
| **Date / Time** | `YYYY-MM-DDTHH:MM:SSZ` |
| **Tester** | _(name)_ |
| **Repository** | `owner/repo` |
| **Server URL** | `http://127.0.0.1:8080` |
| **Webhook Secret** | `configured` / `not configured` |

## 1. Event Delivery Results

| Event Type | HTTP Status | Events Ingested | Status |
|---|---|---|---|
| Push (`push`) | `200` | `N` | ✓ / ✗ |
| Issue (`issues`) | `200` | `1` | ✓ / ✗ |
| Pull Request (`pull_request`) | `200` | `1` | ✓ / ✗ |
| PR Review (`pull_request_review`) | `200` | `1` | ✓ / ✗ |

## 2. API Verification (`GET /v1/events`)

| Check | Expected | Actual | Result |
|---|---|---|---|
| Total events ≥ 4 | ≥ 4 | `N` | ✓ / ✗ |
| `github_commit` present | ≥ 1 | `N` | ✓ / ✗ |
| `github_issue` present | ≥ 1 | `N` | ✓ / ✗ |
| `github_pr` present | ≥ 1 | `N` | ✓ / ✗ |
| `github_pr_comment` present | ≥ 1 | `N` | ✓ / ✗ |
| `channel` = `github` for all events | `github` | | ✓ / ✗ |
| `actorProvenance` correct | `webhook_verified` or `unknown` | | ✓ / ✗ |
| `url` is canonical `github.com/...` | starts with `https://github.com/` | | ✓ / ✗ |

## 3. Database Verification (PostgreSQL)

| Check | Expected | Actual | Result |
|---|---|---|---|
| `github_commit` rows exist | ≥ 1 | `N` | ✓ / ✗ |
| `github_commit.channel` = `github` | `github` | | ✓ / ✗ |
| `github_commit.source_event` = `push` | `push` | | ✓ / ✗ |
| `github_commit.item_key` = commit SHA | 40-char hex | | ✓ / ✗ |
| `github_commit.occurred_at_provenance` = `provider` | `provider` | | ✓ / ✗ |
| `github_commit.actor_provenance` correct | `webhook_verified` or `unknown` | | ✓ / ✗ |
| `github_issue` rows exist | ≥ 1 | `N` | ✓ / ✗ |
| `github_issue.source_event` = `issues` | `issues` | | ✓ / ✗ |
| `github_issue.source_action` not null | not null | | ✓ / ✗ |
| `github_issue.url` contains `/issues/` | `/issues/` | | ✓ / ✗ |
| `github_pr` rows exist | ≥ 1 | `N` | ✓ / ✗ |
| `github_pr.source_event` = `pull_request` | `pull_request` | | ✓ / ✗ |
| `github_pr_comment` rows exist | ≥ 1 | `N` | ✓ / ✗ |
| `github_pr_comment.url` has `#` anchor | contains `#` | | ✓ / ✗ |

## 4. Idempotency

| Check | Expected | Actual | Result |
|---|---|---|---|
| Replay same payload → HTTP 200, all `duplicate` | 200 + duplicate status | `200` | ✓ / ✗ |
| Same delivery, modified payload → HTTP 409 | 409 | `409` | ✓ / ✗ |

## 5. Summary

| Metric | Count |
|---|---|
| Total assertions | `N` |
| Passed | `N` |
| Failed | `N` |

**Overall result**: ✓ PASS / ✗ FAIL

## Notes

_(Any observations, warnings, or limitations encountered during the test.)_
