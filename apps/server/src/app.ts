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
import { buildJobRetryRoutes } from './http/routes/job-retry.js';
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
import { registerMemoryWriteTool } from './mcp/tools/memory_write.js';
import { getPageTool, getPageHandler } from './mcp/tools/get_page.js';
import { timelineTool, timelineHandler } from './mcp/tools/timeline.js';
import { searchTool, searchHandler } from './mcp/tools/search.js';
import { buildSearchRoutes, type SearchRoutesDeps } from './http/routes/search.js';
import { buildContextRoutes } from './http/routes/context.js';
import { buildPurgeRoutes } from './http/routes/purge.js';
import { buildAuthRoutes } from './http/routes/auth.js';
import { buildTeamsRoutes } from './http/routes/teams.js';
import { buildProjectsRoutes } from './http/routes/projects.js';
import { buildKeysRoutes } from './http/routes/keys.js';
import { buildLlmConfigRoutes } from './http/routes/llm-config.js';
import { buildConnectorStatusRoutes } from './http/routes/connectors.js';
import { buildE2eSetupRoutes } from './http/routes/e2e-setup.js';
import { buildAuditRoutes } from './http/routes/audit.js';
import { buildExportRoutes } from './http/routes/export.js';
import { buildMembersRoutes } from './http/routes/members.js';
import { buildInvitesRoutes } from './http/routes/invites.js';
import { inviteLookupHandler } from './http/routes/invite-lookup.js';
import type { GitHubOAuthConfig } from './auth/oauth-github.js';
import type { EmbeddingClient } from './llm/embedding/port.js';
import type { GitHubApiClient } from './connectors/github/app-api-client.js';
import { createSpaMiddleware } from './http/spa.js';

export interface AppDeps extends HealthDeps {
  /** Database instance for scoped queries (events-write, read endpoints). */
  db?: EventsWriteDeps['db'];
  /** Optional compile queue for enqueuing compile jobs. */
  queue?: EventsWriteDeps['queue'];
  /** Override the default 30 s wait timeout (for testing). */
  waitTimeoutMs?: number;
  /** Optional embedding client for hybrid (vector + FTS) search. */
  embeddingClient?: EmbeddingClient | null;
  /** Optional GitHub OAuth config for user login (M2-AUTH-02). */
  githubOAuth?: GitHubOAuthConfig;
  /** True when the GitHub App is fully configured (env.ts githubAppConfigured).
   *  Drives Settings → Ingestion's GitHub "Connected" status. */
  githubAppConfigured?: boolean;
  /** True when TEAMEM_GITHUB_WEBHOOK_SECRET is set. */
  githubWebhookConfigured?: boolean;
  /** Present when App ID + installation ID + private key are all configured —
   *  used to fetch the live installed-repository list for Settings → Ingestion. */
  githubApiClient?: GitHubApiClient;
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

  // GitHub OAuth status — always mounted so the login page can determine
  // whether the "Sign in with GitHub" button should be enabled.
  app.get('/auth/github/status', (c) => {
    return c.json({
      configured: !!(deps.githubOAuth),
    });
  });

  // Auth routes — wired when OAuth config and db are both available.
  if (deps.githubOAuth && deps.db) {
    app.route('/', buildAuthRoutes(deps.githubOAuth, deps.db));

    // Audit query routes (DUA-227 M2-GOV-01) — management capability;
    // web session + admin/owner role required.
    app.route(
      '/',
      buildAuditRoutes({
        db: deps.db,
        oauthConfig: deps.githubOAuth,
      }),
    );

    // Membership routes — team member listing and role management (admin+).
    app.route('/', buildMembersRoutes(deps.githubOAuth, deps.db));

    // Invite routes — team invitation generation (admin+) and acceptance.
    app.route('/', buildInvitesRoutes(deps.db, deps.githubOAuth.serverBaseUrl));

    // Purge route — project-level data deletion (DUA-228).
    // Owner-only; requires web session + team membership.
    app.route('/', buildPurgeRoutes({ db: deps.db }));
  }

