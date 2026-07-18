/**
 * Error handling tests — prove the centralized error envelope works end to end.
 *
 * Success paths: every error code maps to the correct HTTP status.
 * Failure paths: domain errors, HTTP exceptions, unknown errors.
 * Security boundary: a thrown error containing SECRET=abc123 must never
 *   appear in the serialized response body.
 */
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
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

// ── Global error handler — HTTPException mapping (P1 fix) ───────────────────

describe('globalErrorHandler — HTTPException mapping', () => {
  it('401 → unauthorized (not invalid_request)', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new HTTPException(401);
    });

    const res = await app.request('/test');
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('unauthorized');
    expect(body.error.message).toBe('Unauthorized');
  });

  it('403 → forbidden', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new HTTPException(403);
    });

    const res = await app.request('/test');
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('forbidden');
  });

  it('404 → not_found', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new HTTPException(404);
    });

    const res = await app.request('/test');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('not_found');
  });

  it('405 → invalid_request with status 400', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new HTTPException(405);
    });

    const res = await app.request('/test');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_request');
  });

  it('429 → rate_limited', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new HTTPException(429);
    });

    const res = await app.request('/test');
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.code).toBe('rate_limited');
  });

  it('503 → internal with status 500 (not 503)', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new HTTPException(503);
    });

    const res = await app.request('/test');
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('internal');
    expect(body.error.message).toBe('Internal error');
  });

  it('413 → payload_too_large', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new HTTPException(413);
    });

    const res = await app.request('/test');
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error.code).toBe('payload_too_large');
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

// ── Secret leak prevention — P1 fixes ───────────────────────────────────────

describe('secret leak prevention', () => {
  it('P1: AppError with SECRET=abc123 in message never appears in response', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new AppError('internal', 'SECRET=abc123');
    });

    const res = await app.request('/test');
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain('SECRET=abc123');
    expect(body.error.message).toBe('SECRET=[REDACTED]');
  });

  it('P1: AppError with SECRET in details never appears in response', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new AppError('internal', 'failed', { original: 'SECRET=xyz789' });
    });

    const res = await app.request('/test');
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain('xyz789');
    expect(body.error.details?.original).toBe('SECRET=[REDACTED]');
  });

  it('P1: prefixed key pattern in AppError message is redacted', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new AppError('internal', 'key_abcdef1234567890123456 went wrong');
    });

    const res = await app.request('/test');
    const body = await res.json();
    expect(body.error.message).not.toContain('key_abcdef1234567890123456');
  });

  it('P1: unknown error with SECRET=abc123 does not leak to response', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new Error('SECRET=abc123');
    });

    const res = await app.request('/test');
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain('SECRET=abc123');
    expect(JSON.stringify(body)).not.toContain('abc123');
    expect(body.error.message).toBe('Internal error');
  });

  it('P1: unknown error does not expose original message, stack, or SQL', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      const err = new Error('API key sk-1234567890abcdef failed at 10.0.0.5:5432');
      err.stack = 'Error: got SQL SELECT * FROM users\n    at connector.ts:100';
      throw err;
    });

    const res = await app.request('/test');
    const body = await res.json();
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('sk-1234567890abcdef');
    expect(serialized).not.toContain('connector.ts');
    expect(serialized).not.toContain('SELECT *');
    expect(serialized).not.toContain('10.0.0.5');
    expect(body.error.message).toBe('Internal error');
  });

  it('P1: console.error receives redacted message (no raw secrets in logs)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const app = createTestApp();
      app.get('/test', () => {
        throw new Error('SECRET=abc123');
      });

      await app.request('/test');
      expect(spy).toHaveBeenCalledOnce();
      const logged = spy.mock.calls[0]?.[0] as string;
      expect(logged).toContain('SECRET=[REDACTED]');
      expect(logged).not.toContain('SECRET=abc123');
    } finally {
      spy.mockRestore();
    }
  });
});
