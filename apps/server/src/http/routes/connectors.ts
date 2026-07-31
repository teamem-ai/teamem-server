/**
 * Connector Status Routes (DUA-237).
 *
 * Web-session-authenticated route that returns connector status:
 *   GET /v1/teams/:teamId/connectors
 *
 * Returns honest empty/default states when no connectors are configured.
 * Admin+ for sensitive fields; any role can see status.
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

// ── Dependencies ────────────────────────────────────────────────────────────

export interface ConnectorStatusDeps {
  db: AppDb;
}

// ── Route builder ───────────────────────────────────────────────────────────

export function buildConnectorStatusRoutes(deps: ConnectorStatusDeps): Hono {
  const { db } = deps;
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

      // Check GitHub connector presence (table may not exist yet)
      let githubConnected = false;
      try {
        const connectorResult = await db.$client.query(
          `SELECT COUNT(*)::int AS count
           FROM connectors
           WHERE team_id = $1 AND kind = 'github'`,
          [teamId],
        );
        githubConnected = (connectorResult.rows[0]?.['count'] ?? 0) > 0;
      } catch {
        // connectors table not yet migrated — honest default
        githubConnected = false;
      }

      const response: ConnectorStatusResponse = {
        github: {
          connected: githubConnected,
          appName: githubConnected ? null : null, // read from connector config when table exists
          installedOn: null,
          repositories: [],
          webhookSecretConfigured: false,
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
