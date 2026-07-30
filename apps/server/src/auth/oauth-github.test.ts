/**
 * Unit tests for GitHub OAuth login module.
 *
 * Tests the pure-logic functions without real database or network:
 * - CSRF state generation and verification
 * - Session token generation
 * - Cookie parsing and construction
 * - State verification edge cases (expired, malformed, HMAC mismatch)
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  generateState,
  verifyState,
  generateSessionToken,
  parseSessionCookie,
  parseOAuthStateCookie,
  buildSessionCookie,
  buildClearSessionCookie,
  SESSION_COOKIE_NAME,
  OAUTH_STATE_COOKIE_NAME,
} from '../auth/oauth-github.js';

const CLIENT_SECRET = 'test_client_secret_for_hmac';

// ── State token (CSRF) ─────────────────────────────────────────────────────

describe('generateState', () => {
  it('produces a state string with three dot-separated parts', () => {
    const state = generateState(CLIENT_SECRET);
    const parts = state.split('.');
    expect(parts).toHaveLength(3);
    // Each part is non-empty base64url
    for (const part of parts) {
      expect(part.length).toBeGreaterThan(0);
    }
  });

  it('produces different state tokens on each call', () => {
    const s1 = generateState(CLIENT_SECRET);
    const s2 = generateState(CLIENT_SECRET);
    expect(s1).not.toBe(s2);
  });
});

describe('verifyState', () => {
  it('accepts a freshly generated state token', () => {
    const state = generateState(CLIENT_SECRET);
    expect(verifyState(state, CLIENT_SECRET)).toEqual({ valid: true });
  });

  it('rejects a state token with a different client secret', () => {
    const state = generateState(CLIENT_SECRET);
    const result = verifyState(state, 'different_secret');
    expect(result.valid).toBe(false);
    expect((result as { reason: string }).reason).toBe('invalid state');
  });

  it('rejects a malformed state token (wrong number of parts)', () => {
    expect(verifyState('only.two', CLIENT_SECRET).valid).toBe(false);
    expect(verifyState('one', CLIENT_SECRET).valid).toBe(false);
    expect(verifyState('one.two.three.four', CLIENT_SECRET).valid).toBe(false);
  });

  it('rejects an empty state token', () => {
    expect(verifyState('', CLIENT_SECRET).valid).toBe(false);
    expect(verifyState('..', CLIENT_SECRET).valid).toBe(false);
  });

  it('rejects a state token with an expired timestamp', () => {
    // Create a state that expired 1 hour ago
    const random = 'testrandom';
    const pastExpiry = Date.now() - 3600_000; // 1 hour ago
    const payload = `${random}.${pastExpiry}`;
    const sig = createHmac('sha256', CLIENT_SECRET).update(payload).digest('base64url');
    const expiredState = `${payload}.${sig}`;

    const result = verifyState(expiredState, CLIENT_SECRET);
    expect(result.valid).toBe(false);
    expect((result as { reason: string }).reason).toBe('expired state');
  });

  it('rejects a tampered state (modified random part)', () => {
    const state = generateState(CLIENT_SECRET);
    const parts = state.split('.');
    // Append a character to the random part to break the HMAC
    const tamperedRandom = parts[0]! + 'X';
    const tamperedState = `${tamperedRandom}.${parts[1]}.${parts[2]}`;

    const result = verifyState(tamperedState, CLIENT_SECRET);
    expect(result.valid).toBe(false);
    expect((result as { reason: string }).reason).toBe('invalid state');
  });

  it('rejects a tampered state (modified expiry)', () => {
    const state = generateState(CLIENT_SECRET);
    const parts = state.split('.');
    const farFuture = (Date.now() + 999_999_999).toString();
    const tamperedState = `${parts[0]}.${farFuture}.${parts[2]}`;

    const result = verifyState(tamperedState, CLIENT_SECRET);
    expect(result.valid).toBe(false);
  });
});

// ── Session token ───────────────────────────────────────────────────────────

describe('generateSessionToken', () => {
  it('produces a plaintext token and hash', () => {
    const { plaintext, hash } = generateSessionToken();
    expect(plaintext).toBeTruthy();
    expect(plaintext.length).toBeGreaterThanOrEqual(32);
    expect(hash).toBeTruthy();
    // Hash should be hex (all hex characters)
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  it('produces different tokens on each call', () => {
    const t1 = generateSessionToken();
    const t2 = generateSessionToken();
    expect(t1.plaintext).not.toBe(t2.plaintext);
    expect(t1.hash).not.toBe(t2.hash);
  });
});

// ── Cookie parsing ──────────────────────────────────────────────────────────

describe('parseOAuthStateCookie', () => {
  it('extracts the OAuth state from a cookie header', () => {
    const cookie = `${OAUTH_STATE_COOKIE_NAME}=statevalue123; OtherCookie=xyz`;
    expect(parseOAuthStateCookie(cookie)).toBe('statevalue123');
  });

  it('returns null when header is null', () => {
    expect(parseOAuthStateCookie(null)).toBeNull();
  });

  it('returns null when state cookie is not present', () => {
    expect(parseOAuthStateCookie('OtherCookie=value; Another=123')).toBeNull();
  });

  it('returns null when state cookie value is empty', () => {
    expect(parseOAuthStateCookie(`${OAUTH_STATE_COOKIE_NAME}=`)).toBeNull();
  });
});

describe('parseSessionCookie', () => {
  it('extracts the session token from a cookie header', () => {
    const cookie = `${SESSION_COOKIE_NAME}=abc123def456; OtherCookie=value`;
    expect(parseSessionCookie(cookie)).toBe('abc123def456');
  });

  it('returns null when header is null', () => {
    expect(parseSessionCookie(null)).toBeNull();
  });

  it('returns null when session cookie is not present', () => {
    expect(parseSessionCookie('OtherCookie=value; Another=123')).toBeNull();
  });

  it('extracts token when session cookie is last', () => {
    const cookie = `A=1; ${SESSION_COOKIE_NAME}=mytoken`;
    expect(parseSessionCookie(cookie)).toBe('mytoken');
  });

  it('returns null when session cookie value is empty', () => {
    expect(parseSessionCookie(`${SESSION_COOKIE_NAME}=`)).toBeNull();
    expect(parseSessionCookie(`${SESSION_COOKIE_NAME}=; B=1`)).toBeNull();
  });
});

// ── Cookie construction ─────────────────────────────────────────────────────

describe('buildSessionCookie', () => {
  it('sets HttpOnly, SameSite=Lax, Path=/, and Expires', () => {
    const expires = new Date('2027-01-01T00:00:00Z');
    const cookie = buildSessionCookie('token123', expires, 'https://example.com');
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=token123`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('Expires=');
  });

  it('omits Secure flag for localhost', () => {
    const expires = new Date('2027-01-01T00:00:00Z');
    const cookie = buildSessionCookie('token123', expires, 'http://localhost:8080');
    expect(cookie).not.toContain('Secure');
  });

  it('omits Secure flag for 127.0.0.1', () => {
    const expires = new Date('2027-01-01T00:00:00Z');
    const cookie = buildSessionCookie('token123', expires, 'http://127.0.0.1:3000');
    expect(cookie).not.toContain('Secure');
  });
});

describe('buildClearSessionCookie', () => {
  it('sets Max-Age=0 to clear the cookie', () => {
    const cookie = buildClearSessionCookie();
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(cookie).toContain('Max-Age=0');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
  });
});
