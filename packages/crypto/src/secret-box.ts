import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

/**
 * Parses and validates a base64-encoded 32-byte AES-256 key — used for
 * both encrypt and decrypt so a misconfigured key (wrong length, not
 * valid base64) fails loudly at the call site rather than producing a
 * ciphertext that silently can't be decrypted later, or an
 * authentication failure with no indication why.
 */
function parseKey(keyBase64: string): Buffer {
  const key = Buffer.from(keyBase64, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(`Encryption key must be ${KEY_BYTES} bytes when base64-decoded, got ${key.length}.`);
  }
  return key;
}

/**
 * Encrypts a secret (e.g. a customer-supplied LLM provider API key)
 * for storage. AES-256-GCM with a random IV per call — never reuse an
 * IV with the same key, which is why this generates a fresh one every
 * time rather than accepting one as a parameter. Output is a single
 * base64 string: iv (12 bytes) || authTag (16 bytes) || ciphertext,
 * self-contained so decryptSecret needs nothing else to reverse it.
 */
export function encryptSecret(plaintext: string, keyBase64: string): string {
  const key = parseKey(keyBase64);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

/**
 * Reverses encryptSecret. Throws (GCM's built-in authentication failure)
 * if the ciphertext was tampered with, truncated, or encrypted under a
 * different key — never returns a "best guess" plaintext.
 */
export function decryptSecret(payload: string, keyBase64: string): string {
  const key = parseKey(keyBase64);
  const raw = Buffer.from(payload, "base64");
  if (raw.length < IV_BYTES + AUTH_TAG_BYTES) {
    throw new Error("Encrypted payload is too short to contain an IV and auth tag.");
  }

  const iv = raw.subarray(0, IV_BYTES);
  const authTag = raw.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES);
  const ciphertext = raw.subarray(IV_BYTES + AUTH_TAG_BYTES);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
