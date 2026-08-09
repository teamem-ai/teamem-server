# Contributing to Teamem

Thank you for contributing. Teamem welcomes focused issues and pull requests
from forks. Before opening a PR, make sure you understand the engineering
red lines — they are the difference between a merged change and a rejected
one.

- Read `AGENTS.md` in full before implementing anything. It contains the
  product boundaries, the frozen-contract precedence order, the architectural
  red lines, and the definition of done this project enforces.
- Read `docs/GITFLOW.md` for the branch, PR, commit-signing, and release
  policy (this guide is its practical summary).
- For a substantial feature or any change to a frozen contract (see
  `packages/schema`), open an issue before implementing.
- Security vulnerabilities must be reported privately as described in
  `SECURITY.md` — never in a public issue or PR.

## Engineering red lines (the short version)

These are non-negotiable. A PR that violates them will not be merged:

1. **It must actually work.** No hard-coded demo data, mocks, or preloaded
   “sample results” in production paths; honest empty states in the UI.
   An endpoint, queue, or page is complete only when its real dependency
   chain works end to end. Report unfinished capability explicitly.
2. **LLM output must be structured.** F1/F2 use provider-native structured
   output (forced tool use / JSON Schema response formats), the output must
   pass the `@teamem/schema` Zod schema before persistence, and validation
   failure is an explicit compilation failure. No free-text-plus-regex
   parsing.
3. **Redact before persistence.** The fixed order is
   `receive → Zod validation → recursive stripPrivateTags → persist → enqueue`.
   Complete `<private>…</private>` sections are removed from every string
   field on every channel. No queryable pre-redaction copy may exist, and
   logs/audits/errors must not leak original content.
4. **Preserve original facts.** Store original claims, verification state,
   authentication context, and parsed results separately. `actor` may be
   `null` and must never be fabricated; `actor_provenance` and
   `occurred_at_provenance` are independent; `ingested_by` is derived
   server-side, never client-supplied. Parsing can be rerun; history cannot.
5. **Tenant isolation at the query entry point.** Every business query
   explicitly carries `team_id`. HTTP/session/connector layers produce a
   `ScopeContext`; every scoped repository requires one — there is no
   unscoped business-query entry point. Detail lookups execute scoped SQL
   directly. Cross-team access returns the same 404 as a missing resource.

See `AGENTS.md` §5 for the full list, including “LLM keys are BYO”,
multi-tenant compositing, and the no-Redis constraint.

## Local development stack

Requirements: Node.js 20 or 22, pnpm (version pinned in `package.json`),
Docker (for PostgreSQL/pgvector and the compose topologies).

### One-time setup

```bash
pnpm install --frozen-lockfile

# copy the deployment env template and fill in the required values
cp .env.example .env
#  - POSTGRES_PASSWORD (required, no default)
#  - TEAMEM_LLM_ENCRYPTION_KEY  ->  openssl rand -hex 32  (for LLM config)
#  - at least one BYO LLM provider key (TEAMEM_ANTHROPIC_API_KEY /
#    TEAMEM_OPENAI_API_KEY / TEAMEM_OPENROUTER_API_KEY /
#    TEAMEM_OPENAI_COMPAT_BASE_URL + TEAMEM_OPENAI_COMPAT_API_KEY)
#  - GitHub App credentials for OAuth/webhook features (see README §“Creating
#    the GitHub App”)
```

The database (Postgres 17 + pgvector) runs in Docker; the server applies
migrations automatically on boot:

```bash
docker compose up -d postgres          # or the full stack below
```

### Run the stack

```bash
# standard topology — postgres + server + worker (3 containers)
docker compose up -d --build

# all-in-one — server embeds the compile worker (2 containers)
TEAMEM_ALL_IN_ONE=true docker compose up -d --build postgres server

# or local processes for fast iteration
pnpm dev          # starts the server (tsx watch); set TEAMEM_ALL_IN_ONE=true
                  # in .env to also run the embedded compile worker locally
```

Verify: `curl http://localhost:8080/healthz` → `{"status":"ok"}`.

Bootstrap a team + project + mint an API key once:

```bash
DATABASE_URL=postgres://teamem:<password>@127.0.0.1:5432/teamem \
  pnpm --filter @teamem/server bootstrap:dev -- \
    --team-name "<team>" --project-name "<project>"
```

### Tests

```bash
pnpm lint
pnpm typecheck
pnpm test                      # unit + contract tests (no database needed)
pnpm test:integration          # real PostgreSQL/pgvector integration tests
pnpm test:e2e                  # end-to-end tests
pnpm test:compose              # docker-compose topology smoke tests
```

Database behavior must be tested against **real PostgreSQL/pgvector**
(`TEST_DATABASE_URL`). Integration tests skip honestly when
`TEST_DATABASE_URL` is missing — a skipped test is not database verification,
and a mock database never substitutes for the real one. The `postgres`
compose service on `127.0.0.1:5432` (loopback-only) is the usual target:

```bash
TEST_DATABASE_URL=postgres://teamem:<password>@127.0.0.1:5432/teamem pnpm test:integration
```

Before declaring completion, run checks in proportion to the risk of the
change; turn the counterexamples you discover into regression tests named
after the decision they pin down; and report which checks you did not run
and why.

## Branch and pull request

`main` is the only long-lived integration branch; work happens on short-lived
branches and enters `main` only through a pull request (squash-merged). Follow
`docs/GITFLOW.md` for exact rules, including release preparation.

1. Start from a current `main`:

   ```bash
   git switch main
   git pull --ff-only
   git switch -c <prefix>/short-description
   ```

   Branch prefixes: `feat/`, `fix/`, `security/`, `refactor/`, `perf/`,
   `test/`, `docs/`, `ci/`, `chore/` (and `release/` for release prep only).

2. Keep the branch current without merge commits:

   ```bash
   git fetch origin
   git rebase origin/main
   ```

3. **Sign off every commit** — DCO compliance. A PR without sign-offs will
   not be merged:

   ```bash
   git commit -s -m "feat(server): reject an invalid cursor"
   ```

   The `-s` sign-off certifies you have the right to submit the contribution
   under the applicable repository license (AGPL-3.0-only for the root/server/
   web; MIT for `packages/schema`).

4. Open the pull request using the template. Use a Conventional Commit-style
   title — `type(scope): imperative summary` — because the validated title
   becomes the permanent squash-commit message on `main` (e.g.
   `feat(server): add event ingestion`, `docs: architecture overview`).

5. Add **exactly one** `semver:major`, `semver:minor`, `semver:patch`, or
   `semver:none` label so release automation can classify the change.

6. Resolve review conversations, rebase onto current `main`, and push. Do not
   bypass required checks, unresolved conversations, or real-Postgres
   validation.

## License boundary

- Root, `apps/server`, `apps/web`, and `apps/server/drizzle` contributions
  are **AGPL-3.0-only**.
- `packages/schema` contributions are **MIT** and must stay independent:
  do not move AGPL server implementation into the schema package, and do not
  let it inherit the root license.

By adding a DCO sign-off, you certify that you have the right to submit the
contribution under the applicable repository license.

## Definition of done

A change is complete only when all of the following are true (see `AGENTS.md`
§12):

- The real user/data path works end to end — not just a type/interface skeleton.
- DTOs, database constraints, migrations, and implementation agree.
- Tenant scope, identity provenance, redaction, idempotency, audit behavior,
  and error exposure are tested with counterexamples.
- New behavior has success, rejection, and replay/boundary tests.
- The frozen contract stays compatible, or a formal new version was proposed
  with migration and contract tests.
- License boundaries remain correct, and validation reporting is honest.