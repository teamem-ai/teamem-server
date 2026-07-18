/**
 * Centralized error handling — frozen error envelope, error-code → HTTP-status
 * mapping, domain error classes, and Hono global error / not-found handlers.
 *
 * All error responses conform to the `errorResponse` shape defined in
 * `@teamem/schema`'s common.ts: `{ requestId, error: { code, message, details? } }`.
 *
 * Security design:
 *   - Every error code has a fixed DEFAULT_MESSAGE. AppError.message (which a
 *     programmer might accidentally populate with secrets) NEVER reaches the
 *     client — the default is always used.
 *   - AppError.cause holds internal context for debugging and is never
 *     serialized into the response.
 *   - Only InvalidRequestError and CursorInvalidError carry `details`, and
 *     those are run through safeDetails() (handles circular refs, BigInt, etc.).
 *   - Unknown errors are logged with structured safe fields only — no raw
 *     err.message, err.stack, payload, SQL, secrets, or provider responses.
 */
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { errorCode, type ErrorResponse } from '@teamem/schema';

// ── Error-code → HTTP-status mapping ────────────────────────────────────────
// Source of truth: the comments on `errorCode` in packages/schema/src/common.ts.
// `duplicate` (200-companion) is informational-only and never thrown as an error.

export const errorCodeToStatus: Record<z.infer<typeof errorCode>, number> = {
  invalid_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  duplicate: 200,
  idempotency_conflict: 409,
  conflict: 409,
  payload_too_large: 413,
  cursor_invalid: 400,
  unsupported_version: 400,
  version_mismatch: 400,
  rate_limited: 429,
  internal: 500,
};

type ErrorCode = z.infer<typeof errorCode>;

// ── Default public messages ─────────────────────────────────────────────────
// These are the ONLY messages ever returned to the client.  AppError.message
// (the Error.prototype.message) is an internal-only string that is NEVER
// serialized into the error envelope — it lives on the object so that Node.js
// crash / debug output remains useful, but the global handler always uses the
// code-specific default below.

const DEFAULT_MESSAGE: Record<ErrorCode, string> = {
  invalid_request: 'Bad request',
  unauthorized: 'Unauthorized',
  forbidden: 'Forbidden',
  not_found: 'Not found',
  duplicate: 'Duplicate',
  idempotency_conflict: 'Idempotency conflict',
  conflict: 'Conflict',
  payload_too_large: 'Payload too large',
  cursor_invalid: 'Cursor is invalid or expired',
  unsupported_version: 'Unsupported version',
  version_mismatch: 'Version mismatch',
  rate_limited: 'Rate limited',
  internal: 'Internal error',
};

// ── Safe-details helper ─────────────────────────────────────────────────────
// JSON.parse(JSON.stringify(x)) naturally strips BigInt, undefined values,
// Symbols, and functions.  A circular reference or BigInt in the details
// produce a TypeError which is caught → details are dropped silently.
// Only InvalidRequestError and CursorInvalidError carry details.

function safeDetails(details: unknown): Record<string, string> | undefined {
  if (typeof details !== 'object' || details === null) return undefined;
  try {
    const raw = JSON.parse(JSON.stringify(details));
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'string') out[k] = v;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

// ── Domain error classes ────────────────────────────────────────────────────
// Each carries:
//   - code     — frozen error code
//   - cause    — internal context (never reaches the client)
//
// Subclasses that need structured details (InvalidRequestError,
// CursorInvalidError) expose a `details` property that has been run through
// safeDetails().

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly cause?: unknown;

  constructor(code: ErrorCode, message = DEFAULT_MESSAGE[code], options?: { cause?: unknown }) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.cause = options?.cause;
  }
}

export class InvalidRequestError extends AppError {
  readonly details?: Record<string, string>;

