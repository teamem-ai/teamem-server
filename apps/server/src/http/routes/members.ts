/**
 * Member & Role Management API (DUA-226 M2-AUTH-05).
 *
 * Delivers:
 *   GET  /v1/members           — list team members with principal linkage
 *   PATCH /v1/members/:userId   — change a member's role (owner only)
 *   DELETE /v1/members/:userId  — remove a member (owner only)
 *
 * All routes require a valid web session. Role changes and removals are
 * restricted to owners. Last-owner protection: the last remaining owner
 * cannot be demoted or removed (409 Conflict).
 *
 * Security:
 *   - Cross-team access is indistinguishable from "member not found" (404).
 *   - Non-owner role-change/removal attempts return 403.
 *   - Missing/invalid session returns 401.
 */
import { z } from 'zod';
import { teamRole } from '@teamem/schema';
import type { Context, Next, MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import type { AppDb } from '../../db/client.js';
import { requireSession, getSession } from './auth.js';
import type { GitHubOAuthConfig } from '../../auth/oauth-github.js';
import {
  ForbiddenError,
  NotFoundError,
  ConflictError,
  InvalidRequestError,
} from '../errors.js';

// ── Types ──────────────────────────────────────────────────────────────────

interface MemberEntry {
  userId: string;
  githubLogin: string;
  avatarUrl: string | null;
  role: string;
  joinedAt: string;
  /** Linked principal id (pri_...) so the frontend can tie contributions to real member profiles. */
  principalId: string | null;
  /** Display login from the principal record, or null. */
  principalDisplayLogin: string | null;
}

// ── Zod schemas ────────────────────────────────────────────────────────────

const changeRoleBody = z.strictObject({
  role: teamRole,
});

// ── Owner guard middleware ─────────────────────────────────────────────────

/**
 * Middleware that requires the authenticated session to have the 'owner' role.
 *
 * Must be used AFTER requireSession in the middleware chain. Non-owner
 * sessions receive 403 Forbidden (identical envelope regardless of which
 * role they actually hold — no information leakage).
 */
function requireOwner(): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const session = getSession(c);
    if (!session || session.role !== 'owner') {
      throw new ForbiddenError('Only team owners can manage member roles');
    }
    await next();
  };
}

// ── Route factory ──────────────────────────────────────────────────────────

