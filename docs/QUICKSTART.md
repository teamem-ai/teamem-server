# teamem quickstart — from `docker compose up` to the agent's first cited answer in ≤ 30 minutes

**Goal.** A stranger with Docker, a GitHub account, an LLM API key, and an AI
coding agent (Claude Code and/or Codex) goes from zero to:

> ask your code agent a question about your team's work → it answers and cites
> a teamem concept page with an evidence permalink (PR / commit / issue)

…in **≤ 30 minutes** — really reproducible, no speculative steps.

**What "a cited answer" means here.** The agent answers using the teamem MCP
tools (`search` → `get_page`), and the answer references at least one concept
page whose **evidence** links to the durable artifact it was compiled from.
That is teamem's core promise: conclusions you can trace, not chat output.

**Honesty note (read this first).** Every step below that we could execute
on a live stack carries the expected output recorded from an actual run. The
two steps that need credentials we do not have in this repository — a real
GitHub App and a real LLM API key — are marked **⚠ requires real credentials**
and their expected outcomes are written against the implementation and the
M2 acceptance run, not a fresh local execution. See
[Verified vs. flagged](#verified-vs-flagged-at-the-time-of-writing) at the end.

---

## Time budget

| Phase | What | Time |
|---|---|---|
| 0 | Preflight: Docker, GitHub App, LLM key | 8–10 min (App is the long pole) |
| 1 | Configure `.env` | 3 min |
| 2 | `docker compose up -d --build` | 4–8 min first build |
| 3 | Health + auto-migration check | 1 min |
| 4 | Sign in + onboarding wizard | 3–4 min |
| 5 | Connect your agent (Claude Code and/or Codex) | 2 min |
| 6 | Seed the knowledge base | 2–5 min |
| 7 | Ask for the first cited answer | 2 min |
| **Total** | | **≈ 25–33 min** |

---

## 0. Preflight

You need three things **before** `docker compose up`:

1. **Docker with Compose v2** — `docker compose version`.
2. **A single GitHub App** (one-time, ≈ 5–8 min). The same App serves OAuth
   sign-in *and* webhook ingestion, so you create it exactly once. You do
   **not** need a second OAuth App or local user accounts.
3. **An LLM API key** — Anthropic (`TEAMEM_ANTHROPIC_API_KEY`) or OpenAI
   (`TEAMEM_OPENAI_API_KEY`). The compile worker needs one to turn events into
   concept pages. OpenRouter works too but can be less reliable for the strict
   structured output teamem requires (see README → Troubleshooting).

> If you already have one of these from a previous run, skip the matching part.

### 0.1 Create the GitHub App (one-time)

Go to **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App**:

1. **GitHub App name** — anything, e.g. `acme-teamem`.
2. **Homepage URL** — `http://localhost:8080` (your deployment URL).
3. **Callback URL** — `http://localhost:8080/auth/github/callback`. If you run
   on a different host/port or behind a tunnel/base URL, this must match
   `TEAMEM_BASE_URL` **exactly**.
4. **Webhook URL** — you can leave this blank to start; webhook ingestion is
   optional on day one (see "Seed the knowledge base"):
   - **No webhook yet**: agent + portal work fully via the API/MCP/CLI paths.
   - **Webhook now**: set `http://<your-host>:8080/v1/connectors/github/webhook?project=<prj_...>`
     *after* step 4 (the URL contains your project ID — you don't have it yet).
   In both cases set **Webhook secret** now: `openssl rand -hex 32` (save it).
5. **Permissions**:
   - Repository → **Contents**: Read-only · **Pull requests**: Read-only ·
     **Issues**: Read-only
   - Organization → **Members**: Read-only
6. **User permissions → Email addresses**: Read-only.
7. **Where can this GitHub App be installed?** → **Any account** → **Create
   GitHub App**.
8. Save from the App page: **App ID** (numeric, top), then **Private keys →
   Generate a private key** (download the `.pem`), then **Client secrets →
   Generate a new client secret** (copy once — GitHub hides it after).
9. **Install App** (left sidebar) on your personal account or org. Note the
   **Installation ID** from the URL: `https://github.com/settings/installations/NNNNNNNN`.

### 0.2 Prepare a repo to talk about (optional but recommended)

Pick a small repository where you understand the history. The webhook path and
the CLI path both scan real commits/PRs — you'll want one at hand for step 6.

Finally, `cd` into a checkout of this repository:

```sh
git clone https://github.com/teamem-ai/teamem-server.git && cd teamem-server
```

---

## 1. Configure `.env`

```sh
cp .env.example .env
```

Fill in the **required** values:

| Variable | Required? | Notes |
|---|---|---|
| `POSTGRES_PASSWORD` | **Required** | Compose refuses to start without it. `openssl rand -hex 24` |
| `TEAMEM_GITHUB_APP_ID` | Required for sign-in | App ID from step 0.1.8 |
| `TEAMEM_GITHUB_INSTALLATION_ID` | Required for sign-in | From step 0.1.9 |
| `TEAMEM_GITHUB_PRIVATE_KEY` | Required for sign-in | Paste the whole `.pem` (quoted if multi-line issues) |
| `TEAMEM_GITHUB_OAUTH_CLIENT_ID` | Required for sign-in | App page |
| `TEAMEM_GITHUB_OAUTH_CLIENT_SECRET` | Required for sign-in | From step 0.1.8 |
| `TEAMEM_GITHUB_WEBHOOK_SECRET` | Required for webhook delivery | From step 0.1.4; harmless to set even if you skip webhooks |
| `TEAMEM_ANTHROPIC_API_KEY` (or `TEAMEM_OPENAI_API_KEY`) | **Required for compilation** | The only way events become concept pages |

Everything else has a sane default: `TEAMEM_PORT=8080`, `TEAMEM_PG_PORT=5432`,
`TEAMEM_ALL_IN_ONE=false`. All keys are `TEAMEM_`-prefixed on purpose — the
ambient `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` from your shell is never inherited
by accident.

> `TEAMEM_LLM_ENCRYPTION_KEY` and `TEAMEM_LLM_DEBUG` are **optional**. The
> encryption key is only needed for the Settings → LLM web panel that stores
> keys in the database; the env-var providers above work without it. Similarly
> `TEAMEM_LLM_DEBUG` stays **off (blank)** unless you are debugging compile
> failures.

## 2. Start the stack

```sh
docker compose up -d --build
```

- Standard topology is **3 containers**: `postgres` + `server` + `worker`
  (pg-boss queue lives inside Postgres — no Redis).
- The first build installs dependencies and builds the server + web SPA; it
  takes several minutes. Subsequent starts are fast (cached layers).
- The portal web UI is served by the `server` container on the same port — no
  separate web deployment unit.

Timing checkpoint: this is the long build, not a failure.

## 3. Verify health — and know the migrations already ran

```sh
docker compose ps          # all three services show "healthy"
curl -fsS http://127.0.0.1:8080/healthz && echo " OK"
#                                      ^ {"status":"ok"} OK
```

**You do not need a manual migration step.** The server applies pending schema
migrations automatically at boot (that's a deliberate design choice, see
`apps/server/src/db/migrate.ts`; disable with `TEAMEM_AUTO_MIGRATE=false`). A
fresh volume gets its schema with zero manual steps — verified: after first
boot there are 17 tables with no `drizzle-kit` ever invoked:

```sh
docker compose exec postgres psql -U teamem -d teamem -c '\dt'   # 17 rows
```

Debuggability guardrail: `docker compose logs server` shows
`[runtime] [migrate] schema is up to date` when boot finished cleanly.

## 4. Sign in and run the onboarding wizard

Open <http://localhost:8080> and click **Sign in with GitHub**.

**The first user to sign in automatically becomes the team owner** and is
dropped into the **5-step onboarding wizard**:

1. **Create your team + project**
2. **Connect an LLM provider** — select the provider whose key you put in
   `.env` (Anthropic/OpenAI/OpenRouter). If the provider has no embedding API
   (e.g. Anthropic), the UI says so: search degrades to keyword/FTS — honest,
   not hidden.
3. **Confirm repository scope** — which repos the GitHub App can see.
4. **Connect your agent** — the wizard mints your first API key (plaintext shown
   exactly once) and hands you the copyable `claude mcp add` command.
5. **Complete** — real counters for events / jobs / pages; the wizard does not
   pretend data exists when it does not.

If the sign-in button is **disabled** with "Sign-in isn't configured yet",
the six `TEAMEM_GITHUB_*` vars are incomplete — fix `.env`, `docker compose up
-d` again, and reload.

⚠ **requires real credentials**: this whole step needs a real GitHub App (I
cannot execute OAuth from this repository — see the Verified table). The wizard
steps 1–5 are implemented and covered by integration tests; step 4's minted
key + `claude mcp add` command is exactly the output the server's key-minting
path produced in the live verification run below.

### Browser-free alternative (verified)

If you don't want to click through OAuth at all, the same team/project/key can
be bootstrapped from the command line — this path was executed and verified on
a live stack:

```sh
docker compose exec server node apps/server/dist/index.js --bootstrap \
  --team-name "acme" --project-name "docs" \
  | tee /tmp/teamem-bootstrap.json
# The JSON contains team.id, project.id and the ONE-TIME key.token plus
# mcpAddCommand. Copy the token now — it is printed exactly once.
export TEAMEM_PROJECT="<the prj_... id from the output>"
export TEAMEM_TOKEN="<the tok_... value>"
```

(The wizard path and this path both create a team/project and mint a
project-scoped API key; the wizard additionally wires the LLM provider and
repo scope in the UI.)

## 5. Connect your agent

Point your code agent at the server's MCP endpoint. Both commands below
register the **same** teamem server. Start a **new** agent session after
registering — MCP servers are loaded at session start.

<details>
<summary><strong>Claude Code</strong> — <code>claude mcp add</code></summary>

Run the exact command the wizard printed (or, with a bootstrap key, build the
same shape):

```sh
claude mcp add --transport http teamem http://localhost:8080/mcp \
  --header "Authorization: Bearer $TEAMEM_TOKEN"
```

- `--transport http` selects the streamable HTTP transport (JSON-RPC over HTTP).
- The token is embedded in the command — it is stored in Claude Code's
  local config; rotate the key and re-run the command if it ever leaks.
- Verify: `claude mcp list` shows `teamem`.

</details>

<details>
<summary><strong>Codex</strong> — <code>codex mcp add</code></summary>

Codex's streamable-HTTP config doesn't take inline headers; the bearer token is
read from an environment variable (note: no token is written into Codex's
config file):

```sh
export TEAMEM_TOKEN="<the tok_... value>"   # add to ~/.zshrc / ~/.bashrc too
codex mcp add teamem --url http://localhost:8080/mcp --bearer-token-env-var TEAMEM_TOKEN
```

- Verify: `codex mcp list` shows `teamem` with `Bearer token` auth, and
  `codex mcp get teamem` shows `transport: streamable_http`.

</details>

What your agent can now do (the tools it will see):

| Tool | What it does |
|---|---|
| `search` | keyword/full-text search over concept pages — returns index summaries |
| `get_page` | full concept page: body, type, status, confidence, **evidence permalinks**, contributors |
| `timeline` | what happened recently in the project (`occurred_at` ordering) |
| `memory_write` | store a decision/gotcha/convention — validated, redacted, queued for compilation |

**Verified on a live stack** (this repo, MCP SDK client doing exactly what
Claude Code/Codex do): `initialize` → `tools/list` returns those four tools;
a bad token gets HTTP 401; `search` on an empty project returns an honest
`{"results":[],"degraded":true,"nextCursor":null}` (degraded = FTS fallback
without an embedding provider) instead of fake data.

## 6. Seed the knowledge base

Events are what the compiler turns into concept pages. Three ways to get
real events in — pick **one**:

| # | Source | When to use | Status |
|---|---|---|---|
| A | **Webhook** (GitHub push/PR/issue) | Continuous ingestion from a repo you own | ⚠ needs a public URL for GitHub to reach you (tunnel like ngrok) + installed App; unique to this option is that evidence links point at real PR/commits |
| B | **`teamem init`** (CLI) | Scan an existing repo once — solves cold start | ⚠ the CLI ships from the `teamem-ai/cli` repo (`teamem` on npm); if it's not installed, use C |
| C | **`memory_write` via MCP** | Your agent writes what it learns, right now | ✅ verified on a live stack |

Path C is the fastest way to *today's* first cited answer and works with no
public URL:

```sh
# in a new agent session, ask your agent to save what it knows, e.g.:
# "Use memory_write to store: 'The teamem server auto-migrates the schema at
#  boot when TEAMEM_AUTO_MIGRATE is not false.'"
```

or call it directly:

```sh
curl -fsS -X POST http://localhost:8080/mcp \
  -H "Authorization: Bearer $TEAMEM_TOKEN" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"memory_write","arguments":{"projectId":"'"$TEAMEM_PROJECT"'","title":"docs quickstart verification","content":"The teamem server auto-migrates the schema at boot when TEAMEM_AUTO_MIGRATE is not false.","suggestedType":"gotcha"}}}'
```

Verified response: `Memory stored successfully. Event: evt_... (compile job: ...)`
Then the worker picks the job up; **without an LLM key the job ends honestly as
`failed / no_llm_provider`** (visible in the portal's Jobs page and via
`GET /v1/jobs?projectId=...`). With your key set, the job compiles and the
first concept page appears on the portal's knowledge list.

## 7. The first cited answer

Open a **new** session in Claude Code or Codex and ask something whose answer
lives in the knowledge you seeded, then demand citations:

```text
Use the teamem MCP tools. Search teamem knowledge for the concept I stored;
for anything relevant, open the page with get_page and cite its evidence.
Question: when does the teamem server apply database migrations automatically?
```

A good answer looks like:

> teamem applies pending migrations automatically at server boot — you do not
> need a manual `drizzle-kit migrate`. Source: *concept page "…" (gotcha)*,
> evidence: [PR #NNN / commit `<sha>`](…permalink…).

The citation is the point: the answer is not agent invention, it is a compiled,
evidence-anchored conclusion.

---

## Troubleshooting in < 5 minutes

| Symptom | Fix |
|---|---|
| `docker compose up` fails with `POSTGRES_PASSWORD is required` | Set it in `.env` (or export it). No default, on purpose. |
| Sign-in button disabled / "Sign-in isn't configured yet" | One of the six `TEAMEM_GITHUB_*` vars is missing or wrong. |
| `/healthz` doesn't answer | `docker compose ps` — did the server container start? `docker compose logs server`. |
| Agent says it has no `search`/`memory_write` tools | MCP servers load at session start — restart the agent session; `claude mcp list` / `codex mcp list` to confirm registration. |
| Event stored but no concept page appears | Open **Jobs**: `no_llm_provider` means no LLM key is visible to the worker; a red `f1_*` code means the model output failed schema validation (see README Troubleshooting). |
| Webhook deliveries show `400 Bad request` in GitHub's Recent Deliveries | Payload URL is missing `?project=<your-project-id>` — the parameter is required on every delivery. |
| `401` on webhook deliveries | `TEAMEM_GITHUB_WEBHOOK_SECRET` mismatches the App's Webhook secret. |

The README's Troubleshooting section covers these in depth, including the
per-event `f1_*` failure codes and `TEAMEM_LLM_DEBUG=1`.

---

## Verified vs. flagged (at the time of writing)

Live verification was run from this commit against a real `docker compose up`
stack (fresh Postgres volume), recorded 2026-08-09:

| # | Step | Result |
|---|---|---|
| 1 | `docker compose up -d --build` (postgres+server+worker) | ✅ verified — all healthy |
| 2 | `/healthz` → `{"status":"ok"}` | ✅ verified |
| 3 | Auto-migration at boot → 17 tables, no manual migrate | ✅ verified |
| 4 | Bootstrap team/project/key + `claude mcp add` output | ✅ verified |
| 5 | MCP endpoint: initialize / tools/list / tools/call | ✅ verified (official MCP SDK client) |
| 6 | Bad token → HTTP 401; honest empty `search` result | ✅ verified |
| 7 | `memory_write` → event persisted + job enqueued → worker `failed/no_llm_provider` (key absent) | ✅ verified |
| 8 | `codex mcp add teamem --url … --bearer-token-env-var TEAMEM_TOKEN` registers (Codex CLI 0.146.0) | ✅ verified |
| 9 | GitHub OAuth sign-in + onboarding wizard (needs real GitHub App) | ⚠ flagged — requires real credentials; implementation covered by tests, wizard flow per code |
| 10 | Real F1/F2 LLM compilation → first concept page (needs BYO key) | ⚠ flagged — no provider key in this repo; the honest `no_llm_provider` failure state was verified |
| 11 | GitHub webhook ingestion (needs public URL + installed App) | ⚠ flagged — not executable locally; delivery-debug guide in README |
| 12 | `teamem init` CLI seeding (separate repo) | ⚠ flagged — the CLI ships from `teamem-ai/cli` |
| 13 | "First cited answer" end-to-end | ⚠ depends on 9–10; every layer below LLM compilation is verified |

Anything marked ⚠ is written from the implementation/integration tests, not a
fresh local execution. If you hit a snag in those paths, open an issue — that
is exactly the feedback this quickstart is meant to surface.