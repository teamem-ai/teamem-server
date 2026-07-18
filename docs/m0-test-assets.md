# M0 Test Assets

External test assets required for M0 end-to-end validation. This document
records configuration only — no secrets, keys, or tokens are stored here.

## 1. GitHub Test Repository

| Field | Value |
|-------|-------|
| Repository | `teamem-ai/teamem-m0-test` |
| Visibility | Private |
| Purpose | Receive real GitHub webhook events (push, PR, issue) for ingestion pipeline testing |
| Default branch | `main` |

**Seed content:**
- `README.md` — repository description
- `src/index.ts` — sample TypeScript for commit/PR anchoring tests
- `docs/setup.md` — sample documentation for gotcha/convention tests

**Verification:**

```bash
gh repo view teamem-ai/teamem-m0-test
```

## 2. GitHub App Configuration

A GitHub App must be created in the `teamem-ai` organization to receive
webhook events from the test repository.

### Setup Steps

1. Go to https://github.com/organizations/teamem-ai/settings/apps/new
2. Set the following:
   - **GitHub App name:** `teamem-m0-test` (or similar, must be unique org-wide)
   - **Webhook URL:** `https://<your-server-host>:8080/v1/webhooks/github`
   - **Webhook secret:** Generate a strong random secret and store it as `TEAMEM_GITHUB_WEBHOOK_SECRET`
   - **Repository permissions:**
     - Contents: Read-only
     - Metadata: Read-only
     - Pull requests: Read-only
     - Issues: Read-only
     - Commit statuses: Read-only
   - **Subscribe to events:**
     - Push
     - Pull request
     - Issues
   - **Where can this GitHub App be installed:** Only on this organization
3. After creation, note the **App ID** (numeric) — store as `TEAMEM_GITHUB_APP_ID`
4. Install the app on the `teamem-ai` organization, selecting only the `teamem-m0-test` repository
5. After installation, note the **Installation ID** — store as `TEAMEM_GITHUB_INSTALLATION_ID`

### Required Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `TEAMEM_GITHUB_WEBHOOK_SECRET` | Webhook signing secret | `whsec_...` (never commit) |
| `TEAMEM_GITHUB_APP_ID` | GitHub App numeric ID | `123456` |
| `TEAMEM_GITHUB_INSTALLATION_ID` | Installation ID for target org | `78901234` |

### Verification

```bash
# Check env vars are set (without printing values)
test -n "$TEAMEM_GITHUB_WEBHOOK_SECRET" && echo "webhook secret: SET"
test -n "$TEAMEM_GITHUB_APP_ID" && echo "app ID: SET"
test -n "$TEAMEM_GITHUB_INSTALLATION_ID" && echo "installation ID: SET"

# Verify the app is installed
gh api /orgs/teamem-ai/installations --jq '.installations[] | select(.app_slug | test("m0")) | {id, app_slug, account}'
```

## 3. LLM Provider (OpenAI-Compatible Structured Output Endpoint)

M0 requires a real LLM provider that supports structured output (JSON Schema
response format or forced tool use) for F1 extraction.

### Options

| Provider | Env Var | Notes |
|----------|---------|-------|
| OpenAI | `TEAMEM_OPENAI_API_KEY` | Native structured output support |
| Anthropic | `TEAMEM_ANTHROPIC_API_KEY` | Tool-use for structured output |
| OpenRouter | `TEAMEM_OPENROUTER_API_KEY` | Proxy to various models |
| Custom endpoint | `TEAMEM_OPENAI_COMPAT_BASE_URL` + `TEAMEM_OPENAI_COMPAT_API_KEY` | Any OpenAI-compatible API (LM Studio, vLLM, internal gateway) |

### Consumption Limits

For the 20-run M0 validation checks, set provider spending limits:

- **OpenAI:** Set a monthly budget cap in the billing dashboard, or use a prepaid credits account
- **Anthropic:** Set `monthly_cost_limit` in the admin console
- **Custom endpoint:** Configure rate limiting at the gateway level

Recommended: Use a dedicated API key with a hard spending cap of $10-20 for
M0 testing to avoid unexpected costs during repeated validation runs.

### Verification

```bash
# Check OpenAI key is set
test -n "$TEAMEM_OPENAI_API_KEY" && echo "OpenAI key: SET"

# Check custom endpoint is reachable (replace with actual URL)
curl -sS --max-time 5 "$TEAMEM_OPENAI_COMPAT_BASE_URL/models" \
  -H "Authorization: Bearer $TEAMEM_OPENAI_COMPAT_API_KEY" | head -c 200
```

## 4. Test Database

M0 integration tests require a real PostgreSQL instance with pgvector.

### Setup

```bash
# Start Postgres via compose
POSTGRES_PASSWORD=testpassword docker compose up -d postgres

# Apply migrations
psql "postgres://teamem:testpassword@localhost:5432/teamem" \
  < apps/server/drizzle/0000_chilly_the_stranger.sql

# Run tests with database
TEST_DATABASE_URL="postgres://teamem:testpassword@localhost:5432/teamem" pnpm test
```

### Verification

```bash
test -n "$TEST_DATABASE_URL" && echo "test database: SET"
```

## 5. Environment Variables Checklist

Copy `.env.example` to `.env` and fill in:

```bash
cp .env.example .env
# Edit .env with your values
```

Required for M0:
- [ ] `POSTGRES_PASSWORD` — strong password for local Postgres
- [ ] `TEAMEM_GITHUB_WEBHOOK_SECRET` — from GitHub App settings
- [ ] `TEAMEM_GITHUB_APP_ID` — numeric App ID
- [ ] `TEAMEM_GITHUB_INSTALLATION_ID` — installation ID
- [ ] At least one LLM provider key (see section 3)

Optional:
- [ ] `TEST_DATABASE_URL` — for integration tests outside compose
- [ ] `TEAMEM_OPENAI_COMPAT_BASE_URL` / `TEAMEM_OPENAI_COMPAT_API_KEY` — for custom endpoint
