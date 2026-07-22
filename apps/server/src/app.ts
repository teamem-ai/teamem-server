/**
 * Injectable Hono app factory (AGPL-3.0-only)
 *
 * `buildApp()` creates a fully configured Hono instance.  Dependencies
 * (database URL, future LLM keys, etc.) are injected via the `AppDeps`
 * parameter so the factory is testable without environment side-effects.
 *
 * This module owns route wiring.  Handler implementations live in
 * `http/health.ts`, `http/routes/events-write.ts`, and future route modules.
 */
import { Hono, type Context, type Next } from 'hono';
import { healthzHandler, readyzHandler, type HealthDeps } from './http/health.js';
import { requestContext } from './http/request-context.js';
import { globalErrorHandler, notFoundHandler } from './http/errors.js';
import {
  buildEventsWriteRoutes,
  type EventsWriteDeps,
} from './http/routes/events-write.js';
import { buildJobsReadRoutes } from './http/routes/jobs-read.js';
import {
  buildConnectorWebhookRoutes,
} from './http/routes/connector-webhook.js';
import { buildConceptsReadRoutes } from './http/routes/concepts-read.js';
import {
  buildEventsReadRoutes,
} from './http/routes/events-read.js';
import {
  buildCompilationsRoutes,
} from './ingest/create-compilation.js';
import {
  buildEventsBatchRoutes,
  type EventsBatchDeps,
} from './http/routes/events-batch.js';
import { buildMcpRoutes } from './mcp/server.js';
import { ToolRegistry } from './mcp/registry.js';
import { getPageTool, getPageHandler } from './mcp/tools/get_page.js';

export interface AppDeps extends HealthDeps {
  /** Database instance for scoped queries (events-write, read endpoints). */
  db?: EventsWriteDeps['db'];
  /** Optional compile queue for enqueuing compile jobs. */
  queue?: EventsWriteDeps['queue'];
  /** Override the default 30 s wait timeout (for testing). */
  waitTimeoutMs?: number;
}

type AppEnv = { Variables: { healthDeps: HealthDeps } };

function injectDeps(deps: AppDeps) {
  return async (c: Context<AppEnv>, next: Next) => {
    c.set('healthDeps', deps);
    await next();
  };
}

export function buildApp(deps: AppDeps = {}) {
  const app = new Hono<AppEnv>().basePath('/');

  // Global middleware: request ID for every response (success or error).
  app.use('*', requestContext);
  app.use('*', injectDeps(deps));

  // Global error handling: catches unhandled errors from any route.
  app.onError(globalErrorHandler);
  app.notFound(notFoundHandler);

  app.get('/healthz', healthzHandler);
  app.get('/readyz', readyzHandler);

  // Ingestion routes — wired only when db is available.
  if (deps.db) {
    const eventsWriteDeps: EventsWriteDeps = {
      db: deps.db,
      queue: deps.queue,
      waitTimeoutMs: deps.waitTimeoutMs,
    };
    app.route('/', buildEventsWriteRoutes(eventsWriteDeps));

    const eventsBatchDeps: EventsBatchDeps = {
      db: deps.db,
      queue: deps.queue,
    };
    app.route('/', buildEventsBatchRoutes(eventsBatchDeps));

    // Job read routes (list + detail)
    app.route(
      '/',
      buildJobsReadRoutes({ db: deps.db }),
    );

    // Connector webhook routes (no Bearer-token auth — webhook signatures
    // are the auth mechanism, verified inside each connector's
    // handleWebhook()).
    app.route(
      '/',
      buildConnectorWebhookRoutes({
        db: deps.db,
        queue: deps.queue,
      }),
    );

    // Compilation routes — explicit compilation trigger for stored events.
    app.route(
      '/',
      buildCompilationsRoutes({
        db: deps.db,
        queue: deps.queue,
      }),
    );

    // Concept read routes — detail by UUID and by path (M0-READ-04).
    app.route(
      '/',
      buildConceptsReadRoutes({ db: deps.db }),
    );

    // Read routes — event list + detail with scope, cursor, and audit.
    app.route(
      '/',
      buildEventsReadRoutes({
        db: deps.db,
      }),
    );

    // MCP streamable HTTP endpoint (M1-MCP-01 scaffold).
    // Uses the same Bearer-token auth as the REST API.
    const mcpRegistry = new ToolRegistry();
    mcpRegistry.register(getPageTool, getPageHandler);
    app.route(
      '/',
      buildMcpRoutes({ db: deps.db, registry: mcpRegistry }),
    );
  }

  return app;
}

export type App = ReturnType<typeof buildApp>;
