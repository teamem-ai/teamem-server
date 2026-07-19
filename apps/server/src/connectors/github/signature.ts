/**
 * GitHub webhook signature verification — constant-time HMAC-SHA256 from raw bytes.
 *
 * Verifies the `x-hub-signature-256` header against the exact request body
 * bytes *before* any JSON.parse() runs. This is the hard constraint that
 * prevents timing attacks and ensures the signed payload is the one processed.
 *
 * Design:
 *   - Uses Node.js `crypto.timingSafeEqual` for constant-time comparison.
 *   - Normalizes the header name to lowercase (GitHub sends `x-hub-signature-256`,
 *     but HTTP headers are case-insensitive per RFC 7230).
 *   - Throws `SignatureVerificationError` (code: `unauthorized`) on any failure —
 *     the caller maps that to HTTP 401.
 *   - The expected format is `sha256=<lowercase-hex>`.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError } from '../../http/errors.js';

/**
 * Typed error for webhook signature verification failures.
 * Maps to error code `unauthorized` (HTTP 401) via the frozen error envelope.
 *
 * Distinct from `UnauthorizedError` so callers can distinguish signature
 * failures (connector-level) from generic auth failures (middleware-level).
 */
export class SignatureVerificationError extends AppError {
  constructor(message = 'Webhook signature verification failed', options?: { cause?: unknown }) {
    super('unauthorized', message, options);
    this.name = 'SignatureVerificationError';
  }
}

const SIGNATURE_PREFIX = 'sha256=';

/**
 * Look up a header by case-insensitive name from a Record<string, string | undefined>.
 * HTTP headers are case-insensitive (RFC 7230 §3.2); GitHub sends
 * `x-hub-signature-256` but intermediary code may normalize differently.
 */
export function getHeaderCaseInsensitive(
  headers: Record<string, string | undefined>,
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

/**
 * Verify a GitHub webhook signature against raw request body bytes.
 *
 * @param rawBody     - The exact bytes received (before any JSON parse).
 * @param signatureHeader - The value of the `x-hub-signature-256` header (or undefined if absent).
 * @param secret      - The webhook secret configured for this GitHub App/installation.
 * @throws {SignatureVerificationError} If the signature is missing, malformed, or does not match.
 */
export function verifyGitHubSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): void {
  if (!signatureHeader || !signatureHeader.startsWith(SIGNATURE_PREFIX)) {
    throw new SignatureVerificationError(
      'Missing or malformed x-hub-signature-256 header',
    );
  }

  const providedHex = signatureHeader.slice(SIGNATURE_PREFIX.length);
  if (!/^[0-9a-f]{64}$/i.test(providedHex)) {
    throw new SignatureVerificationError(
      'Signature contains non-hex characters',
    );
  }

  const expectedMac = createHmac('sha256', secret).update(rawBody).digest();
  const providedMac = Buffer.from(providedHex, 'hex');

  if (expectedMac.length !== providedMac.length) {
    throw new SignatureVerificationError('Signature length mismatch');
  }

  if (!timingSafeEqual(expectedMac, providedMac)) {
    throw new SignatureVerificationError('Signature does not match');
  }
}
