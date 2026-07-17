import { z } from "zod";

import { emailSchema, slugSchema } from "./auth.js";
import { cursorPaginationSchema } from "./pagination.js";

export const orgRoleSchema = z.enum(["OWNER", "ADMIN", "MEMBER"]);

export const createOrganizationSchema = z.object({
  name: z.string().trim().min(1).max(200),
  slug: slugSchema.optional(),
});
export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;

// OWNER is deliberately excluded from invitable roles: an invite is
// accepted by anyone who has the token and a matching email, so allowing
// an invite to directly grant OWNER would let any ADMIN who can send
// invites mint new OWNERs with no further safeguard. OWNER can only be
// granted afterward, via changeMemberRoleSchema, by an existing OWNER.
export const inviteMemberSchema = z.object({
  email: emailSchema,
  role: z.enum(["ADMIN", "MEMBER"]),
});
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;

export const acceptInviteSchema = z.object({
  token: z.string().min(1, "token is required"),
});
export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>;

export const changeMemberRoleSchema = z.object({
  role: orgRoleSchema,
});
export type ChangeMemberRoleInput = z.infer<typeof changeMemberRoleSchema>;

export const listMembersQuerySchema = cursorPaginationSchema;
export type ListMembersQuery = z.infer<typeof listMembersQuerySchema>;

// PATCH /organizations/:id — plan is a free-text-ish enum here (no
// billing integration exists yet to validate against), matching
// Organization.plan's own "free | pro | enterprise" comment in
// schema.prisma.
export const updateOrganizationSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  plan: z.enum(["free", "pro", "enterprise"]).optional(),
});
export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;

export const createWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(200),
  slug: slugSchema.optional(),
});
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>;

export const updateWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(200),
});
export type UpdateWorkspaceInput = z.infer<typeof updateWorkspaceSchema>;

export const listWorkspacesQuerySchema = cursorPaginationSchema;
export type ListWorkspacesQuery = z.infer<typeof listWorkspacesQuerySchema>;
