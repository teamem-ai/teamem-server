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
import type { ApiScope } from '@teamem/schema';
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
} from './errors.js';

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
