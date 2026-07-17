import { assembleContext, buildChatMessages, CitationMarkerFilter, embedQuery, searchSimilarChunks, validateCitations } from "@raas/core";
import { withTenantTransaction } from "@raas/db";
import { ApiError, chatSchema, parseOrThrow } from "@raas/shared";
import type { FastifyInstance, FastifyReply } from "fastify";

import { getEmbeddingProvider } from "../lib/embedding-provider.js";
import { getLLMProvider } from "../lib/llm-provider.js";
import { requireMembership } from "../lib/membership.js";
import { requireAuth } from "../plugins/auth-guard.js";

// architecture.md §4.6: top-k candidates before context assembly truncates
// to a token budget.
const TOP_K = 8;

function sendEvent(reply: FastifyReply, event: string, data: unknown): void {
  reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  app.post("/kb/:id/chat", { preHandler: requireAuth }, async (request, reply) => {
    const { id: knowledgeBaseId } = request.params as { id: string };
    const input = parseOrThrow(chatSchema, request.body);
    const userId = request.userId;
    if (!userId) throw ApiError.unauthorized();

    await requireMembership(input.organizationId, userId);

    // Retrieval happens entirely before the response commits to SSE: a
    // missing KB, a validation failure, or an embedding-provider error
    // here still returns a normal { error: ... } JSON response through
    // the standard error handler, never a half-open stream.
    const assembled = await withTenantTransaction(input.organizationId, async (tx) => {
      const knowledgeBase = await tx.knowledgeBase.findUnique({ where: { id: knowledgeBaseId } });
      if (!knowledgeBase) {
        throw ApiError.notFound("Knowledge base not found");
      }

      // Same model the KB's chunks were embedded with — retrieval never
      // lets the caller pick a different one (architecture.md §4.6).
      const queryEmbedding = await embedQuery(getEmbeddingProvider(), input.message);
      const candidates = await searchSimilarChunks(tx, {
        organizationId: input.organizationId,
        knowledgeBaseId,
        queryEmbedding,
        limit: TOP_K,
      });

      return assembleContext(candidates);
    });

    const messages = buildChatMessages(assembled.contextText, input.message);

    // From here on the response is committed to SSE — reply.hijack() tells
    // Fastify not to touch the response itself, since we're writing to the
    // raw http.ServerResponse directly.
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // Strips [[chunk:refId]] markers out of every delta before it's
    // written to the client — the model is instructed to emit them, but
    // they're an internal signal for citation parsing, never something a
    // user should see (implementation-plan.md §2 item 5).
    const filter = new CitationMarkerFilter();
    try {
      for await (const delta of getLLMProvider().streamCompletion(messages)) {
        const safe = filter.push(delta);
        if (safe) sendEvent(reply, "token", { text: safe });
      }
      const trailing = filter.flush();
      if (trailing) sendEvent(reply, "token", { text: trailing });

      // Citations are only ever sent once generation AND validation are
      // both complete — never derived from markers as they stream past,
      // which is what would let the client render something a validation
      // pass later has to silently retract (architecture.md §1.3 step 6).
      // This validates that each citation resolves to a chunk that was
      // actually sent in this request's context — it does not verify the
      // model's claim is actually supported by that chunk's content (see
      // validateCitations's own doc comment).
      const citations = validateCitations(filter.fullText, assembled.chunks);
      sendEvent(reply, "citations", { citations });
    } catch (err) {
      request.log.error({ err }, "chat generation failed mid-stream");
      sendEvent(reply, "error", { message: "Generation failed" });
    } finally {
      reply.raw.end();
    }
  });
}
