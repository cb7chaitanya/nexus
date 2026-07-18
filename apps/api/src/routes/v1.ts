import { ApiError, cursorPaginationSchema, parseOrThrow } from "@raas/shared";
import { withTenantTransaction } from "@raas/db";
import type { FastifyInstance } from "fastify";

import { paginate } from "../lib/pagination.js";
import { requireApiKeyAuth } from "../plugins/api-key-auth.js";

/**
 * The API-key-authenticated public surface (docs/architecture.md §5's
 * "Public API" section) — everything under here is reached exclusively
 * via requireApiKeyAuth (Authorization: Bearer <api_key>), never a
 * session cookie. Only the one read-only endpoint architecture.md already
 * documents that this ticket's scope covers; the rest of that section
 * (/v1/knowledge-bases/:id/query, /v1/knowledge-bases/:id/chat, POST
 * .../documents) is a separate, larger ticket, same as api-keys.ts's own
 * "out of scope" note previously said about API-key auth itself.
 *
 * Unlike the dashboard's GET /kb/:id/documents (routes/knowledge-bases.ts),
 * there is no organizationId to accept from the caller at all: the API
 * key IS the tenant context (see plugins/api-key-auth.ts), so a knowledge
 * base id belonging to a different organization than the one the caller's
 * key resolves to is indistinguishable from one that doesn't exist —
 * the same "404, not 403" convention every other cross-tenant boundary in
 * this codebase already uses, here enforced by RLS (withTenantTransaction
 * scoped to request.apiKeyOrganizationId) rather than an application-level
 * check.
 */
export async function v1Routes(app: FastifyInstance): Promise<void> {
  app.get("/v1/knowledge-bases/:id/documents", { preHandler: requireApiKeyAuth }, async (request, reply) => {
    const { id: knowledgeBaseId } = request.params as { id: string };
    const input = parseOrThrow(cursorPaginationSchema, request.query);
    const organizationId = request.apiKeyOrganizationId;
    if (!organizationId) throw ApiError.unauthorized();

    const documents = await withTenantTransaction(organizationId, async (tx) => {
      const knowledgeBase = await tx.knowledgeBase.findUnique({ where: { id: knowledgeBaseId } });
      if (!knowledgeBase || knowledgeBase.status !== "ACTIVE") {
        return null;
      }

      // DELETED excluded, same convention as every other document listing
      // in this codebase (routes/knowledge-bases.ts).
      return tx.document.findMany({
        where: { knowledgeBaseId, status: { not: "DELETED" } },
        orderBy: { createdAt: "desc" },
        take: input.limit,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      });
    });

    if (documents === null) {
      throw ApiError.notFound("Knowledge base not found");
    }

    reply.send(paginate(documents, input.limit));
  });
}
