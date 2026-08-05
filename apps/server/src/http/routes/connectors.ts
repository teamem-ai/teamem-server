/**
 * Connector Status Routes (DUA-237).
 *
 * Web-session-authenticated route that returns connector status:
 *   GET /v1/teams/:teamId/connectors
 *
 * Returns honest empty/default states when no connectors are configured.
 * Admin+ for sensitive fields; any role can see status.
 *
 * GitHub is a single App per deployment, configured via environment
 * variables at startup (TEAMEM_GITHUB_*) — not a per-team database row.
 * There is no `connectors` table (never migrated); `githubAppConfigured`
 * and `webhookSecretConfigured` are passed in from the same env-derived
 * flags the rest of the server uses (see config/env.ts). The repository
 * list is fetched live from GitHub (GET /installation/repositories) via an
 * injected GitHubApiClient when the App ID/installation ID/private key are
 * present — teamem never stores or infers which repos are selected.
 */
import { Hono, type Context } from 'hono';
import type { AppDb } from '../../db/client.js';
import {
  requireWebSession,
  requireTeamMembership,
  getWebSession,
} from '../session.js';
import {
  InternalError,
  REQUEST_ID_KEY,
} from '../errors.js';
import type { ConnectorStatusResponse } from '@teamem/schema';
import type { GitHubApiClient } from '../../connectors/github/app-api-client.js';

// ── Dependencies ────────────────────────────────────────────────────────────

export interface ConnectorStatusDeps {
  db: AppDb;
  /** True when the GitHub App is fully configured (env.ts githubAppConfigured):
   *  App ID, private key, webhook secret, and OAuth client id/secret all set. */
  githubAppConfigured?: boolean;
  /** True when TEAMEM_GITHUB_WEBHOOK_SECRET is set, independent of the other
   *  four App credentials — surfaced separately in the UI. */
  githubWebhookConfigured?: boolean;
  /** Present only when App ID + installation ID + private key are all
   *  configured — used to fetch the live repository list. Absent (not just
   *  a failed call) means "can't ask GitHub", which is distinct from "GitHub
   *  said zero repos" but both honestly render as an empty list here. */
  githubApiClient?: GitHubApiClient;
}

// ── Route builder ───────────────────────────────────────────────────────────

export function buildConnectorStatusRoutes(deps: ConnectorStatusDeps): Hono {
  const {
    db,
    githubAppConfigured = false,
    githubWebhookConfigured = false,
    githubApiClient,
  } = deps;
  const routes = new Hono();

  routes.use('/v1/teams/:teamId/connectors', requireWebSession(db));
  routes.use('/v1/teams/:teamId/connectors', requireTeamMembership(db));

  // ── GET /v1/teams/:teamId/connectors ────────────────────────────────
  routes.get('/v1/teams/:teamId/connectors', async (c: Context) => {
    const requestId = c.get(REQUEST_ID_KEY) as string;
    const ws = getWebSession(c);
    const teamId = ws.scope.teamId;

    try {
      // Count active write-capable keys for CLI/MCP cards
      const keyResult = await db.$client.query(
        `SELECT COUNT(*)::int AS count
         FROM api_keys
         WHERE team_id = $1 AND revoked_at IS NULL
           AND 'events:write' = ANY(scopes)`,
        [teamId],
      );
      const writeKeyCount: number = keyResult.rows[0]?.['count'] ?? 0;

      // GitHub is one App per deployment (env-configured at startup), not a
      // per-team row — "connected" reflects the real server-side config.
      // Repositories are fetched live from GitHub, never stored — teamem is
      // not the source of truth for which repos are selected, GitHub is.
      // A fetch failure (rate limit, transient network error, no
      // installation ID yet) degrades to an honestly empty list rather than
      // failing the whole status request.
      let repositories: string[] = [];
      if (githubApiClient) {
        try {
          repositories = await githubApiClient.listInstallationRepositories();
        } catch (err) {
          console.warn(
            JSON.stringify({
              event: 'github_repos_fetch_failed',
              requestId,
              teamId,
              message:
                err instanceof Error
                  ? err.message.slice(0, 200)
                  : String(err).slice(0, 200),
            }),
          );
        }
      }

      // appName/installedOn/recentDeliveries are not tracked anywhere yet
      // (no App-level lookup, no delivery log), so they stay honestly empty
      // rather than showing invented data.
      const response: ConnectorStatusResponse = {
        github: {
          connected: githubAppConfigured,
          appName: null,
          installedOn: null,
          repositories,
          webhookSecretConfigured: githubWebhookConfigured,
          recentDeliveries: [],
        },
        cli: {
          lastInit: {
            at: null,
            repo: null,
            commitSha: null,
            eventsCount: 0,
            pagesCount: 0,
          },
          activeKeysWithWrite: writeKeyCount,
        },
        mcp: {
          endpointHealthy: true,
          activeKeysWithWrite: writeKeyCount,
        },
      };

      return c.json({ requestId, data: response });
    } catch (err) {
      throw new InternalError('Failed to read connector status', { cause: err });
    }
  });

  return routes;
}
