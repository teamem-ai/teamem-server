/**
 * SHA-256 payload hash over canonical JSON (N1).
 *
 * Computes `sha256(canonical_json(payload))` as a lowercase hex string.
 * The payload MUST already be redacted (private tags stripped) before
 * hashing — this module does not strip content itself.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical-json.js';

export function payloadHash(value: unknown): string {
  const canonical = canonicalJson(value);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Compute the UTF-8 byte length of the canonical JSON representation.
 * Useful for storing payload size without re-serializing.
 */
export function payloadByteLength(value: unknown): number {
  return Buffer.byteLength(canonicalJson(value), 'utf8');
}
