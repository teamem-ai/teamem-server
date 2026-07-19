/**
 * teamem portal server — Hono on Node.js (AGPL-3.0-only)
 *
 * M0 scope: HTTP listener, /healthz, /readyz, /v1/events/github (webhook
 * receiver), /v1/events (query), raw-body webhook access.
 *
 * Raw body access: `c.req.raw` returns the web `Request` object; the
 * undigested body bytes are available before any JSON.parse() runs.
 * This is the mechanism that lets webhook signature verification
 * (GitHub HMAC) execute against the original bytes — a hard constraint.
 *
 * Body limit: 5 MB enforced at the Hono level before any handler runs.
 */
import { serve } from '@hono/node-server';
import { buildApp, type AppDeps } from './app.js';
import { GitHubConnector } from './connectors/github/connector.js';
import type { AppDb } from './db/client.js';
import { enforceBodyLimit, MAX_BODY_BYTES } from './http/middleware.js';

export { enforceBodyLimit, MAX_BODY_BYTES };

// ── Server start ────────────────────────────────────────────────────────────
const port = Number(process.env['TEAMEM_PORT'] ?? 8080);

export interface StartServerOptions {
  /** Drizzle database instance (for webhook + events routes). */
  db?: AppDb;
  /** GitHub webhook secret — pass false to skip verification. */
  githubWebhookSecret?: string | false;
  /** Webhook scope (team + project IDs for event delivery). */
  webhookScope?: { teamId: string; projectId: string };
  /** Override the listen port. */
  port?: number;
}

export function startServer(options: StartServerOptions = {}) {
  const p = options.port ?? port;

  const deps: AppDeps = {
    dbUrl: process.env['TEAMEM_DATABASE_URL'],
    db: options.db,
  };

  // Wire GitHub connector if we have a db (need it for webhook routes)
  if (options.db) {
    deps.githubConnector = new GitHubConnector({
      webhookSecret:
        options.githubWebhookSecret === false
          ? undefined
          : (options.githubWebhookSecret ?? process.env['TEAMEM_GITHUB_WEBHOOK_SECRET']),
    });
    deps.webhookScope = options.webhookScope ?? {
      teamId: process.env['TEAMEM_WEBHOOK_TEAM_ID'] ?? 'team_default',
      projectId: process.env['TEAMEM_WEBHOOK_PROJECT_ID'] ?? 'prj_default',
    };
  }

  const app = buildApp(deps);
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

  // All-in-one mode: embed the pg-boss compile worker in the server
  // process. Used with `TEAMEM_ALL_IN_ONE=true` — bring up only
  // `postgres server` and skip the `worker` container.
  if (process.env['TEAMEM_ALL_IN_ONE'] === 'true') {
    void import('./worker.js').then(() => {
      console.log('teamem compile worker embedded in server process');
    });
  }
}

// Re-export the factory and a default app for backward compatibility with
// tests that import `app` from './server.js'.
const app = buildApp({ dbUrl: process.env['TEAMEM_DATABASE_URL'] });
export { app };
