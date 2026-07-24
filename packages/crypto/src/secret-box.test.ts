import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { decryptSecret, encryptSecret } from "./secret-box.js";

function testKey(): string {
  return randomBytes(32).toString("base64");
}

describe("encryptSecret / decryptSecret", () => {
  it("round-trips a plaintext secret", () => {
    const key = testKey();
    const plaintext = "sk-live-real-provider-key-abc123";
    const ciphertext = encryptSecret(plaintext, key);
    expect(ciphertext).not.toContain(plaintext);
    expect(decryptSecret(ciphertext, key)).toBe(plaintext);
  });

  it("produces a different ciphertext each time (random IV)", () => {
    const key = testKey();
    const a = encryptSecret("same-plaintext", key);
    const b = encryptSecret("same-plaintext", key);
    expect(a).not.toBe(b);
  });

  it("rejects a ciphertext decrypted with the wrong key", () => {
    const ciphertext = encryptSecret("secret", testKey());
    expect(() => decryptSecret(ciphertext, testKey())).toThrow();
  });

  it("rejects a tampered ciphertext (GCM auth tag catches it)", () => {
    const key = testKey();
    const ciphertext = encryptSecret("secret", key);
    const raw = Buffer.from(ciphertext, "base64");
    raw[raw.length - 1] = raw[raw.length - 1]! ^ 0xff;
    expect(() => decryptSecret(raw.toString("base64"), key)).toThrow();
  });

  it("rejects a key that isn't 32 bytes when base64-decoded", () => {
    const shortKey = Buffer.from("too-short").toString("base64");
    expect(() => encryptSecret("secret", shortKey)).toThrow(/32 bytes/);
  });

  it("rejects a payload too short to contain an IV and auth tag", () => {
    const key = testKey();
    expect(() => decryptSecret(Buffer.from("short").toString("base64"), key)).toThrow(/too short/);
  });
});
