import { assembleContext, buildChatMessages, CitationMarkerFilter, embedQuery, searchSimilarChunks, validateCitations } from "@raas/core";
import { withTenantTransaction } from "@raas/db";
import type { Prisma } from "@raas/db";
import type { CompletionStream } from "@raas/providers";
import { recordUsage } from "@raas/usage";
import { ApiError, chatSchema, parseOrThrow } from "@raas/shared";
import type { FastifyInstance, FastifyReply } from "fastify";

import { env } from "../env.js";
import { findOrCreateConversation, loadConversationHistory } from "../lib/conversation.js";
import { getBudgetGuardedEmbeddingProvider } from "../lib/embedding-provider.js";
import { getLLMModelName, getLLMProvider } from "../lib/llm-provider.js";
import { requireMembership } from "../lib/membership.js";
import { checkChatRateLimit, reserveChatTokenBudget, settleChatTokenUsage } from "../lib/rate-limit.js";
import { getReranker } from "../lib/reranker.js";
import { estimateChatReservation, resolveChatTokenUsage, type ChatTokenAccounting } from "../lib/token-accounting.js";
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

    await requireMembership(request, input.organizationId, userId);

    // Rate limiting before any retrieval/generation work starts — a
    // limit-exceeded response is a normal ApiError (429) through the
    // standard error handler, never a partial/half-open stream. The token
    // budget itself can't be checked here yet — an accurate reservation
    // needs the real prompt text, which isn't assembled until after
    // retrieval below (see reserveChatTokenBudget's call site).
    await checkChatRateLimit({ organizationId: input.organizationId, userId }, reply);

    // Steps 1-3 of the ticket's chat flow: create/find conversation, load
    // history, retrieve context. Everything here can still fail with a
    // normal JSON error response — the response only commits to SSE once
    // generation actually starts below.
    //
    // Deliberately THREE sequential steps, not one transaction wrapping
    // all of retrieval (as this used to be): embedQuery (a real OpenAI
    // call) and getReranker().rerank() (a no-op today via
    // IdentityReranker, but swappable to a real hosted reranking API via
    // getReranker() — see that call site's own comment) must never run
    // inside a Postgres transaction. Holding a pooled connection open
    // across a third-party network round-trip — including that call's
    // own internal retry/backoff — for however long it takes is a real
    // production risk under concurrent load or provider degradation, the
    // same reason apps/worker's embed-chunks processor already keeps its
    // own provider call outside its persistence transaction. Every
    // RLS-scoped table this route touches is still only ever queried
    // through withTenantTransaction (unchanged — see @raas/db's tenant.ts
    // for why that's the only sanctioned way); there are just two of them
    // now instead of one, with the OpenAI call happening in the gap
    // between.
    const { conversation, history } = await withTenantTransaction(input.organizationId, async (tx) => {
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

      return { conversation, history };
    });

    // Same model the KB's chunks were embedded with — retrieval never
    // lets the caller pick a different one (architecture.md §4.6).
    // Wrapped with the same daily embedding-token budget guard the
    // ingestion pipeline uses (see @raas/usage's withEmbeddingBudgetGuard)
    // — a query embedding is small, but it's still a real OpenAI call
    // billed against the org's budget. No tx here — see this block's
    // opening comment.
    const queryEmbedding = await embedQuery(await getBudgetGuardedEmbeddingProvider(input.organizationId), input.message);

    const candidates = await withTenantTransaction(input.organizationId, (tx) =>
      searchSimilarChunks(tx, {
        organizationId: input.organizationId,
        knowledgeBaseId,
        queryEmbedding,
        limit: TOP_K,
      }),
    );

    // retrieve -> rerank -> assemble context -> LLM (architecture.md
    // §4.7). IdentityReranker (the current default) returns candidates
    // unchanged; the pipeline shape is what makes a real reranker later a
    // config change in getReranker(), not an edit here. Also no tx — same
    // reasoning as embedQuery above, since a real reranker is realistically
    // a network call too.
    const reranked = await getReranker().rerank({ query: input.message, chunks: candidates });
    const assembled = assembleContext(reranked);

    const messages = buildChatMessages(assembled.contextText, input.message, history);
    // Used both as resolveChatTokenUsage's fallback input (if the stream
    // ends up not reporting real usage) and, right below, to size the
    // up-front reservation — never sent anywhere or recorded directly.
    const promptText = messages.map((m) => m.content).join("\n");

    // Atomically reserves a worst-case token estimate against the org's
    // daily budget BEFORE generation starts, rejecting (429, still a
    // normal JSON error response — this runs before hijack) if the
    // reservation itself doesn't fit. This is the fix for the race the
    // old peek-then-record design had: every request now atomically
    // claims its own worst-case share of the budget up front, so
    // concurrent requests can no longer all pass a stale check before any
    // of them accounts for real usage. Settled exactly once against real
    // usage below, on every exit path — success, a mid-stream failure, or
    // a provider timeout (see settleChatTokenUsage's call sites).
    const reservation = await reserveChatTokenBudget(input.organizationId, estimateChatReservation(promptText, env.MAX_COMPLETION_TOKENS), reply);

    // From here on the response is committed to SSE — reply.hijack() tells
    // Fastify not to touch the response itself, since we're writing to the
    // raw http.ServerResponse directly.
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // Rewrites [[chunk:refId]] markers into client-safe [[cite:refId]]
    // tokens (dropping any refId that doesn't resolve against this
    // request's own assembled chunks) before they're written to the
    // client — the raw chunk: form is an internal signal for citation
    // parsing, never something a user should see
    // (implementation-plan.md §2 item 5), but a resolved refId is safe to
    // expose since it's already been checked against real context.
    const filter = new CitationMarkerFilter(new Set(assembled.chunks.map((chunk) => chunk.refId)));
    let cleanText = "";
    // Declared outside the try so the catch block below can still reach
    // stream.usage (whatever was captured before things broke) and so
    // accounting is available afterward for the settle call regardless of
    // which branch ran — a safe all-zero default rather than `| undefined`
    // plus a non-null assertion, since this feeds a budget settlement and
    // "provably always assigned by construction" is a weaker guarantee to
    // lean on there than a value that's always safe to use as-is.
    let stream: CompletionStream | undefined;
    let accounting: ChatTokenAccounting = { promptTokens: 0, completionTokens: 0, totalTokens: 0, source: "estimated" };
    try {
      stream = getLLMProvider().streamCompletion(messages);
      for await (const delta of stream) {
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

      // Resolves only after the stream above is fully consumed — real,
      // billed counts from OpenAI's stream_options.include_usage chunk
      // when the provider reported one, a chars/4 estimate otherwise (see
      // resolveChatTokenUsage's own doc comment for why a fallback is
      // still needed).
      const usage = await stream.usage;
      accounting = resolveChatTokenUsage(usage, promptText, cleanText);
      if (accounting.source === "estimated") {
        request.log.warn(
          { conversationId: conversation.id },
          "chat completion stream did not report token usage — falling back to a tokenizer-based estimate for billing/budget accounting",
        );
      }
      const { promptTokens, completionTokens, totalTokens, source: tokenSource } = accounting;
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
              usageMetadata: { model, promptTokens, completionTokens, totalTokens, tokenSource },
            },
          });
          await recordUsage(
            { organizationId: input.organizationId, userId, type: "CHAT_REQUEST", metadata: { conversationId: conversation.id, knowledgeBaseId } },
            tx,
          );
          await recordUsage(
            {
              organizationId: input.organizationId,
              userId,
              type: "CHAT_PROMPT_TOKENS",
              metadata: { model, conversationId: conversation.id, tokenCount: promptTokens, tokenSource },
            },
            tx,
          );
          await recordUsage(
            {
              organizationId: input.organizationId,
              userId,
              type: "CHAT_COMPLETION_TOKENS",
              metadata: { model, conversationId: conversation.id, tokenCount: completionTokens, tokenSource },
            },
            tx,
          );
        });
      } catch (persistErr) {
        request.log.error({ err: persistErr }, "failed to persist chat message/usage after successful generation");
        sendEvent(reply, "error", { message: "Your answer was generated successfully but could not be saved to conversation history" });
      }
    } catch (err) {
      request.log.error({ err }, "chat generation failed mid-stream");
      sendEvent(reply, "error", { message: "Generation failed" });

      // Stream interruption, a provider failure, a connect timeout — all
      // land here. Whatever text actually reached the client (cleanText,
      // possibly empty if generation failed before yielding anything) and
      // whatever the stream captured before things broke (usually null —
      // real usage only arrives on the final chunk of a stream that
      // finished normally) still get a best-effort accounting via the
      // exact same real-usage-preferred, chars/4-fallback logic the
      // success path uses, so a failed request settles for something
      // reasonable instead of either the full reservation or nothing.
      const usage = stream ? await stream.usage.catch(() => null) : null;
      accounting = resolveChatTokenUsage(usage, promptText, cleanText);
    } finally {
      reply.raw.end();
    }

    // Exactly one settle call per request, regardless of which branch
    // above ran: the try's success path assigns `accounting` after the
    // persistence attempt (whether persistence itself succeeded or not),
    // the catch assigns it on every failure path — never both, never
    // neither. Tops the reservation up or refunds the unused portion; see
    // settleChatTokenUsage's own doc comment. Never awaited inside the
    // try/catch itself: this must run even when persistence failed, and
    // must run exactly once even though there are two very different
    // ways to reach it.
    await settleChatTokenUsage(input.organizationId, reservation.reserved, accounting.totalTokens).catch((err: unknown) => {
      request.log.error({ err }, "failed to settle chat token usage against the daily rate-limit budget");
    });
  });
}
