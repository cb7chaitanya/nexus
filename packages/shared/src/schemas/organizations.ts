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
