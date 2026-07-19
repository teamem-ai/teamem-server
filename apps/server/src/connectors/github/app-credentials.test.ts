/**
 * GitHub App credentials provider — unit tests (DUA-147 / M0-GH-07).
 *
 * Tests JWT generation, token exchange, caching, error handling, and
 * credential leak prevention. Uses a real RSA key pair so the JWT
 * signature is verifiable; the call to GitHub's token endpoint is mocked
 * via an injected fetch so the test never hits the real API.
 */
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createGitHubAppCredentialsProvider,
  __test,
  type GitHubAppCredentialsConfig,
} from './app-credentials.js';

// ── Test keypair (generated fresh per process — never a real credential) ────
const testKeyPair = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const validConfig: GitHubAppCredentialsConfig = {
  appId: '123456',
  installationId: '9876543',
  privateKey: testKeyPair.privateKey,
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Create a mock fetch that returns a valid token response. */
function mockTokenResponse(token: string, expiresAt: string): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ token, expires_at: expiresAt, permissions: {}, repository_selection: 'selected' }),
    text: async () => '',
  });
}

/** Expiry 1 hour from now (typical GitHub behaviour). */
function futureExpiry(offsetMs = 3600_000): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

// ── JWT generation ───────────────────────────────────────────────────────────

describe('generateAppJwt', () => {
  it('generates a valid JWT with three dot-separated segments', () => {
    const jwt = __test.generateAppJwt('123456', testKeyPair.privateKey);
    const segments = jwt.split('.');
    expect(segments).toHaveLength(3);

    // Header and payload should be parseable base64url JSON
    for (const seg of [segments[0]!, segments[1]!]) {
      const decoded = Buffer.from(seg, 'base64url').toString('utf-8');
      expect(() => JSON.parse(decoded)).not.toThrow();
    }
  });

  it('sets iss to the app ID', () => {
    const jwt = __test.generateAppJwt('789', testKeyPair.privateKey);
    const payloadB64 = jwt.split('.')[1]!;
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf-8'));
    expect(payload.iss).toBe('789');
  });

  it('sets iat in the past and exp in the future within valid ranges', () => {
    const now = Math.floor(Date.now() / 1000);
    const jwt = __test.generateAppJwt('123', testKeyPair.privateKey);
    const payloadB64 = jwt.split('.')[1]!;
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf-8'));

    expect(payload.iat).toBeLessThanOrEqual(now);
    expect(payload.iat).toBeGreaterThanOrEqual(now - 120); // at most 2 min ago
    expect(payload.exp).toBeGreaterThan(now);
    expect(payload.exp).toBeLessThanOrEqual(now + 600 + 120); // at most 12 min ahead
  });

  it('uses RS256 algorithm in the header', () => {
    const jwt = __test.generateAppJwt('123', testKeyPair.privateKey);
    const headerB64 = jwt.split('.')[0]!;
    const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf-8'));
    expect(header.alg).toBe('RS256');
    expect(header.typ).toBe('JWT');
  });

  it('produces structurally valid JWTs on consecutive calls', () => {
    const jwt1 = __test.generateAppJwt('1', testKeyPair.privateKey);
    const jwt2 = __test.generateAppJwt('1', testKeyPair.privateKey);

    // Both must be valid 3-segment JWTs
    expect(jwt1.split('.')).toHaveLength(3);
    expect(jwt2.split('.')).toHaveLength(3);

    // Both must have the same iss
    const p1 = JSON.parse(Buffer.from(jwt1.split('.')[1]!, 'base64url').toString('utf-8'));
    const p2 = JSON.parse(Buffer.from(jwt2.split('.')[1]!, 'base64url').toString('utf-8'));
    expect(p1.iss).toBe('1');
    expect(p2.iss).toBe('1');
  });

  it('throws on invalid private key', () => {
    expect(() => __test.generateAppJwt('1', 'not-a-valid-pem')).toThrow();
  });
});

// ── Token provider ───────────────────────────────────────────────────────────

