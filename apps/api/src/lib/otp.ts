import { createHash, randomInt } from "node:crypto";

/** 6 digits, zero-padded (leading zeros allowed — a uniform 000000-999999 range, not 100000-999999). */
export function generateOtp(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

/** SHA-256 of the code — same at-rest-hashing discipline as invite tokens/API keys, even though a 6-digit code's real protection is the attempt cap, not hash secrecy. */
export function hashOtp(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}
