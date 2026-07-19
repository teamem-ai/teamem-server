/**
 * GitHub App credentials provider — configuration-driven installation token flow
 * (DUA-147 / M0-GH-07).
 *
 * Generates a short-lived JWT signed with the App's RSA private key, exchanges
 * it for an installation access token via the GitHub API, and caches the token
 * until it expires. Every call to `getInstallationToken()` returns a fresh
 * token when the cached one is expired or about to expire.
 *
 * Design:
 *   - All credential material comes from configuration (never hard-coded).
 *   - The JWT is generated using Node.js built-in `crypto` (no third-party JWT
 *     library) — RS256 signing, standard header/payload, base64url-encoded.
 *   - Token caching respects the `expires_at` returned by GitHub (typically
 *     1 hour); a 5-minute safety margin prevents using a token that expires
 *     mid-request.
 *   - Credentials never appear in logs, error messages, or stack traces
 *     (red line: AGENTS.md §5.3).
 *
 * GitHub App auth flow (documented at docs.github.com):
 *   1. Generate a JWT: header { alg: 'RS256', typ: 'JWT' }, payload
 *      { iat: now-60, exp: now+600, iss: appId }.
 *   2. POST /app/installations/{installation_id}/access_tokens with the JWT.
 *   3. Receive { token, expires_at, permissions, repository_selection }.
 */

import { createSign, createPrivateKey } from 'node:crypto';

// ── Configuration ────────────────────────────────────────────────────────────

/**
 * Credentials a GitHub App installation needs. All fields come from the App's
 * settings page and the installation's configuration page on github.com.
 */
export interface GitHubAppCredentialsConfig {
  /** GitHub App numeric ID (e.g. 123456). */
  readonly appId: string;
  /** Installation ID for the target org/user (e.g. 9876543). */
  readonly installationId: string;
  /**
   * RSA private key in PEM format (-----BEGIN RSA PRIVATE KEY-----...).
   * The key must be the one generated when the GitHub App was created.
   */
  readonly privateKey: string;
}

// ── JWT generation ───────────────────────────────────────────────────────────

/** Base64url-encode a Buffer (RFC 7515 Appendix C). */
function base64url(buffer: Buffer): string {
  return buffer
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/**
 * Generate a GitHub App JWT signed with the App's RSA private key.
 *
 * The JWT is valid for 10 minutes (GitHub's maximum) with a 60-second clock
 * skew allowance in the past (`iat` is set 60 seconds ago). `iss` is the
 * App ID.
 */
function generateAppJwt(appId: string, privateKeyPem: string): string {
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iat: now - 60, // 60-second clock skew allowance
    exp: now + 600, // 10-minute maximum validity
    iss: appId,
  };

  const headerB64 = base64url(Buffer.from(JSON.stringify(header), 'utf-8'));
  const payloadB64 = base64url(Buffer.from(JSON.stringify(payload), 'utf-8'));
  const signingInput = `${headerB64}.${payloadB64}`;

  const privateKey = createPrivateKey(privateKeyPem);
  const sign = createSign('RSA-SHA256');
  sign.update(signingInput);
  sign.end();
  const signature = sign.sign(privateKey);
  const signatureB64 = base64url(signature);

  return `${signingInput}.${signatureB64}`;
}

// ── Token exchange ──────────────────────────────────────────────────────────

const GITHUB_API_BASE = 'https://api.github.com';

/** GitHub's response from POST /app/installations/{id}/access_tokens */
interface InstallationTokenResponse {
  token: string;
  expires_at: string; // ISO 8601 UTC
  permissions?: Record<string, string>;
  repository_selection?: string;
}

/**
 * Exchange a JWT for an installation access token.
 *
 * Makes a POST to `https://api.github.com/app/installations/{id}/access_tokens`
 * and returns the token with its expiry. Throws on non-2xx responses (the
 * caller decides whether to retry).
 */
async function exchangeJwtForToken(
  jwt: string,
  installationId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<InstallationTokenResponse> {
  const url = `${GITHUB_API_BASE}/app/installations/${encodeURIComponent(installationId)}/access_tokens`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${jwt}`,
      },
    });
  } catch (err) {
    throw new Error(
      `GitHub App token exchange failed (network): ${String(err).slice(0, 200)}`,
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `GitHub App token exchange failed (${response.status}): ${body.slice(0, 200)}`,
    );
  }

  const data = (await response.json()) as InstallationTokenResponse;
  if (typeof data.token !== 'string' || typeof data.expires_at !== 'string') {
    throw new Error(
      `GitHub App token exchange returned an unexpected shape: ${JSON.stringify(data).slice(0, 200)}`,
    );
  }
  return data;
}

// ── Token cache ─────────────────────────────────────────────────────────────

/**
 * How long before the token's actual expiry to consider it expired.
 * 5 minutes = conservative; GitHub tokens are typically valid 1 hour, so
 * effectively we use each token for at most 55 minutes.
 */
const TOKEN_EXPIRY_MARGIN_MS = 5 * 60_000;

interface CachedToken {
  token: string;
  expiresAt: number; // epoch ms — the time after which we must NOT use this token
}

/**
 * GitHub App installation token provider with in-memory caching.
 *
 * Usage:
 *   const provider = createGitHubAppCredentialsProvider(config);
 *   const token = await provider.getInstallationToken();
 *   // use token.Bearer for Authorization header
 *
 * The provider is NOT a class to keep the surface minimal and testable
 * (all dependencies are explicit parameters).
 */
export interface GitHubAppCredentialsProvider {
  /**
   * Get a valid installation access token, refreshing if necessary.
   * The returned value is safe to log after scrubbing (the caller must never
   * log the raw token string).
   */
  getInstallationToken(): Promise<string>;
}

export function createGitHubAppCredentialsProvider(
  config: GitHubAppCredentialsConfig,
  fetchImpl: typeof fetch = fetch,
): GitHubAppCredentialsProvider {
  let cached: CachedToken | null = null;

  async function refreshToken(): Promise<string> {
    const jwt = generateAppJwt(config.appId, config.privateKey);
    const response = await exchangeJwtForToken(jwt, config.installationId, fetchImpl);

    const expiresAtMs = new Date(response.expires_at).getTime();
    if (Number.isNaN(expiresAtMs)) {
      throw new Error(
        `GitHub App token exchange returned an unparseable expires_at: ${response.expires_at}`,
      );
    }

    cached = {
      token: response.token,
      expiresAt: expiresAtMs,
    };
    return response.token;
  }

  return {
    async getInstallationToken(): Promise<string> {
      const now = Date.now();
      if (cached && now < cached.expiresAt - TOKEN_EXPIRY_MARGIN_MS) {
        return cached.token;
      }
      return refreshToken();
    },
  };
}

// ── Re-exports for testing ──────────────────────────────────────────────────

export const __test = {
  generateAppJwt,
  exchangeJwtForToken,
  base64url,
  TOKEN_EXPIRY_MARGIN_MS,
};
