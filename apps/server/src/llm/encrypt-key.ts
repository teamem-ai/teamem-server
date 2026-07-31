/**
 * AES-256-GCM encryption for LLM provider API keys (DUA-237).
 *
 * BYO LLM keys must be stored encrypted (reversible) because the server
 * needs the plaintext to make provider API calls. This is fundamentally
 * different from API key auth where we only need to verify a hash.
 *
 * Encryption key: TEAMEM_LLM_ENCRYPTION_KEY env var (64 hex chars = 32 bytes).
 * If not set, LLM config writes are rejected.
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits for GCM
const AUTH_TAG_LENGTH = 16; // 128 bits

function getEncryptionKey(): Buffer {
  const hex = process.env['TEAMEM_LLM_ENCRYPTION_KEY'];
  if (!hex || hex.length !== 64) {
    throw new Error(
      'TEAMEM_LLM_ENCRYPTION_KEY must be 64 hex characters (32 bytes) to encrypt LLM provider keys',
    );
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Encrypt a plaintext API key. Returns a hex-encoded string:
 *   iv (12 bytes) + ciphertext + authTag (16 bytes) → hex
 */
export function encryptApiKey(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Format: iv + ciphertext + authTag, all hex-encoded
  return Buffer.concat([iv, encrypted, authTag]).toString('hex');
}

/**
 * Decrypt a hex-encoded encrypted API key back to plaintext.
 * Returns null if the ciphertext is malformed.
 */
export function decryptApiKey(hexCiphertext: string): string | null {
  try {
    const key = getEncryptionKey();
    const data = Buffer.from(hexCiphertext, 'hex');
    const iv = data.subarray(0, IV_LENGTH);
    const authTag = data.subarray(data.length - AUTH_TAG_LENGTH);
    const encrypted = data.subarray(IV_LENGTH, data.length - AUTH_TAG_LENGTH);
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
