import type { LLMMessage } from "@raas/providers";
import type { Conversation, Prisma } from "@raas/db";
import { ApiError } from "@raas/shared";

const TITLE_MAX_CHARS = 60;

function deriveTitle(firstMessage: string): string {
  const trimmed = firstMessage.trim();
  return trimmed.length > TITLE_MAX_CHARS ? `${trimmed.slice(0, TITLE_MAX_CHARS)}…` : trimmed;
}

/**
 * Chat flow step 1: resolves an existing conversation, or creates a new
 * one. Ownership is enforced the same way every other resource in this
 * schema enforces it — RLS scopes the lookup to this org, and an explicit
 * knowledgeBaseId check catches a conversationId that's real but belongs
 * to a different KB within the same org; either case is a 404, not
 * distinguishable to the caller. Any org member may continue any
 * conversation in their org — no finer ACL than org membership, matching
 * architecture.md §7's stated MVP scope for every other resource.
 */
export async function findOrCreateConversation(
  tx: Prisma.TransactionClient,
  params: { organizationId: string; userId: string; knowledgeBaseId: string; conversationId?: string; firstMessage: string },
): Promise<Conversation> {
  if (params.conversationId) {
    const existing = await tx.conversation.findUnique({ where: { id: params.conversationId } });
    if (!existing || existing.knowledgeBaseId !== params.knowledgeBaseId) {
      throw ApiError.notFound("Conversation not found");
    }
    return existing;
  }

  return tx.conversation.create({
    data: {
      organizationId: params.organizationId,
      userId: params.userId,
      knowledgeBaseId: params.knowledgeBaseId,
      title: deriveTitle(params.firstMessage),
    },
  });
}

/**
 * Chat flow step 2: loads the last `limit` messages, oldest-first (for
 * correct chronological prompt ordering — Postgres gives them back
 * newest-first from the `take` query, so this reverses in memory), mapped
 * into LLMMessage entries for @raas/core's buildChatMessages history
 * parameter. `content` on a persisted Message is always the clean,
 * marker-stripped text already shown to the client (see the Message model
 * comment in schema.prisma), so replaying it back into a future prompt
 * never reintroduces a raw [[chunk:refId]] marker.
 */
export async function loadConversationHistory(tx: Prisma.TransactionClient, conversationId: string, limit: number): Promise<LLMMessage[]> {
  const messages = await tx.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  return messages.reverse().map((m) => ({ role: m.role === "USER" ? ("user" as const) : ("assistant" as const), content: m.content }));
}
