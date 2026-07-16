import { ApiError } from "@raas/shared";
import { withTenantTransaction } from "@raas/db";
import type { OrgRole } from "@raas/db";

/**
 * Confirms `userId` belongs to `organizationId` and returns their role.
 * Throws 404 (not 403) when they don't — a non-member should not be able
 * to distinguish "not a member" from "org doesn't exist". Used by every
 * route where the organization context comes from the request body/query
 * rather than a `:id` URL param (see plugins/auth-guard.ts's
 * requireOrgMembership for the URL-param version, which delegates here).
 */
export async function requireMembership(organizationId: string, userId: string): Promise<OrgRole> {
  const membership = await withTenantTransaction(organizationId, (tx) =>
    tx.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
    }),
  );

  if (!membership) {
    throw ApiError.notFound("Organization not found");
  }

  return membership.role;
}
