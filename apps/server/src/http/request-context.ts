/**
 * Request-ID middleware — accepts an incoming `x-request-id` header or
 * generates a fresh UUID, stores it in the Hono context, and sets the
 * response header so callers can correlate requests.
 *
 * The `requestId` is available downstream via `c.get('requestId')` and
 * is included in every error and success envelope produced by the
 * centralized error handler (errors.ts).
 */
import { randomUUID } from 'node:crypto';
import type { Context, Next } from 'hono';
import { REQUEST_ID_KEY } from './errors.js';

/**
 * Hono middleware that ensures every request carries a request ID.
 *
 * - If the incoming request has a non-empty `x-request-id` header, it is
 *   reused (caller-provided correlation).
 * - Otherwise a new UUID v4 is generated.
 * - The ID is stored in the Hono context (`c.set('requestId', id)`) and
 *   echoed back in the `x-request-id` response header.
 */
export async function requestContext(c: Context, next: Next): Promise<void> {
  const incoming = c.req.header('x-request-id');
  const id = incoming && incoming.trim().length > 0 ? incoming.trim() : randomUUID();
  c.set(REQUEST_ID_KEY, id);
  await next();
  c.header('x-request-id', id);
}