  constructor(
    message: string,
    details?: Record<string, unknown>,
    options?: { cause?: unknown },
  ) {
    super('invalid_request', message, options);
    this.name = 'InvalidRequestError';
    this.details = safeDetails(details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = DEFAULT_MESSAGE.unauthorized, options?: { cause?: unknown }) {
    super('unauthorized', message, options);
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends AppError {
  constructor(message = DEFAULT_MESSAGE.forbidden, options?: { cause?: unknown }) {
    super('forbidden', message, options);
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends AppError {
  constructor(message = DEFAULT_MESSAGE.not_found, options?: { cause?: unknown }) {
    super('not_found', message, options);
    this.name = 'NotFoundError';
  }
}

export class IdempotencyConflictError extends AppError {
  constructor(
    message = DEFAULT_MESSAGE.idempotency_conflict,
    options?: { cause?: unknown },
  ) {
    super('idempotency_conflict', message, options);
    this.name = 'IdempotencyConflictError';
  }
}

export class ConflictError extends AppError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('conflict', message, options);
    this.name = 'ConflictError';
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('payload_too_large', message, options);
    this.name = 'PayloadTooLargeError';
  }
}

export class CursorInvalidError extends AppError {
  readonly details?: Record<string, string>;

  constructor(
    message = DEFAULT_MESSAGE.cursor_invalid,
    details?: Record<string, unknown>,
    options?: { cause?: unknown },
  ) {
    super('cursor_invalid', message, options);
    this.name = 'CursorInvalidError';
    this.details = safeDetails(details);
  }
}

export class UnsupportedVersionError extends AppError {
  constructor(
    message = DEFAULT_MESSAGE.unsupported_version,
    options?: { cause?: unknown },
  ) {
    super('unsupported_version', message, options);
    this.name = 'UnsupportedVersionError';
  }
}

export class VersionMismatchError extends AppError {
  constructor(
    message = DEFAULT_MESSAGE.version_mismatch,
    options?: { cause?: unknown },
  ) {
    super('version_mismatch', message, options);
    this.name = 'VersionMismatchError';
  }
}

export class RateLimitedError extends AppError {
  constructor(message = DEFAULT_MESSAGE.rate_limited, options?: { cause?: unknown }) {
    super('rate_limited', message, options);
    this.name = 'RateLimitedError';
  }
}

export class InternalError extends AppError {
  constructor(message = DEFAULT_MESSAGE.internal, options?: { cause?: unknown }) {
    super('internal', message, options);
    this.name = 'InternalError';
  }
}

// ── Request-scoped context keys ─────────────────────────────────────────────
export const REQUEST_ID_KEY = 'requestId';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Build a frozen error envelope.  Always uses the code's fixed default
 *  message — never err.message or other potentially-untrusted input. */
export function buildErrorResponse(
  requestId: string,
  code: ErrorCode,
  details?: Record<string, unknown>,
): ErrorResponse {
  return {
    requestId,
    error: {
      code,
      message: DEFAULT_MESSAGE[code],
      ...(details !== undefined ? { details } : {}),
    },
  };
}

// ── HTTP → error-code mapping ───────────────────────────────────────────────
// Maps Hono HTTPException status codes to frozen error codes.
// The response status is always derived from errorCodeToStatus[code] so that
// the client sees a consistent code/status pair — never a raw 401 with an
// invalid_request code.

const httpStatusToCode: Record<number, ErrorCode> = {
  400: 'invalid_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  405: 'invalid_request',
  409: 'conflict',
  413: 'payload_too_large',
  415: 'invalid_request',
  429: 'rate_limited',
};

function httpStatusToErrorCode(status: number): ErrorCode {
  return httpStatusToCode[status] ?? (status >= 500 ? 'internal' : 'invalid_request');
}

// ── Hono global error handler ───────────────────────────────────────────────
// Catches any unhandled error from route handlers or middleware and returns
// a frozen error envelope.  NEVER leaks stack traces, SQL, payloads, prompts,
// secrets, or provider responses — the response message is always the
// code's DEFAULT_MESSAGE, and logging uses structured safe fields only.

export function globalErrorHandler(err: Error, c: Context): Response {
  const requestId = (c.get(REQUEST_ID_KEY) as string) ?? 'unknown';

  // AppError: domain error with frozen code.  The response uses the code's
  // default message — err.message is NEVER echoed to the client.
  if (err instanceof AppError) {
    const status = errorCodeToStatus[err.code] as number;
    const body: ErrorResponse = err instanceof InvalidRequestError || err instanceof CursorInvalidError
      ? buildErrorResponse(requestId, err.code, err.details)
      : buildErrorResponse(requestId, err.code);
    return c.json(body, status as never);
  }

  // Hono HTTPException: map through stable code table, then derive status
  // from the code — never preserve the raw exception status verbatim.
  if (err instanceof HTTPException) {
    const code = httpStatusToErrorCode(err.status);
    const status = errorCodeToStatus[code] as number;
    const body = buildErrorResponse(requestId, code);
    return c.json(body, status as never);
  }

  // Unknown error: log structured safe fields only — no raw message, stack,
  // payload, SQL, secrets, or provider responses.
  console.error(
    JSON.stringify({
      event: 'unhandled_error',
      requestId,
      errorClass: err.constructor.name,
      method: c.req.method,
      pathname: c.req.path,
    }),
  );
  const body = buildErrorResponse(requestId, 'internal');
  return c.json(body, 500 as never);
}

// ── Hono not-found handler ──────────────────────────────────────────────────

export function notFoundHandler(c: Context): Response {
  const requestId = (c.get(REQUEST_ID_KEY) as string) ?? 'unknown';
  const body = buildErrorResponse(requestId, 'not_found');
  return c.json(body, 404 as never);
}
