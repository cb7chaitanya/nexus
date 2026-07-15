import { createHash, randomBytes } from "node:crypto";

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The raw, high-entropy token handed to the invitee — never stored, shown exactly once. */
export function generateInviteToken(): string {
  return randomBytes(32).toString("base64url");
}

/** SHA-256 of the raw token — what's actually stored, mirroring the ApiKey pattern in architecture.md. */
export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
