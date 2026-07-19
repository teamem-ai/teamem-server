# M0 GitHub Webhook Smoke Test — Result Template

## Run Information

| Field | Value |
|---|---|
| **Date / Time** | `2026-07-19T23:09:48Z` |
| **Tester** | duan-li (automated smoke test) |
| **Repository** | `duan-li/gocker` |
| **Webhook Secret** | `configured` _(REQUIRED)_ |
| **Server URL** | `http://127.0.0.1:8080` |

## 1. Webhook Setup

| Check | Expected | Actual | Result |
|---|---|---|---|
| Temporary webhook created on repo | `id` returned | `654527940` | ✓ |
| Webhook configured with secret | `config.secret` set | configured (26 chars) | ✓ |
| Events subscribed: push, issues, pull_request, pull_request_review | all 4 | 6 events subscribed | ✓ |

## 2. Real GitHub Events Created

| Event Type | Created? | Identifier |
|---|---|---|
| Push | ✓ | commit `61cf4694` |
| Issue | ✓ | `#10` |
| Pull Request | ✓ | `#11` |
| PR Review | ✓ | review ID `4731651667` |

## 3. Real Webhook Deliveries (from GitHub Delivery Log)

| Delivery Type | Found in GitHub Log? | Delivery ID | Payload Size |
|---|---|---|---|
| `push` | ✓ | `3832190144476102656` | 7454 bytes |
| `issues` | ✓ | `3832190149423267840` | 8440 bytes |
| `pull_request` | ✓ | `3832190157065289728` | 21353 bytes |
| `pull_request_review` | ✓ | `3832190155278516224` | 22661 bytes |

## 4. HTTP Webhook Ingest

| Event Type | Delivery ID Used | Events Ingested | Status |
|---|---|---:|---|
| Push (`github_commit`) | `3832190144476102656` | `1` | ✓ |
| Issue (`github_issue`) | `3832190149423267840` | `1` | ✓ |
| PR (`github_pr`) | `3832190157065289728` | `1` | ✓ |
| Review (`github_pr_comment`) | `3832190155278516224` | `1` | ✓ |

## 5. Verification — `GET /v1/events`

| Check | Expected | Actual | Result |
|---|---|---|---|
| `github_commit` present | ≥ 1 | `2` (incl. previous run) | ✓ |
| `github_issue` present | ≥ 1 | `2` | ✓ |
| `github_pr` present | ≥ 1 | `2` | ✓ |
| `github_pr_comment` present | ≥ 1 | `2` | ✓ |
| `channel` = `github` for all | `github` | `github` | ✓ |
| `actorProvenance` = `webhook_verified` | `webhook_verified` | `webhook_verified` | ✓ |
| `url` starts with `https://github.com/` | `https://github.com/...` | `https://github.com/...` | ✓ |

## 6. Verification — PostgreSQL

| Check | Expected | Actual | Result |
|---|---|---|---|
| `github_commit` rows | ≥ 1 | `1` | ✓ |
| `github_commit.channel` = `github` | `github` | `github` | ✓ |
| `github_commit.source_event` = `push` | `push` | `push` | ✓ |
| `github_commit.item_key` = commit SHA | ≥ 40 chars | `61cf4694...` (40 chars) | ✓ |
| `github_commit.occurred_at_provenance` = `provider` | `provider` | `provider` | ✓ |
| `github_commit.actor_provenance` = `webhook_verified` | `webhook_verified` | `webhook_verified` | ✓ |
| `github_issue.source_event` = `issues` | `issues` | `issues` | ✓ |
| `github_issue.source_action` not null | not null | `labeled` | ✓ |
| `github_pr.source_event` = `pull_request` | `pull_request` | `pull_request` | ✓ |
| `github_pr_comment.url` has `#` fragment | contains `#` | contains `#pullrequestreview-4731651667` | ✓ |
| All events: `actor_provenance` = `webhook_verified` | `webhook_verified` | `webhook_verified` | ✓ |

