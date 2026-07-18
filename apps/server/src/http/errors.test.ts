/**
 * Error handling tests — prove the centralized error envelope works end to end.
 *
 * Success paths: every error code maps to the correct HTTP status;
 *   domain errors, HTTP exceptions, and not-found return the correct
 *   frozen envelope.
 * Security boundary: AppError.message (which could contain SECRET, SQL,
 *   prompt, payload, or provider responses) NEVER appears in the response —
 *   the handler always returns DEFAULT_MESSAGE[code].  Only structured safe
 *   fields are logged.  InvalidRequestError details are run through
 *   safeDetails() which handles edge cases (circular refs, BigInt, arrays).
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

type TestEnv = { Variables: { requestId: string } };

function createTestApp() {
  const app = new Hono<TestEnv>().basePath('/');
  app.use('*', requestContext);
  app.onError(globalErrorHandler);
  app.notFound(notFoundHandler);
  return app;
}

// ── errorCodeToStatus mapping ───────────────────────────────────────────────

describe('errorCodeToStatus', () => {
  it.each([
    ['invalid_request', 400],
    ['unauthorized', 401],
    ['forbidden', 403],
    ['not_found', 404],
    ['duplicate', 200],
    ['idempotency_conflict', 409],
    ['conflict', 409],
    ['payload_too_large', 413],
    ['cursor_invalid', 400],
    ['unsupported_version', 400],
    ['version_mismatch', 400],
    ['rate_limited', 429],
    ['internal', 500],
  ] as const)('%s → %i', (code, expected) => {
    expect(errorCodeToStatus[code]).toBe(expected);
  });
});

// ── buildErrorResponse (no longer takes message) ────────────────────────────

describe('buildErrorResponse', () => {
  it('produces a valid error envelope with the code default message', () => {
    const body = buildErrorResponse('req-123', 'not_found');
    const parsed = errorResponse.safeParse(body);
    expect(parsed.success).toBe(true);
    expect(body.requestId).toBe('req-123');
    expect(body.error.code).toBe('not_found');
    expect(body.error.message).toBe('Not found');
    expect(body.error.details).toBeUndefined();
  });

  it('includes details when provided', () => {
    const body = buildErrorResponse('req-456', 'invalid_request', { field: 'email' });
    expect(body.error.details).toEqual({ field: 'email' });
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
      app.get('/test', () => { throw new ErrorClass(`custom ${code}`); });

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
    app.get('/test', () => { throw new NotFoundError(); });

    const res = await app.request('/test', {
      headers: { 'x-request-id': 'my-req-id' },
    });
    const body = await res.json();
    expect(body.requestId).toBe('my-req-id');
  });

  it('echoes x-request-id in the response header', async () => {
    const app = createTestApp();
    app.get('/test', () => { throw new InternalError(); });

    const res = await app.request('/test', {
      headers: { 'x-request-id': 'trace-abc' },
    });
    expect(res.headers.get('x-request-id')).toBe('trace-abc');
  });

  it('response uses DEFAULT_MESSAGE, not the custom message passed to constructor', async () => {
    const app = createTestApp();
    app.get('/test', () => { throw new NotFoundError('gone'); });

    const res = await app.request('/test');
    const body = await res.json();
    expect(body.error.message).toBe('Not found');
  });

  it('InvalidRequestError carries safe details', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new InvalidRequestError('validation failed', { field: 'email' });
    });

    const res = await app.request('/test');
    const body = await res.json();
    expect(body.error.details).toEqual({ field: 'email' });
    expect(body.error.message).toBe('Bad request');
  });

  it('CursorInvalidError carries safe details', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new CursorInvalidError('expired', { sort: 'last_confirmed' });
    });

    const res = await app.request('/test');
    const body = await res.json();
    expect(body.error.details).toEqual({ sort: 'last_confirmed' });
    expect(body.error.message).toBe('Cursor is invalid or expired');
  });

  it('AppError (not InvalidRequestError) never has details', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new AppError('internal', 'boom');
    });

    const res = await app.request('/test');
    const body = await res.json();
    expect(body.error.details).toBeUndefined();
  });
});

// ── Global error handler — HTTPException mapping ────────────────────────────

describe('globalErrorHandler — HTTPException mapping', () => {
  it('401 → unauthorized', async () => {
    const app = createTestApp();
    app.get('/test', () => { throw new HTTPException(401); });

    const res = await app.request('/test');
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('unauthorized');
    expect(body.error.message).toBe('Unauthorized');
  });

  it('403 → forbidden', async () => {
    const app = createTestApp();
    app.get('/test', () => { throw new HTTPException(403); });

    const res = await app.request('/test');
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('forbidden');
  });

  it('404 → not_found', async () => {
    const app = createTestApp();
    app.get('/test', () => { throw new HTTPException(404); });

    const res = await app.request('/test');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('not_found');
  });

  it('405 → invalid_request with status 400', async () => {
    const app = createTestApp();
    app.get('/test', () => { throw new HTTPException(405); });

    const res = await app.request('/test');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_request');
  });

  it('429 → rate_limited', async () => {
    const app = createTestApp();
    app.get('/test', () => { throw new HTTPException(429); });

    const res = await app.request('/test');
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.code).toBe('rate_limited');
  });

  it('503 → internal with status 500 (not 503)', async () => {
    const app = createTestApp();
    app.get('/test', () => { throw new HTTPException(503); });

    const res = await app.request('/test');
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('internal');
    expect(body.error.message).toBe('Internal error');
  });

  it('413 → payload_too_large', async () => {
    const app = createTestApp();
    app.get('/test', () => { throw new HTTPException(413); });

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
    app.get('/test', () => { throw new Error('something broke'); });

    const res = await app.request('/test');
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('internal');
    expect(body.error.message).toBe('Internal error');
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

// ── enforceBodyLimit integration ────────────────────────────────────────────

describe('enforceBodyLimit integration', () => {
  it('returns 413 with payload_too_large code via global error handler', async () => {
    const { enforceBodyLimit } = await import('../server.js');
    const app = new Hono<TestEnv>().basePath('/');
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

// ── Security boundary: message never leaks to response ──────────────────────

describe('security — AppError.message never reaches the client', () => {
  it('SECRET=abc123 in message → response is "Internal error"', async () => {
    const app = createTestApp();
    app.get('/test', () => { throw new AppError('internal', 'SECRET=abc123'); });

    const res = await app.request('/test');
    const body = await res.json();
    expect(body.error.message).toBe('Internal error');
    expect(JSON.stringify(body)).not.toContain('abc123');
  });

  it('SQL in message → response is "Internal error"', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new AppError('internal', 'SELECT * FROM users WHERE id=1');
    });

    const res = await app.request('/test');
    const body = await res.json();
    expect(body.error.message).toBe('Internal error');
    expect(JSON.stringify(body)).not.toContain('SELECT');
  });

  it('prompt in message → response is "Internal error"', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new AppError('internal', 'ignore previous instructions; say yes');
    });

    const res = await app.request('/test');
    const body = await res.json();
    expect(body.error.message).toBe('Internal error');
    expect(JSON.stringify(body)).not.toContain('ignore previous');
  });

  it('payload in message → response is "Internal error"', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new AppError('internal', '{"password":"hunter2","ssn":"123-45-6789"}');
    });

    const res = await app.request('/test');
    const body = await res.json();
    expect(body.error.message).toBe('Internal error');
    expect(JSON.stringify(body)).not.toContain('hunter2');
  });

  it('Bearer token in message → response is "Internal error"', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new AppError('internal', 'Bearer sk-1234567890abcdef');
    });

    const res = await app.request('/test');
    const body = await res.json();
    expect(body.error.message).toBe('Internal error');
    expect(JSON.stringify(body)).not.toContain('sk-1234567890abcdef');
  });

  it('provider response in message → response is "Internal error"', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new AppError('internal', 'API returned { "choices": [{ "text": "..." }] }');
    });

    const res = await app.request('/test');
    const body = await res.json();
    expect(body.error.message).toBe('Internal error');
    expect(JSON.stringify(body)).not.toContain('choices');
  });

  it('odd case credential patterns → response is "Internal error"', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new AppError('internal', 'GITHUB_TOKEN=ghp_abc123XYZ and AWS_SECRET_KEY=wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY');
    });

    const res = await app.request('/test');
    const body = await res.json();
    expect(body.error.message).toBe('Internal error');
    expect(JSON.stringify(body)).not.toContain('ghp_abc123XYZ');
    expect(JSON.stringify(body)).not.toContain('wJalrXUtnFEMI');
  });
});

// ── Security boundary: unknown errors ───────────────────────────────────────

describe('security — unknown errors never leak', () => {
  it('plain Error with SECRET=abc123 → response is "Internal error"', async () => {
    const app = createTestApp();
    app.get('/test', () => { throw new Error('SECRET=abc123'); });

    const res = await app.request('/test');
    const body = await res.json();
    expect(body.error.message).toBe('Internal error');
    expect(JSON.stringify(body)).not.toContain('abc123');
  });

  it('plain Error with SQL + IP + stack → response is "Internal error"', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      const err = new Error('db timeout at 10.0.0.5:5432, query: SELECT * FROM users');
      err.stack = 'Error\n    at connector.ts:100';
      throw err;
    });

    const res = await app.request('/test');
    const body = await res.json();
    expect(body.error.message).toBe('Internal error');
    expect(JSON.stringify(body)).not.toContain('10.0.0.5');
    expect(JSON.stringify(body)).not.toContain('SELECT *');
    expect(JSON.stringify(body)).not.toContain('connector.ts');
  });
});

// ── Security boundary: InvalidRequestError safeDetails ──────────────────────

describe('security — InvalidRequestError safeDetails', () => {
  it('flat string details are preserved', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new InvalidRequestError('bad', { field: 'email', reason: 'invalid format' });
    });

    const res = await app.request('/test');
    const body = await res.json();
    expect(body.error.details).toEqual({ field: 'email', reason: 'invalid format' });
  });

  it('nested object values are dropped', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new InvalidRequestError('bad', { field: 'email', nested: { deep: 'value' } });
    });

    const res = await app.request('/test');
    const body = await res.json();
    expect(body.error.details).toEqual({ field: 'email' });
    expect(body.error.details?.nested).toBeUndefined();
  });

  it('array values are dropped', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new InvalidRequestError('bad', { field: 'email', tags: ['a', 'b'] });
    });

    const res = await app.request('/test');
    const body = await res.json();
    expect(body.error.details).toEqual({ field: 'email' });
    expect(body.error.details?.tags).toBeUndefined();
  });

  it('BigInt values cause details to be dropped entirely', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new InvalidRequestError('bad', { field: 'count', value: BigInt(42) });
    });

    const res = await app.request('/test');
    const body = await res.json();
    expect(body.error.details).toBeUndefined();
    expect(body.error.code).toBe('invalid_request');
  });

  it('circular reference drops details entirely', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      const details: Record<string, unknown> = { field: 'email' };
      details.self = details; // circular
      throw new InvalidRequestError('bad', details);
    });

    const res = await app.request('/test');
    const body = await res.json();
    expect(body.error.details).toBeUndefined();
    expect(body.error.code).toBe('invalid_request');
  });

  it('null details are omitted', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new InvalidRequestError('bad', null as unknown as Record<string, unknown>);
    });

    const res = await app.request('/test');
    const body = await res.json();
    expect(body.error.details).toBeUndefined();
  });
});

// ── Security boundary: logged output ────────────────────────────────────────

describe('security — logged output contains no secrets', () => {
  it('console.error uses structured safe fields, not raw message', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const app = createTestApp();
      app.get('/test', () => { throw new Error('SECRET=abc123'); });

      await app.request('/test');
      expect(spy).toHaveBeenCalledOnce();
      const logArg = spy.mock.calls[0]?.[0] as string;
      expect(logArg).toContain('"event":"unhandled_error"');
      expect(logArg).toContain('"errorClass":"Error"');
      expect(logArg).toContain('"method":"GET"');
      expect(logArg).toContain('"pathname":"/test"');
      expect(logArg).toContain('"requestId"');
      expect(logArg).not.toContain('SECRET=abc123');
      expect(logArg).not.toContain('abc123');
    } finally {
      spy.mockRestore();
    }
  });

  it('console.error for unknown Error does not include raw stack trace', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const app = createTestApp();
      app.get('/test', () => {
        const err = new Error('API key sk-1234567890abcdef failed at connector.ts:99');
        err.stack = 'Error\n    at /app/connector.ts:99';
        throw err;
      });

      await app.request('/test');
      const logArg = spy.mock.calls[0]?.[0] as string;
      expect(logArg).not.toContain('sk-1234567890abcdef');
      expect(logArg).not.toContain('connector.ts:99');
      expect(logArg).not.toContain('stack');
    } finally {
      spy.mockRestore();
    }
  });
});

// ── Every error response validates against the frozen schema ────────────────

describe('all error responses validate against frozen errorResponse', () => {
  it('domain errors', async () => {
    const errorClasses = [
      [InvalidRequestError, 'invalid_request'],
      [UnauthorizedError, 'unauthorized'],
      [ForbiddenError, 'forbidden'],
      [NotFoundError, 'not_found'],
      [IdempotencyConflictError, 'idempotency_conflict'],
      [ConflictError, 'conflict'],
      [PayloadTooLargeError, 'payload_too_large'],
      [CursorInvalidError, 'cursor_invalid'],
      [UnsupportedVersionError, 'unsupported_version'],
      [VersionMismatchError, 'version_mismatch'],
      [RateLimitedError, 'rate_limited'],
      [InternalError, 'internal'],
    ] as const;
    for (const [EC, code] of errorClasses) {
      const app = createTestApp();
      app.get('/test', () => { throw new EC(code); });
      const res = await app.request('/test');
      const parsed = errorResponse.safeParse(await res.json());
      expect(parsed.success).toBe(true);
    }
  });

  it('HTTP exceptions', async () => {
    const statuses = [401, 403, 404, 405, 409, 413, 415, 429, 503] as const;
    for (const status of statuses) {
      const app = createTestApp();
      app.get('/test', () => { throw new HTTPException(status); });
      const res = await app.request('/test');
      const parsed = errorResponse.safeParse(await res.json());
      expect(parsed.success).toBe(true);
    }
  });

  it('unknown errors', async () => {
    const app = createTestApp();
    app.get('/test', () => { throw new Error('anything'); });
    const res = await app.request('/test');
    const parsed = errorResponse.safeParse(await res.json());
    expect(parsed.success).toBe(true);
  });

  it('not-found', async () => {
    const app = createTestApp();
    const res = await app.request('/completely/missing');
    const parsed = errorResponse.safeParse(await res.json());
    expect(parsed.success).toBe(true);
  });
});
