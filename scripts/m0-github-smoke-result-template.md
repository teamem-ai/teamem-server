# M0 GitHub Webhook Smoke Test — Result Template

> Fill in this template when running the smoke test. Replace `«placeholder»` values with
> actual results from the test run.

## Run Information

| Field | Value |
|---|---|
| **Date / Time** | `«ISO 8601»` |
| **Tester** | `«name»` |
| **Repository** | `«owner/repo»` |
| **Webhook Secret** | `configured` _(REQUIRED)_ |
| **API Key** | `configured` _(REQUIRED for /v1/events read)_ |
| **Server URL** | `«TEAMEM_BASE_URL»` |

## 1. Webhook Setup

| Check | Expected | Actual | Result |
|---|---|---|---|
| Temporary webhook created on repo | `id` returned | `«HOOK_ID»` | «✓/✗» |
| Webhook configured with secret | secret set | configured | «✓/✗» |
| Events subscribed: push, issues, pull_request, pull_request_review | all 4 | «count» | «✓/✗» |

## 2. Real GitHub Events Created

| Event Type | Created? | Identifier |
|---|---|---|
| Push | «✓/✗» | commit `«sha»` |
| Issue | «✓/✗» | `#«number»` |
| Pull Request | «✓/✗» | `#«number»` |
| PR Review | «✓/✗» | review ID `«id»` |

## 3. Real Webhook Deliveries (from GitHub Delivery Log)

| Delivery Type | Found in GitHub Log? | Delivery ID | Payload Size |
|---|---|---|---|
| `push` | «✓/✗» | `«delivery_id»` | «size» bytes |
| `issues` | «✓/✗» | `«delivery_id»` | «size» bytes |
| `pull_request` | «✓/✗» | `«delivery_id»` | «size» bytes |
| `pull_request_review` | «✓/✗» | `«delivery_id»` | «size» bytes |

## 4. HTTP Webhook Ingest (POST /v1/connectors/github/webhook)

| Event Type | Delivery ID Used | Events Ingested | Status |
|---|---|---:|---|
| Push (`github_commit`) | `«delivery_id»` | `«n»` | «✓/✗» |
| Issue (`github_issue`) | `«delivery_id»` | `«n»` | «✓/✗» |
| PR (`github_pr`) | `«delivery_id»` | `«n»` | «✓/✗» |
| Review (`github_pr_comment`) | `«delivery_id»` | `«n»` | «✓/✗» |

## 5. Verification — `GET /v1/events`

| Check | Expected | Actual | Result |
|---|---|---|---|
| `github_commit` present | ≥ 1 | `«count»` | «✓/✗» |
| `github_issue` present | ≥ 1 | `«count»` | «✓/✗» |
| `github_pr` present | ≥ 1 | `«count»` | «✓/✗» |
| `github_pr_comment` present | ≥ 1 | `«count»` | «✓/✗» |
| `source.channel` = `github` for all | `github` | `«value»` | «✓/✗» |
| `actorProvenance` = `webhook_verified` | `webhook_verified` | `«value»` | «✓/✗» |
| `source.url` starts with `https://github.com/` | `https://github.com/...` | `«url»` | «✓/✗» |

## 6. Verification — PostgreSQL

| Check | Expected | Actual | Result |
|---|---|---|---|
| `github_commit` rows | ≥ 1 | `«count»` | «✓/✗» |
| `github_commit.channel` = `github` | `github` | `«value»` | «✓/✗» |
| `github_commit.source_event` = `push` | `push` | `«value»` | «✓/✗» |
| `github_commit.item_key` = commit SHA | ≥ 40 chars | `«sha»` (40 chars) | «✓/✗» |
| `github_commit.occurred_at_provenance` = `provider` | `provider` | `«value»` | «✓/✗» |
| `github_commit.actor_provenance` = `webhook_verified` | `webhook_verified` | `«value»` | «✓/✗» |
| `github_issue.source_event` = `issues` | `issues` | `«value»` | «✓/✗» |
| `github_issue.source_action` not null | not null | `«value»` | «✓/✗» |
| `github_pr.source_event` = `pull_request` | `pull_request` | `«value»` | «✓/✗» |
| `github_pr_comment.source_event` is set | not null | `«value»` | «✓/✗» |
| `github_pr_comment.url` has `#` fragment | contains `#` | `«fragment»` | «✓/✗» |
| All events: `actor_provenance` = `webhook_verified` | `webhook_verified` | `«value»` | «✓/✗» |

## 7. Verification — Jobs

| Check | Expected | Actual | Result |
|---|---|---|---|
| Smoke events linked to `job_events` | all smoke events | `«linked»`/`«total»` | «✓/✗» |
| At least one `jobs` row present | ≥ 1 | `«count»` | «✓/✗» |
| Job status recorded | `queued` / `completed` / `failed` | `«status»` | «✓/✗» |

_Note: The connector webhook endpoint (M0-GH-08) creates compile jobs after persistence.
If the server is running with a pg-boss queue, jobs should be enqueued and processed.
Without a running worker, jobs will stay in `queued` status._

## 8. Idempotency

| Check | Expected | Result |
|---|---|---|
| Replay same payload → all `duplicate` status | all duplicate | «✓/✗» |
| Modified payload (different hash) → rejected | HTTP 409 | «✓/✗» |

## 9. Redaction (§5.3)

| Check | Expected | Result |
|---|---|---|
| `<private>` tag stripped from PR review body | no `<private>` in stored payload | «✓/✗» |
| `SECRET_TOKEN` content stripped | no secret in stored payload | «✓/✗» |
| Public content preserved | "Public review start … public review end" present | «✓/✗» |

_Note: The connector webhook endpoint runs `stripPrivateTags` after normalization and
before persistence (red line 5.3). PR review/comment normalizers do not self-redact — they
rely on this pipeline step. The test verifies the pipeline is intact._

## 10. Summary

| Metric | Count |
|---|---|
| Total assertions | `«n»` |
| Passed | `«n»` |
| Failed | `«n»` |

## Regression Checks

| Check | Result |
|---|---|
| `pnpm lint` | «✓/✗» |
| `pnpm typecheck` | «✓/✗» |
| `pnpm test -- --run` | «✓/✗» («n» passed, «n» skipped) |
| `bash -n scripts/m0-github-smoke.sh` | «✓/✗» |

## Notes

1. **Endpoint**: The smoke test sends webhook payloads to `POST /v1/connectors/github/webhook?project=…`
   (the real M0-GH-08 connector webhook endpoint) and reads events from `GET /v1/events`
   (requires a valid API key with `read` scope).

2. **API key**: The events list endpoint requires Bearer token authentication.
   Use `TEAMEM_API_KEY` (a `tm_`-prefixed token) with `read` and `read:payload` scopes.
   Run `pnpm --filter @teamem/server bootstrap -- --team-name M0 --project-name demo`
   to generate one.

3. **Webhook secret**: The script signs each payload with `TEAMEM_WEBHOOK_SECRET` and
   sends it in the `X-Hub-Signature-256` header. The server must be started with the
   same secret via `TEAMEM_GITHUB_WEBHOOK_SECRET` for the GitHub connector to register.

4. **Delivery log approach**: The script creates a temporary webhook pointing to a fake URL,
   then fetches the actual payloads from GitHub's delivery log and re-delivers them to
   teamem with proper HMAC signatures. This avoids needing a public callback URL while
   still testing with real GitHub webhook payloads.

5. **Cleanup**: Set `TEAMEM_SMOKE_KEEP_DATA=true` to preserve database rows for inspection.
   The temporary webhook and branch are always cleaned up.
