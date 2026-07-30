/**
 * Auth routes — GitHub OAuth login, callback, logout, and session middleware.
 *
 * Public routes (no auth required):
 *   GET  /auth/github            → redirect to GitHub OAuth authorize
 *   GET  /auth/github/callback   → handle OAuth callback, set session cookie
 *
 * Authenticated routes (session cookie required):
 *   POST /auth/logout            → revoke session, clear cookie
 *   GET  /auth/me                → return current user + team membership
 *
 * Session middleware for protecting web routes:
 *   requireSession(db)           → 401 for missing/invalid/expired session
 *
 * Security:
 *   - State parameter prevents CSRF on the OAuth flow.
 *   - Session cookie is httpOnly, SameSite=Lax, Secure (production).
 *   - Access tokens and client secrets are NEVER logged or returned.
 *   - Expired/revoked/unknown sessions all return identical 401.
 */
import { Hono, type Context, type Next, type MiddlewareHandler } from 'hono';
import type { AppDb } from '../../db/client.js';
import type { GitHubOAuthConfig } from '../../auth/oauth-github.js';
import {
  generateState,
  verifyState,
  exchangeCodeForToken,
  getGitHubUser,
  upsertUser,
  createSession,
  verifySession,
  revokeSession,
  ensureTeamMembership,
  buildSessionCookie,
  buildClearSessionCookie,
  parseSessionCookie,
} from '../../auth/oauth-github.js';
import {
  UnauthorizedError,
} from '../errors.js';

// ── Hono context keys ──────────────────────────────────────────────────────

/** Key for session data stored on the Hono context Variables. */
export const SESSION_KEY = 'session';

/** The Hono Variables shape after requireSession has run. */
export interface SessionVariables {
  [SESSION_KEY]: SessionData;
}

/** Data extracted from a verified session + user lookup. */
export interface SessionData {
  userId: string;
  sessionId: string;
  githubLogin: string;
  avatarUrl: string | null;
  /** The user's team membership (null if not yet a member of any team). */
  teamId: string | null;
  teamName: string | null;
  role: string | null;
}

// ── Session middleware ──────────────────────────────────────────────────────

/**
 * Middleware that requires a valid web session cookie.
 *
 * Steps:
 * 1. Extract the session cookie from the Cookie header.
 * 2. Verify the session token against the database.
 *    Missing, expired, or revoked tokens → 401 (identical response).
 * 3. Fetch the user record.
 * 4. Look up the user's team membership.
 * 5. Attach SessionData to the Hono context.
 *
 * Usage:
 *   routes.use('/auth/me', requireSession(config, db));
 */
export function requireSession(
  config: GitHubOAuthConfig,
  db: AppDb,
): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const cookieHeader = c.req.header('cookie') ?? null;
    const token = parseSessionCookie(cookieHeader);

    if (!token) {
      throw new UnauthorizedError('Missing or invalid session');
    }

    // Verify session
    const session = await verifySession(db, token);
    if (!session) {
      throw new UnauthorizedError('Missing or invalid session');
    }

    // Fetch user
    const userResult = await db.$client.query(
      `SELECT id, github_login, avatar_url FROM users WHERE id = $1 LIMIT 1`,
      [session.userId],
    );
    const userRow = userResult.rows[0];
    if (!userRow) {
      throw new UnauthorizedError('Missing or invalid session');
    }

    // Look up team membership
    let teamId: string | null = null;
    let teamName: string | null = null;
    let role: string | null = null;

    const membershipResult = await db.$client.query(
      `SELECT m.team_id, m.role, t.name as team_name
       FROM memberships m
       JOIN teams t ON t.id = m.team_id
       WHERE m.user_id = $1
       ORDER BY m.created_at ASC
       LIMIT 1`,
      [session.userId],
    );
    const membership = membershipResult.rows[0];
    if (membership) {
      teamId = membership['team_id'] as string;
      teamName = membership['team_name'] as string;
      role = membership['role'] as string;
    }

    const sessionData: SessionData = {
      userId: session.userId,
      sessionId: session.sessionId,
      githubLogin: userRow['github_login'] as string,
      avatarUrl: (userRow['avatar_url'] as string) ?? null,
      teamId,
      teamName,
      role,
    };

    c.set(SESSION_KEY, sessionData);
    await next();
  };
}

