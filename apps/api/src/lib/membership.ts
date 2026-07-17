import { ApiError } from "@raas/shared";
import { withTenantTransaction } from "@raas/db";
import type { OrgRole } from "@raas/db";
import type { FastifyRequest } from "fastify";

/**
 * Confirms `userId` belongs to `organizationId` and returns their role.
 * Throws 404 (not 403) when they don't — a non-member should not be able
 * to distinguish "not a member" from "org doesn't exist". Used by every
 * route where the organization context comes from the request body/query
 * rather than a `:id` URL param (see plugins/auth-guard.ts's
 * requireOrgMembership for the URL-param version, which delegates here).
 *
 * `request` is required — not just for the ApiError above, but because
 * this is THE single chokepoint every tenant-scoped route already passes
 * through before touching org data, so it's also where organizationId
 * gets bound onto request.log for the rest of the request (see
 * @raas/logger's LogBindings). Bound once membership is actually
 * confirmed, not before — an organizationId the caller merely claimed
 * but doesn't belong to shouldn't show up in logs as if it were real
 * request context.
 */
export async function requireMembership(request: FastifyRequest, organizationId: string, userId: string): Promise<OrgRole> {
  const membership = await withTenantTransaction(organizationId, (tx) =>
    tx.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
    }),
  );

  if (!membership) {
    throw ApiError.notFound("Organization not found");
  }

  request.log = request.log.child({ organizationId });

  return membership.role;
}