  // Invite lookup — public endpoint (no auth required).
  // Mounted when db is available so the invite acceptance page can show
  // what the user is joining before they sign in.
  if (deps.db) {
    const db = deps.db;
    app.get('/invites/:token', (c) => inviteLookupHandler(c, db));
  }

  // Governance routes (teams, projects, keys) — wired when db is available.
  // These are web-session-authenticated and require a valid OAuth session cookie.
  if (deps.db) {
    // Same resolution config/env.ts uses for GitHub OAuth's redirect_uri —
    // TEAMEM_BASE_URL when set, otherwise localhost on the configured port.
    // Reading it independently here (rather than threading parseServerEnv's
    // result through) previously meant this could silently disagree with
    // OAuth about what "this server" is reachable at.
    const mcpPort = Number(process.env['TEAMEM_PORT'] ?? 8080);
    const mcpBaseUrl = process.env['TEAMEM_BASE_URL'] || `http://localhost:${mcpPort}`;
    const mcpConfig = { baseUrl: mcpBaseUrl };
    app.route('/', buildTeamsRoutes({ db: deps.db, mcpConfig }));
    app.route('/', buildProjectsRoutes({ db: deps.db }));
    app.route('/', buildKeysRoutes({ db: deps.db, mcpConfig }));
    app.route('/', buildLlmConfigRoutes({ db: deps.db }));
    app.route(
      '/',
      buildConnectorStatusRoutes({
        db: deps.db,
        githubAppConfigured: deps.githubAppConfigured,
        githubWebhookConfigured: deps.githubWebhookConfigured,
        githubApiClient: deps.githubApiClient,
      }),
    );

    // E2E test setup route — only mounted when TEAMEM_E2E_SECRET is set.
    const e2eSecret = process.env['TEAMEM_E2E_SECRET'];
    if (e2eSecret) {
      const e2eRoutes = buildE2eSetupRoutes({ db: deps.db, secret: e2eSecret });
      if (e2eRoutes) {
        app.route('/', e2eRoutes);
      }
    }
  }

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

    // Job retry — session-only, admin+ (see job-retry.ts for the role/
    // provenance rationale).
    app.route(
      '/',
      buildJobRetryRoutes({ db: deps.db, queue: deps.queue }),
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

    // Search routes — POST /v1/search (M1-SR-02).
    const searchDeps: SearchRoutesDeps = {
      db: deps.db,
      embeddingClient: deps.embeddingClient,
    };
    app.route(
      '/',
      buildSearchRoutes(searchDeps),
    );

    // Context injection endpoint — GET /v1/context (DUA-229 M2-GOV-03).
    app.route(
      '/',
      buildContextRoutes({ db: deps.db }),
    );

    // OKF export download — GET /v1/export (DUA-251 M3-EXPORT-04).
    // Scope/role-gated: API key read + project scope; web session member+.
    app.route(
      '/',
      buildExportRoutes({ db: deps.db }),
    );

    // MCP streamable HTTP endpoint (M1-MCP-01 scaffold, extended DUA-210).
    // Uses the same Bearer-token auth as the REST API.
    const mcpRegistry = new ToolRegistry();
    // Register MCP tools — each tool wires its handler into the registry.
    registerMemoryWriteTool(mcpRegistry);
    mcpRegistry.register(searchTool, searchHandler, ['read']);
    mcpRegistry.register(getPageTool, getPageHandler, ['read']);
    mcpRegistry.register(timelineTool, timelineHandler, ['read']);
    app.route(
      '/',
      buildMcpRoutes({ db: deps.db, registry: mcpRegistry, queue: deps.queue, embeddingClient: deps.embeddingClient }),
    );
  }

  // ── SPA static file serving (production: web SPA hosted by server) ──
  // Mounted after all API routes so /v1, /auth, /healthz, /readyz,
  // /invites, /teams, /mcp, and /e2e take precedence.  The middleware
  // serves static assets from apps/web/dist and falls back to index.html
  // for SPA client-side routing.  If the dist directory doesn't exist
  // (e.g. pure-API deployments or dev with Vite dev server), it does
  // nothing and requests fall through to the 404 handler.
  app.use('*', createSpaMiddleware());

  return app;
}

export type App = ReturnType<typeof buildApp>;
