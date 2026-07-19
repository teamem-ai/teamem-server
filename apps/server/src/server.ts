/**
 * teamem portal server — Hono on Node.js (AGPL-3.0-only)
 *
 * M0 scope: HTTP listener, /healthz, raw-body webhook access.
 *
 * Raw body access: `c.req.raw` returns the web `Request` object; the
 * undigested body bytes are available before any JSON.parse() runs.
 * This is the mechanism that lets webhook signature verification
 * (GitHub HMAC) execute against the original bytes — a hard constraint.
 *
 * Body limit: 5 MB enforced at the Hono level before any handler runs.
 */
import { type Context, type Next } from 'hono';
import { serve } from '@hono/node-server';
import { buildApp, type AppDeps } from './app.js';
import { PayloadTooLargeError } from './http/errors.js';

const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB batch limit (contract ②)
// ── Body-size guard ─────────────────────────────────────────────────────────
// Applied per-route rather than globally so /healthz stays lightweight.
// Ingestion routes will use this middleware explicitly.
export function enforceBodyLimit(limit = MAX_BODY_BYTES) {
  return async (c: Context, next: Next) => {
    const contentLength = c.req.header('content-length');
    if (contentLength && Number(contentLength) > limit) {
      throw new PayloadTooLargeError(`Body exceeds ${limit} bytes`);
    }
    await next();
  };
}

// ── Server start ────────────────────────────────────────────────────────────
const port = Number(process.env['TEAMEM_PORT'] ?? 8080);

export function startServer(portOverride?: number, deps?: AppDeps) {
  const p = portOverride ?? port;
  const app = buildApp({
    dbUrl: process.env['TEAMEM_DATABASE_URL'],
    ...deps,
  });
  const server = serve({ fetch: app.fetch, port: p }, (info) => {
    console.log(`teamem server listening on http://127.0.0.1:${info.port}`);
  });
  return server;
}

// Re-export a default app for backward compatibility with tests that import
// `app` from './server.js'. The real composition-root entrypoint is index.ts;
// server.ts is a pure module — it never self-starts.
const app = buildApp();
export { app };
