import { ApiError } from "@raas/shared";
import type { OrgRole } from "@raas/db";

const ROLE_RANK: Record<OrgRole, number> = { MEMBER: 0, ADMIN: 1, OWNER: 2 };

export function hasAtLeastRole(role: OrgRole, min: OrgRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

/**
 * Rules (see docs/decisions.md for the reasoning):
 *  - Only an OWNER can grant OWNER — an ADMIN cannot mint new owners.
 *  - Only an OWNER can change another OWNER's role at all (promote a
 *    MEMBER/ADMIN is an ADMIN-or-OWNER operation; touching an existing
 *    OWNER's role is OWNER-only).
 *  - The last remaining OWNER of an org can never be demoted — there must
 *    always be at least one.
 * Throws an ApiError on any violation; callers don't need to separately
 * check a boolean.
 */
export function assertCanSetRole(params: {
  callerRole: OrgRole;
  targetCurrentRole: OrgRole;
  newRole: OrgRole;
  isLastOwner: boolean;
}): void {
  const { callerRole, targetCurrentRole, newRole, isLastOwner } = params;

  if (newRole === "OWNER" && callerRole !== "OWNER") {
    throw ApiError.forbidden("Only an owner can grant owner permissions");
  }

  if (targetCurrentRole === "OWNER" && newRole !== "OWNER") {
    if (callerRole !== "OWNER") {
      throw ApiError.forbidden("Only an owner can change another owner's role");
    }
    if (isLastOwner) {
      throw ApiError.conflict("Cannot change the role of the last owner of an organization");
    }
  }
}

/**
 * Rules:
 *  - The last remaining OWNER can never be removed, by themselves or
 *    anyone else — ownership must be transferred (via assertCanSetRole)
 *    to someone else first.
 *  - Anyone may remove themselves (leave an org), subject to the above.
 *  - A MEMBER may not remove anyone but themselves.
 *  - Only an OWNER may remove another OWNER.
 */
export function assertCanRemoveMember(params: {
  callerRole: OrgRole;
  targetRole: OrgRole;
  isSelf: boolean;
  isLastOwner: boolean;
}): void {
  const { callerRole, targetRole, isSelf, isLastOwner } = params;

  if (targetRole === "OWNER" && isLastOwner) {
    throw ApiError.conflict(
      "Cannot remove the last owner of an organization — transfer ownership first",
    );
  }

  if (isSelf) {
    return;
  }

  if (callerRole === "MEMBER") {
    throw ApiError.forbidden("Members cannot remove other members");
  }

  if (targetRole === "OWNER" && callerRole !== "OWNER") {
    throw ApiError.forbidden("Only an owner can remove another owner");
  }
}
