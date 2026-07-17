import {
  ApiError,
  createWorkspaceSchema,
  listWorkspacesQuerySchema,
  parseOrThrow,
  updateWorkspaceSchema,
} from "@raas/shared";
import { withTenantTransaction } from "@raas/db";
import type { FastifyInstance } from "fastify";

import { paginate } from "../lib/pagination.js";
import { generateUniqueSlug } from "../lib/slugify.js";
import { requireAuth, requireOrgMembership, requireRole } from "../plugins/auth-guard.js";

/**
 * Workspace CRUD (docs/architecture.md's "Workspace decision": Option
 * B — finish it rather than leave the model dead). A workspace is a
 * logical grouping *within* an organization, e.g. "Support Team" — not a
 * second tenancy boundary (see schema.prisma's comment on the model).
 * RLS-protected exactly like OrganizationMember, so every query here goes
 * through withTenantTransaction, never a bare prisma call.
 *
 * Deliberately not wired into KnowledgeBase in this ticket — the current
 * schema has no KnowledgeBase.workspaceId column at all (unlike
 * architecture.md's original proposal), and adding one would mean
 * modifying POST/PATCH /kb's existing behavior, which is out of scope
 * for "implement missing CRUD only."
 */
export async function workspaceRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/organizations/:id/workspaces",
    { preHandler: [requireAuth, requireOrgMembership] },
    async (request, reply) => {
      const { id: organizationId } = request.params as { id: string };
      const input = parseOrThrow(createWorkspaceSchema, request.body);

      // Any member may create a workspace — same org-level, not
      // role-gated, access model as POST /kb.
      const slug = await generateUniqueSlug(input.slug ?? input.name, async (candidate) => {
        const existing = await withTenantTransaction(organizationId, (tx) =>
          tx.workspace.findUnique({ where: { organizationId_slug: { organizationId, slug: candidate } } }),
        );
        return existing !== null;
      });

      const workspace = await withTenantTransaction(organizationId, (tx) =>
        tx.workspace.create({ data: { organizationId, name: input.name, slug } }),
      );

      reply.status(201).send(workspace);
    },
  );

  app.get(
    "/organizations/:id/workspaces",
    { preHandler: [requireAuth, requireOrgMembership] },
    async (request, reply) => {
      const { id: organizationId } = request.params as { id: string };
      const input = parseOrThrow(listWorkspacesQuerySchema, request.query);

      const workspaces = await withTenantTransaction(organizationId, (tx) =>
        tx.workspace.findMany({
          orderBy: { createdAt: "asc" },
          take: input.limit,
          ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        }),
      );

      reply.send(paginate(workspaces, input.limit));
    },
  );

  app.patch(
    "/organizations/:id/workspaces/:workspaceId",
    // Mutating a shared org resource — ADMIN-or-higher, same bar as
    // PATCH /kb/:id and PATCH /organizations/:id.
    { preHandler: [requireAuth, requireOrgMembership, requireRole("ADMIN")] },
    async (request, reply) => {
      const { id: organizationId, workspaceId } = request.params as { id: string; workspaceId: string };
      const input = parseOrThrow(updateWorkspaceSchema, request.body);

      const workspace = await withTenantTransaction(organizationId, async (tx) => {
        const existing = await tx.workspace.findUnique({ where: { id: workspaceId } });
        if (!existing) {
          throw ApiError.notFound("Workspace not found");
        }
        return tx.workspace.update({ where: { id: workspaceId }, data: { name: input.name } });
      });

      reply.send(workspace);
    },
  );

  app.delete(
    "/organizations/:id/workspaces/:workspaceId",
    { preHandler: [requireAuth, requireOrgMembership, requireRole("ADMIN")] },
    async (request, reply) => {
      const { id: organizationId, workspaceId } = request.params as { id: string; workspaceId: string };

      await withTenantTransaction(organizationId, async (tx) => {
        const existing = await tx.workspace.findUnique({ where: { id: workspaceId } });
        if (!existing) {
          throw ApiError.notFound("Workspace not found");
        }
        await tx.workspace.delete({ where: { id: workspaceId } });
      });

      reply.status(204).send();
    },
  );
}
