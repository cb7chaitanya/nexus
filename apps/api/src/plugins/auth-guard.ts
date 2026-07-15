import { ApiError } from "@raas/shared";
import { withTenantTransaction } from "@raas/db";
import type { OrgRole } from "@raas/db";
import type { FastifyReply, FastifyRequest } from "fastify";

import { resolveSession } from "../lib/session.js";
import { hasAtLeastRole } from "../lib/roles.js";

export const SESSION_COOKIE_NAME = "raas_session";

declare module "fastify" {
  interface FastifyRequest {
    userId?: string;
    sessionId?: string;
    membership?: { organizationId: string; role: OrgRole };
  }
}

/**
 * Requires a valid, non-revoked session. Decorates request.userId /
 * request.sessionId on success. This is the ONLY place a cookie is read
 * and turned into an identity — every protected route depends on this
 * having run first, never re-implements session resolution itself.
 */
export async function requireAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const token = request.cookies[SESSION_COOKIE_NAME];
  if (!token) {
    throw ApiError.unauthorized();
  }

  const session = await resolveSession(token);
  if (!session) {
    throw ApiError.unauthorized();
  }

  request.userId = session.userId;
  request.sessionId = session.sessionId;
}

/**
 * Requires the caller to be a member of the :id organization in the
 * route params. Decorates request.membership on success. Deliberately
 * returns 404 (not 403) when the caller has no membership row — whether
 * that's because the org doesn't exist or because they're just not a
 * member is not something a non-member should be able to distinguish.
 * Must run after requireAuth.
 */
export async function requireOrgMembership(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!request.userId) {
    throw ApiError.unauthorized();
  }

  const organizationId = (request.params as { id?: string }).id;
  if (!organizationId) {
    throw ApiError.notFound("Organization not found");
  }

  const userId = request.userId;
  const membership = await withTenantTransaction(organizationId, (tx) =>
    tx.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
    }),
  );

  if (!membership) {
    throw ApiError.notFound("Organization not found");
  }

  request.membership = { organizationId, role: membership.role };
}

/**
 * Factory for a preHandler requiring at least `minRole` in the org
 * resolved by requireOrgMembership. Must run after requireOrgMembership.
 */
export function requireRole(minRole: OrgRole) {
  // Must be async (or otherwise return a promise) even though it does no
  // I/O: Fastify's preHandler hook runner always invokes the hook as
  // fn(request, reply, next) and only knows a *synchronous* hook is done
  // when the hook itself calls that `next` — a plain function that just
  // returns undefined (our earlier, non-async version) makes every request
  // hang until Fastify's own timeout, since nothing ever signals
  // completion. Returning a promise is what the runner actually waits on.
  return async function requireRolePreHandler(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    if (!request.membership) {
      throw ApiError.unauthorized();
    }
    if (!hasAtLeastRole(request.membership.role, minRole)) {
      throw ApiError.forbidden(`This action requires the ${minRole} role or higher`);
    }
  };
}
