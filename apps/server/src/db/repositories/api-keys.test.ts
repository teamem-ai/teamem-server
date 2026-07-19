import { describe, expect, it } from 'vitest';
import {
  validateApiKeyScopes,
  AuthenticationError,
} from './api-keys.js';

describe('validateApiKeyScopes', () => {
  // ── Success ─────────────────────────────────────────────────────────────

  it('accepts any subset of valid ApiScope values', () => {
    expect(validateApiKeyScopes(['read'])).toEqual(['read']);
    expect(validateApiKeyScopes(['events:write'])).toEqual(['events:write']);
    expect(validateApiKeyScopes(['read', 'events:write'])).toEqual([
      'read',
      'events:write',
    ]);
    expect(validateApiKeyScopes(['read', 'read:payload', 'events:write'])).toEqual([
      'read',
      'read:payload',
      'events:write',
    ]);
    expect(validateApiKeyScopes(['read', 'read:payload', 'events:write', 'audit:read'])).toEqual([
      'read',
      'read:payload',
      'events:write',
      'audit:read',
    ]);
  });

  // ── read:payload without read (N7 violation) ────────────────────────────

  it('rejects read:payload without read (N7 violation)', () => {
    expect(() => validateApiKeyScopes(['read:payload'])).toThrow(AuthenticationError);
    expect(() => validateApiKeyScopes(['read:payload', 'events:write'])).toThrow(AuthenticationError);
  });

  // ── Invalid scope values ────────────────────────────────────────────────

  it('rejects unknown scope strings', () => {
    expect(() => validateApiKeyScopes(['admin'])).toThrow(AuthenticationError);
    expect(() => validateApiKeyScopes(['read', 'delete'])).toThrow(AuthenticationError);
    expect(() => validateApiKeyScopes([''])).toThrow(AuthenticationError);
  });

  // ── Empty / edge cases ──────────────────────────────────────────────────

  it('accepts an empty array (no scopes, but technically valid)', () => {
    expect(validateApiKeyScopes([])).toEqual([]);
  });

  it('accepts duplicate scopes (Zod array allows duplicates)', () => {
    expect(validateApiKeyScopes(['read', 'read'])).toEqual(['read', 'read']);
  });

  // ── Error message is generic (no information leakage) ───────────────────

  it('produces the same generic error for any rejection (no information leakage)', () => {
    const rejections = [
      () => validateApiKeyScopes(['admin']),
      () => validateApiKeyScopes(['read:payload']),
      () => validateApiKeyScopes(['read', 'write', 'delete']),
    ];

    for (const err of rejections) {
      expect(err).toThrow('invalid or revoked API key');
    }
  });
});
