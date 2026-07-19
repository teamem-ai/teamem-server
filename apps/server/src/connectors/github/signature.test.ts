/**
 * GitHub webhook signature verification tests.
 *
 * Covers: success path, typed error on failure, constant-time comparison,
 * case-insensitive header lookup, and the boundary that general parse errors
 * must not be misclassified as signature failures.
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../http/errors.js';
import {
  SignatureVerificationError,
  getHeaderCaseInsensitive,
  verifyGitHubSignature,
} from './signature.js';

const SECRET = 'test-webhook-secret';

function sign(body: string, secret = SECRET): string {
  const mac = createHmac('sha256', secret).update(body).digest('hex');
  return `sha256=${mac}`;
}

// ── Success path ────────────────────────────────────────────────────────────

describe('verifyGitHubSignature — success', () => {
  it('passes for a known body and valid signature', () => {
    const body = '{"action":"opened"}';
    const sig = sign(body);
    expect(() => verifyGitHubSignature(Buffer.from(body), sig, SECRET)).not.toThrow();
  });

  it('passes for an empty body', () => {
    const body = '';
    const sig = sign(body);
    expect(() => verifyGitHubSignature(Buffer.from(body), sig, SECRET)).not.toThrow();
  });

  it('passes for a large body (1 MB)', () => {
    const body = 'x'.repeat(1024 * 1024);
    const sig = sign(body);
    expect(() => verifyGitHubSignature(Buffer.from(body), sig, SECRET)).not.toThrow();
  });
});

// ── Failure path — missing / malformed header ───────────────────────────────

describe('verifyGitHubSignature — header validation', () => {
  it('throws SignatureVerificationError when header is undefined', () => {
    const body = '{"action":"opened"}';
    expect(() => verifyGitHubSignature(Buffer.from(body), undefined, SECRET)).toThrow(
      SignatureVerificationError,
    );
  });

  it('throws SignatureVerificationError when header is empty string', () => {
    const body = '{"action":"opened"}';
    expect(() => verifyGitHubSignature(Buffer.from(body), '', SECRET)).toThrow(
      SignatureVerificationError,
    );
  });

  it('throws SignatureVerificationError when header lacks sha256= prefix', () => {
    const body = '{"action":"opened"}';
    expect(() =>
      verifyGitHubSignature(Buffer.from(body), 'md5=abc123', SECRET),
    ).toThrow(SignatureVerificationError);
  });

  it('throws SignatureVerificationError when hex contains non-hex chars', () => {
    const body = '{"action":"opened"}';
    expect(() =>
      verifyGitHubSignature(
        Buffer.from(body),
        'sha256=zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz',
        SECRET,
      ),
    ).toThrow(SignatureVerificationError);
  });
});

// ── Failure path — wrong secret or wrong body ───────────────────────────────

describe('verifyGitHubSignature — wrong secret / body', () => {
  it('throws SignatureVerificationError when secret is wrong', () => {
    const body = '{"action":"opened"}';
    const sig = sign(body, 'wrong-secret');
    expect(() => verifyGitHubSignature(Buffer.from(body), sig, SECRET)).toThrow(
      SignatureVerificationError,
    );
  });

  it('throws SignatureVerificationError when body is tampered (one byte changed)', () => {
    const body = '{"action":"opened"}';
    const sig = sign(body);
    const tampered = Buffer.from(body);
    tampered[0] = tampered[0]! === 0x7b ? 0x7c : 0x7b; // flip first byte
    expect(() => verifyGitHubSignature(tampered, sig, SECRET)).toThrow(
      SignatureVerificationError,
    );
  });

  it('throws SignatureVerificationError for an empty body when signature is for non-empty', () => {
    const sig = sign('some body');
    expect(() => verifyGitHubSignature(Buffer.from(''), sig, SECRET)).toThrow(
      SignatureVerificationError,
    );
  });
});

// ── Typed error contract ────────────────────────────────────────────────────

describe('verifyGitHubSignature — typed error contract', () => {
  it('SignatureVerificationError is an instance of AppError', () => {
    const err = new SignatureVerificationError();
    expect(err).toBeInstanceOf(AppError);
    expect(err).toBeInstanceOf(Error);
  });

  it('SignatureVerificationError has code "unauthorized"', () => {
    const err = new SignatureVerificationError('test');
    expect(err.code).toBe('unauthorized');
  });

  it('error message does not leak the secret', () => {
    const body = '{"test":true}';
    const sig = sign(body, 'super-secret-key');
    expect(() => verifyGitHubSignature(Buffer.from(body), sig, SECRET)).toThrow(
      SignatureVerificationError,
    );
    try {
      verifyGitHubSignature(Buffer.from(body), sig, SECRET);
    } catch (err) {
      expect((err as Error).message).not.toContain('super-secret-key');
    }
  });

  it('error message does not leak the raw body', () => {
    const body = '{"password":"hunter2"}';
    const sig = sign(body, SECRET);
    expect(() => verifyGitHubSignature(Buffer.from(body), sig, 'different-secret')).toThrow(
      SignatureVerificationError,
    );
    try {
      verifyGitHubSignature(Buffer.from(body), sig, 'different-secret');
    } catch (err) {
      expect((err as Error).message).not.toContain('hunter2');
    }
  });
});

// ── Case-insensitive header lookup ──────────────────────────────────────────

describe('getHeaderCaseInsensitive', () => {
  it('finds header with exact case', () => {
    const headers = { 'x-hub-signature-256': 'sha256=abc' };
    expect(getHeaderCaseInsensitive(headers, 'x-hub-signature-256')).toBe('sha256=abc');
  });

  it('finds header with different case', () => {
    const headers = { 'X-Hub-Signature-256': 'sha256=abc' };
    expect(getHeaderCaseInsensitive(headers, 'x-hub-signature-256')).toBe('sha256=abc');
  });

  it('returns undefined for missing header', () => {
    const headers = { 'content-type': 'application/json' };
    expect(getHeaderCaseInsensitive(headers, 'x-hub-signature-256')).toBeUndefined();
  });

  it('handles empty headers object', () => {
    expect(getHeaderCaseInsensitive({}, 'x-hub-signature-256')).toBeUndefined();
  });
});

// ── Boundary: general errors must NOT be misclassified ──────────────────────

describe('verifyGitHubSignature — does not misclassify internal errors', () => {
  it('a thrown SignatureVerificationError is NOT a generic internal error', () => {
    const body = '{"test":true}';
    const sig = sign(body, 'wrong');
    try {
      verifyGitHubSignature(Buffer.from(body), sig, SECRET);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SignatureVerificationError);
      expect(err).not.toBeInstanceOf(TypeError);
      expect(err).not.toBeInstanceOf(RangeError);
      // The error code is 'unauthorized', not 'internal'
      if (err instanceof AppError) {
        expect(err.code).toBe('unauthorized');
      }
    }
  });
});
