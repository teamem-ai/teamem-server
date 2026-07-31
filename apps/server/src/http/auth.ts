/**
 * Auth middleware — Bearer token authentication and scope enforcement.
 *
 * Provides reusable Hono middleware that:
 * - Extracts the Bearer token from the Authorization header
 * - Resolves it against the database to produce an AuthContext
 *   (credential, principal snapshot, tagged ScopeContext, scopes)
 * - Attaches the AuthContext to the Hono context for downstream handlers
 * - Checks required scopes, returning 403 when insufficient
 * - Returns identical 401 for unknown, malformed, and revoked tokens
 *
 * The middleware is deliberately split into two layers so route
 * registration code can decide whether a route needs authentication,
 * authorisation, or both:
 *
 *   requireAuth(db)     → 401 for missing/invalid/revoked tokens
 *   requireScope('read') → 403 for insufficient scope
 *
 * Combined usage on a protected route:
 *
 *   routes.use('/v1/events', requireAuth(db));
 *   routes.use('/v1/events', requireScope('events:write'));
 */
import type { Context, Next, MiddlewareHandler } from 'hono';
import type { ApiScope, TeamRole } from '@teamem/schema';
import * as schema from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { hashToken, parseBearerToken } from '../auth/api-key.js';
import {
  resolveTokenHash,
  AuthenticationError,
  type AuthContext,
} from '../db/repositories/api-keys.js';
import type { AppDb } from '../db/client.js';
import {
  UnauthorizedError,
  ForbiddenError,
  InternalError,
  NotFoundError,
} from './errors.js';
import { allProjectsScope } from '../auth/scope.js';
import { parseSessionCookie, verifySession } from '../auth/oauth-github.js';
import { checkRole } from '../auth/rbac.js';

// ── Hono context keys ──────────────────────────────────────────────────────

/** Key for AuthContext stored on the Hono context Variables. */
export const AUTH_KEY = 'auth';

/** The Hono Variables shape after requireAuth has run. */
export interface AuthVariables {
  [AUTH_KEY]: AuthContext;
}

// ── AuthContext accessor ────────────────────────────────────────────────────

/**
 * Retrieve the AuthContext from the Hono context.
 *
 * Must only be called after `requireAuth` middleware has run (i.e. on a
 * route or middleware that follows `requireAuth` in the chain). Calling
 * this on an unauthenticated request will return `undefined`.
 */
export function getAuth(c: Context): AuthContext {
  return c.get(AUTH_KEY) as AuthContext;
}

// ── requireAuth middleware ──────────────────────────────────────────────────

/**
 * Middleware that requires a valid Bearer token.
 *
 * Steps:
 * 1. Extract the Authorization header and parse the Bearer token.
 *    Missing or malformed headers → 401 Unauthorized (identical envelope).
 * 2. Hash the plaintext token and resolve it against the database.
 *    Unknown or revoked tokens → 401 Unauthorized (identical envelope,
 *    same error code and message — no information leakage).
 * 3. Attach the resolved AuthContext to the Hono context via `c.set(AUTH_KEY, auth)`.
 *
 * Must be invoked as `requireAuth(db)` where `db` is the Drizzle instance.
 */
export function requireAuth(db: AppDb): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    // Step 1: Extract and parse the Bearer token
    const authHeader = c.req.header('authorization') ?? null;
    const token = parseBearerToken(authHeader);
    if (!token) {
      throw new UnauthorizedError('Missing or malformed Authorization header');
    }

    // Step 2: Hash and resolve against the database
    const tokenHash = hashToken(token);

    let auth: AuthContext;
    try {
      auth = await resolveTokenHash(db, tokenHash);
    } catch (err) {
      if (err instanceof AuthenticationError) {
        // Unknown or revoked — identical 401, no information leakage
        throw new UnauthorizedError('invalid or revoked API key');
      }
      throw new InternalError('authentication lookup failed', { cause: err });
    }

    // Step 3: Attach AuthContext to the Hono context
    c.set(AUTH_KEY, auth);

    await next();
  };
}

// ── requireAuthOrWebSession middleware ─────────────────────────────────────────

/**
 * Middleware that accepts either a Bearer API key OR a valid web session cookie.
 *
 * Web sessions are converted into an AuthContext with an `allProjects` scope
 * for the user's team, so the existing scoped handlers and `requireScope`
 * checks work unchanged. This lets the SPA read event/job data using the same
 * cookie it received during GitHub OAuth login.
 *
 * API keys remain the primary auth mechanism for ingestion, MCP, and CLI use.
 * Web sessions are allowed only for read endpoints that the portal UI needs.
 *
 * Security invariants:
 * - The project ID is taken from the query string; the team is looked up from
 *   the project, and membership is verified against the session user. No
 *   cross-team access: no membership or missing project → 404.
 * - Session scopes are derived from the team role (viewer/member/admin/owner).
 * - Unknown/revoked API keys and missing/invalid sessions all return the same
 *   401 envelope.
 */