export function buildMembersRoutes(config: GitHubOAuthConfig, db: AppDb): Hono {
  const routes = new Hono();

  // All routes require a valid web session.
  routes.use('*', requireSession(config, db));

  // ── GET /v1/members ──────────────────────────────────────────────────────
  // Returns the team's members in join order (oldest first). Each entry
  // includes the linked principal so the frontend can connect a member to
  // their contributions (concept contributors, events, etc.).

  routes.get('/v1/members', async (c) => {
    const session = getSession(c);

    // No team membership — user is an orphan. Return empty list.
    if (!session.teamId) {
      return c.json({ data: [] });
    }

    const result = await db.$client.query(
      `SELECT
         m.user_id,
         u.github_login,
         u.avatar_url,
         m.role,
         m.created_at,
         (SELECT p.id FROM principals p
          WHERE p.team_id = m.team_id
            AND p.provider = 'github'
            AND p.provider_user_id = u.github_id::text
          LIMIT 1) AS principal_id,
         (SELECT p.display_login FROM principals p
          WHERE p.team_id = m.team_id
            AND p.provider = 'github'
            AND p.provider_user_id = u.github_id::text
          LIMIT 1) AS principal_display_login
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       WHERE m.team_id = $1
       ORDER BY m.created_at ASC`,
      [session.teamId],
    );

    const members: MemberEntry[] = result.rows.map((row) => ({
      userId: row['user_id'] as string,
      githubLogin: row['github_login'] as string,
      avatarUrl: (row['avatar_url'] as string | null) ?? null,
      role: row['role'] as string,
      joinedAt: (row['created_at'] as Date).toISOString(),
      principalId: (row['principal_id'] as string | null) ?? null,
      principalDisplayLogin: (row['principal_display_login'] as string | null) ?? null,
    }));

    return c.json({ data: members });
  });

  // ── GET /v1/members/:userId/concepts ─────────────────────────────────────
  // Returns concepts contributed by this member's linked principal.
  // Requires a projectId query parameter (concepts are project-scoped).

  routes.get('/v1/members/:userId/concepts', async (c) => {
    const session = getSession(c);

    if (!session.teamId) {
      throw new NotFoundError('Member not found');
    }

    const targetUserId = c.req.param('userId');
    if (!targetUserId) {
      throw new InvalidRequestError('Missing userId parameter');
    }

    // Parse projectId from query
    const projectId = c.req.query('projectId');
    if (!projectId) {
      throw new InvalidRequestError('projectId query parameter is required');
    }
    if (!/^prj_[A-Za-z0-9]+$/.test(projectId)) {
      throw new InvalidRequestError('Invalid projectId format');
    }
    const rawLimit = c.req.query('limit');
    const limit = rawLimit ? Math.min(Math.max(parseInt(rawLimit, 10) || 20, 1), 100) : 20;

    // Look up the member to get their linked principal.
    const memberResult = await db.$client.query(
      `SELECT m.role, u.github_login, u.github_id
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       WHERE m.user_id = $1 AND m.team_id = $2`,
      [targetUserId, session.teamId],
    );

    if (memberResult.rows.length === 0) {
      throw new NotFoundError('Member not found');
    }

    const githubId = memberResult.rows[0]!['github_id'] as number;

    // Find the principal linked to this user's github_id.
    const principalResult = await db.$client.query(
      `SELECT p.id, p.display_login
       FROM principals p
       WHERE p.team_id = $1
         AND p.provider = 'github'
         AND p.provider_user_id = $2::text
       LIMIT 1`,
      [session.teamId, String(githubId)],
    );

    const principalId = principalResult.rows[0]?.['id'] as string | undefined;

    if (!principalId) {
      // No linked principal — this member has no verified contributions.
      return c.json({ data: [], nextCursor: null });
    }

    // Query concepts contributed by this principal.  Only concepts where
    // the principal appears in concept_contributors are returned.  Per
    // the frozen contract, client_claimed actors never enter that table
    // (AGENTS.md: "client_claimed actors do not enter contributors by
    // default"), so all entries are already from verified sources.
    // The `provider = 'github'` guard in the principal lookup above
    // further constrains to GitHub-verified principals only.
    const conceptRows = await db.$client.query(
      `SELECT DISTINCT c.uuid, c.type, c.status, c.confidence, c.title,
              c.tags, c.last_confirmed, cp.path
       FROM concepts c
       JOIN concept_contributors cc
         ON cc.concept_uuid = c.uuid
        AND cc.team_id = $2 AND cc.project_id = $3 AND cc.principal_id = $4
       LEFT JOIN concept_paths cp
         ON cp.concept_uuid = c.uuid AND cp.is_current = true
        AND cp.team_id = $2 AND cp.project_id = $3
       WHERE c.team_id = $2 AND c.project_id = $3
       ORDER BY c.last_confirmed DESC
       LIMIT $5`,
      [targetUserId, session.teamId, projectId, principalId, limit],
    );

    const data = conceptRows.rows.map((row) => ({
      uuid: row['uuid'] as string,
      path: (row['path'] as string) ?? '',
      type: row['type'] as string,
      status: row['status'] as string,
      confidence: row['confidence'] as string,
      title: row['title'] as string,
      tags: row['tags'] as string[],
      lastConfirmed: (row['last_confirmed'] as Date).toISOString(),
    }));

    return c.json({ data, nextCursor: null });
  });

  // ── PATCH /v1/members/:userId ────────────────────────────────────────────
  // Change a member's role. Owner-only. Last-owner protection enforced.

  routes.patch('/v1/members/:userId', requireOwner(), async (c) => {
    const session = getSession(c);

    if (!session.teamId) {
      throw new NotFoundError('Team not found');
    }

    const targetUserId = c.req.param('userId');
    if (!targetUserId) {
      throw new InvalidRequestError('Missing userId parameter');
    }

    // Parse and validate the request body.
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new InvalidRequestError('Invalid JSON body');
    }

    const parsed = changeRoleBody.safeParse(body);
    if (!parsed.success) {
      throw new InvalidRequestError('Invalid request body');
    }
    const newRole = parsed.data.role;

    // Look up the target membership within the caller's team.
    const targetResult = await db.$client.query(
      `SELECT m.role, u.github_login
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       WHERE m.user_id = $1 AND m.team_id = $2`,
      [targetUserId, session.teamId],
    );

    if (targetResult.rows.length === 0) {
      // Same 404 whether the user doesn't exist or belongs to another team
      // — cross-team enumeration is not distinguishable.
      throw new NotFoundError('Member not found');
    }

    const currentRole = targetResult.rows[0]!['role'] as string;

    // Idempotent: same role is a success no-op.
    if (currentRole === newRole) {
      return c.json({
        userId: targetUserId,
        role: newRole,
        githubLogin: targetResult.rows[0]!['github_login'] as string,
      });
    }

    // ── Last-owner protection ──────────────────────────────────────────
    // Before demoting the last owner, verify another owner exists.
    if (currentRole === 'owner' && newRole !== 'owner') {
      const ownerCountResult = await db.$client.query(
        `SELECT COUNT(*)::int AS count FROM memberships
         WHERE team_id = $1 AND role = 'owner'`,
        [session.teamId],
      );
      const ownerCount = ownerCountResult.rows[0]!['count'] as number;
      if (ownerCount <= 1) {
        throw new ConflictError('Cannot change role of the last owner');
      }
    }

    await db.$client.query(
      `UPDATE memberships SET role = $1 WHERE user_id = $2 AND team_id = $3`,
      [newRole, targetUserId, session.teamId],
    );

    return c.json({
      userId: targetUserId,
      role: newRole,
      githubLogin: targetResult.rows[0]!['github_login'] as string,
    });
  });

  // ── DELETE /v1/members/:userId ───────────────────────────────────────────
  // Remove a member from the team. Owner-only. Last-owner protection enforced.

  routes.delete('/v1/members/:userId', requireOwner(), async (c) => {
    const session = getSession(c);

    if (!session.teamId) {
      throw new NotFoundError('Team not found');
    }

    const targetUserId = c.req.param('userId');
    if (!targetUserId) {
      throw new InvalidRequestError('Missing userId parameter');
    }

    // Look up the target membership within the caller's team.
    const targetResult = await db.$client.query(
      `SELECT m.role, u.github_login
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       WHERE m.user_id = $1 AND m.team_id = $2`,
      [targetUserId, session.teamId],
    );

    if (targetResult.rows.length === 0) {
      // Same 404 whether the user doesn't exist or belongs to another team
      // — cross-team enumeration is not distinguishable.
      throw new NotFoundError('Member not found');
    }

    const currentRole = targetResult.rows[0]!['role'] as string;

    // ── Last-owner protection ──────────────────────────────────────────
    if (currentRole === 'owner') {
      const ownerCountResult = await db.$client.query(
        `SELECT COUNT(*)::int AS count FROM memberships
         WHERE team_id = $1 AND role = 'owner'`,
        [session.teamId],
      );
      const ownerCount = ownerCountResult.rows[0]!['count'] as number;
      if (ownerCount <= 1) {
        throw new ConflictError('Cannot remove the last owner');
      }
    }

    await db.$client.query(
      `DELETE FROM memberships WHERE user_id = $1 AND team_id = $2`,
      [targetUserId, session.teamId],
    );

    return c.json({
      removed: true,
      userId: targetUserId,
      githubLogin: targetResult.rows[0]!['github_login'] as string,
    });
  });

  return routes;
}