## 7. Verification — Jobs

| Check | Expected | Actual | Result |
|---|---|---|---|
| Smoke events linked to `job_events` | all smoke events | 0 linked (no pg-boss) | ✗ |
| At least one `jobs` row present | ≥ 1 | `0` (no pg-boss) | ✗ |
| Job status recorded | `queued` / `processing` / `completed` / `failed` | N/A | ✗ |

_Note: Jobs empty — the webhook→event path used for this run did not include enqueue. The persist→enqueue step belongs to the ingestion pipeline (M0-GH-08)._

## 8. Idempotency

| Check | Expected | Result |
|---|---|---|
| Replay same payload → all `duplicate` status | all duplicate | ✓ (1/1 duplicate) |
| Modified payload (different hash) → rejected | HTTP 409 | ✓ (HTTP 409) |

_Note: Conflict test fixed to modify `commits[0].message` — the field the push normalizer actually stores in its event payload. HTTP 409 confirmed._

## 9. Redaction (§5.3)

| Check | Expected | Result |
|---|---|---|
| `<private>` tag stripped from PR review body | no `<private>` in stored payload | ✗ (LEAKED — endpoint missing stripPrivateTags) |
| `SECRET_TOKEN` content stripped | no secret in stored payload | ✗ (LEAKED) |

_**The redaction test works correctly**: it detected that the endpoint used for this run does not strip `<private>` tags from PR review payloads. The comment normalizer (`comments.ts`) intentionally does not self-redact — it relies on the ingestion pipeline's `stripPrivateTags` step (§5.3). This endpoint (temporary, not in this branch) is missing that step. M0-GH-08 must include `stripPrivateTags` in the webhook handler between normalization and persistence for all event types, especially PR reviews and comments whose normalizers do not self-redact._

## 10. Summary

| Metric | Count |
|---|---|
| Total assertions | `58` |
| Passed | `55` |
| Failed | `3` |

**Failed assertions:**
1. jobs: at least one job is present _(expected — no pg-boss)_
2. jobs: every smoke event linked through job_events _(expected — no pg-boss)_
3. Redaction: `<private>` tag LEAKED _(script correctly detected missing stripPrivateTags in temporary endpoint — M0-GH-08 must fix)_

**Key improvements from previous run:**
- Idempotency conflict (HTTP 409): now ✓ (previously ✗)
- Redaction test: now runs and detects violations (previously skipped with bug)

## Regression Checks

| Check | Result |
|---|---|
| `pnpm lint` | ✓ PASS (0 errors) |
| `pnpm typecheck` | ✓ PASS (apps/web, packages/schema, apps/server) |
| `pnpm test -- --run` | ✓ 735 passed, 168 skipped |
| `bash -n scripts/m0-github-smoke.sh` | ✓ syntax OK |

## Notes

1. **Endpoint dependency**: The smoke test requires `POST /v1/events/github` and `GET /v1/events`. These are owned by M0-GH-08. This green-run used a temporary local endpoint. Until M0-GH-08 merges, the script fails at `check_prereqs` with a clear message.

2. **Branch scope**: This branch contains only `scripts/m0-github-smoke.sh` and this result template. No server-side code.

3. **Redaction (red line 5.3)**: The script validates redaction by injecting a PR review with `<private>` tags and checking the stored payload. The test correctly detected the leak in the temporary endpoint. M0-GH-08 must ensure `stripPrivateTags` runs after normalization and before persistence in the webhook handler, covering all event types (especially PR reviews and comments whose normalizers do not self-redact).

4. **Conflict test (contract 6.2)**: Now works — modifying `commits[0].message` triggers HTTP 409 because the push normalizer stores commit messages in its event payload. Previous version modified `head_commit.message` which the normalizer ignores.

5. **Jobs (enqueue)**: The M0 pipeline requires persist→enqueue. The temporary endpoint used for this run does not enqueue. M0-GH-08 must create compilation jobs after persistence.
