/**
 * E2E test setup route (DUA-237).
 *
 * This endpoint is ONLY mounted when TEAMEM_E2E_SECRET is set. It creates
 * deterministic test users, a team, a project, and web sessions so that
 * Playwright browser tests can authenticate without running GitHub OAuth.
 *
 * NEVER expose this endpoint in production. The secret acts as a gate:
 * without it, the route is not registered and the URL returns 404.
 */
import { Hono, type Context } from 'hono';
import { generateSessionToken, SESSION_COOKIE_NAME } from '../../auth/oauth-github.js';
import type { AppDb } from '../../db/client.js';
import { notFoundHandler } from '../errors.js';

export interface E2eSetupDeps {
  db: AppDb;
  secret: string;
}

export function buildE2eSetupRoutes(deps: E2eSetupDeps): Hono | null {
  if (!deps.secret) return null;

  const routes = new Hono();

  routes.post('/__e2e/setup', async (c: Context) => {
    const header = c.req.header('x-e2e-secret');
    if (header !== deps.secret) {
      return notFoundHandler(c);
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + 24 * 3600_000);

    const teamId = 'team_e2e';
    const projectId = 'prj_e2e';

    const { db } = deps;
    const client = db.$client;

    // Clean up any previous E2E state.
    await client.query("DELETE FROM web_sessions WHERE id LIKE 'ses_e2e_%'");
    await client.query("DELETE FROM memberships WHERE user_id LIKE 'usr_e2e_%'");
    await client.query("DELETE FROM api_keys WHERE team_id = 'team_e2e'");
    await client.query("DELETE FROM projects WHERE id = 'prj_e2e'");
    await client.query("DELETE FROM principals WHERE team_id = 'team_e2e'");
    await client.query("DELETE FROM users WHERE id LIKE 'usr_e2e_%'");
    await client.query("DELETE FROM teams WHERE id = 'team_e2e'");

    // Create team and project.
    await client.query("INSERT INTO teams (id, name) VALUES ('team_e2e', 'E2E Team')");
    await client.query(
      "INSERT INTO projects (id, team_id, name) VALUES ('prj_e2e', 'team_e2e', 'E2E Project')",
    );

    // Create users.
    await client.query(
      "INSERT INTO users (id, github_id, github_login) VALUES ('usr_e2e_owner', 999999001, 'e2e-owner')",
    );
    await client.query(
      "INSERT INTO users (id, github_id, github_login) VALUES ('usr_e2e_viewer', 999999002, 'e2e-viewer')",
    );

    // Create memberships.
    await client.query(
      "INSERT INTO memberships (user_id, team_id, role) VALUES ('usr_e2e_owner', 'team_e2e', 'owner')",
    );
    await client.query(
      "INSERT INTO memberships (user_id, team_id, role) VALUES ('usr_e2e_viewer', 'team_e2e', 'viewer')",
    );

    // Create sessions.
    const ownerToken = generateSessionToken();
    const viewerToken = generateSessionToken();

    await client.query(
      "INSERT INTO web_sessions (id, user_id, token_hash, issued_at, expires_at) VALUES ('ses_e2e_owner', 'usr_e2e_owner', $1, $2, $3)",
      [ownerToken.hash, now.toISOString(), expiresAt.toISOString()],
    );
    await client.query(
      "INSERT INTO web_sessions (id, user_id, token_hash, issued_at, expires_at) VALUES ('ses_e2e_viewer', 'usr_e2e_viewer', $1, $2, $3)",
      [viewerToken.hash, now.toISOString(), expiresAt.toISOString()],
    );

    return c.json({
      ownerCookie: `${SESSION_COOKIE_NAME}=${ownerToken.plaintext}`,
      viewerCookie: `${SESSION_COOKIE_NAME}=${viewerToken.plaintext}`,
      teamId,
      projectId,
      projectName: 'E2E Project',
    });
  });

  return routes;
}
