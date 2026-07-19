/**
 * API Key token generation, hashing, Bearer header parsing, and secure comparison.
 *
 * Security invariants (N7):
 * - Tokens are high-entropy random strings (256-bit).
 * - Only SHA-256 hashes are stored in the database; plaintext is shown once at mint.
 * - Database `key_...` IDs are NOT the secret token; they are stable identifiers.
 * - Timing-safe comparison prevents timing attacks.
 * - Plaintext tokens are NEVER logged.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const TOKEN_BYTES = 32; // 256-bit entropy
const TOKEN_PREFIX = 'tm_';
const HASH_ALGORITHM = 'sha256';

/**
 * Generate a high-entropy plaintext API key token.
 *
 * Format: `tm_<base64url>` where the random part is 256 bits.
 * The prefix helps identify the string as a teamem API key.
 *
 * SECURITY: The returned plaintext must be shown to the user exactly once
 * and then discarded. It must NEVER be logged, stored, or included in
 * error messages, audit records, or any persistent output.
 */
export function generateApiKeyToken(): string {
  const randomPart = randomBytes(TOKEN_BYTES)
    .toString('base64url')
    .replace(/=/g, ''); // strip padding for cleaner tokens
  return `${TOKEN_PREFIX}${randomPart}`;
}

/**
 * Compute the SHA-256 hash of an API key token.
 *
 * This is the value stored in the `api_keys.token_hash` column.
 * The original plaintext is never persisted.
 */
export function hashToken(token: string): string {
  return createHash(HASH_ALGORITHM).update(token, 'utf8').digest('hex');
}

/**
 * Verify a plaintext token against a stored SHA-256 hash.
 *
 * Uses timing-safe comparison to prevent timing attacks.
 * Returns `true` if the token matches, `false` otherwise.
 */
export function verifyToken(token: string, storedHash: string): boolean {
  const computedHash = hashToken(token);
  const hashBuffer = Buffer.from(storedHash, 'hex');
  const computedBuffer = Buffer.from(computedHash, 'hex');

  if (hashBuffer.length !== computedBuffer.length) {
    return false;
  }

  return timingSafeEqual(hashBuffer, computedBuffer);
}

/**
 * Parse and validate an Authorization header value.
 *
 * Accepts only: `Bearer <token>` (case-insensitive scheme).
 * Returns the token string if valid, or `null` for any malformed input.
 *
 * Valid tokens match: /^tm_[A-Za-z0-9_-]{40,}$/
 * (base64url without padding, 32 bytes = ~43 chars)
 */
export function parseBearerToken(authorizationHeader: string | null): string | null {
  if (!authorizationHeader) {
    return null;
  }

  // Strict: exactly "Bearer " prefix, case-insensitive scheme
  const match = /^Bearer\s+(tm_[A-Za-z0-9_-]{40,})$/i.exec(authorizationHeader.trim());
  if (!match?.[1]) {
    return null;
  }

  return match[1] ?? null;
}

/**
 * Extract a key ID prefix for logging/display purposes.
 * Returns the first 8 characters of a key ID (e.g., "key_abc1").
 * This is safe for logs; it is NOT the secret token.
 */
export function keyIdPrefix(keyId: string): string {
  return keyId.length > 8 ? keyId.slice(0, 8) : keyId;
}
