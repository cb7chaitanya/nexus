import { createHash, randomBytes } from "node:crypto";

import { withTenantTransaction } from "@raas/db";

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
 * Updates lastUsedAt for a key. Called by requireApiKeyAuth
 * (apps/api/src/plugins/api-key-auth.ts) on every successful key
 * verification. Best-effort by design: a lastUsedAt update failing should
 * never fail the request that was actually using the key — callers should
 * not await this without a .catch, or should treat a rejection as
 * non-fatal.
 *
 * withTenantTransaction, scoped to the key's own organizationId — ApiKey
 * now has a real RLS policy (see migration 20260718100000_add_apikey_rls),
 * so this goes through the standard tenant_isolation policy like every
 * other write in this codebase, not an application-level filter.
 */
export async function recordApiKeyUsage(organizationId: string, keyId: string): Promise<void> {
  await withTenantTransaction(organizationId, (tx) => tx.apiKey.updateMany({ where: { id: keyId }, data: { lastUsedAt: new Date() } }));
}