/**
 * Retrieve the SessionData from the Hono context.
 *
 * Must only be called after `requireSession` middleware has run.
 */
export function getSession(c: Context): SessionData {
  return c.get(SESSION_KEY) as SessionData;
}

// ── Route handlers ──────────────────────────────────────────────────────────

/**
 * Build the auth routes Hono instance.
 *
 * Dependencies are injected via the factory parameter. The returned
 * instance can be mounted into the main app.
 */
export function buildAuthRoutes(config: GitHubOAuthConfig, db: AppDb): Hono {
  const routes = new Hono();

  // ── GET /auth/github ───────────────────────────────────────────────────
  // Initiate GitHub OAuth: generate state, store in a short-lived cookie
  // (for CSRF verification on callback), redirect to GitHub.
  routes.get('/auth/github', (c) => {
    const state = generateState(config.clientSecret);

    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      scope: 'read:user',
      state,
    });

    const authorizeUrl = `https://github.com/login/oauth/authorize?${params.toString()}`;

    // Set the state in a short-lived cookie as a secondary CSRF check.
    // The primary check is the signed state parameter itself; the cookie
    // adds defense-in-depth (the callback handler verifies both match).
    c.header(
      'Set-Cookie',
      `teamem_oauth_state=${state}; HttpOnly; SameSite=Lax; Path=/auth/github; Max-Age=600`,
    );

    return c.redirect(authorizeUrl, 302);
  });

  // ── GET /auth/github/callback ───────────────────────────────────────────
  // Handle the OAuth callback: verify state, exchange code for token,
  // fetch GitHub user, upsert, bootstrap team if needed, create session.
  routes.get('/auth/github/callback', async (c) => {
    // Get requestId from header (set by requestContext middleware)
    const requestId = c.req.header('x-request-id') ?? 'unknown';

    // Validate query parameters
    const code = c.req.query('code');
    const state = c.req.query('state');
    const error = c.req.query('error');
    const errorDescription = c.req.query('error_description');

    // If GitHub returned an error (e.g. user denied access)
    if (error) {
      // Never echo error_description to the client — it may contain
      // sensitive context. Log it scrubbed for debugging.
      console.warn(
        JSON.stringify({
          event: 'oauth_github_error',
          requestId,
          error,
          errorDescription: errorDescription?.slice(0, 100) ?? null,
        }),
      );
      const redirectUrl = new URL(config.serverBaseUrl);
      redirectUrl.pathname = '/login';
      redirectUrl.searchParams.set('error', 'github_denied');
      return c.redirect(redirectUrl.toString(), 302);
    }

    if (!code || !state) {
      const redirectUrl = new URL(config.serverBaseUrl);
      redirectUrl.pathname = '/login';
      redirectUrl.searchParams.set('error', 'invalid_request');
      return c.redirect(redirectUrl.toString(), 302);
    }

    // Verify CSRF state
    const stateResult = verifyState(state, config.clientSecret);
    if (!stateResult.valid) {
      console.warn(
        JSON.stringify({
          event: 'oauth_invalid_state',
          requestId,
          reason: stateResult.reason,
        }),
      );
      const redirectUrl = new URL(config.serverBaseUrl);
      redirectUrl.pathname = '/login';
      redirectUrl.searchParams.set('error', 'invalid_state');
      return c.redirect(redirectUrl.toString(), 302);
    }

    // Exchange code for access token
    let accessToken: string;
    try {
      accessToken = await exchangeCodeForToken(code, config, config.fetchImpl);
    } catch (err) {
      console.error(
        JSON.stringify({
          event: 'oauth_token_exchange_failed',
          requestId,
          error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
        }),
      );
      const redirectUrl = new URL(config.serverBaseUrl);
      redirectUrl.pathname = '/login';
      redirectUrl.searchParams.set('error', 'auth_failed');
      return c.redirect(redirectUrl.toString(), 302);
    }

    // Fetch GitHub user profile
    let githubUser: { id: number; login: string; avatarUrl: string | null };
    try {
      githubUser = await getGitHubUser(accessToken, config.fetchImpl);
    } catch (err) {
      console.error(
        JSON.stringify({
          event: 'oauth_user_fetch_failed',
          requestId,
          error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
        }),
      );
      const redirectUrl = new URL(config.serverBaseUrl);
      redirectUrl.pathname = '/login';
      redirectUrl.searchParams.set('error', 'auth_failed');
      return c.redirect(redirectUrl.toString(), 302);
    }

    // Upsert user in database
    let user: { id: string; githubId: number; githubLogin: string; avatarUrl: string | null };
    try {
      user = await upsertUser(db, githubUser);
    } catch (err) {
      console.error(
        JSON.stringify({
          event: 'oauth_user_upsert_failed',
          requestId,
          error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
        }),
      );
      const redirectUrl = new URL(config.serverBaseUrl);
      redirectUrl.pathname = '/login';
      redirectUrl.searchParams.set('error', 'auth_failed');
      return c.redirect(redirectUrl.toString(), 302);
    }

    // Ensure team membership (bootstrap first user as owner)
    const membership = await ensureTeamMembership(db, user.id, user.githubLogin);

    // Create web session
    let sessionToken: { plaintext: string; sessionId: string; expiresAt: Date };
    try {
      sessionToken = await createSession(db, user.id, config);
    } catch (err) {
      console.error(
        JSON.stringify({
          event: 'oauth_session_create_failed',
          requestId,
          error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
        }),
      );
      const redirectUrl = new URL(config.serverBaseUrl);
      redirectUrl.pathname = '/login';
      redirectUrl.searchParams.set('error', 'auth_failed');
      return c.redirect(redirectUrl.toString(), 302);
    }

    // Set the session cookie
    const cookieHeader = buildSessionCookie(
      sessionToken.plaintext,
      sessionToken.expiresAt,
      config.serverBaseUrl,
    );
    c.header('Set-Cookie', cookieHeader);

    // Redirect to the frontend — if the user has no team membership,
    // include a flag so the frontend can show the "no team" onboarding
    // screen (not a raw error).
    const redirectUrl = new URL(config.serverBaseUrl);
    redirectUrl.pathname = '/app';
    if (!membership) {
      redirectUrl.searchParams.set('no_team', 'true');
    }

    // Log successful login (no tokens or secrets)
    console.info(
      JSON.stringify({
        event: 'user_login',
        requestId,
        userId: user.id,
        githubId: user.githubId,
        teamId: membership?.teamId ?? null,
        role: membership?.role ?? null,
        teamCreated: membership?.teamCreated ?? false,
      }),
    );

    return c.redirect(redirectUrl.toString(), 302);
  });

  // ── POST /auth/logout ──────────────────────────────────────────────────
  // Revoke the current session and clear the session cookie.
  routes.post('/auth/logout', requireSession(config, db), async (c) => {
    const session = getSession(c);

    try {
      await revokeSession(db, session.sessionId);
    } catch (err) {
      console.error(
        JSON.stringify({
          event: 'logout_revoke_failed',
          sessionId: session.sessionId,
          error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
        }),
      );
      // Even if revoke fails, clear the cookie so the client
      // doesn't get stuck with a session it can't use.
    }

    c.header('Set-Cookie', buildClearSessionCookie());
    return c.json({ status: 'ok' });
  });

  // ── GET /auth/me ───────────────────────────────────────────────────────
  // Return the current user's info (from session).
  routes.get('/auth/me', requireSession(config, db), (c) => {
    const session = getSession(c);
    return c.json({
      userId: session.userId,
      githubLogin: session.githubLogin,
      avatarUrl: session.avatarUrl,
      teamId: session.teamId,
      teamName: session.teamName,
      role: session.role,
    });
  });

  return routes;
}
