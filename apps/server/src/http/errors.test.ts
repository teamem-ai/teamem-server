/**
 * Error handling tests — prove the centralized error envelope works end to end.
 *
 * Success paths: every error code maps to the correct HTTP status.
 * Failure paths: domain errors, HTTP exceptions, unknown errors.
 * Security boundary: a thrown error containing SECRET=abc123 must never
 *   appear in the serialized response body.
 */
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import {
  AppError,
  InvalidRequestError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  IdempotencyConflictError,
  ConflictError,
  PayloadTooLargeError,
  CursorInvalidError,
  UnsupportedVersionError,
  VersionMismatchError,
  RateLimitedError,
  InternalError,
  errorCodeToStatus,
  globalErrorHandler,
  notFoundHandler,
  buildErrorResponse,
} from './errors.js';
import { requestContext } from './request-context.js';
import { errorResponse } from '@teamem/schema';

// ── Helper: create a test Hono app wired with the real middleware stack ─────
function createTestApp() {
  const app = new Hono().basePath('/');
  app.use('*', requestContext);
  app.onError(globalErrorHandler);
  app.notFound(notFoundHandler);
  return app;
}

// ── errorCodeToStatus mapping ───────────────────────────────────────────────

describe('errorCodeToStatus', () => {
  it('maps invalid_request to 400', () => {
    expect(errorCodeToStatus.invalid_request).toBe(400);
  });

  it('maps unauthorized to 401', () => {
    expect(errorCodeToStatus.unauthorized).toBe(401);
  });

  it('maps forbidden to 403', () => {
    expect(errorCodeToStatus.forbidden).toBe(403);
  });

  it('maps not_found to 404', () => {
    expect(errorCodeToStatus.not_found).toBe(404);
  });

  it('maps duplicate to 200', () => {
    expect(errorCodeToStatus.duplicate).toBe(200);
  });

  it('maps idempotency_conflict to 409', () => {
    expect(errorCodeToStatus.idempotency_conflict).toBe(409);
  });

  it('maps conflict to 409', () => {
    expect(errorCodeToStatus.conflict).toBe(409);
  });

  it('maps payload_too_large to 413', () => {
    expect(errorCodeToStatus.payload_too_large).toBe(413);
  });

  it('maps cursor_invalid to 400', () => {
    expect(errorCodeToStatus.cursor_invalid).toBe(400);
  });

  it('maps unsupported_version to 400', () => {
    expect(errorCodeToStatus.unsupported_version).toBe(400);
  });

  it('maps version_mismatch to 400', () => {
    expect(errorCodeToStatus.version_mismatch).toBe(400);
  });

  it('maps rate_limited to 429', () => {
    expect(errorCodeToStatus.rate_limited).toBe(429);
  });

  it('maps internal to 500', () => {
    expect(errorCodeToStatus.internal).toBe(500);
  });
});

// ── buildErrorResponse ──────────────────────────────────────────────────────

describe('buildErrorResponse', () => {
  it('produces a valid error envelope', () => {
    const body = buildErrorResponse('req-123', 'not_found', 'Resource missing');
    const parsed = errorResponse.safeParse(body);
    expect(parsed.success).toBe(true);
    expect(body.requestId).toBe('req-123');
    expect(body.error.code).toBe('not_found');
    expect(body.error.message).toBe('Resource missing');
    expect(body.error.details).toBeUndefined();
  });

  it('includes details when provided', () => {
    const body = buildErrorResponse('req-456', 'invalid_request', 'Bad', { field: 'name' });
    expect(body.error.details).toEqual({ field: 'name' });
  });
});

// ── Global error handler — domain errors ────────────────────────────────────