export function requireAuthOrWebSession(db: AppDb): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    // ── Try API key first ───────────────────────────────────────────────────
    const authHeader = c.req.header('authorization') ?? null;
    const apiToken = parseBearerToken(authHeader);
    if (apiToken) {
      const tokenHash = hashToken(apiToken);
      let auth: AuthContext;
      try {
        auth = await resolveTokenHash(db, tokenHash);
      } catch (err) {
        if (err instanceof AuthenticationError) {
          throw new UnauthorizedError('invalid or revoked API key');
        }
        throw new InternalError('authentication lookup failed', { cause: err });
      }
      c.set(AUTH_KEY, auth);
      await next();
      return;
    }

    // ── Fall back to web session cookie ──────────────────────────────────────
    const cookieHeader = c.req.header('cookie') ?? null;
    const sessionToken = parseSessionCookie(cookieHeader);
    if (!sessionToken) {
      throw new UnauthorizedError('Missing or invalid authentication');
    }

    const session = await verifySession(db, sessionToken);
    if (!session) {
      throw new UnauthorizedError('Missing or invalid authentication');
    }

    const userResult = await db.$client.query(
      'SELECT id, github_login, avatar_url FROM users WHERE id = $1 LIMIT 1',
      [session.userId],
    );
    const userRow = userResult.rows[0] as Record<string, unknown> | undefined;
    if (!userRow) {
      throw new UnauthorizedError('Missing or invalid authentication');
    }

    const projectId2 = c.req.query('projectId') ?? c.req.param('projectId');
    if (!projectId2) {
      throw new UnauthorizedError('Missing or invalid authentication');
    }

    // Resolve project → team and verify membership in one query.
    const projectRows = await db
      .select({
        teamId: schema.projects.teamId,
        teamName: schema.teams.name,
      })
      .from(schema.projects)
      .innerJoin(schema.teams, eq(schema.projects.teamId, schema.teams.id))
      .where(eq(schema.projects.id, projectId2))
      .limit(1);

    if (projectRows.length === 0) {
      // Same 404 as genuinely missing project — no team probe leak.
      throw new NotFoundError();
    }

    const { teamId, teamName } = projectRows[0]!;

    const membershipRows = await db
      .select({ role: schema.memberships.role })
      .from(schema.memberships)
      .where(
        and(
          eq(schema.memberships.userId, session.userId),
          eq(schema.memberships.teamId, teamId),
        ),
      )
      .limit(1);

    if (membershipRows.length === 0) {
      // Indistinguishable from missing project.
      throw new NotFoundError();
    }

    const teamRole = membershipRows[0]!.role as TeamRole;

    // Role → data-plane scopes. Viewer can read lists; member+ can read
    // payloads (event detail). Admin/owner inherit member capabilities.
    const scopes: ApiScope[] = ['read'];
    if (checkRole(teamRole, 'member')) {
      scopes.push('read:payload');
    }

    const auth: AuthContext = {
      credentialId: session.sessionId,
      keyName: 'Web Session',
      scopes,
      scope: allProjectsScope(teamId),
      principal: {
        id: session.userId,
        kind: 'user',
        provider: 'github',
        providerKind: 'github',
        providerUserId: (userRow['github_login'] as string) ?? '',
        displayLogin: (userRow['github_login'] as string) ?? null,
      },
      team: { id: teamId, name: teamName },
      createdAt: new Date(),
    };

    c.set(AUTH_KEY, auth);
    await next();
  };
}

// ── requireScope middleware ─────────────────────────────────────────────────

/**
 * Middleware factory that checks the authenticated request has ALL of the
 * specified scopes.
 *
 * Must be used AFTER `requireAuth` in the middleware chain. If the
 * AuthContext is missing (requireAuth not run), the request is rejected
 * with 401. If the key has insufficient scopes, the request is rejected
 * with 403 (identical envelope regardless of which scope is missing —
 * no information leakage).
 *
 * Usage:
 *   routes.use('/v1/events', requireScope('events:write'));
 *   routes.use('/v1/concepts', requireScope('read'));
 *   routes.use('/v1/events/:id', requireScope('read', 'read:payload'));
 */
export function requireScope(...requiredScopes: ApiScope[]): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const auth = getAuth(c);

    if (!auth) {
      // requireAuth was not run before this middleware
      throw new UnauthorizedError();
    }

    for (const scope of requiredScopes) {
      if (!auth.scopes.includes(scope)) {
        throw new ForbiddenError(
          `API key does not have ${scope} scope`,
        );
      }
    }

    await next();
  };
}
