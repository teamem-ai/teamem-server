/**
 * GitHub OAuth login — user-to-server flow using the SAME GitHub App
 * that powers ingestion (not a separate OAuth App).
 *
 * Flow:
 *   1. GET /auth/github → redirect to github.com/login/oauth/authorize
 *   2. GitHub redirects back with ?code=...&state=...
 *   3. POST /login/oauth/access_token to exchange code for access token
 *   4. GET /user with the access token to fetch GitHub identity
 *   5. Upsert users row (github_id is the stable key)
 *   6. Create web session → set httpOnly cookie
 *   7. If no teams exist, bootstrap team + owner membership
 *
 * Security invariants:
 *   - State parameter is cryptographically signed (HMAC-SHA256) with
 *     client secret and carries an expiry; forged/expired state is rejected.
 *   - Access tokens and client secrets are NEVER logged or returned in
 *     responses.
 *   - The session token is stored as an irreversible SHA-256 hash; the
 *     plaintext is returned once in the Set-Cookie header and never again.
 *   - Session cookies are httpOnly, Secure (when not localhost), and
 *     SameSite=Lax.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { AppDb } from '../db/client.js';

// ── Constants ───────────────────────────────────────────────────────────────

const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_USER_API = 'https://api.github.com/user';

/** CSRF state expires after 10 minutes. */
const STATE_EXPIRY_MS = 10 * 60_000;

/** Session token: 256-bit entropy (same as API keys). */
const SESSION_TOKEN_BYTES = 32;

/** Default session lifetime: 7 days. */
const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Cookie name for the web session. */
const SESSION_COOKIE = 'teamem_session';

/** HMAC key for session token hashing (server-side secret, not exposed). */
const SESSION_HMAC_KEY = 'teamem-session';

// ── Config ──────────────────────────────────────────────────────────────────

export interface GitHubOAuthConfig {
  /** OAuth Client ID from the GitHub App settings. */
  readonly clientId: string;
  /** OAuth Client Secret from the GitHub App settings. */
  readonly clientSecret: string;
  /**
   * Callback URL registered with the GitHub App.
   * Defaults to `${serverBaseUrl}/auth/github/callback`.
   */
  readonly redirectUri: string;
  /** Server base URL (e.g. http://localhost:8080) — used for cookie domain decisions. */
  readonly serverBaseUrl: string;
  /** Session TTL override (default: 7 days). */
  readonly sessionTtlMs?: number;
  /** Injection seam for tests: override the fetch implementation. */
  readonly fetchImpl?: typeof fetch;
}

// ── State token (CSRF) ─────────────────────────────────────────────────────

/**
 * Generate a signed, expiring state token for OAuth CSRF protection.
 *
 * Format: `${random}.${expiresAtEpochMs}.${hmacSignature}`
 * where hmacSignature = HMAC-SHA256(clientSecret, `${random}.${expiresAtEpochMs}`)
 *
 * The client secret is used as the HMAC key so only this server can
 * create and verify state tokens (the secret never leaves the server).
 */
export function generateState(clientSecret: string): string {
  const random = randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + STATE_EXPIRY_MS;
  const payload = `${random}.${expiresAt}`;
  const hmac = createHmac('sha256', clientSecret).update(payload).digest('base64url');
  return `${payload}.${hmac}`;
}

/**
 * Verify a state token returned from GitHub's callback.
 *
 * Returns `{ valid: true }` on success, or `{ valid: false, reason }` on
 * any failure (expired, malformed, HMAC mismatch). Uses timing-safe
 * comparison for the HMAC to prevent timing attacks.
 *
 * The caller must NEVER distinguish between failure reasons in the HTTP
 * response — always return the same generic "invalid state" error.
 */
