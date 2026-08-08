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
 *   - Self-serve creation by a memberless caller is rejected once any team
 *     already exists — see the guard in POST /v1/teams. Without it, any
 *     signed-in GitHub account (not just invited ones) could spin up its
 *     own team on someone else's self-hosted instance.
 */
import { Hono, type Context } from 'hono';
import { randomBytes } from 'node:crypto';
import type { AppDb } from '../../db/client.js';
import type { McpCommandConfig } from '../../commands/format-mcp-command.js';
import {
  requireWebSession,
  requireTeamMembership,
  getSessionUser,
} from '../session.js';
import {
  InvalidRequestError,
  NotFoundError,
  InternalError,
  ForbiddenError,
  REQUEST_ID_KEY,
} from '../errors.js';
import {
  requireRole,
} from '../../auth/rbac.js';
import {
  createTeamRequest as createTeamRequestSchema,
  renameTeamRequest as renameTeamRequestSchema,
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

  // ── Session middleware applied per-route (NOT use('*') — that would ──
  // leak to every other route in the combined app when mounted at '/').
  // These two routes only need requireWebSession (no team membership
  // check: create-team is the onboarding path, mine crosses all teams).

  // ── POST /v1/teams ─────────────────────────────────────────────────────
  // Create a new team. The session user automatically becomes the owner.
  routes.post('/v1/teams', requireWebSession(db), async (c: Context) => {
    const requestId = c.get(REQUEST_ID_KEY) as string;
    const sessionUser = getSessionUser(c);

    // Self-serve team creation is the true first-run bootstrap path only —
    // ensureTeamMembership (auth/oauth-github.ts) already auto-creates the
    // first team + owner membership at login the moment no team exists yet,
    // so by the time this route can even be reached, a team already exists.
    // A signed-in caller with no membership anywhere hitting this endpoint
    // is therefore never a legitimate "first user" — self-hosted teamem is
    // not an open multi-tenant signup surface, and letting any GitHub
    // account spin up its own team here was the actual hole (a removed or
    // never-invited visitor could always just make a new one). Existing
    // members creating an additional team for their own org are unaffected.
    const existingMembership = await db.$client.query(
      `SELECT 1 FROM memberships WHERE user_id = $1 LIMIT 1`,
      [sessionUser.userId],
    );
    if (existingMembership.rows.length === 0) {
      const teamCountResult = await db.$client.query(`SELECT COUNT(*)::int AS count FROM teams`);
      const teamCount = teamCountResult.rows[0]?.['count'] as number;
      if (teamCount > 0) {
        throw new ForbiddenError(
          'Self-serve team creation is not available on this portal — ask an existing team owner for an invite',
        );
      }
    }

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
  routes.get('/v1/teams/mine', requireWebSession(db), async (c: Context) => {
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

  // ── PATCH /v1/teams/:teamId ────────────────────────────────────────────
  // Rename a team. Requires owner role.
  routes.patch('/v1/teams/:teamId', requireWebSession(db), requireTeamMembership(db), requireRole('owner'), async (c: Context) => {
    const requestId = c.get(REQUEST_ID_KEY) as string;
    const teamId = c.req.param('teamId');

    if (!teamId) {
      throw new InvalidRequestError('Missing teamId parameter');
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new InvalidRequestError('Request body is not valid JSON');
    }

    const parsed = renameTeamRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new InvalidRequestError('Request body validation failed', {
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      } as unknown as Record<string, unknown>);
    }

    const { name } = parsed.data;

    try {
      const result = await db.$client.query(
        `UPDATE teams SET name = $1 WHERE id = $2
         RETURNING id, name`,
        [name, teamId],
      );

      const row = result.rows[0];
      if (!row) {
        throw new NotFoundError();
      }

      return c.json({ requestId, data: { id: row['id'] as string, name: row['name'] as string } });
    } catch (err) {
      if (err instanceof NotFoundError) throw err;
      throw new InternalError('Failed to rename team', { cause: err });
    }
  });

  // ── POST /v1/teams/:teamId/delete ─────────────────────────────────────
  // Delete a team. Requires owner role. This is destructive and cannot be undone.
  routes.post('/v1/teams/:teamId/delete', requireWebSession(db), requireTeamMembership(db), requireRole('owner'), async (c: Context) => {
    const requestId = c.get(REQUEST_ID_KEY) as string;
    const sessionUser = getSessionUser(c);
    const teamId = c.req.param('teamId');

    if (!teamId) {
      throw new InvalidRequestError('Missing teamId parameter');
    }

    try {
      // Verify team exists and user is owner
      const membershipResult = await db.$client.query(
        `SELECT role FROM memberships WHERE user_id = $1 AND team_id = $2 AND role = 'owner' LIMIT 1`,
        [sessionUser.userId, teamId],
      );

      if (membershipResult.rows.length === 0) {
        throw new NotFoundError();
      }

      await db.$client.query('BEGIN');
      try {
        // CASCADE will handle related records. Audit records are kept
        // because audit_log has no FK to teams.
        await db.$client.query('DELETE FROM teams WHERE id = $1', [teamId]);
        await db.$client.query('COMMIT');
      } catch (err) {
        await db.$client.query('ROLLBACK');
        throw err;
      }

      console.info(
        JSON.stringify({
          event: 'team_deleted',
          requestId,
          teamId,
          deletedByUserId: sessionUser.userId,
        }),
      );

      return c.json({
        requestId,
        data: { id: teamId, deleted: true, deletedAt: new Date().toISOString() },
      });
    } catch (err) {
      if (err instanceof NotFoundError) throw err;
      throw new InternalError('Failed to delete team', { cause: err });
    }
  });

  return routes;
}
