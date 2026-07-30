/**
 * Web Session Middleware — session verification + team-scope derivation (N6).
 *
 * Two-layer middleware design:
 *
 *   1. requireWebSession(db)
 *      Validates the session cookie and fetches the user. Does NOT check
 *      team membership — that is the job of the next layer.
 *      Missing / expired / revoked session → 401.
 *
 *   2. requireTeamMembership(db, teamIdParam?)
 *      Must run after requireWebSession. Extracts the target team ID from
 *      a URL parameter (default 'teamId'), looks up the user's membership
 *      in THAT SPECIFIC team, and produces a tagged ScopeContext +
 *      TeamRole. No membership in the target team → 404 (indistinguishable
 *      from a genuinely missing resource — does NOT leak whether the team
 *      or membership exists).
 *
 *   3. requireRole(minRole)  [defined in ../auth/rbac.js]
 *      Must run after requireTeamMembership. Checks the derived TeamRole
 *      against the role ladder.
 *
 * Security invariants:
 * - The ScopeContext is derived from the membership row, NOT from the
 *   client (the client cannot claim an arbitrary team/project scope).
 * - Missing, expired, and revoked sessions all return identical 401.
 * - "No membership in target team" returns 404 — the same response a
 *   genuinely non-existent team/resource would produce. This prevents
 *   attackers from probing team existence via membership checks.
 * - A user who belongs to team A but not team B gets 404 when hitting
 *   team B's URL, which is byte-identical to the response for a
 *   non-existent team.
 *
 * This middleware is the web-session counterpart of the Bearer-token
 * `requireAuth` in http/auth.ts. Web sessions carry team roles; API keys
 * carry data-plane scopes. These are two SEPARATE authorization systems
 * — web sessions must never gain API-key-style scopes, and API keys
 * must never gain web-session-style roles or admin capabilities.
 */
import type { Context, Next, MiddlewareHandler } from 'hono';
import type { TeamRole } from '@teamem/schema';
import type { AppDb } from '../db/client.js';
import type { ScopeContext } from '../auth/scope.js';
import { allProjectsScope } from '../auth/scope.js';
import {
  verifySession,
  parseSessionCookie,
} from '../auth/oauth-github.js';
import {
  UnauthorizedError,
  NotFoundError,
  InternalError,
} from './errors.js';

// ── Hono context keys ──────────────────────────────────────────────────────

/** Key for SessionUser stored on the Hono context after requireWebSession. */
export const SESSION_USER_KEY = 'sessionUser';

/** Key for WebSessionContext stored after requireTeamMembership. */
export const WEB_SESSION_KEY = 'webSession';

/** The Hono Variables shape after requireWebSession has run. */
export interface SessionUserVariables {
  [SESSION_USER_KEY]: SessionUser;
}

/** The Hono Variables shape after requireTeamMembership has run. */
export interface WebSessionVariables {
  [WEB_SESSION_KEY]: WebSessionContext;
}

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * The authenticated user identity extracted from a valid web session.
 * Produced by `requireWebSession` — does NOT include team scope.
 */
export interface SessionUser {
  /** The user's ID (usr_...). */
  readonly userId: string;
  /** The session row ID (ses_...). */
  readonly sessionId: string;
  /** The user's GitHub login (display name). */
  readonly githubLogin: string;
  /** The user's avatar URL or null. */
  readonly avatarUrl: string | null;
}

/**
 * The full web-session context including team scope and role.
 * Produced by `requireTeamMembership` — includes SessionUser fields
 * plus the team-specific scope and role.
 */
export interface WebSessionContext {
  /** The user's ID (usr_...). */
  readonly userId: string;
  /** The session row ID (ses_...). */
  readonly sessionId: string;
  /** The user's GitHub login (display name). */
  readonly githubLogin: string;
  /** The user's avatar URL or null. */
  readonly avatarUrl: string | null;
  /** The user's role in the target team (viewer/member/admin/owner). */
  readonly teamRole: TeamRole;
  /** The tagged ScopeContext for downstream scoped queries. */
  readonly scope: ScopeContext;
}

// ── requireWebSession middleware ────────────────────────────────────────────

/**
 * Middleware that requires a valid web session cookie.
 *
 * Steps:
 * 1. Extract the session cookie from the Cookie header.
 *    Missing/malformed cookie → 401 (identical envelope).
 * 2. Verify the session token against the database.
 *    Expired, revoked, or unknown tokens → 401 (identical envelope,
 *    same error code and message — no information leakage).
 * 3. Fetch the user record.
 *    User deleted after session creation → 401 (defensive).
 * 4. Attach SessionUser to the Hono context.
 *
 * This middleware does NOT check team membership — use
 * `requireTeamMembership` after it for team-scoped routes.
 *
 * Must be invoked as `requireWebSession(db)` where `db` is the
 * Drizzle database instance.
 *
 * Usage:
 *   routes.use('/teams/:teamId/*', requireWebSession(db));
 *   routes.use('/teams/:teamId/*', requireTeamMembership(db));
 *   routes.use('/teams/:teamId/admin/*', requireRole('admin'));
 */
