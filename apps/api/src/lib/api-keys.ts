import { createHash, randomBytes } from "node:crypto";

import { prisma } from "@raas/db";

// Visible, non-secret prefix for identification in the dashboard/list
// endpoint — long enough to tell keys apart at a glance, far too short
// (relative to the ~32 bytes of entropy after it) to help brute-force
// anything.
const PREFIX_LENGTH = 12;

export interface GeneratedApiKey {
  /** Shown to the caller exactly once (POST response), never stored. */
  raw: string;
  /** Stored alongside the hash — safe to display forever after. */
  prefix: string;
}

/** `rk_live_` + 32 random bytes, base64url-encoded — mirrors
 * generateInviteToken's shape (apps/api/src/lib/invites.ts), just with a
 * recognizable prefix so a leaked key is identifiable as this platform's
 * in a secret scanner. */
export function generateApiKey(): GeneratedApiKey {
  const raw = `rk_live_${randomBytes(32).toString("base64url")}`;
  return { raw, prefix: raw.slice(0, PREFIX_LENGTH) };
}

/** SHA-256 of the raw key — see schema.prisma's ApiKey model comment for
 * why this is SHA-256, not argon2, mirroring hashInviteToken exactly. */
export function hashApiKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * Updates lastUsedAt for a key. Not called by any route in this ticket —
 * there is no API-key-authenticated request path yet (see
 * docs/architecture.md's "Public API" section, out of scope here); this
 * is the ready-to-use integration point a future one calls on every
 * successful key verification, kept alongside the rest of this file's key
 * lifecycle logic rather than left for that ticket to invent from
 * scratch. Best-effort by design: a lastUsedAt update failing should
 * never fail the request that was actually using the key.
 *
 * Plain `prisma`, not withTenantTransaction — ApiKey has no RLS policy
 * (see schema.prisma's comment on the model), so organizationId is an
 * explicit application-level filter here, same as every OrganizationInvite
 * query in this codebase.
 */
export async function recordApiKeyUsage(organizationId: string, keyId: string): Promise<void> {
  await prisma.apiKey.updateMany({ where: { id: keyId, organizationId }, data: { lastUsedAt: new Date() } });
}