export function verifyState(
  state: string,
  clientSecret: string,
): { valid: true } | { valid: false; reason: string } {
  const parts = state.split('.');
  if (parts.length !== 3) {
    return { valid: false, reason: 'malformed state' };
  }

  const [random, expiresAtStr, signature] = parts;
  if (!random || !expiresAtStr || !signature) {
    return { valid: false, reason: 'malformed state' };
  }

  // Check expiry
  const expiresAt = Number(expiresAtStr);
  if (!Number.isSafeInteger(expiresAt) || expiresAt < Date.now()) {
    return { valid: false, reason: 'expired state' };
  }

  // Verify HMAC (timing-safe)
  const payload = `${random}.${expiresAtStr}`;
  const expectedSig = createHmac('sha256', clientSecret).update(payload).digest('base64url');

  const sigBuf = Buffer.from(signature, 'utf-8');
  const expectedBuf = Buffer.from(expectedSig, 'utf-8');

  if (sigBuf.length !== expectedBuf.length) {
    return { valid: false, reason: 'invalid state' };
  }

  if (!timingSafeEqual(sigBuf, expectedBuf)) {
    return { valid: false, reason: 'invalid state' };
  }

  return { valid: true };
}

// ── GitHub API interaction ──────────────────────────────────────────────────

/**
 * Zod schema for the GitHub access token response.
 * Cross-boundary input — must be validated before any field is read.
 */
const githubTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string(),
  scope: z.string(),
}).passthrough();

/**
 * Exchange an OAuth authorization code for an access token.
 *
 * POSTs to https://github.com/login/oauth/access_token with the code,
 * client_id, client_secret, and redirect_uri. Returns the parsed
 * access token response.
 *
 * SECURITY: The client secret is sent in the POST body (not URL query
 * string) over HTTPS. It is never logged or returned in a response.
 */
export async function exchangeCodeForToken(
  code: string,
  config: GitHubOAuthConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    redirect_uri: config.redirectUri,
  });

  let response: Response;
  try {
    response = await fetchImpl(GITHUB_TOKEN_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });
  } catch (err) {
    throw new Error(
      `GitHub token exchange failed (network): ${String(err).slice(0, 200)}`,
    );
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(
      `GitHub token exchange failed (${response.status}): ${text.slice(0, 200)}`,
    );
  }

  const rawData: unknown = await response.json();
  const parsed = githubTokenResponseSchema.safeParse(rawData);
  if (!parsed.success) {
    // Do NOT include raw response body in error — it may contain a token.
    const issueMessages = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(
      `GitHub token exchange returned an unexpected shape: ${issueMessages}`.slice(0, 300),
    );
  }

  // The access token itself must never be logged.
  return parsed.data.access_token;
}

/**
 * Zod schema for the GitHub /user response.
 * We only extract the fields we need — everything else is ignored.
 */
const githubUserSchema = z.object({
  id: z.number().int().positive(),
  login: z.string().min(1),
  avatar_url: z.string().url().optional().nullable(),
}).passthrough();

export interface GitHubUser {
  id: number;
  login: string;
  avatarUrl: string | null;
}

/**
 * Fetch the authenticated GitHub user's profile.
 *
 * GET /user with the access token in the Authorization header.
 * Returns the user's numeric id, login, and avatar URL.
 *
 * SECURITY: The access token is sent as a Bearer token over HTTPS.
 * It is never logged. The response is validated against a Zod schema
 * before any field is read.
 */
