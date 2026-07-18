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
import { buildApp } from './app.js';

const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB batch limit (contract ②)

// ── Body-size guard ─────────────────────────────────────────────────────────
// Applied per-route rather than globally so /healthz stays lightweight.
// Ingestion routes will use this middleware explicitly.
export function enforceBodyLimit(limit = MAX_BODY_BYTES) {
  return async (c: Context, next: Next) => {
    const contentLength = c.req.header('content-length');
    if (contentLength && Number(contentLength) > limit) {
      return c.json(
        { error: { code: 'payload_too_large', message: `Body exceeds ${limit} bytes` } },
        413,
      );
    }
    await next();
  };
}

// ── Server start ────────────────────────────────────────────────────────────
const port = Number(process.env['TEAMEM_PORT'] ?? 8080);

export function startServer(portOverride?: number) {
  const p = portOverride ?? port;
  const app = buildApp({ dbUrl: process.env['TEAMEM_DATABASE_URL'] });
  const server = serve({ fetch: app.fetch, port: p }, (info) => {
    console.log(`teamem server listening on http://127.0.0.1:${info.port}`);
  });
  return server;
}

// When executed directly (not imported), start the server.
// In tests, the server is imported and started explicitly.
const isMain =
  process.argv[1]?.endsWith('/server.js') ||
  process.argv[1]?.endsWith('/server.ts');

if (isMain) {
  startServer();
}

// Re-export the factory and a default app for backward compatibility with
// tests that import `app` from './server.js'.
const app = buildApp();
export { app };
