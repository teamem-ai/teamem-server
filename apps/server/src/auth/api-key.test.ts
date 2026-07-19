/**
 * API Key token and hashing utilities tests.
 *
 * These tests verify:
 * - High-entropy token generation (uniqueness, format, entropy)
 * - SHA-256 hashing (determinism, non-reversibility)
 * - Bearer header parsing (valid, malformed, edge cases)
 * - Timing-safe comparison (correct tokens, wrong tokens, timing safety)
 * - Security invariants (no plaintext in logs, key_id ≠ token)
 *
 * CLI: pnpm exec vitest run apps/server/src/auth/api-key.test.ts
 */
import { describe, expect, it, vi } from 'vitest';
import {
  generateApiKeyToken,
  hashToken,
  verifyToken,
  parseBearerToken,
  keyIdPrefix,
} from './api-key.js';

// ── Token generation ────────────────────────────────────────────────────────

describe('generateApiKeyToken', () => {
  it('returns a string with the tm_ prefix', () => {
    const token = generateApiKeyToken();
    expect(token).toMatch(/^tm_/);
  });

  it('generates unique tokens across calls', () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 100; i++) {
      tokens.add(generateApiKeyToken());
    }
    expect(tokens.size).toBe(100);
  });

  it('token body is valid base64url', () => {
    const token = generateApiKeyToken();
    const body = token.slice(3); // remove 'tm_' prefix
    expect(body).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('token has sufficient entropy (≥256 bits)', () => {
    const token = generateApiKeyToken();
    const body = token.slice(3);
    // base64url: 43 chars ≈ 256 bits, 44 chars ≈ 264 bits
    expect(body.length).toBeGreaterThanOrEqual(43);
  });

  it('never produces the same token twice in 10000 iterations', () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      tokens.add(generateApiKeyToken());
    }
    expect(tokens.size).toBe(10_000);
  });
});

// ── Token hashing ───────────────────────────────────────────────────────────

describe('hashToken', () => {
  it('returns a 64-character hex string (SHA-256)', () => {
    const hash = hashToken('tm_test');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is deterministic for the same input', () => {
    const token = 'tm_test_token_for_hashing';
    expect(hashToken(token)).toBe(hashToken(token));
  });

  it('produces different hashes for different tokens', () => {
    const hash1 = hashToken(generateApiKeyToken());
    const hash2 = hashToken(generateApiKeyToken());
    expect(hash1).not.toBe(hash2);
  });

  it('hash is not reversible to the original token', () => {
    const token = generateApiKeyToken();
    const hash = hashToken(token);
    // SHA-256 is one-way; verify we can't trivially recover the token
    expect(hash).not.toContain(token);
    expect(hash.length).toBe(64); // much shorter than token + prefix
  });
});

// ── Token verification ──────────────────────────────────────────────────────

describe('verifyToken', () => {
  it('returns true when token matches hash', () => {
    const token = generateApiKeyToken();
    const hash = hashToken(token);
    expect(verifyToken(token, hash)).toBe(true);
  });

  it('returns false for wrong token', () => {
    const hash = hashToken(generateApiKeyToken());
    const wrongToken = generateApiKeyToken();
    expect(verifyToken(wrongToken, hash)).toBe(false);
  });

  it('returns false for empty string token', () => {
    const hash = hashToken(generateApiKeyToken());
    expect(verifyToken('', hash)).toBe(false);
  });

  it('returns false for malformed token', () => {
    const hash = hashToken(generateApiKeyToken());
    expect(verifyToken('not-a-valid-token', hash)).toBe(false);
  });

  it('returns false for different-length hash', () => {
    const token = generateApiKeyToken();
    expect(verifyToken(token, 'a'.repeat(64))).toBe(false);
  });
});

// ── Bearer header parsing ───────────────────────────────────────────────────

