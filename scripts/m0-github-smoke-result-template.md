# M0 GitHub Webhook Smoke Test — Result Template

## Run Information

| Field | Value |
|---|---|
| **Date / Time** | `YYYY-MM-DDTHH:MM:SSZ` |
| **Tester** | _(name)_ |
| **Repository** | `owner/repo` |
| **Webhook Secret** | `configured` _(REQUIRED)_ |
| **Server URL** | `http://127.0.0.1:8080` |

## 1. Webhook Setup

| Check | Expected | Actual | Result |
|---|---|---|---|
| Temporary webhook created on repo | `id` returned | | ✓ / ✗ |
| Webhook configured with secret | `config.secret` set | | ✓ / ✗ |
| Events subscribed: push, issues, pull_request, pull_request_review | all 4 | | ✓ / ✗ |

## 2. Real GitHub Events Created

| Event Type | Created? | Identifier |
|---|---|---|
| Push | ✓ / ✗ | commit `abc1234` |
| Issue | ✓ / ✗ | `#N` |
| Pull Request | ✓ / ✗ | `#N` |
| PR Review | ✓ / ✗ | review ID `N` |

## 3. Real Webhook Deliveries (from GitHub Delivery Log)

| Delivery Type | Found in GitHub Log? | Delivery GUID | Payload Size |
|---|---|---|---|
| `push` | ✓ / ✗ | | bytes |
| `issues` | ✓ / ✗ | | bytes |
| `pull_request` | ✓ / ✗ | | bytes |
| `pull_request_review` | ✓ / ✗ | | bytes |

## 4. HTTP Webhook Ingest

| Event Type | Delivery GUID Used | Events Ingested | Status |
|---|---|---:|---|
| Push (`github_commit`) | | `N` | ✓ / ✗ |
| Issue (`github_issue`) | | `1` | ✓ / ✗ |
| PR (`github_pr`) | | `1` | ✓ / ✗ |
| Review (`github_pr_comment`) | | `1` | ✓ / ✗ |

## 5. Verification — `GET /v1/events`

| Check | Expected | Actual | Result |
|---|---|---|---|
| `github_commit` present | ≥ 1 | `N` | ✓ / ✗ |
| `github_issue` present | ≥ 1 | `N` | ✓ / ✗ |
| `github_pr` present | ≥ 1 | `N` | ✓ / ✗ |
| `github_pr_comment` present | ≥ 1 | `N` | ✓ / ✗ |
| `channel` = `github` for all | `github` | | ✓ / ✗ |
| `actorProvenance` = `webhook_verified` | `webhook_verified` | | ✓ / ✗ |
| `url` starts with `https://github.com/` | `https://github.com/...` | | ✓ / ✗ |

## 6. Verification — PostgreSQL

| Check | Expected | Actual | Result |
|---|---|---|---|
| `github_commit` rows | ≥ 1 | `N` | ✓ / ✗ |
| `github_commit.channel` = `github` | `github` | | ✓ / ✗ |
| `github_commit.source_event` = `push` | `push` | | ✓ / ✗ |
| `github_commit.item_key` = commit SHA | ≥ 40 chars | | ✓ / ✗ |
| `github_commit.occurred_at_provenance` = `provider` | `provider` | | ✓ / ✗ |
| `github_commit.actor_provenance` = `webhook_verified` | `webhook_verified` | | ✓ / ✗ |
| `github_issue.source_event` = `issues` | `issues` | | ✓ / ✗ |
| `github_issue.source_action` not null | not null | | ✓ / ✗ |
| `github_pr.source_event` = `pull_request` | `pull_request` | | ✓ / ✗ |
| `github_pr_comment.url` has `#` fragment | contains `#` | | ✓ / ✗ |
| All events: `actor_provenance` = `webhook_verified` | `webhook_verified` | | ✓ / ✗ |

## 7. Verification — Jobs

| Check | Expected | Actual | Result |
|---|---|---|---|
| Smoke events linked to `job_events` | all smoke events | | ✓ / ✗ |
| At least one `jobs` row present | ≥ 1 | | ✓ / ✗ |
| Job status recorded | `queued` / `processing` / `completed` / `failed` | | ✓ / ✗ |

## 8. Idempotency

| Check | Expected | Result |
|---|---|---|
| Replay same payload → all `duplicate` status | all duplicate | ✓ / ✗ |
| Modified payload with same delivery GUID → rejected | HTTP 409 | ✓ / ✗ |

## 9. Summary

| Metric | Count |
|---|---|
| Total assertions | `N` |
| Passed | `N` |
| Failed | `N` |

**Overall result**: ✓ PASS / ✗ FAIL

## Notes

_(Observations, warnings, or limitations encountered.)_