export function requireWebSession(db: AppDb): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    // Step 1: Extract the session cookie
    const cookieHeader = c.req.header('cookie') ?? null;
    const token = parseSessionCookie(cookieHeader);

    if (!token) {
      throw new UnauthorizedError();
    }

    // Step 2: Verify session
    let session: { userId: string; sessionId: string } | null;
    try {
      session = await verifySession(db, token);
    } catch (err) {
      throw new InternalError('session verification failed', { cause: err });
    }

    if (!session) {
      // Expired, revoked, or unknown — identical 401
      throw new UnauthorizedError();
    }

    // Step 3: Fetch user
    let userRow: Record<string, unknown> | undefined;
    try {
      const userResult = await db.$client.query(
        `SELECT id, github_login, avatar_url FROM users WHERE id = $1 LIMIT 1`,
        [session.userId],
      );
      userRow = userResult.rows[0] as Record<string, unknown> | undefined;
    } catch (err) {
      throw new InternalError('user lookup failed', { cause: err });
    }

    if (!userRow) {
      // User deleted after session creation — defensive
      throw new UnauthorizedError();
    }

    // Step 4: Attach SessionUser (no membership check yet — that is
    // the job of requireTeamMembership)
    const sessionUser: SessionUser = {
      userId: session.userId,
      sessionId: session.sessionId,
      githubLogin: (userRow['github_login'] as string) ?? '',
      avatarUrl: (userRow['avatar_url'] as string) ?? null,
    };

    c.set(SESSION_USER_KEY, sessionUser);

    await next();
  };
}

// ── requireTeamMembership middleware ────────────────────────────────────────

/**
 * Middleware that requires the authenticated user to be a member of the
 * target team.
 *
 * Must be used AFTER `requireWebSession` in the middleware chain.
 *
 * Steps:
 * 1. Retrieve the SessionUser from the Hono context (set by requireWebSession).
 * 2. Extract the target team ID from the URL parameter.
 *    Missing teamId param → 500 (programmer error: route not configured).
 * 3. Look up the membership row for (userId, teamId).
 *    No membership → 404 (identical to a genuinely missing resource —
 *    does NOT leak whether the team exists or the user exists).
 * 4. Build and attach WebSessionContext (teamRole + ScopeContext).
 *
 * @param db - The Drizzle database instance
 * @param teamIdParam - The URL parameter name containing the team ID
 *   (default: 'teamId'). The route must declare this parameter, e.g.
 *   `/teams/:teamId/admin`.
 *
 * Security: the team ID is taken from the URL, but the SCOPE is only
 * granted after the database confirms the user has a membership row for
 * that team. The client cannot fabricate a scope by guessing a team ID
 * — the membership row is the authoritative source.
 *
 * Usage:
 *   routes.use('/teams/:teamId/*', requireWebSession(db));
 *   routes.use('/teams/:teamId/*', requireTeamMembership(db));
 *   routes.use('/teams/:teamId/admin/*', requireRole('admin'));
 */
export function requireTeamMembership(
  db: AppDb,
  teamIdParam = 'teamId',
): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    // Step 1: Retrieve the SessionUser (must have been set by requireWebSession)
    const sessionUser = c.get(SESSION_USER_KEY) as SessionUser | undefined;
    if (!sessionUser) {
      // requireWebSession was not run before this middleware
      throw new UnauthorizedError();
    }

    // Step 2: Extract target team ID from the URL parameter
    const teamId = c.req.param(teamIdParam);
    if (!teamId) {
      // Programmer error: the route doesn't declare :teamId but
      // requireTeamMembership was used. This is a server-side bug —
      // do NOT return 404 (would leak that the param is optional).
      throw new InternalError(
        `requireTeamMembership: URL param '${teamIdParam}' is missing`,
      );
    }

    // Step 3: Look up membership for (userId, teamId)
    let membershipRow: Record<string, unknown> | undefined;
    try {
      const membershipResult = await db.$client.query(
        `SELECT m.role
         FROM memberships m
         WHERE m.user_id = $1 AND m.team_id = $2
         LIMIT 1`,
        [sessionUser.userId, teamId],
      );
      membershipRow = membershipResult.rows[0] as Record<string, unknown> | undefined;
    } catch (err) {
      throw new InternalError('membership lookup failed', { cause: err });
    }

    if (!membershipRow) {
      // No membership in the target team.
      // Return 404 — indistinguishable from a genuinely missing resource.
      // This MUST NOT reveal whether:
      //   - The team exists but the user is not a member
      //   - The team doesn't exist at all
      //   - The user exists but has no memberships
      throw new NotFoundError();
    }

    const teamRole = membershipRow['role'] as TeamRole;

    // Step 4: Build and attach WebSessionContext
    const webSession: WebSessionContext = {
      userId: sessionUser.userId,
      sessionId: sessionUser.sessionId,
      githubLogin: sessionUser.githubLogin,
      avatarUrl: sessionUser.avatarUrl,
      teamRole,
      scope: allProjectsScope(teamId),
    };

    c.set(WEB_SESSION_KEY, webSession);

    await next();
  };
}

// ── Accessors ──────────────────────────────────────────────────────────────

/**
 * Retrieve the SessionUser from the Hono context.
 *
 * Must only be called after `requireWebSession` middleware has run.
 *
 * @throws UnauthorizedError if the session user is not present
 */
export function getSessionUser(c: Context): SessionUser {
  const user = c.get(SESSION_USER_KEY) as SessionUser | undefined;
  if (!user) {
    throw new UnauthorizedError();
  }
  return user;
}

/**
 * Retrieve the WebSessionContext from the Hono context.
 *
 * Must only be called after `requireTeamMembership` middleware has run
 * (i.e. on a route or middleware that follows both `requireWebSession`
 * and `requireTeamMembership` in the chain).
 *
 * @throws UnauthorizedError if the session context is not present
 */
export function getWebSession(c: Context): WebSessionContext {
  const session = c.get(WEB_SESSION_KEY) as WebSessionContext | undefined;
  if (!session) {
    throw new UnauthorizedError();
  }
  return session;
}