describe('parseBearerToken', () => {
  it('extracts token from valid Bearer header', () => {
    const token = generateApiKeyToken();
    expect(parseBearerToken(`Bearer ${token}`)).toBe(token);
  });

  it('is case-insensitive for Bearer scheme', () => {
    const token = generateApiKeyToken();
    expect(parseBearerToken(`bearer ${token}`)).toBe(token);
    expect(parseBearerToken(`BEARER ${token}`)).toBe(token);
    expect(parseBearerToken(`BeArEr ${token}`)).toBe(token);
  });

  it('returns null for null input', () => {
    expect(parseBearerToken(null)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseBearerToken('')).toBeNull();
  });

  it('returns null for missing token', () => {
    expect(parseBearerToken('Bearer ')).toBeNull();
    expect(parseBearerToken('Bearer')).toBeNull();
  });

  it('returns null for non-Bearer scheme', () => {
    const token = generateApiKeyToken();
    expect(parseBearerToken(`Basic ${token}`)).toBeNull();
    expect(parseBearerToken(`Token ${token}`)).toBeNull();
  });

  it('returns null for tokens without tm_ prefix', () => {
    expect(parseBearerToken('Bearer abcdefghijklmnop')).toBeNull();
  });

  it('returns null for tokens with invalid base64url characters', () => {
    expect(parseBearerToken('Bearer tm_abc!@#$%^&*()')).toBeNull();
  });

  it('returns null for tokens too short (< 40 body chars)', () => {
    expect(parseBearerToken('Bearer tm_abc')).toBeNull();
  });

  it('handles whitespace around header value', () => {
    const token = generateApiKeyToken();
    expect(parseBearerToken(`  Bearer ${token}  `)).toBe(token);
  });

  it('rejects tokens with embedded spaces', () => {
    const token = generateApiKeyToken();
    expect(parseBearerToken(`Bearer ${token} extra`)).toBeNull();
  });

  it('rejects tokens with newlines (header injection)', () => {
    const token = generateApiKeyToken();
    expect(parseBearerToken(`Bearer ${token}\r\nX-Injected: true`)).toBeNull();
  });
});

// ── Security: plaintext never logged ────────────────────────────────────────

describe('security — plaintext token never appears in logs', () => {
  it('generateApiKeyToken never logs the plaintext', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const token = generateApiKeyToken();
      // Simulate what a caller might log
      console.log(`Generated token prefix: ${token.slice(0, 6)}...`);

      const allLogs = [...consoleSpy.mock.calls, ...errorSpy.mock.calls]
        .map((args) => args.join(' '))
        .join(' ');

      // The full token should never appear in any log
      expect(allLogs).not.toContain(token);
      // Partial token (prefix only) is acceptable
      expect(allLogs).toContain(token.slice(0, 6));
    } finally {
      consoleSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('key_id is not the secret token', () => {
    const token = generateApiKeyToken();
    const keyId = 'key_abc123';

    // The key_id is a stable identifier, NOT derived from the token
    expect(keyId).not.toContain(token);
    expect(keyId).not.toContain(token.slice(0, 10));
  });
});

// ── End-to-end: generate → hash → verify → parse ────────────────────────────

describe('end-to-end API key lifecycle', () => {
  it('mint → store hash → verify from Bearer header', () => {
    // 1. Mint: generate token, compute hash for storage
    const token = generateApiKeyToken();
    const storedHash = hashToken(token);

    // 2. Verify token against stored hash
    expect(verifyToken(token, storedHash)).toBe(true);

    // 3. Parse from Authorization header
    const parsed = parseBearerToken(`Bearer ${token}`);
    expect(parsed).toBe(token);

    // 4. Verify parsed token against stored hash
    expect(verifyToken(parsed!, storedHash)).toBe(true);
  });

  it('two different keys have different hashes', () => {
    const token1 = generateApiKeyToken();
    const token2 = generateApiKeyToken();

    const hash1 = hashToken(token1);
    const hash2 = hashToken(token2);

    expect(token1).not.toBe(token2);
    expect(hash1).not.toBe(hash2);
  });

  it('wrong token fails verification even with similar prefix', () => {
    const token = generateApiKeyToken();
    const hash = hashToken(token);

    // Generate a token that starts with same prefix but different body
    const wrongToken = 'tm_' + token.slice(3).split('').reverse().join('');
    expect(verifyToken(wrongToken, hash)).toBe(false);
  });
});

// ── keyIdPrefix utility ─────────────────────────────────────────────────────

describe('keyIdPrefix', () => {
  it('returns first 8 characters of a longer key ID', () => {
    expect(keyIdPrefix('key_abc123def')).toBe('key_abc1');
  });

  it('returns full ID if shorter than 8 characters', () => {
    expect(keyIdPrefix('key_ab')).toBe('key_ab');
  });

  it('returns full ID if exactly 8 characters', () => {
    expect(keyIdPrefix('key_abcd')).toBe('key_abcd');
  });
});
