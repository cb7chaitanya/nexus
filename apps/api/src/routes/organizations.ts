import {
  acceptInviteSchema,
  ApiError,
  changeMemberRoleSchema,
  createOrganizationSchema,
  inviteMemberSchema,
  parseOrThrow,
} from "@raas/shared";
import { prisma, withTenantTransaction, withUserContext } from "@raas/db";
import type { OrgRole } from "@raas/db";
import type { FastifyInstance } from "fastify";

import { generateInviteToken, hashInviteToken, INVITE_TTL_MS } from "../lib/invites.js";
import { assertCanRemoveMember, assertCanSetRole } from "../lib/roles.js";
import { generateUniqueSlug } from "../lib/slugify.js";
import { requireAuth, requireOrgMembership, requireRole } from "../plugins/auth-guard.js";

async function updateMemberRole(params: {
  organizationId: string;
  targetUserId: string;
  callerRole: OrgRole;
  newRole: OrgRole;
}) {
  const { organizationId, targetUserId, callerRole, newRole } = params;

  return withTenantTransaction(organizationId, async (tx) => {
    const target = await tx.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId: targetUserId } },
    });
    if (!target) {
      throw ApiError.notFound("Member not found");
    }

    const ownerCount = await tx.organizationMember.count({ where: { organizationId, role: "OWNER" } });
    const isLastOwner = target.role === "OWNER" && ownerCount <= 1;

    assertCanSetRole({ callerRole, targetCurrentRole: target.role, newRole, isLastOwner });

    return tx.organizationMember.update({
      where: { organizationId_userId: { organizationId, userId: targetUserId } },
      data: { role: newRole },
    });
  });
}

async function removeMember(params: {
  organizationId: string;
  targetUserId: string;
  callerRole: OrgRole;
  isSelf: boolean;
}): Promise<void> {
  const { organizationId, targetUserId, callerRole, isSelf } = params;

  await withTenantTransaction(organizationId, async (tx) => {
    const target = await tx.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId: targetUserId } },
    });
    if (!target) {
      throw ApiError.notFound("Member not found");
    }

    const ownerCount = await tx.organizationMember.count({ where: { organizationId, role: "OWNER" } });
    const isLastOwner = target.role === "OWNER" && ownerCount <= 1;

    assertCanRemoveMember({ callerRole, targetRole: target.role, isSelf, isLastOwner });

    await tx.organizationMember.delete({
      where: { organizationId_userId: { organizationId, userId: targetUserId } },
    });
  });
}

