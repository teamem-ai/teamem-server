# teamem-server

**Team memory for AI coding agents.** teamem portal is an open, self-hostable
service that ingests your team's engineering signals (GitHub commits, PRs,
issues), continuously compiles them with LLMs into a structured, interlinked
knowledge base (open markdown format, fully exportable), and serves it to
every team member's code agent over MCP with progressive disclosure.

> **Status: pre-M0 skeleton.** This repository was just initialized — no
> functionality has landed yet. Per project rule, nothing here will ever
> pretend to work: features appear when they are real, end to end.

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

## Self-hosted deployment (topology draft)

Three containers, no Redis — the compile queue is [pg-boss](https://github.com/timgit/pg-boss),
which lives inside Postgres:

```sh
cp .env.example .env             # fill in POSTGRES_PASSWORD (no default, on purpose)

# Standard: postgres + server + worker
docker compose up -d

# All-in-one: server embeds the compile worker (2 containers)
TEAMEM_ALL_IN_ONE=true docker compose up -d postgres server

# Scale compile throughput
docker compose up -d --scale worker=3
```

**Current status:** only the `postgres` service (with pgvector enabled) is
functional today — verified: container healthy, `vector` extension active,
cosine-distance queries working. The `server`/`worker` services are the
wiring target for M0; their Dockerfile and entrypoints land with the first
real implementation.

## Tech stack (decided)

TypeScript · Postgres (+ pgvector) · pg-boss · Drizzle ORM · Zod ·
React + Vite + shadcn/ui · LLM via BYO key (Claude / OpenAI / OpenRouter /
any OpenAI-compatible endpoint).
