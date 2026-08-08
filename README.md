# teamem-server

**Team memory for AI coding agents.** teamem portal is an open, self-hostable
service that ingests your team's engineering signals (GitHub commits, PRs,
issues), continuously compiles them with LLMs into a structured, interlinked
knowledge base (open markdown format, fully exportable), and serves it to
every team member's code agent over MCP with progressive disclosure.

> **Status: M1 server track complete; standalone CLI work continues.** The
> server now implements ingestion, F1 extraction, F2 semantic merge, hybrid
> vector/FTS retrieval, MCP tools, redaction, persistence, and queue processing,
> with real PostgreSQL/pgvector integration coverage. Checks that require a
> live LLM/embedding provider or GitHub App remain conditional until those
> credentials are supplied. See the scope-corrected
> [M1 acceptance report](./docs/m1-acceptance.md). The standalone MIT CLI lives
> in [`teamem-ai/cli`](https://github.com/teamem-ai/cli); its repository
> skeleton is complete, while `teamem init` is still pending. The
> Web UI remains a later milestone.

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
environment.

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

### 3. Verify health

```sh
# All services should show "healthy"
docker compose ps

# The server health endpoint returns 200 OK
curl -fSs http://127.0.0.1:${TEAMEM_PORT:-8080}/healthz && echo " OK"

# Postgres is bound to loopback only (never exposed to the network)
docker compose port postgres 5432
# Expected: 127.0.0.1:5432 (not 0.0.0.0)
```

### 4. Run database migrations

**This step is required and does not happen automatically.** No service in
`docker-compose.yml` runs `drizzle-kit migrate` on boot — `/healthz` is a
liveness probe, not a schema check, so a fresh Postgres volume comes up
"healthy" with zero tables. Skipping this step means the first sign-in
attempt fails at the database layer (`relation "users" does not exist`),
surfaced to the browser only as a generic "Sign-in didn't complete." error.

The runtime image has no `pnpm`/source (the `Dockerfile` only copies build
output), so migrations run from the host against the loopback Postgres port:

```sh
pnpm install --frozen-lockfile
set -a; . ./.env; set +a
DATABASE_URL="postgres://${POSTGRES_USER:-teamem}:${POSTGRES_PASSWORD}@127.0.0.1:${TEAMEM_PG_PORT:-5432}/${POSTGRES_DB:-teamem}" \
  pnpm --filter @teamem/server db:migrate
```

Expect `[✓] migrations applied successfully!` and 17 tables afterward
(`docker compose exec postgres psql -U teamem -d teamem -c '\dt'`).

### 5. Open the portal

Navigate to [http://localhost:8080](http://localhost:8080) and click
**Sign in with GitHub**.

**The first user to sign in automatically becomes the team owner.** The GitHub
OAuth callback bootstraps:

1. A user record tied to your GitHub identity.
2. A team (named after your GitHub login).
3. An owner membership in that team.
4. A web session cookie (httpOnly, SameSite=Lax).

After sign-in you land on the app landing page. From there you can:
- Create a project in **Settings → Project**.
- Mint an API key in **Settings → API Keys**.
- Invite team members in **Members**.
- Configure the webhook on your GitHub App to start ingesting events.

### 6. Wire up GitHub webhook (for event ingestion)

Go to your GitHub App settings → **Webhook** and set:
- **Payload URL**: `http://<your-host>:8080/v1/webhooks/github`
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
| `POSTGRES_PASSWORD` set, but not exported for `docker compose` | Compose ignores `.env` if not also exported; fails with the same error. | `POSTGRES_PASSWORD` must be in `.env` (Compose auto-loads `.env`), or exported in the shell. |

### Stopping and cleanup

```sh
docker compose down           # stop containers, keep data volume
docker compose down -v        # stop containers and delete the database volume
```

## Tech stack (decided)

TypeScript · Postgres (+ pgvector) · pg-boss · Drizzle ORM · Zod ·
React + Vite + shadcn/ui · LLM via BYO key (Claude / OpenAI / OpenRouter /
any OpenAI-compatible endpoint).
