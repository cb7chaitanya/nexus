import { prisma, setTenantContext } from "@raas/db";
import type { Organization, User } from "@raas/db";

import { generateUniqueSlug } from "./slugify.js";

export interface CreateUserWithOrganizationInput {
  email: string;
  name?: string | null;
  organizationName: string;
  organizationSlug?: string;
  passwordHash?: string | null;
  googleId?: string | null;
  emailVerified: boolean;
}

/**
 * Every account (password+OTP, or Google) is created the same way: a
 * User, a fresh Organization, and an OWNER membership, all in one
 * transaction — factored out of the OTP-verify handler so the Google
 * OAuth callback (routes/auth.ts) can reuse it exactly rather than
 * re-implementing the same atomicity.
 */
export async function createUserWithOrganization(
  input: CreateUserWithOrganizationInput,
): Promise<{ user: User; organization: Organization }> {
  const slug = await generateUniqueSlug(
    input.organizationSlug ?? input.organizationName,
    async (candidate) => (await prisma.organization.findUnique({ where: { slug: candidate } })) !== null,
  );

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email: input.email,
        name: input.name,
        passwordHash: input.passwordHash,
        googleId: input.googleId,
        emailVerified: input.emailVerified,
      },
    });
    const organization = await tx.organization.create({ data: { name: input.organizationName, slug } });
    await setTenantContext(tx, organization.id);
    await tx.organizationMember.create({ data: { organizationId: organization.id, userId: user.id, role: "OWNER" } });
    return { user, organization };
  });
}