describe('createGitHubAppCredentialsProvider', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = mockTokenResponse('ghs_test-token-123', futureExpiry());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('success paths', () => {
    it('exchanges a JWT for an installation token and returns it', async () => {
      const provider = createGitHubAppCredentialsProvider(validConfig, mockFetch);
      const token = await provider.getInstallationToken();

      expect(token).toBe('ghs_test-token-123');
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Verify the fetch call was to the correct endpoint
      const url = mockFetch.mock.calls[0]?.[0] as string;
      expect(url).toContain('/app/installations/9876543/access_tokens');
      expect(url).toContain('api.github.com');

      // Verify Authorization header is Bearer with a JWT
      const headers = mockFetch.mock.calls[0]?.[1]?.headers as Record<string, string>;
      const authHeader = headers?.['Authorization'] ?? '';
      expect(authHeader).toMatch(/^Bearer /);
      const jwt = authHeader.slice('Bearer '.length);
      expect(jwt.split('.')).toHaveLength(3);
    });

    it('caches the token and does not re-fetch on the next call', async () => {
      const provider = createGitHubAppCredentialsProvider(validConfig, mockFetch);

      const t1 = await provider.getInstallationToken();
      const t2 = await provider.getInstallationToken();

      expect(t1).toBe(t2);
      expect(mockFetch).toHaveBeenCalledTimes(1); // cached
    });

    it('refreshes the token when the cached one is within the expiry margin', async () => {
      // Token that expires in 2 minutes (within the 5-min margin)
      const shortExpiry = futureExpiry(120_000);
      mockFetch = mockTokenResponse('ghs_first', shortExpiry);

      const provider = createGitHubAppCredentialsProvider(validConfig, mockFetch);
      const t1 = await provider.getInstallationToken();
      expect(t1).toBe('ghs_first');

      // Reconfigure the mock to return a different token on the next call
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ token: 'ghs_second', expires_at: futureExpiry() }),
        text: async () => '',
      });

      const t2 = await provider.getInstallationToken();
      expect(t2).toBe('ghs_second');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('refreshes if expiry is in the past', async () => {
      // Already-expired token from the mock
      mockFetch = mockTokenResponse('ghs_expired', new Date(Date.now() - 1000).toISOString());
      const provider = createGitHubAppCredentialsProvider(validConfig, mockFetch);
      const token = await provider.getInstallationToken();
      expect(token).toBe('ghs_expired');
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Second call must re-fetch because first token was already expired
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ token: 'ghs_fresh', expires_at: futureExpiry() }),
        text: async () => '',
      });
      const token2 = await provider.getInstallationToken();
      expect(token2).toBe('ghs_fresh');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('failure paths', () => {
    it('throws on 401 from GitHub (bad credentials)', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ message: 'Bad credentials' }),
        text: async () => '{"message":"Bad credentials"}',
      });

      const provider = createGitHubAppCredentialsProvider(validConfig, mockFetch);
      await expect(provider.getInstallationToken()).rejects.toThrow(
        /token exchange failed.*401/,
      );
    });

    it('throws on 403 from GitHub (permission denied)', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({ message: 'Forbidden' }),
        text: async () => '{"message":"Forbidden"}',
      });

      const provider = createGitHubAppCredentialsProvider(validConfig, mockFetch);
      await expect(provider.getInstallationToken()).rejects.toThrow(
        /token exchange failed.*403/,
      );
    });

    it('throws on unexpected response shape (missing token)', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ unexpected: 'shape' }),
        text: async () => '',
      });

      const provider = createGitHubAppCredentialsProvider(validConfig, mockFetch);
      await expect(provider.getInstallationToken()).rejects.toThrow(
        /unexpected shape/,
      );
    });

    it('throws on unparseable expires_at', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ token: 'ghs_xxx', expires_at: 'not-a-date' }),
        text: async () => '',
      });

      const provider = createGitHubAppCredentialsProvider(validConfig, mockFetch);
      await expect(provider.getInstallationToken()).rejects.toThrow(
        /unparseable expires_at/,
      );
    });

    it('throws on network failure', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

      const provider = createGitHubAppCredentialsProvider(validConfig, mockFetch);
      await expect(provider.getInstallationToken()).rejects.toThrow(
        /token exchange failed/,
      );
    });
  });

  describe('credential leak prevention', () => {
    it('never includes private key or token in error messages', async () => {
      // Force a failure with the private key present in config
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });

      const provider = createGitHubAppCredentialsProvider(validConfig, mockFetch);
      let error: Error | null = null;
      try {
        await provider.getInstallationToken();
      } catch (e) {
        error = e as Error;
      }

      expect(error).not.toBeNull();
      const msg = error!.message;
      // The private key must not appear in the error
      expect(msg).not.toContain(testKeyPair.privateKey);
      expect(msg).not.toContain('BEGIN PRIVATE KEY');
      expect(msg).not.toContain('BEGIN RSA PRIVATE KEY');
    });

    it('does not log the JWT or token through error paths', async () => {
      // Force HTTP failure after the JWT has been generated
      mockFetch.mockRejectedValue(new Error('Connection reset'));

      const provider = createGitHubAppCredentialsProvider(validConfig, mockFetch);
      let error: Error | null = null;
      try {
        await provider.getInstallationToken();
      } catch (e) {
        error = e as Error;
      }

      expect(error).not.toBeNull();
      // The error is from fetch, so it shouldn't contain JWT data
      // (the JWT lives only in the closure, never serialized to error)
      expect(error!.message).not.toContain('eyJ'); // JWT prefix
    });
  });
});

// ── base64url encoding ───────────────────────────────────────────────────────

describe('base64url', () => {
  it('encodes without padding, +, or /', () => {
    const result = __test.base64url(Buffer.from('test+/='));
    expect(result).not.toContain('=');
    expect(result).not.toContain('+');
    expect(result).not.toContain('/');
  });

  it('round-trips correctly', () => {
    const input = JSON.stringify({ hello: 'world', num: 42 });
    const encoded = __test.base64url(Buffer.from(input, 'utf-8'));
    const decoded = Buffer.from(encoded, 'base64url').toString('utf-8');
    expect(decoded).toBe(input);
  });
});

// ── Token expiry margin ──────────────────────────────────────────────────────

describe('TOKEN_EXPIRY_MARGIN_MS', () => {
  it('is a positive number (5 minutes)', () => {
    expect(__test.TOKEN_EXPIRY_MARGIN_MS).toBeGreaterThan(0);
    expect(__test.TOKEN_EXPIRY_MARGIN_MS).toBe(5 * 60_000);
  });
});
