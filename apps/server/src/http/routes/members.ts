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
