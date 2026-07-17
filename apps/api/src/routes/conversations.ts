import { withTenantTransaction } from "@raas/db";
import { ApiError, getConversationQuerySchema, listConversationsQuerySchema, listMessagesQuerySchema, parseOrThrow } from "@raas/shared";
import type { FastifyInstance } from "fastify";

import { requireMembership } from "../lib/membership.js";
import { paginate } from "../lib/pagination.js";
import { requireAuth } from "../plugins/auth-guard.js";

// Cursor pagination, most-recent-first: both list endpoints below default
// to the newest page (matching how a chat UI actually loads — the latest
// conversation/messages first), and a `cursor` (the last id seen on the
// current page) pages backward into older history.

export async function conversationRoutes(app: FastifyInstance): Promise<void> {
  app.get("/conversations", { preHandler: requireAuth }, async (request, reply) => {
    const input = parseOrThrow(listConversationsQuerySchema, request.query);
    const userId = request.userId;
    if (!userId) throw ApiError.unauthorized();

    await requireMembership(request, input.organizationId, userId);

    const conversations = await withTenantTransaction(input.organizationId, (tx) =>
      tx.conversation.findMany({
        where: input.knowledgeBaseId ? { knowledgeBaseId: input.knowledgeBaseId } : undefined,
        orderBy: { createdAt: "desc" },
        take: input.limit,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      }),
    );

    reply.send(paginate(conversations, input.limit));
  });

  app.get("/conversations/:id", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = parseOrThrow(getConversationQuerySchema, request.query);
    const userId = request.userId;
    if (!userId) throw ApiError.unauthorized();

    await requireMembership(request, input.organizationId, userId);

    // Ownership: scoped to this org's tenant context, so a conversation
    // id belonging to another org is indistinguishable from a
    // nonexistent one — RLS enforces this, matching every other resource
    // in this codebase.
    const conversation = await withTenantTransaction(input.organizationId, (tx) => tx.conversation.findUnique({ where: { id } }));
    if (!conversation) {
      throw ApiError.notFound("Conversation not found");
    }

    reply.send(conversation);
  });

  app.get("/conversations/:id/messages", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = parseOrThrow(listMessagesQuerySchema, request.query);
    const userId = request.userId;
    if (!userId) throw ApiError.unauthorized();

    await requireMembership(request, input.organizationId, userId);

    const messages = await withTenantTransaction(input.organizationId, async (tx) => {
      const conversation = await tx.conversation.findUnique({ where: { id } });
      if (!conversation) {
        throw ApiError.notFound("Conversation not found");
      }

      return tx.message.findMany({
        where: { conversationId: id },
        orderBy: { createdAt: "desc" },
        take: input.limit,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      });
    });

    reply.send(paginate(messages, input.limit));
  });
}
