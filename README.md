# teamem-server

**Team memory for AI coding agents.** teamem is an open, self-hostable
service that ingests your team's engineering signals (GitHub commits, PRs,
issues), continuously compiles them with LLMs into a structured, interlinked
knowledge base (open markdown format, fully exportable), and serves it to
every team member's code agent over MCP with progressive disclosure.


The core loop:

```text
GitHub webhook / agent memory_write / CLI scan
  -> ingestion, validation, and pre-persistence redaction
  -> Postgres events + pg-boss compilation queue
  -> F1 typed extraction + F2 entity resolution/merging
  -> structured concept pages (evidence-anchored)
  -> MCP search/get_page/timeline, SessionStart context, and the portal UI
```

> **Status: M0–M2 complete; M3 (export, docs) in progress.** Ingestion,
> F1/F2 compilation, hybrid vector/FTS retrieval, MCP tools, redaction,
> idempotency, multi-tenant scope, web auth/RBAC, the onboarding wizard, and
> the portal UI are implemented and acceptance-tested against real
> PostgreSQL/pgvector (see [M0](./docs/m0-acceptance.md), [M1](./docs/m1-acceptance.md),
> and [M2](./docs/m2-acceptance.md) acceptance reports). OKF export was
> added in M3. Checks that need a live LLM/embedding provider or a real
> GitHub App still require those credentials and are flagged as such rather
> than claimed as passed. The standalone MIT CLI lives in
> [`teamem-ai/cli`](https://github.com/teamem-ai/cli) (npm package `teamem`).

## Quickstart — first cited answer in ≤ 30 minutes

> [**docs/QUICKSTART.md**](./docs/QUICKSTART.md) is the full, step-by-step,
> time-budgeted walkthrough with expected outputs and an honest
> verified-vs-flagged table. The short version:

```sh
git clone https://github.com/teamem-ai/teamem-server.git && cd teamem-server
cp .env.example .env
# fill POSTGRES_PASSWORD, the six TEAMEM_GITHUB_* vars (one GitHub App —
# see below), and one LLM key (TEAMEM_ANTHROPIC_API_KEY or TEAMEM_OPENAI_API_KEY)
docker compose up -d --build     # postgres + server + worker (no Redis)
curl -fsS http://127.0.0.1:8080/healthz && echo " OK"
#   → {"status":"ok"} OK   (schema migrations applied automatically at boot)
```

1. Open <http://localhost:8080> → **Sign in with GitHub** (first user becomes
   owner) → the 5-step wizard creates your team/project, connects your LLM
   provider, and mints your first API key.
2. Connect your agent (new session afterwards):
   - **Claude Code** — paste the `claude mcp add` command the wizard printed:
     `claude mcp add --transport http teamem http://localhost:8080/mcp --header "Authorization: Bearer <key>"`
   - **Codex** — the token is read from an env var, not written to config:
     `export TEAMEM_TOKEN=<key>` then
     `codex mcp add teamem --url http://localhost:8080/mcp --bearer-token-env-var TEAMEM_TOKEN`
3. Seed knowledge (any one): the agent's `memory_write` tool, a GitHub
   webhook, or `teamem init` from the CLI repo.
4. Ask, in a new agent session, for an answer **with citations** — your agent
   `search`es and `get_page`s concept pages and cites their evidence
   permalinks. That evidence-anchored answer is the product.

> **Documentation.** A compiled-by-dogfooding
> [architecture overview](./docs/architecture.md) and the
> [contributing guide](./CONTRIBUTING.md) live in this repository.

## Monorepo layout & licensing

| Path | Package | License | Purpose |
|---|---|---|---|
| `/` (root) | — | **AGPL-3.0-only** | Repository default license |
| `apps/server` | `@teamem/server` | **AGPL-3.0-only** | Ingestion API, compile engine, MCP endpoint, GitHub connector |
| `apps/web` | `@teamem/web` | **AGPL-3.0-only** | Portal UI (served by the server) |
| `packages/schema` | [`@teamem/schema`](./packages/schema) | **MIT** | Shared contract types & Zod validators — the open-format carrier, free for any client/tool to import |

