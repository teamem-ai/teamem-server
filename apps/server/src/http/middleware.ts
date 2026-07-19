/**
 * Shared HTTP middleware (AGPL-3.0-only).
 *
 * - enforceBodyLimit: rejects requests exceeding the contract body limit
 *   (5 MB, frozen contract ②). Applied per-route so /healthz stays lightweight.
 */
import type { Context, Next } from 'hono';
import { PayloadTooLargeError } from './errors.js';

export const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB batch limit (contract ②)

export function enforceBodyLimit(limit = MAX_BODY_BYTES) {
  return async (c: Context, next: Next) => {
    const contentLength = c.req.header('content-length');
    if (contentLength && Number(contentLength) > limit) {
      throw new PayloadTooLargeError(`Body exceeds ${limit} bytes`);
    }
    await next();
  };
}