export async function getGitHubUser(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GitHubUser> {
  let response: Response;
  try {
    response = await fetchImpl(GITHUB_USER_API, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${accessToken}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
  } catch (err) {
    throw new Error(
      `GitHub user fetch failed (network): ${String(err).slice(0, 200)}`,
    );
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(
      `GitHub user fetch failed (${response.status}): ${text.slice(0, 200)}`,
    );
  }

  const rawData: unknown = await response.json();
  const parsed = githubUserSchema.safeParse(rawData);
  if (!parsed.success) {
    const issueMessages = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(
      `GitHub user API returned an unexpected shape: ${issueMessages}`.slice(0, 300),
    );
  }

  return {
    id: parsed.data.id,
    login: parsed.data.login,
    avatarUrl: parsed.data.avatar_url ?? null,
  };
}

// ── Database operations ─────────────────────────────────────────────────────

export interface UpsertedUser {
  id: string;
  githubId: number;
  githubLogin: string;
  avatarUrl: string | null;
  createdAt: Date;
}

/**
 * Upsert a GitHub-authenticated user.
 *
 * If a user with the given github_id already exists, their github_login
 * and avatar_url are updated (GitHub logins can be renamed).
 * Otherwise a new user row is created.
 *
 * Uses PostgreSQL ON CONFLICT ... DO UPDATE for atomic upsert.
 */
export async function upsertUser(
  db: AppDb,
  githubUser: GitHubUser,
): Promise<UpsertedUser> {
  const id = `usr_${randomBytes(12).toString('hex')}`;

  const result = await db.$client.query(
    `INSERT INTO users (id, github_id, github_login, avatar_url)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (github_id)
     DO UPDATE SET github_login = EXCLUDED.github_login,
                   avatar_url = EXCLUDED.avatar_url
     RETURNING id, github_id, github_login, avatar_url, created_at`,
    [id, githubUser.id, githubUser.login, githubUser.avatarUrl],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error('Failed to upsert user: no row returned');
  }

  return {
    id: row['id'] as string,
    githubId: row['github_id'] as number,
    githubLogin: row['github_login'] as string,
    avatarUrl: (row['avatar_url'] as string) ?? null,
    createdAt: row['created_at'] as Date,
  };
}

// ── Session management ──────────────────────────────────────────────────────

export interface SessionToken {
  /** The plaintext session token (returned once in the Set-Cookie header). */
  plaintext: string;
  /** SHA-256 hash of the plaintext token (stored in web_sessions.token_hash). */
  hash: string;
  /** The session row ID. */
  sessionId: string;
  /** When the session expires. */
  expiresAt: Date;
}

/**
 * Generate a session token (plaintext + hash) for a new web session.
 *
 * The plaintext is a high-entropy random string returned to the client
 * exactly once. The hash is stored in the database. The plaintext is
 * NEVER logged or persisted.
 */
export function generateSessionToken(): { plaintext: string; hash: string } {
  const plaintext = randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
  const hash = createHmac('sha256', SESSION_HMAC_KEY).update(plaintext).digest('hex');
  return { plaintext, hash };
}

/**
 * Create a new web session for a user.
 *
 * Inserts a row into web_sessions with the token hash and expiry.
 * Returns the session metadata including the plaintext token (for the
 * Set-Cookie header) — the caller must NEVER log this value.
 */
export async function createSession(
  db: AppDb,
  userId: string,
  config: GitHubOAuthConfig,
): Promise<SessionToken> {
  const { plaintext, hash } = generateSessionToken();
  const now = new Date();
  const ttl = config.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const expiresAt = new Date(now.getTime() + ttl);
  const sessionId = `ses_${randomBytes(12).toString('hex')}`;

  await db.$client.query(
    `INSERT INTO web_sessions (id, user_id, token_hash, issued_at, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [sessionId, userId, hash, now.toISOString(), expiresAt.toISOString()],
  );

  return { plaintext, hash, sessionId, expiresAt };
}

/**
 * Verify a session token and return the user it belongs to.
 *
 * Looks up the token hash in web_sessions, checks it has not expired
 * or been revoked. Returns the user row on success, null otherwise.
 *
 * SECURITY: Expired, revoked, and unknown tokens all return null —
 * callers must return the same 401 response for all three cases.
 */
export async function verifySession(
  db: AppDb,
  sessionPlaintext: string,
): Promise<{ userId: string; sessionId: string } | null> {
  const hash = createHmac('sha256', SESSION_HMAC_KEY).update(sessionPlaintext).digest('hex');

  const result = await db.$client.query(
    `SELECT ws.id, ws.user_id, ws.expires_at, ws.revoked_at
     FROM web_sessions ws
     WHERE ws.token_hash = $1`,
    [hash],
  );

  const row = result.rows[0];
  if (!row) {
    return null; // Unknown token
  }

  // Check revoked
  if (row['revoked_at'] !== null) {
    return null;
  }

  // Check expiry
  const expiresAt = row['expires_at'] as unknown as Date;
  if (expiresAt < new Date()) {
    return null;
  }

  return {
    userId: row['user_id'] as string,
    sessionId: row['id'] as string,
  };
}

/**
 * Revoke a web session by setting its revoked_at timestamp.
 *
 * After this call, the session token becomes immediately invalid.
 * Idempotent — calling on an already-revoked session is a no-op.
 */
export async function revokeSession(
  db: AppDb,
  sessionId: string,
): Promise<void> {
  await db.$client.query(
    `UPDATE web_sessions SET revoked_at = $1 WHERE id = $2 AND revoked_at IS NULL`,
    [new Date().toISOString(), sessionId],
  );
}

// ── Bootstrap: first user becomes team owner ────────────────────────────────

export interface BootstrapResult {
  /** The team this user belongs to (may be newly created). */
  teamId: string;
  teamName: string;
  /** The user's role in the team. */
  role: string;
  /** True if a new team was created (first user scenario). */
  teamCreated: boolean;
}

/**
 * Ensure a user has team membership.
 *
 * - If no teams exist at all: create a new team and add the user as owner.
 * - If teams exist but the user has no membership: return null (the user
 *   is not yet a member of any team — they must be invited).
 * - If the user already has a membership: return the team info.
 *
 * The team name for the first team is derived from the user's GitHub login.
 */
export async function ensureTeamMembership(
  db: AppDb,
  userId: string,
  githubLogin: string,
): Promise<BootstrapResult | null> {
  // Check if any teams exist
  const teamCount = await db.$client.query(`SELECT COUNT(*) as count FROM teams`);
  const count = Number(teamCount.rows[0]?.['count'] ?? 0);

  if (count === 0) {
    // Bootstrap: create first team with the user as owner
    const teamId = `team_${randomBytes(8).toString('hex')}`;
    const teamName = `${githubLogin}'s Team`;

    await db.$client.query(
      `INSERT INTO teams (id, name) VALUES ($1, $2)`,
      [teamId, teamName],
    );

    await db.$client.query(
      `INSERT INTO memberships (user_id, team_id, role) VALUES ($1, $2, 'owner')`,
      [userId, teamId],
    );

    return { teamId, teamName, role: 'owner', teamCreated: true };
  }

  // Check existing membership
  const membershipResult = await db.$client.query(
    `SELECT m.team_id, m.role, t.name as team_name
     FROM memberships m
     JOIN teams t ON t.id = m.team_id
     WHERE m.user_id = $1
     ORDER BY m.created_at ASC
     LIMIT 1`,
    [userId],
  );

  const membership = membershipResult.rows[0];
  if (membership) {
    return {
      teamId: membership['team_id'] as string,
      teamName: membership['team_name'] as string,
      role: membership['role'] as string,
      teamCreated: false,
    };
  }

  // User exists but has no team membership — needs invitation
  return null;
}

// ── Cookie helpers ──────────────────────────────────────────────────────────

/**
 * Build the Set-Cookie header value for the session cookie.
 *
 * The cookie is:
 * - httpOnly: prevents JavaScript access (XSS protection)
 * - Secure: only sent over HTTPS (disabled for localhost)
 * - SameSite=Lax: sent on top-level navigations (GET requests)
 *   but NOT on cross-site POSTs (CSRF protection)
 * - Path=/: available to all routes
 * - Expires: matches the session expiry
 */
export function buildSessionCookie(
  token: string,
  expiresAt: Date,
  serverBaseUrl: string,
): string {
  const isLocalhost =
    serverBaseUrl.startsWith('http://localhost') ||
    serverBaseUrl.startsWith('http://127.0.0.1') ||
    serverBaseUrl.startsWith('http://[::1]');

  const parts: string[] = [
    `${SESSION_COOKIE}=${token}`,
    'HttpOnly',
    'SameSite=Lax',
    `Path=/`,
    `Expires=${expiresAt.toUTCString()}`,
  ];

  if (!isLocalhost) {
    parts.push('Secure');
  }

  return parts.join('; ');
}

/**
 * Build the Set-Cookie header to clear the session cookie (logout).
 */
export function buildClearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

/**
 * Extract the session token from the request cookies.
 */
export function parseSessionCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;

  // Parse cookies: split by ';', trim whitespace, find the session cookie
  const cookies = cookieHeader.split(';').map((c) => c.trim());
  for (const cookie of cookies) {
    const [name, ...valueParts] = cookie.split('=');
    if (name?.trim() === SESSION_COOKIE) {
      const value = valueParts.join('=').trim();
      return value || null;
    }
  }

  return null;
}

// ── Re-exports for testing ──────────────────────────────────────────────────

export const SESSION_COOKIE_NAME = SESSION_COOKIE;
export const __test = {
  STATE_EXPIRY_MS,
  SESSION_TOKEN_BYTES,
  DEFAULT_SESSION_TTL_MS,
};
