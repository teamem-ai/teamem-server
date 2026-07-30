/**
 * Team management routes — create team, list my teams (DUA-230).
 *
 * Web-session-authenticated routes for onboarding and the team switcher:
 *   POST /v1/teams        → create a team (creator becomes owner)
 *   GET  /v1/teams/mine   → list teams the session user belongs to
 *
 * Security invariants:
 *   - Team scope is derived from the web session, NOT from client input.
 *   - Creating a team automatically adds the creator as owner.
 *   - "My teams" only returns teams where the user has a membership row.
 *   - No API key (Bearer token) can use these endpoints — they are
 *     web-session-exclusive (governance belongs to web roles only).
 */
import { Hono, type Context } from 'hono';
import { randomBytes } from 'node:crypto';
import type { AppDb } from '../../db/client.js';
import type { McpCommandConfig } from '../../commands/format-mcp-command.js';
import {
  requireWebSession,
  getSessionUser,
} from '../session.js';
import {
  InvalidRequestError,
  InternalError,
  REQUEST_ID_KEY,
} from '../errors.js';
import {
  createTeamRequest as createTeamRequestSchema,
  type CreateTeamResponse,
  type MyTeam,
} from '@teamem/schema';

// ── Dependencies ────────────────────────────────────────────────────────────

export interface TeamsDeps {
  db: AppDb;
  /** Optional MCP command config — when absent, mcpCommand is omitted. */
  mcpConfig?: McpCommandConfig;
}

// ── Route builder ───────────────────────────────────────────────────────────

export function buildTeamsRoutes(deps: TeamsDeps): Hono {
  const { db } = deps;
  const routes = new Hono();

  // ── Session middleware — all routes require a valid web session ─────────
  routes.use('*', requireWebSession(db));

  // ── POST /v1/teams ─────────────────────────────────────────────────────
  // Create a new team. The session user automatically becomes the owner.
  // No team membership check is needed here — the user may have no team yet
  // (this is the onboarding path).
  routes.post('/v1/teams', async (c: Context) => {
    const requestId = c.get(REQUEST_ID_KEY) as string;
    const sessionUser = getSessionUser(c);

    // Parse and validate request body
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new InvalidRequestError('Request body is not valid JSON');
    }

    const parsed = createTeamRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new InvalidRequestError('Request body validation failed', {
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      } as unknown as Record<string, unknown>);
    }

    const { name } = parsed.data;
    const teamId = `team_${randomBytes(12).toString('hex')}`;

    try {
      // Create team and add creator as owner in a transaction
      await db.$client.query('BEGIN');
      try {
        await db.$client.query(
          `INSERT INTO teams (id, name) VALUES ($1, $2)`,
          [teamId, name],
        );

        await db.$client.query(
          `INSERT INTO memberships (user_id, team_id, role) VALUES ($1, $2, 'owner')`,
          [sessionUser.userId, teamId],
        );

        await db.$client.query('COMMIT');
      } catch (err) {
        await db.$client.query('ROLLBACK');
        throw err;
      }

      const response: CreateTeamResponse = {
        id: teamId,
        name,
        role: 'owner',
        createdAt: new Date().toISOString(),
      };

      return c.json({ requestId, data: response }, 201);
    } catch (err) {
      throw new InternalError('Failed to create team', { cause: err });
    }
  });

  // ── GET /v1/teams/mine ─────────────────────────────────────────────────
  // List all teams the session user is a member of.
  routes.get('/v1/teams/mine', async (c: Context) => {
    const requestId = c.get(REQUEST_ID_KEY) as string;
    const sessionUser = getSessionUser(c);

    try {
      const result = await db.$client.query(
        `SELECT t.id, t.name, m.role
         FROM memberships m
         JOIN teams t ON t.id = m.team_id
         WHERE m.user_id = $1
         ORDER BY m.created_at ASC`,
        [sessionUser.userId],
      );

      const teams: MyTeam[] = result.rows.map((row) => ({
        id: row['id'] as string,
        name: row['name'] as string,
        role: row['role'] as MyTeam['role'],
      }));

      return c.json({ requestId, data: teams });
    } catch (err) {
      throw new InternalError('Failed to list teams', { cause: err });
    }
  });

  return routes;
}