export async function organizationRoutes(app: FastifyInstance): Promise<void> {
  app.post("/organizations", { preHandler: requireAuth }, async (request, reply) => {
    const input = parseOrThrow(createOrganizationSchema, request.body);
    const userId = request.userId;
    if (!userId) throw ApiError.unauthorized();

    const slug = await generateUniqueSlug(
      input.slug ?? input.name,
      async (candidate) => (await prisma.organization.findUnique({ where: { slug: candidate } })) !== null,
    );

    const organization = await prisma.organization.create({ data: { name: input.name, slug } });

    try {
      await withTenantTransaction(organization.id, (tx) =>
        tx.organizationMember.create({
          data: { organizationId: organization.id, userId, role: "OWNER" },
        }),
      );
    } catch (err) {
      await prisma.organization.delete({ where: { id: organization.id } });
      throw err;
    }

    reply.status(201).send({ ...organization, role: "OWNER" as const });
  });

  app.get("/organizations", { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.userId;
    if (!userId) throw ApiError.unauthorized();

    const memberships = await withUserContext(userId, (tx) =>
      tx.organizationMember.findMany({ include: { organization: true } }),
    );

    reply.send({
      organizations: memberships.map((m) => ({ ...m.organization, role: m.role })),
    });
  });

  app.get(
    "/organizations/:id/members",
    { preHandler: [requireAuth, requireOrgMembership] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const members = await withTenantTransaction(id, (tx) =>
        tx.organizationMember.findMany({
          include: { user: true },
          orderBy: { createdAt: "asc" },
        }),
      );

      reply.send({
        members: members.map((m) => ({
          userId: m.userId,
          role: m.role,
          email: m.user.email,
          name: m.user.name,
          joinedAt: m.createdAt,
        })),
      });
    },
  );

  app.post(
    "/organizations/:id/invites",
    { preHandler: [requireAuth, requireOrgMembership, requireRole("ADMIN")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const input = parseOrThrow(inviteMemberSchema, request.body);
      const inviterId = request.userId;
      if (!inviterId) throw ApiError.unauthorized();

      const token = generateInviteToken();
      const hashedToken = hashInviteToken(token);

      const invite = await prisma.organizationInvite.create({
        data: {
          organizationId: id,
          email: input.email,
          role: input.role,
          hashedToken,
          invitedById: inviterId,
          expiresAt: new Date(Date.now() + INVITE_TTL_MS),
        },
      });

      // Raw token is returned exactly once — it's hashed at rest, so there
      // is no way to retrieve it again after this response. No email
      // delivery is implemented; relaying it to the invitee is out of
      // scope for this ticket.
      reply.status(201).send({
        invite: {
          id: invite.id,
          organizationId: invite.organizationId,
          email: invite.email,
          role: invite.role,
          expiresAt: invite.expiresAt,
        },
        token,
      });
    },
  );

  // Top-level, not nested under /organizations — the acceptor has no org
  // context yet; the token itself is what grants access.
  app.post("/invites/:token/accept", { preHandler: requireAuth }, async (request, reply) => {
    const input = parseOrThrow(acceptInviteSchema, request.params);
    const userId = request.userId;
    if (!userId) throw ApiError.unauthorized();

    const hashedToken = hashInviteToken(input.token);
    const invite = await prisma.organizationInvite.findUnique({ where: { hashedToken } });

    if (!invite || invite.revokedAt || invite.expiresAt < new Date()) {
      throw ApiError.notFound("Invite not found or expired");
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.email !== invite.email) {
      throw ApiError.forbidden("This invite was issued to a different email address");
    }

    const existingMembership = await withTenantTransaction(invite.organizationId, (tx) =>
      tx.organizationMember.findUnique({
        where: { organizationId_userId: { organizationId: invite.organizationId, userId } },
      }),
    );

    if (existingMembership) {
      if (!invite.acceptedAt) {
        await prisma.organizationInvite.update({ where: { id: invite.id }, data: { acceptedAt: new Date() } });
      }
      reply.send({ ...existingMembership });
      return;
    }

    const membership = await withTenantTransaction(invite.organizationId, (tx) =>
      tx.organizationMember.create({
        data: { organizationId: invite.organizationId, userId, role: invite.role },
      }),
    );

    await prisma.organizationInvite.update({ where: { id: invite.id }, data: { acceptedAt: new Date() } });

    reply.status(201).send({ ...membership });
  });

  app.patch(
    "/organizations/:id/members/:userId",
    { preHandler: [requireAuth, requireOrgMembership, requireRole("ADMIN")] },
    async (request, reply) => {
      const { id, userId: targetUserId } = request.params as { id: string; userId: string };
      const input = parseOrThrow(changeMemberRoleSchema, request.body);
      const callerRole = request.membership?.role;
      if (!callerRole) throw ApiError.unauthorized();

      const membership = await updateMemberRole({
        organizationId: id,
        targetUserId,
        callerRole,
        newRole: input.role,
      });

      reply.send({ ...membership });
    },
  );

  app.delete(
    "/organizations/:id/members/:userId",
    { preHandler: [requireAuth, requireOrgMembership] },
    async (request, reply) => {
      const { id, userId: targetUserId } = request.params as { id: string; userId: string };
      const callerRole = request.membership?.role;
      const callerId = request.userId;
      if (!callerRole || !callerId) throw ApiError.unauthorized();

      await removeMember({
        organizationId: id,
        targetUserId,
        callerRole,
        isSelf: targetUserId === callerId,
      });

      reply.status(204).send();
    },
  );
}
