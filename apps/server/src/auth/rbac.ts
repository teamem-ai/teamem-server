/**
 * Role-Based Access Control — web-session role ladder (N6).
 *
 * Web roles (viewer < member < admin < owner) are independent of API key
 * scopes. API keys have data-plane scopes only and can NEVER gain admin
 * capability; web sessions are membership-scoped and can NEVER bypass
 * team-id enforcement.
 *
 * The role ladder is additive: each level includes everything below it.
 *   viewer  — browse concepts/jobs lists
 *   member  — + search/context, concept detail
 *   admin   — + key mint/revoke, source & LLM config, audit:read, payload detail
 *   owner   — + purge, role management, team deletion
 *
 * @module rbac
 */
import type { Context, Next, MiddlewareHandler } from 'hono';
import type { TeamRole } from '@teamem/schema';
import { ForbiddenError, UnauthorizedError } from '../http/errors.js';
import { getWebSession, type WebSessionContext } from '../http/session.js';

// ── Role rank ───────────────────────────────────────────────────────────────

/** Numeric rank for role comparison. Higher rank includes lower ranks. */
const ROLE_RANK: Record<TeamRole, number> = {
  viewer: 0,
  member: 1,
  admin: 2,
  owner: 3,
} as const;

/**
 * Return the numeric rank of a team role.
 *
 * Used by internal comparisons; exported for testability and
 * for downstream code that needs to sort or filter by role level.
 */
export function roleRank(role: TeamRole): number {
  return ROLE_RANK[role];
}

/**
 * Check whether a user's role satisfies a minimum role requirement.
 *
 * @returns true if userRole >= minRole in the role ladder
 */
export function checkRole(userRole: TeamRole, minRole: TeamRole): boolean {
  return roleRank(userRole) >= roleRank(minRole);
}

// ── requireRole middleware ──────────────────────────────────────────────────

/**
 * Middleware factory that requires the web session to have at least the
 * specified minimum role.
 *
 * Must be used AFTER `requireTeamMembership` in the middleware chain
 * (which itself must follow `requireWebSession`).
 *
 * Security invariants:
 * - No WebSessionContext (requireTeamMembership not run) → 401
 * - Role too low → 403 (identical envelope regardless of which role
 *   is missing — no information leakage about minimum required role)
 *
 * Usage:
 *   routes.use('/teams/:teamId/*', requireWebSession(db));
 *   routes.use('/teams/:teamId/*', requireTeamMembership(db));
 *   routes.use('/teams/:teamId/admin/*', requireRole('admin'));
 *   routes.use('/teams/:teamId/owner/*', requireRole('owner'));
 */
export function requireRole(minRole: TeamRole): MiddlewareHandler {
  return async (_c: Context, _next: Next) => {
    let session: WebSessionContext;
    try {
      session = getWebSession(_c);
    } catch {
      // No session context — requireWebSession was not run before this
      // middleware. Treat as unauthorized (identical to missing session).
      throw new UnauthorizedError();
    }

    if (!session) {
      // Defensive: getWebSession returned null/undefined
      throw new UnauthorizedError();
    }

    if (!checkRole(session.teamRole, minRole)) {
      // Role too low. Always return the same 403 — never reveal the
      // minimum required role or the user's actual role.
      throw new ForbiddenError();
    }

    await _next();
  };
}

// ── Re-exports for testing ──────────────────────────────────────────────────

export const __test = {
  ROLE_RANK,
};
