import { assembleContext, buildChatMessages, CitationMarkerFilter, embedQuery, searchSimilarChunks, validateCitations } from "@raas/core";
import { withTenantTransaction } from "@raas/db";
import type { Prisma } from "@raas/db";
import { recordUsage } from "@raas/usage";
import { ApiError, chatSchema, parseOrThrow } from "@raas/shared";
import type { FastifyInstance, FastifyReply } from "fastify";

import { env } from "../env.js";
import { findOrCreateConversation, loadConversationHistory } from "../lib/conversation.js";
import { getEmbeddingProvider } from "../lib/embedding-provider.js";
import { getLLMModelName, getLLMProvider } from "../lib/llm-provider.js";
import { requireMembership } from "../lib/membership.js";
import { checkChatRateLimit, checkChatTokenBudget, recordChatTokenUsage } from "../lib/rate-limit.js";
import { getReranker } from "../lib/reranker.js";
import { requireAuth } from "../plugins/auth-guard.js";

// architecture.md §4.6: top-k candidates before context assembly truncates
// to a token budget.
const TOP_K = 8;
// Same chars-per-token approximation used across this codebase (see
// apps/worker's embed-chunks.ts and packages/core's assembleContext) —
// neither LLMProvider's interface nor the real OpenAI streaming response
// currently exposes real token usage without a larger interface change,
// so this is an estimate, not billing-grade accounting.
const CHARS_PER_TOKEN = 4;

function approxTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

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

    // Rate limiting before any retrieval/generation work starts — a
    // limit-exceeded response is a normal ApiError (429) through the
    // standard error handler, never a partial/half-open stream.
    await checkChatRateLimit({ organizationId: input.organizationId, userId }, reply);
    await checkChatTokenBudget(input.organizationId, reply);

    // Steps 1-3 of the ticket's chat flow: create/find conversation, load
    // history, retrieve context. Everything here can still fail with a
    // normal JSON error response — the response only commits to SSE once
    // this transaction (and therefore retrieval) has actually succeeded.
    const { conversation, history, assembled } = await withTenantTransaction(input.organizationId, async (tx) => {
      const knowledgeBase = await tx.knowledgeBase.findUnique({ where: { id: knowledgeBaseId } });
      if (!knowledgeBase) {
        throw ApiError.notFound("Knowledge base not found");
      }

      const conversation = await findOrCreateConversation(tx, {
        organizationId: input.organizationId,
        userId,
        knowledgeBaseId,
        conversationId: input.conversationId,
        firstMessage: input.message,
      });

      const history = await loadConversationHistory(tx, conversation.id, env.CHAT_HISTORY_MESSAGE_LIMIT);

      // Same model the KB's chunks were embedded with — retrieval never
      // lets the caller pick a different one (architecture.md §4.6).
      const queryEmbedding = await embedQuery(getEmbeddingProvider(), input.message);
      const candidates = await searchSimilarChunks(tx, {
        organizationId: input.organizationId,
        knowledgeBaseId,
        queryEmbedding,
        limit: TOP_K,
      });

      // retrieve -> rerank -> assemble context -> LLM (architecture.md
      // §4.7). IdentityReranker (the current default) returns candidates
      // unchanged; the pipeline shape is what makes a real reranker later
      // a config change in getReranker(), not an edit here.
      const reranked = await getReranker().rerank({ query: input.message, chunks: candidates });

      return { conversation, history, assembled: assembleContext(reranked) };
    });

    const messages = buildChatMessages(assembled.contextText, input.message, history);
    const promptTokens = approxTokens(messages.map((m) => m.content).join("\n"));

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
    let cleanText = "";
    try {
      for await (const delta of getLLMProvider().streamCompletion(messages)) {
        const safe = filter.push(delta);
        if (safe) {
          cleanText += safe;
          sendEvent(reply, "token", { text: safe });
        }
      }
      const trailing = filter.flush();
      if (trailing) {
        cleanText += trailing;
        sendEvent(reply, "token", { text: trailing });
      }

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

      const completionTokens = approxTokens(cleanText);
      const model = getLLMModelName();

      // Step 6: persist user message, assistant message, citations, and
      // usage — all in one transaction, only after generation and
      // validation both succeeded. If this fails, the answer the client
      // already received is real and complete; this only means it wasn't
      // saved to history, which is why the SSE error event here has a
      // distinct, more accurate message than a generation failure.
      try {
        await withTenantTransaction(input.organizationId, async (tx) => {
          await tx.message.create({
            data: { organizationId: input.organizationId, conversationId: conversation.id, role: "USER", content: input.message },
          });
          await tx.message.create({
            data: {
              organizationId: input.organizationId,
              conversationId: conversation.id,
              role: "ASSISTANT",
              content: cleanText,
              citations: citations as unknown as Prisma.InputJsonValue,
              usageMetadata: { model, promptTokens, completionTokens },
            },
          });
          await recordUsage(
            { organizationId: input.organizationId, userId, type: "CHAT_REQUEST", metadata: { conversationId: conversation.id, knowledgeBaseId } },
            tx,
          );
          await recordUsage(
            { organizationId: input.organizationId, userId, type: "CHAT_PROMPT_TOKENS", metadata: { model, conversationId: conversation.id, tokenCount: promptTokens } },
            tx,
          );
          await recordUsage(
            {
              organizationId: input.organizationId,
              userId,
              type: "CHAT_COMPLETION_TOKENS",
              metadata: { model, conversationId: conversation.id, tokenCount: completionTokens },
            },
            tx,
          );
        });
      } catch (persistErr) {
        request.log.error({ err: persistErr }, "failed to persist chat message/usage after successful generation");
        sendEvent(reply, "error", { message: "Your answer was generated successfully but could not be saved to conversation history" });
      }

      // Best-effort: record actual token usage against the daily
      // rate-limit budget after the fact (see recordChatTokenUsage's doc
      // comment — this can't happen before generation, since nobody knows
      // the token count yet).
      await recordChatTokenUsage(input.organizationId, promptTokens + completionTokens).catch((err: unknown) => {
        request.log.error({ err }, "failed to record chat token usage against the daily rate-limit budget");
      });
    } catch (err) {
      request.log.error({ err }, "chat generation failed mid-stream");
      sendEvent(reply, "error", { message: "Generation failed" });
    } finally {
      reply.raw.end();
    }
  });
}
