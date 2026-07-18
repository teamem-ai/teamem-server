# ADR 001: HTTP Runtime and Dev Scripts

**Date:** 2026-07-18  
**Status:** Accepted  
**Milestone:** M0-FND-01

## Context

The teamem server needs a frozen HTTP runtime and standardized dev/build/test scripts for M0. The runtime must support:

- Node 20 ESM
- Raw webhook byte access before JSON parsing (for GitHub HMAC verification)
- 5MB body limit enforcement
- No Redis dependency
- TypeScript with pnpm monorepo

## Decision

**Selected: Hono on Node.js** via `@hono/node-server`

### Alternatives Considered

| Option | Verdict | Reason |
|---|---|---|
| Express | Rejected | CJS legacy, poor ESM-first support, no raw Request object |
| Fastify | Rejected | Heavier, plugin system overhead for M0 scope |
| raw `node:http` | Rejected | Too low-level; no routing, middleware, or Request/Response web API |
| **Hono** | **Selected** | ESM-native, ~14KB, `c.req.raw` gives web Request with original bytes, web-standard Request/Response API |

### Key Design Points

1. **Raw body access**: `c.req.raw` returns the web `Request` object. The body `ReadableStream` is available before any `JSON.parse()` — this is the mechanism that lets webhook signature verification run against original bytes.

2. **Body limit**: Enforced via `enforceBodyLimit()` middleware applied per-route. Default 5MB matches the batch limit in contract ②.

3. **ESM-only output**: tsup builds to `dist/` as ESM. No CommonJS fallback.

4. **Separate entrypoints**: `server.ts` (HTTP listener) and `worker.ts` (pg-boss consumer) are independent entrypoints. Docker Compose runs them as separate containers; `TEAMEM_ALL_IN_ONE=true` embeds the worker in the server process.

## Consequences

- Hono becomes the frozen HTTP runtime for M0+. Replacing it requires updating this ADR.
- All ingestion routes use `c.req.raw` for webhook byte access; no route may call `c.req.json()` before signature verification.
- The `enforceBodyLimit` middleware is the single enforcement point for the 5MB constraint.
- tsup produces ESM-only output; no CommonJS compatibility layer.

## Scripts Convention

All scripts live in `apps/server/package.json` and are proxied from the root:

| Script | Command | Purpose |
|---|---|---|
| `dev` | `tsx watch src/server.ts` | Hot-reload dev server |
| `build` | `tsup` | Production ESM build |
| `start` | `node dist/server.js` | Production server |
| `worker` | `node dist/worker.js` | Compile worker |
| `db:generate` | `drizzle-kit generate` | Generate migration SQL |
| `db:migrate` | `drizzle-kit migrate` | Run migrations |
| `bootstrap` | `node dist/server.js --bootstrap` | Initial setup |
| `test:integration` | `vitest run --config vitest.integration.config.ts` | DB integration tests |
| `test:e2e` | `vitest run --config vitest.e2e.config.ts` | End-to-end tests |
| `test:compose` | docker compose + vitest | Compose topology tests |
| `m0:f1-reliability` | `vitest run --config vitest.f1.config.ts` | F1 reliability tests |
