/**
 * Centralized error handling — frozen error envelope, error-code → HTTP-status
 * mapping, domain error classes, and Hono global error / not-found handlers.
 *
 * All error responses conform to the `errorResponse` shape defined in
 * `@teamem/schema`'s common.ts: `{ requestId, error: { code, message, details? } }`.
 *
 * Security: the global handler never exposes stack traces, SQL, internal
 * messages, payloads, prompts, secrets, or provider responses to clients.
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

// ── Domain error classes ────────────────────────────────────────────────────
// Each carries a frozen error code. The message must be safe for client
// exposure — callers must not embed secrets, SQL, or payloads.

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }
}

export class InvalidRequestError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('invalid_request', message, details);
    this.name = 'InvalidRequestError';
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super('unauthorized', message);
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super('forbidden', message);
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super('not_found', message);
    this.name = 'NotFoundError';
  }
}

export class IdempotencyConflictError extends AppError {
  constructor(message = 'Idempotency conflict') {
    super('idempotency_conflict', message);
    this.name = 'IdempotencyConflictError';
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super('conflict', message);
    this.name = 'ConflictError';
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message: string) {
    super('payload_too_large', message);
    this.name = 'PayloadTooLargeError';
  }
}

export class CursorInvalidError extends AppError {
  constructor(message = 'Cursor is invalid or expired') {
    super('cursor_invalid', message);
    this.name = 'CursorInvalidError';
  }
}

export class UnsupportedVersionError extends AppError {
  constructor(message = 'Unsupported version') {
    super('unsupported_version', message);
    this.name = 'UnsupportedVersionError';
  }
}

export class VersionMismatchError extends AppError {
  constructor(message = 'Version mismatch') {
    super('version_mismatch', message);
    this.name = 'VersionMismatchError';
  }
}

export class RateLimitedError extends AppError {
  constructor(message = 'Rate limited') {
    super('rate_limited', message);
    this.name = 'RateLimitedError';
  }
}

export class InternalError extends AppError {
  constructor(message = 'Internal error') {
    super('internal', message);
    this.name = 'InternalError';
  }
}

// ── Request-scoped context keys ─────────────────────────────────────────────
export const REQUEST_ID_KEY = 'requestId';

// ── Redaction helpers ───────────────────────────────────────────────────────
// Defense-in-depth: strip known secret patterns before data reaches clients
// or server logs. These are not a substitute for the design-level rule that
// domain error messages must never contain secrets — they are a last-resort
// catch for accidental leakage.

const REDACTED = '[REDACTED]';

/** Patterns that match env-var-style secrets like `SECRET=abc123`. */
const ENV_SECRET_RE = /[A-Z][A-Z_]+=[^\s"'`,\]}]*/g;

/** Patterns that match prefixed API keys / tokens (sk-, pk_, whsec_, key_). */
const PREFIXED_KEY_RE = /\b(?:sk|pk|wh|key|cred|pri)[_-][a-zA-Z0-9]{16,}/g;

/** Strip common secret patterns from a string destined for the client. */
function redactForClient(s: string): string {
  return s
    .replace(ENV_SECRET_RE, (m) => {
      const eq = m.indexOf('=');
      return m.slice(0, eq + 1) + REDACTED;
    })
    .replace(PREFIXED_KEY_RE, REDACTED);
}

/** Strip common secret patterns from a string destined for server logs. */
function redactForLog(s: string): string {
  return s
    .replace(ENV_SECRET_RE, (m) => {
      const eq = m.indexOf('=');
      return m.slice(0, eq + 1) + REDACTED;
    })
    .replace(PREFIXED_KEY_RE, REDACTED);
}

/** Redact details values recursively. */
function redactDetails(details: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(details)) {
    if (typeof v === 'string') {
      out[k] = redactForClient(v);
    } else if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = redactDetails(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Build a frozen error envelope for the given request context. */
export function buildErrorResponse(
  requestId: string,
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): ErrorResponse {
  return {
    requestId,
    error: {
      code,
      message: redactForClient(message),
      ...(details !== undefined ? { details: redactDetails(details) } : {}),
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
// a frozen error envelope. Never leaks stack traces, SQL, payloads, prompts,
// secrets, or provider responses.

export function globalErrorHandler(err: Error, c: Context): Response {
  const requestId = (c.get(REQUEST_ID_KEY) as string) ?? 'unknown';

  // AppError: domain error with frozen code — message should be safe but is
  // still run through redactForClient as defense in depth.
  if (err instanceof AppError) {
    const status = errorCodeToStatus[err.code] as number;
    const body = buildErrorResponse(requestId, err.code, err.message, err.details);
    return c.json(body, status as never);
  }

  // Hono HTTPException: map through stable code table, then derive status
  // from the code — never preserve the raw exception status verbatim.
  if (err instanceof HTTPException) {
    const code = httpStatusToErrorCode(err.status);
    const status = errorCodeToStatus[code] as number;
    const defaultMessages: Partial<Record<ErrorCode, string>> = {
      unauthorized: 'Unauthorized',
      forbidden: 'Forbidden',
      not_found: 'Not found',
      conflict: 'Conflict',
      payload_too_large: 'Payload too large',
      rate_limited: 'Rate limited',
      internal: 'Internal error',
    };
    const body = buildErrorResponse(requestId, code, defaultMessages[code] ?? 'Bad request');
    return c.json(body, status as never);
  }

  // Unknown error: never expose internals in the response or in logs
  const safeLogMessage = redactForLog(err.message);
  const safeLogStack = err.stack ? redactForLog(err.stack) : '(no stack)';
  console.error(`Unhandled error: ${safeLogMessage}\n${safeLogStack}`);
  const body = buildErrorResponse(requestId, 'internal', 'Internal error');
  return c.json(body, 500 as never);
}

// ── Hono not-found handler ──────────────────────────────────────────────────

export function notFoundHandler(c: Context): Response {
  const requestId = (c.get(REQUEST_ID_KEY) as string) ?? 'unknown';
  const body = buildErrorResponse(requestId, 'not_found', 'Not found');
  return c.json(body, 404 as never);
}