The license split is deliberate: the portal (server + web) is AGPL so the
product stays open; the schema package is MIT so the knowledge format stays
freely adoptable by clients, connectors, and third-party tools without
copyleft obligations. The CLI lives in a separate MIT repository
(`teamem-ai/cli`, npm package `teamem`).

## Development

Requires Node >= 20 and [pnpm](https://pnpm.io).

```sh
pnpm install
pnpm lint        # eslint
pnpm typecheck   # tsc --noEmit across packages
pnpm test        # vitest
```

Contributions use short-lived branches, signed-off commits, protected pull
requests, and squash merges into `main`. See [CONTRIBUTING.md](./CONTRIBUTING.md)
for the contributor checklist and [docs/GITFLOW.md](./docs/GITFLOW.md) for the
complete branch, review, GitHub governance, and release policy. Report security
issues through the private process in [SECURITY.md](./SECURITY.md), not a public
issue.

Releases are versioned Git tags plus GitHub Releases and GHCR images. This
repository publishes distributable artifacts; it does not deploy a hosted
environment. The [release checklist](./docs/release-checklist.md) is the
pre-tag gate list, release-note/demo-GIF placement contract, and post-release
verification runbook.

## Self-hosted deployment (≈ 30 minutes from zero)

Three containers, no Redis — the compile queue is [pg-boss](https://github.com/timgit/pg-boss),
which lives inside Postgres. One fewer service to operate than comparable stacks.

The portal web UI is served directly by the server container on the same port —
no separate web deployment unit. Bring the stack up, open the browser, sign in
with GitHub, and you're running.

### Prerequisites

- **Docker** and **Docker Compose** v2 installed on the host.
- **A single GitHub App** — created once before `docker compose up`. The same
  App is used for two purposes:
  1. **OAuth sign-in** — team members sign in with their GitHub accounts.
  2. **Webhook ingestion** — GitHub pushes, PRs, and issues are ingested as
     evidence for the knowledge compiler.

  You do **not** need a second OAuth App, and you do **not** need to create
  local user accounts. The GitHub App is the only identity provider.

#### Creating the GitHub App

1. Go to **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App**.
2. Fill in the required fields:
   - **GitHub App name** — anything (e.g. `acme-teamem`).
   - **Homepage URL** — `http://localhost:8080` (or your deployment URL).
   - **Callback URL** — `http://localhost:8080/auth/github/callback`.
     If you deploy on a different host/port, adjust the origin accordingly and
     also set `TEAMEM_BASE_URL` in your `.env`.
   - **Webhook URL** — leave blank for now (or set to a public URL if you have
     one). Webhook ingestion works later, after initial setup.
   - **Webhook secret** — generate a strong random string (e.g.
     `openssl rand -hex 32`). Save this — you will put it in `.env`.
3. Under **Permissions**, set:
   - **Repository permissions → Contents** — *Read-only* (for commit access).
   - **Repository permissions → Pull requests** — *Read-only*.
   - **Repository permissions → Issues** — *Read-only*.
   - **Organization permissions → Members** — *Read-only* (for team member
     profile resolution).
4. Under **User permissions**:
   - **Email addresses** — *Read-only*.
5. Under **Where can this GitHub App be installed?** choose **Any account**.
6. Click **Create GitHub App**.
7. After creation, note the **App ID** (top of the page).
8. Scroll to **Private keys** → **Generate a private key**. Download the `.pem`
   file — you will paste its contents into `.env`.
9. Under **Client secrets** → **Generate a new client secret**. Copy the value
   immediately (GitHub shows it only once).
10. Go to **Install App** in the left sidebar and install it on your personal
    account or organization. Note the **Installation ID** from the URL:
    `https://github.com/settings/installations/NNNNNNNN`.

You now have all the values needed for `.env`:

| .env variable | Where to find it |
|---|---|
| `TEAMEM_GITHUB_APP_ID` | App ID (numeric, top of GitHub App settings) |
| `TEAMEM_GITHUB_INSTALLATION_ID` | Installation ID from the URL after install |
| `TEAMEM_GITHUB_PRIVATE_KEY` | Contents of the downloaded `.pem` file |
| `TEAMEM_GITHUB_OAUTH_CLIENT_ID` | Client ID (shown on the App settings page) |
| `TEAMEM_GITHUB_OAUTH_CLIENT_SECRET` | Client secret (generated in step 9) |
| `TEAMEM_GITHUB_WEBHOOK_SECRET` | Webhook secret (generated in step 2) |

### 1. Configure the environment

```sh
cp .env.example .env
```

Open `.env` and fill in the following **required** values:

| Variable | Requirement |
|---|---|
| `POSTGRES_PASSWORD` | **Required — no default.** Compose refuses to start without it. Pick a strong password. |
| All six `TEAMEM_GITHUB_*` variables | **Required for sign-in.** Without them the login page shows a disabled button with a setup notice. |

**LLM provider keys** (at least one is required for the compile worker to turn
events into concept pages):

| Variable | Provider |
|---|---|
| `TEAMEM_ANTHROPIC_API_KEY` | Anthropic Claude |
| `TEAMEM_OPENAI_API_KEY` | OpenAI |
| `TEAMEM_OPENROUTER_API_KEY` | OpenRouter (multi-provider gateway) |

TEAMEM-prefixed on purpose — the ambient `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`
from your host shell is never inherited by accident.

> **Model choice affects compile reliability.** teamem requires provider-native
> structured output and rejects anything that doesn't match the schema. The
> native `claude` and `openai` providers enforce this robustly; routing a weak
> model through OpenRouter (or another OpenAI-compatible endpoint) can produce
> malformed JSON that fails compilation. See
> [Troubleshooting → compilation failures](#compilation-failures) before picking
> a model.

`TEAMEM_LLM_ENCRYPTION_KEY` and `TEAMEM_LLM_DEBUG` are optional: the encryption
key is only needed for the Settings → LLM web panel (env-var providers work
without it), and LLM debug logging stays off by default.

See `.env.example` for all available variables and their defaults.

### 2. Start the stack

```sh
# Standard topology — postgres + server + worker (3 containers)
docker compose up -d --build

# All-in-one — server embeds the compile worker (2 containers)
TEAMEM_ALL_IN_ONE=true docker compose up -d --build postgres server
```

The first build takes a few minutes (installing dependencies, building the
server and web SPA). Subsequent starts are faster — the image layers are cached.

### 3. Verify health (migrations are automatic)

```sh
# All services should show "healthy"
docker compose ps

# The server health endpoint returns 200 OK
curl -fsS http://127.0.0.1:${TEAMEM_PORT:-8080}/healthz && echo " OK"

# Postgres is bound to loopback only (never exposed to the network)
docker compose port postgres 5432
# Expected: 127.0.0.1:5432 (not 0.0.0.0)
```

**Schema migrations run automatically at server boot** — a fresh Postgres
volume gets its full schema with no manual `drizzle-kit` step. The server
applies pending Drizzle migrations before it starts serving (the runtime image
has no drizzle-kit, so the compiled server uses drizzle-orm's own migrator; see
`apps/server/src/db/migrate.ts`). Operators who prefer out-of-band migrations
can set `TEAMEM_AUTO_MIGRATE=false` and run them from the host with:

```sh
set -a; . ./.env; set +a
DATABASE_URL="postgres://${POSTGRES_USER:-teamem}:${POSTGRES_PASSWORD}@127.0.0.1:${TEAMEM_PG_PORT:-5432}/${POSTGRES_DB:-teamem}" \
  pnpm --filter @teamem/server db:migrate
```

### 4. Open the portal

Navigate to [http://localhost:8080](http://localhost:8080) and click
**Sign in with GitHub**.

**The first user to sign in automatically becomes the team owner** and is
dropped into the 5-step onboarding wizard: create team/project → connect your
LLM provider → confirm repository scope → mint your first API key (shown once,
with the pasteable `claude mcp add` command) → watch the first pages compile.
The GitHub OAuth callback bootstraps:

1. A user record tied to your GitHub identity.
2. A team (named after your GitHub login).
3. An owner membership in that team.
4. A web session cookie (httpOnly, SameSite=Lax).

After the wizard you can invite team members in **Members**, manage projects,
keys, and LLM providers in **Settings**, and inspect everything in **Events /
Jobs / Knowledge**.

### 5. Connect your code agent (Claude Code / Codex)

The MCP endpoint is `POST /mcp` on the server port, authenticated with a
project-scoped API key (`Authorization: Bearer <token>`). Mint a key in the
wizard or in **Settings → API Keys**.

**Claude Code** — paste the command the UI gives you (same shape either way):

```sh
claude mcp add --transport http teamem http://localhost:8080/mcp \
  --header "Authorization: Bearer <your-api-key>"
```

**Codex** — Codex's streamable-HTTP config reads the token from an environment
variable instead of an inline header, so nothing secret lands in
`~/.codex/config.toml`:

```sh
export TEAMEM_TOKEN=<your-api-key>   # add to your shell profile too
codex mcp add teamem --url http://localhost:8080/mcp --bearer-token-env-var TEAMEM_TOKEN
```

Start a **new** agent session after registering. Your agent then has
`search`, `get_page`, `timeline`, and `memory_write` (see the
[quickstart](docs/QUICKSTART.md) for the full walkthrough and verified
expected outputs). To verify the endpoint yourself:

```sh
curl -fsS -X POST http://127.0.0.1:8080/mcp \
  -H "Authorization: Bearer $TEAMEM_TOKEN" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'
```

### 6. Feed the knowledge base

Three ingestion paths feed the compiler; use any combination:

| Source | How | Notes |
|---|---|---|
| **GitHub webhook** | Configure the webhook on your GitHub App (below) | Real PR/commit/issue evidence — the strongest "why" trail |
| **Agent `memory_write`** | Your agent stores decisions/gotchas over MCP | Works with no public URL; verified path |
| **CLI `teamem init`** | Scan an existing repo once | Ships from the `teamem-ai/cli` repo |

#### Wire up the GitHub webhook (for continuous ingestion)

Copy your project ID (`prj_...`) from **Settings → Project** — the webhook
route requires it in the URL so each delivery is routed to the right project.

Go to your GitHub App settings → **Webhook** and set:
- **Payload URL**: `http://<your-host>:8080/v1/connectors/github/webhook?project=<your-project-id>`
  (**the `?project=prj_...` query parameter is required** — without it every
  delivery is rejected with a generic `400 Bad request`, even for events GitHub
  sends automatically regardless of your subscriptions, like `installation`)
- **Content type**: `application/json`
- **Secret**: the same value as `TEAMEM_GITHUB_WEBHOOK_SECRET` in your `.env`

Select **Pull requests**, **Pushes**, **Issues**, and **Issue comments** under
"Let me select individual events", then save. GitHub will deliver events to
your portal — they appear in **Events** and are compiled into concept pages.

> **Note:** webhook delivery requires GitHub to reach your server. For local
> development, use a tunnel like [ngrok](https://ngrok.com) to expose your
> local port and update both the GitHub App callback URL and
> `TEAMEM_BASE_URL` accordingly.

### Counterexamples (what "not working yet" looks like)

These behaviors are **intentional** — they are guardrails, not bugs:

| What you do | What happens | Why |
|---|---|---|
| Omit `POSTGRES_PASSWORD` from `.env` | `docker compose up` fails immediately with `POSTGRES_PASSWORD is required` | No default password — you must set one. |
| Omit GitHub App OAuth credentials | Login page shows a warning banner: *"Sign-in isn't configured yet"* and the button is **disabled**. | The operator must create a GitHub App before sign-in works. |
| Sign in as a user who is not in any team | Landing page says *"You're not in a team yet"* with guidance to ask for an invite link. | Every user must be a team member — no orphan accounts. |
| `POSTGRES_PASSWORD` set, but not in `.env` | Compose fails with the same required-variable error. | Compose interpolates the file's variables from `.env` (auto-loaded) or the exported shell; if it's missing everywhere, compose refuses to start. |

### Stopping and cleanup

```sh
docker compose down           # stop containers, keep data volume
docker compose down -v        # stop containers and delete the database volume
```

## Troubleshooting

### Compilation failures

The worker turns events into concept pages by calling your configured LLM with
provider-native structured output and validating the result against the frozen
schema **before** persisting it — it never accepts "approximately correct"
output. A per-event failure appears on the job detail page with a code. The job
itself is marked **Failed** only when *every* event fails; a job with a mix of
compiled/skipped/failed events is **Completed with errors** (amber pill). Its
failed events can be re-run *without* redoing the successful ones via
**Retry failed** (as opposed to **Retry all**).

| Per-event code | Meaning | What to do |
|---|---|---|
| `f1_schema_validation_failed` | The model's output wasn't valid JSON, or didn't match the schema. | Usually a weak model over an OpenAI-compatible endpoint (see below). Retry; if it persists, switch to a stronger model or a native provider. |
| `f1_output_truncated` | The model hit its output-token limit mid-response. | Retry; if it persists, the output genuinely exceeded the model's ceiling — use a model with a larger output budget. |
| `f1_timeout` | The request ran past the 30-second deadline (often a large, slow F2 merge). | Retry; a native/faster provider produces the same output more quickly. |
| `f1_provider_error` / `f1_http_error` | The provider rejected the request or returned an error status. | Enable `TEAMEM_LLM_DEBUG=1` (below) to see the real cause in the worker log. |
| `no_llm_provider` | No provider is configured for the team. | Configure one in **Settings → LLM**, or set a `TEAMEM_*_API_KEY` and restart. |
| `worker_interrupted` | The worker was restarted while the job was mid-flight. | The orphaned job is auto-reclaimed to **Failed** on worker startup — just **Retry failed**. |

**Model choice matters for reliability.** teamem asks for strict structured
output, but *how* that's enforced depends on the path:

- **Native `claude` (Anthropic)** uses forced tool use — the provider returns
  already-structured data, so malformed JSON is essentially impossible. This is
  the most robust path.
- **Native `openai`** uses a JSON-schema `response_format`; OpenAI's own models
  honor it reliably.
- **OpenRouter and other OpenAI-compatible endpoints** proxy many backing
  models. For some of them `response_format` degrades to a *prompt* asking for
  JSON, with no hard grammar constraint — so a weaker model (e.g. Claude 3 Haiku
  via OpenRouter) can wrap the JSON in prose, leave inner quotes unescaped, or
  under-escape backslashes, surfacing as `f1_schema_validation_failed`. teamem
  recovers many of these automatically, but the most reliable fix is to point at
  a native provider or a stronger model.

### Debugging LLM failures

Set `TEAMEM_LLM_DEBUG=1` (read by both server and worker; restart to apply) to
log the underlying cause of any compile failure — the provider's `finish_reason`
and a secret-scrubbed snippet of the response — to the worker log, so an
otherwise-opaque `f1_*` error can be investigated:

```sh
docker compose logs -f worker | grep llm_debug
```

Keep it **off** (blank) in production; it is a diagnostics aid, not a
steady-state setting.

### GitHub events never show up in the portal

If you created a PR/commit/issue and it never appears under **Events**, check GitHub App settings →
**Advanced → Recent Deliveries** first — it tells you immediately whether GitHub ever attempted a
delivery, and if so, what your server returned:

| Recent Deliveries shows | Likely cause |
|---|---|
| **Nothing at all** (no rows, not even failed ones) | Either the event happened *before* the webhook was fully configured and saved (GitHub never retroactively delivers — trigger a fresh event, e.g. a new PR comment, and check again), or the App isn't actually installed on this repo, or the webhook's "Active" toggle is off. |
| **A delivery with `400 Bad request`** | Almost always the Payload URL is missing the required `?project=<your-project-id>` query parameter (see step 6 above) — every delivery is rejected before teamem even looks at the event type. This also fires for GitHub's automatic meta-events (`installation`, `ping`) that arrive regardless of your event subscriptions. |
| **A delivery with `401`** | `TEAMEM_GITHUB_WEBHOOK_SECRET` in `.env` doesn't match the Secret configured on the GitHub App — signature verification is rejecting it. |
| **A delivery with `200`**, still nothing in the portal | Ingestion succeeded; the issue is downstream (compilation). Check **Jobs** for a failed job, or see "Compilation failures" above. |

## Tech stack (decided)

TypeScript · Postgres (+ pgvector) · pg-boss · Drizzle ORM · Zod ·
React + Vite + shadcn/ui · LLM via BYO key (Claude / OpenAI / OpenRouter /
any OpenAI-compatible endpoint).