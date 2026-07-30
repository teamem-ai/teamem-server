/**
 * Project management routes — create, rename, list projects (DUA-230).
 *
 * Web-session-authenticated routes for team-scoped project management:
 *   POST   /v1/teams/:teamId/projects             → create project (admin+)
 *   PATCH  /v1/teams/:teamId/projects/:projectId  → rename project (admin+)
 *   GET    /v1/teams/:teamId/projects              → list projects (any role)
 *
 * Security invariants:
 *   - Team scope is derived from the web session's membership row, NOT
 *     from the URL parameter alone — the middleware confirms the user
 *     has a membership for the target team before the handler runs.
 *   - Cross-team access returns 404 (indistinguishable from a genuinely
 *     non-existent team) — enforced by requireTeamMembership middleware.
 *   - Project operations are admin+ gated. member/viewer get 403.
 *   - The projectId in the URL must match a project that belongs to the
 *     same team (scoped query using team_id from the session).
 */
import { Hono, type Context } from 'hono';
import { randomBytes } from 'node:crypto';
import type { AppDb } from '../../db/client.js';
import {
  requireWebSession,
  requireTeamMembership,
  getWebSession,
} from '../session.js';
import { requireRole } from '../../auth/rbac.js';
import {
  InvalidRequestError,
  NotFoundError,
  InternalError,
  REQUEST_ID_KEY,
} from '../errors.js';
import {
  createProjectRequest as createProjectRequestSchema,
  renameProjectRequest as renameProjectRequestSchema,
  type ProjectEntry,
} from '@teamem/schema';

// ── Dependencies ────────────────────────────────────────────────────────────

export interface ProjectsDeps {
  db: AppDb;
}

// ── Route builder ───────────────────────────────────────────────────────────

export function buildProjectsRoutes(deps: ProjectsDeps): Hono {
  const { db } = deps;
  const routes = new Hono();

  // ── Auth middleware stack — scoped to team-prefixed paths so :teamId ──
  // is captured and available to requireTeamMembership's c.req.param().
  routes.use('/v1/teams/:teamId/*', requireWebSession(db));
  routes.use('/v1/teams/:teamId/*', requireTeamMembership(db));

  // ── POST /v1/teams/:teamId/projects ────────────────────────────────────
  // Create a project. Requires admin+ role.
  routes.post('/v1/teams/:teamId/projects', requireRole('admin'), async (c: Context) => {
    const requestId = c.get(REQUEST_ID_KEY) as string;
    const ws = getWebSession(c);

    // Parse and validate request body
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new InvalidRequestError('Request body is not valid JSON');
    }

    const parsed = createProjectRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new InvalidRequestError('Request body validation failed', {
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      } as unknown as Record<string, unknown>);
    }

    const { name } = parsed.data;
    const projectId = `prj_${randomBytes(12).toString('hex')}`;
    const teamId = ws.scope.teamId;

    try {
      await db.$client.query(
        `INSERT INTO projects (id, team_id, name) VALUES ($1, $2, $3)`,
        [projectId, teamId, name],
      );

      const result = await db.$client.query(
        `SELECT id, team_id, name, created_at FROM projects WHERE id = $1 AND team_id = $2`,
        [projectId, teamId],
      );

      const row = result.rows[0];
      if (!row) {
        throw new InternalError('Project created but not found on read-back');
      }

      const response: ProjectEntry = {
        id: row['id'] as string,
        teamId: row['team_id'] as string,
        name: row['name'] as string,
        createdAt: (row['created_at'] as Date).toISOString(),
      };

      return c.json({ requestId, data: response }, 201);
    } catch (err) {
      throw new InternalError('Failed to create project', { cause: err });
    }
  });

  // ── PATCH /v1/teams/:teamId/projects/:projectId ────────────────────────
  // Rename a project. Requires admin+ role.
  routes.patch('/v1/teams/:teamId/projects/:projectId', requireRole('admin'), async (c: Context) => {
    const requestId = c.get(REQUEST_ID_KEY) as string;
    const ws = getWebSession(c);
    const teamId = ws.scope.teamId;
    const projectId = c.req.param('projectId');

    if (!projectId) {
      throw new InvalidRequestError('Missing projectId parameter');
    }

    // Parse and validate request body
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new InvalidRequestError('Request body is not valid JSON');
    }

    const parsed = renameProjectRequestSchema.safeParse(body);
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
        `UPDATE projects SET name = $1
         WHERE id = $2 AND team_id = $3
         RETURNING id, team_id, name, created_at`,
        [name, projectId, teamId],
      );

      const row = result.rows[0];
      if (!row) {
        // Project not found in this team — return 404 (same as genuinely
        // missing project; does NOT reveal whether the project exists in
        // another team).
        throw new NotFoundError();
      }

      const response: ProjectEntry = {
        id: row['id'] as string,
        teamId: row['team_id'] as string,
        name: row['name'] as string,
        createdAt: (row['created_at'] as Date).toISOString(),
      };

      return c.json({ requestId, data: response });
    } catch (err) {
      if (err instanceof NotFoundError) throw err;
      throw new InternalError('Failed to rename project', { cause: err });
    }
  });

  // ── GET /v1/teams/:teamId/projects ─────────────────────────────────────
  // List all projects in the team. Any role can access.
  routes.get('/v1/teams/:teamId/projects', async (c: Context) => {
    const requestId = c.get(REQUEST_ID_KEY) as string;
    const ws = getWebSession(c);
    const teamId = ws.scope.teamId;

    try {
      const result = await db.$client.query(
        `SELECT id, team_id, name, created_at
         FROM projects
         WHERE team_id = $1
         ORDER BY created_at ASC`,
        [teamId],
      );

      const projects: ProjectEntry[] = result.rows.map((row) => ({
        id: row['id'] as string,
        teamId: row['team_id'] as string,
        name: row['name'] as string,
        createdAt: (row['created_at'] as Date).toISOString(),
      }));

      return c.json({ requestId, data: projects });
    } catch (err) {
      throw new InternalError('Failed to list projects', { cause: err });
    }
  });

  return routes;
}
