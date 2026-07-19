/**
 * Injectable Hono app factory (AGPL-3.0-only)
 *
 * `buildApp()` creates a fully configured Hono instance.  Dependencies
 * (database URL, DB handle, LLM keys, connectors) are injected via the
 * `AppDeps` parameter so the factory is testable without environment
 * side-effects.
 *
 * This module owns route wiring.  Handler implementations live in
 * `http/health.ts`, `http/webhooks.ts`, `http/events-list.ts`, and
 * future route modules.
 */
import { Hono, type Context, type Next } from 'hono';
import { healthzHandler, readyzHandler } from './http/health.js';
import { githubWebhookHandler, type WebhookScope } from './http/webhooks.js';
import { listEventsHandler } from './http/events-list.js';
import { registerConnector } from './connectors/registry.js';
import { enforceBodyLimit } from './http/middleware.js';
import type { AppDb } from './db/client.js';
import type { Connector } from './connectors/registry.js';
import {
  globalErrorHandler,
  notFoundHandler,
  REQUEST_ID_KEY,
} from './http/errors.js';
import { requestContext } from './http/request-context.js';

export interface AppDeps {
  /** Database connection string for the readiness probe. */
  dbUrl?: string;
  /** Drizzle database instance for business routes (webhooks, events). */
  db?: AppDb;
  /** GitHub connector instance (registered at startup). */
  githubConnector?: Connector;
  /** Webhook scope (team + project) for event delivery. */
  webhookScope?: WebhookScope;
}

type AppEnv = { Variables: { appDeps: AppDeps; [REQUEST_ID_KEY]: string } };

function injectDeps(deps: AppDeps) {
  return async (c: Context<AppEnv>, next: Next) => {
    c.set('appDeps', deps);
    await next();
  };
}

export function buildApp(deps: AppDeps = {}) {
  const app = new Hono<AppEnv>().basePath('/');

  // Request-id middleware for audit trail
  app.use('*', requestContext);

  // Error handling
  app.onError(globalErrorHandler);
  app.notFound(notFoundHandler);

  // ── Dependencies middleware ────────────────────────────────────────────
  app.use('*', injectDeps(deps));

  // ── Health endpoints ───────────────────────────────────────────────────
  app.get('/healthz', healthzHandler);
  app.get('/readyz', readyzHandler);

  // ── Webhook endpoints ──────────────────────────────────────────────────
  // Only registered when db + connector + scope are available.
  if (deps.db && deps.githubConnector && deps.webhookScope) {
    // Register the connector so the handler can look it up
    registerConnector(deps.githubConnector);

    // GitHub webhook receiver — body-size gated, signature-verified
    app.post(
      '/v1/events/github',
      enforceBodyLimit(),
      githubWebhookHandler(deps.db, deps.webhookScope),
    );

    // Events list — query stored events
    app.get('/v1/events', listEventsHandler(deps.db, deps.webhookScope));
  }

  return app;
}

export type App = ReturnType<typeof buildApp>;