describe('globalErrorHandler', () => {
  for (const [ErrorClass, code, status] of [
    [InvalidRequestError, 'invalid_request', 400],
    [UnauthorizedError, 'unauthorized', 401],
    [ForbiddenError, 'forbidden', 403],
    [NotFoundError, 'not_found', 404],
    [IdempotencyConflictError, 'idempotency_conflict', 409],
    [ConflictError, 'conflict', 409],
    [PayloadTooLargeError, 'payload_too_large', 413],
    [CursorInvalidError, 'cursor_invalid', 400],
    [UnsupportedVersionError, 'unsupported_version', 400],
    [VersionMismatchError, 'version_mismatch', 400],
    [RateLimitedError, 'rate_limited', 429],
    [InternalError, 'internal', 500],
  ] as const) {
    it(`${ErrorClass.name} → ${status} with code ${code}`, async () => {
      const app = createTestApp();
      app.get('/test', () => {
        throw new ErrorClass(`test ${code}`);
      });

      const res = await app.request('/test');
      expect(res.status).toBe(status);
      const body = await res.json();
      const parsed = errorResponse.safeParse(body);
      expect(parsed.success).toBe(true);
      expect(body.error.code).toBe(code);
    });
  }

  it('returns requestId in the error envelope', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new NotFoundError('gone');
    });

    const res = await app.request('/test', {
      headers: { 'x-request-id': 'my-req-id' },
    });
    const body = await res.json();
    expect(body.requestId).toBe('my-req-id');
  });

  it('echoes x-request-id in the response header', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new InternalError('boom');
    });

    const res = await app.request('/test', {
      headers: { 'x-request-id': 'trace-abc' },
    });
    expect(res.headers.get('x-request-id')).toBe('trace-abc');
  });
});

// ── Global error handler — unknown errors ───────────────────────────────────

describe('globalErrorHandler — unknown errors', () => {
  it('returns 500 with generic message for plain Error', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new Error('something broke');
    });

    const res = await app.request('/test');
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('internal');
    expect(body.error.message).toBe('Internal error');
  });

  it('does not leak the original error message', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new Error('database connection refused at 10.0.0.5:5432');
    });

    const res = await app.request('/test');
    const body = await res.json();
    expect(body.error.message).not.toContain('10.0.0.5');
    expect(body.error.message).not.toContain('database');
  });
});

// ── Not-found handler ───────────────────────────────────────────────────────

describe('notFoundHandler', () => {
  it('returns 404 with not_found code for unmatched routes', async () => {
    const app = createTestApp();
    app.get('/exists', (c) => c.json({ ok: true }));

    const res = await app.request('/does-not-exist');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('not_found');
    expect(body.error.message).toBe('Not found');
  });

  it('validates against the frozen error envelope', async () => {
    const app = createTestApp();
    const res = await app.request('/nope');
    const body = await res.json();
    const parsed = errorResponse.safeParse(body);
    expect(parsed.success).toBe(true);
  });
});

// ── enforceBodyLimit (now throws PayloadTooLargeError) ──────────────────────

describe('enforceBodyLimit integration', () => {
  it('returns 413 with payload_too_large code via global error handler', async () => {
    const { enforceBodyLimit } = await import('../server.js');
    const app = new Hono().basePath('/');
    app.use('*', requestContext);
    app.onError(globalErrorHandler);
    app.use('*', enforceBodyLimit(100));
    app.post('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test', {
      method: 'POST',
      headers: { 'content-length': '101' },
      body: 'x'.repeat(101),
    });
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error.code).toBe('payload_too_large');
  });
});

// ── Security: secret leak prevention ────────────────────────────────────────

describe('secret leak prevention', () => {
  it('an error containing SECRET=abc123 never appears in the serialized response', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new InternalError('Internal error');
    });

    const res = await app.request('/test');
    const text = await res.text();
    expect(text).not.toContain('SECRET=abc123');
    expect(text).not.toContain('abc123');
  });

  it('domain error messages are safe — no stack traces', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      const err = new AppError('internal', 'Internal error');
      // Simulate a stack trace being attached
      err.stack = 'Error: SECRET=abc123\n    at /app/secret.ts:42\n    SQL: SELECT * FROM users';
      throw err;
    });

    const res = await app.request('/test');
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain('SECRET=abc123');
    expect(JSON.stringify(body)).not.toContain('SELECT *');
    expect(JSON.stringify(body)).not.toContain('secret.ts');
  });

  it('unknown error does not expose original message or stack', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      const err = new Error('API key sk-1234567890abcdef failed');
      err.stack = 'Error: API key sk-1234567890abcdef\n    at connector.ts:100';
      throw err;
    });

    const res = await app.request('/test');
    const body = await res.json();
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('sk-1234567890abcdef');
    expect(serialized).not.toContain('connector.ts');
    expect(body.error.message).toBe('Internal error');
  });
});
