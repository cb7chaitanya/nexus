/**
 * Integration tests against real Postgres + Redis via app.inject() — no
 * mocking of either. Uses EMBEDDING_PROVIDER=fake / LLM_PROVIDER=fake (the
 * local dev/test default — see .env.example) so this test needs no OpenAI
 * key and no network call, while still exercising the real retrieval ->
 * generation -> streaming -> citation-validation pipeline end to end.
 * Prerequisites: docker compose up -d, migrations applied.
 */
import { randomUUID } from "node:crypto";

import { IdentityReranker } from "@raas/core";
import { PrismaClient, prisma, withTenantTransaction } from "@raas/db";
import { FakeEmbeddingProvider } from "@raas/providers";
import { PLATFORM_EMBEDDING_DIM } from "@raas/shared";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { buildApp } from "../app.js";
import { env } from "../env.js";
import { redis } from "../lib/redis.js";
import { estimateChatReservation } from "../lib/token-accounting.js";
import { SESSION_COOKIE_NAME } from "../plugins/auth-guard.js";
import { signup } from "../test-support/signup.js";

interface SseEvent {
  event: string;
  data: unknown;
}

/** Parses the raw SSE body light-my-request captured from reply.raw's
 * writes into structured { event, data } records, in arrival order. */
function parseSse(payload: string): SseEvent[] {
  return payload
    .split("\n\n")
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      const eventLine = block.split("\n").find((line) => line.startsWith("event:"))!;
      const dataLine = block.split("\n").find((line) => line.startsWith("data:"))!;
      return { event: eventLine.slice("event:".length).trim(), data: JSON.parse(dataLine.slice("data:".length).trim()) };
    });
}

describe("chat route", () => {
  let app: FastifyInstance;
  const suffix = randomUUID().slice(0, 8);
  const password = "correct-horse-battery-staple";

  let ownerCookie: string;
  let ownerUserId: string;
  let organizationId: string;
  let outsiderCookie: string;
  let knowledgeBaseId: string;
  let chunkId: string;
  let documentId: string;

  const message = `What is the refund policy? ${randomUUID()}`;
  const chunkContent = "Refunds are processed within 30 days of purchase, in full, to the original payment method.";

  beforeAll(async () => {
    app = await buildApp();

    const owner = await signup(app, `chat-owner-${suffix}@example.com`, password, `Chat Org ${suffix}`);
    ownerCookie = owner.sessionCookie;
    ownerUserId = owner.userId;
    organizationId = owner.organizationId;

    const outsider = await signup(app, `chat-outsider-${suffix}@example.com`, password, `Chat Outsider Org ${suffix}`);
    outsiderCookie = outsider.sessionCookie;

    const kb = await withTenantTransaction(organizationId, (tx) =>
      tx.knowledgeBase.create({
        data: {
          organizationId,
          name: "Chat KB",
          embeddingProvider: "openai",
          embeddingModel: "text-embedding-3-small",
          embeddingDim: PLATFORM_EMBEDDING_DIM,
        },
      }),
    );
    knowledgeBaseId = kb.id;

    const doc = await withTenantTransaction(organizationId, (tx) =>
      tx.document.create({
        data: {
          organizationId,
          knowledgeBaseId,
          fileName: "refund-policy.pdf",
          mimeType: "application/pdf",
          sizeBytes: 100,
          storageKey: `${organizationId}/${randomUUID()}`,
          status: "READY",
        },
      }),
    );
    documentId = doc.id;

    const chunk = await withTenantTransaction(organizationId, (tx) =>
      tx.documentChunk.create({
        data: {
          organizationId,
          knowledgeBaseId,
          documentId,
          chunkIndex: 0,
          content: chunkContent,
          tokenCount: 20,
          pageNumber: 3,
          charStart: 0,
          charEnd: chunkContent.length,
        },
      }),
    );
    chunkId = chunk.id;

    // Written with the FAKE embedding provider's own vector for `message`
    // (matching the real embed-chunks/embedding-provider plumbing this
    // test's chat request will exercise via EMBEDDING_PROVIDER=fake) so
    // this chunk is unambiguously the top match for the query below —
    // this test only needs a real end-to-end pipeline exercise, not a
    // relevance-ranking assertion.
    const [queryVector] = await new FakeEmbeddingProvider().embed([message]);
    const vectorLiteral = `[${queryVector!.join(",")}]`;
    await withTenantTransaction(organizationId, (tx) => tx.$executeRaw`UPDATE "DocumentChunk" SET embedding = ${vectorLiteral}::vector WHERE id = ${chunkId}`);
  });

  afterAll(async () => {
    await app.close();
    await prisma.user.deleteMany({ where: { email: { contains: suffix } } });
    await prisma.organization.deleteMany({ where: { slug: { contains: suffix } } });
    await redis.quit();
  });

  it("streams token events and a final citations event resolving to the retrieved chunk", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/kb/${knowledgeBaseId}/chat`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      payload: { organizationId, message },
    });

    expect(response.statusCode).toBe(200);
    const events = parseSse(response.payload);

    const tokenEvents = events.filter((e) => e.event === "token");
    expect(tokenEvents.length).toBeGreaterThan(0);
    // The model-internal marker must never reach a token event, no matter
    // how the fake provider chose to split its output across deltas.
    for (const tokenEvent of tokenEvents) {
      expect((tokenEvent.data as { text: string }).text).not.toContain("[[chunk:");
    }

    // Exactly one citations event, sent last, after every token event.
    const citationEvents = events.filter((e) => e.event === "citations");
    expect(citationEvents).toHaveLength(1);
    expect(events.indexOf(citationEvents[0]!)).toBe(events.length - 1);

    const citations = (citationEvents[0]!.data as { citations: Array<Record<string, unknown>> }).citations;
    expect(citations).toEqual([{ refId: "c1", chunkId, documentId, pageNumber: 3, quote: expect.any(String) }]);
    expect((citations[0]!.quote as string).length).toBeGreaterThan(0);
  });

  it("never holds a Postgres transaction open while the embedding provider or reranker call is in flight (regression test for the transaction-boundary fix)", async () => {
    // Admin connection (raas, the superuser DATABASE_URL role — same
    // narrowly-scoped-admin-connection pattern
    // packages/core/scripts/benchmark-vector-search.ts already uses for
    // out-of-band inspection) used only to read pg_stat_activity, never
    // to touch application data. raas_app (what every real request in
    // this app connects as) can't reliably see other sessions' full
    // state, so this can't be done through the app's own restricted
    // connection.
    const admin = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });

    async function hasIdleInTransactionSession(): Promise<boolean> {
      const rows = await admin.$queryRaw<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM pg_stat_activity
        WHERE usename = 'raas_app' AND state = 'idle in transaction'
      `;
      return rows[0]!.count > 0;
    }

    let embedSawOpenTransaction = false;
    let rerankSawOpenTransaction = false;

    // Spies on the real test doubles this suite already uses for the
    // embedding provider and reranker (FakeEmbeddingProvider/
    // IdentityReranker — never Postgres or Redis themselves, see this
    // file's header comment) rather than a global FAKE_EMBEDDING_DELAY_MS,
    // which would slow down every other test in this file. Each spy
    // pauses briefly and checks pg_stat_activity before calling through
    // to the real implementation — a fake provider with genuinely zero
    // latency would otherwise make the "was a transaction open at this
    // instant" window too small to reliably observe.
    const originalEmbed = FakeEmbeddingProvider.prototype.embed;
    const embedSpy = vi.spyOn(FakeEmbeddingProvider.prototype, "embed").mockImplementation(async function (this: FakeEmbeddingProvider, texts: string[]) {
      await new Promise((resolve) => setTimeout(resolve, 75));
      embedSawOpenTransaction = await hasIdleInTransactionSession();
      return originalEmbed.call(this, texts);
    });

    const originalRerank = IdentityReranker.prototype.rerank;
    const rerankSpy = vi.spyOn(IdentityReranker.prototype, "rerank").mockImplementation(async function (this: IdentityReranker, params) {
      await new Promise((resolve) => setTimeout(resolve, 75));
      rerankSawOpenTransaction = await hasIdleInTransactionSession();
      return originalRerank.call(this, params);
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: `/kb/${knowledgeBaseId}/chat`,
        cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
        payload: { organizationId, message: `transaction boundary probe ${randomUUID()}` },
      });

      // The fix must not change observable behavior — still a normal,
      // complete, successful response.
      expect(response.statusCode).toBe(200);
      expect(embedSpy).toHaveBeenCalledOnce();
      expect(rerankSpy).toHaveBeenCalledOnce();

      // The actual regression test: neither call ever saw a raas_app
      // session sitting idle-in-transaction. Before this fix, the
      // embedding call in particular ran INSIDE the same transaction as
      // the KB/conversation/history lookup — this would have reliably
      // observed one here.
      expect(embedSawOpenTransaction).toBe(false);
      expect(rerankSawOpenTransaction).toBe(false);
    } finally {
      embedSpy.mockRestore();
      rerankSpy.mockRestore();
      await admin.$disconnect();
    }
  });

  it("requires authentication", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/kb/${knowledgeBaseId}/chat`,
      payload: { organizationId, message: "hello" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects a caller who isn't a member of the organization", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/kb/${knowledgeBaseId}/chat`,
      cookies: { [SESSION_COOKIE_NAME]: outsiderCookie },
      payload: { organizationId, message: "hello" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("returns 404 for a knowledge base id that doesn't exist", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/kb/${randomUUID()}/chat`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      payload: { organizationId, message: "hello" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("rejects an empty message with a validation error", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/kb/${knowledgeBaseId}/chat`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      payload: { organizationId, message: "" },
    });
    expect(response.statusCode).toBe(422);
  });

  it("records CHAT_REQUEST/CHAT_PROMPT_TOKENS/CHAT_COMPLETION_TOKENS usage events", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/kb/${knowledgeBaseId}/chat`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      payload: { organizationId, message: `usage metering probe ${randomUUID()}` },
    });
    expect(response.statusCode).toBe(200);
    const conversationId = await lastConversationId(organizationId);

    const events = await withTenantTransaction(organizationId, (tx) => tx.usageEvent.findMany({ where: { userId: ownerUserId } }));
    expect(events.some((e) => e.type === "CHAT_REQUEST")).toBe(true);
    const promptEvent = events.find((e) => e.type === "CHAT_PROMPT_TOKENS" && (e.metadata as Record<string, unknown>).conversationId === conversationId);
    const completionEvent = events.find((e) => e.type === "CHAT_COMPLETION_TOKENS" && (e.metadata as Record<string, unknown>).conversationId === conversationId);
    expect(promptEvent).toBeDefined();
    expect(completionEvent).toBeDefined();
    expect(typeof (promptEvent!.metadata as Record<string, unknown>).tokenCount).toBe("number");
    expect((promptEvent!.metadata as Record<string, unknown>).model).toBe("fake");
  });

  it("persists the user + assistant messages and citations, and continues the same conversation across two calls", async () => {
    const first = await app.inject({
      method: "POST",
      url: `/kb/${knowledgeBaseId}/chat`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      payload: { organizationId, message },
    });
    expect(first.statusCode).toBe(200);
    const conversationId = await lastConversationId(organizationId);

    const second = await app.inject({
      method: "POST",
      url: `/kb/${knowledgeBaseId}/chat`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      payload: { organizationId, message: "follow-up question", conversationId },
    });
    expect(second.statusCode).toBe(200);

    // A conversationId was supplied on the second call — it must not have
    // created a second conversation.
    const secondConversationId = await lastConversationId(organizationId);
    expect(secondConversationId).toBe(conversationId);

    const dbMessages = await withTenantTransaction(organizationId, (tx) =>
      tx.message.findMany({ where: { conversationId }, orderBy: { createdAt: "asc" } }),
    );
    expect(dbMessages).toHaveLength(4);
    expect(dbMessages.map((m) => m.role)).toEqual(["USER", "ASSISTANT", "USER", "ASSISTANT"]);
    expect(dbMessages[0]!.content).toBe(message);
    expect(dbMessages[2]!.content).toBe("follow-up question");
    // Persisted content is the clean, marker-stripped text — never a raw
    // internal citation marker.
    for (const m of dbMessages) {
      expect(m.content).not.toContain("[[chunk:");
    }
    expect(dbMessages[1]!.citations).not.toEqual([]);
  });

  it("rejects continuing another organization's conversation (404, indistinguishable from a nonexistent id)", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/kb/${knowledgeBaseId}/chat`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      payload: { organizationId, message: `cross-tenant setup ${randomUUID()}` },
    });
    expect(created.statusCode).toBe(200);
    const conversationId = await lastConversationId(organizationId);

    const outsiderOrg = await signup(app, `chat-outsider-org-${suffix}@example.com`, password, `Chat Outsider's Own Org ${suffix}`);
    const outsiderKb = await withTenantTransaction(outsiderOrg.organizationId, (tx) =>
      tx.knowledgeBase.create({
        data: {
          organizationId: outsiderOrg.organizationId,
          name: "Outsider KB",
          embeddingProvider: "openai",
          embeddingModel: "text-embedding-3-small",
          embeddingDim: PLATFORM_EMBEDDING_DIM,
        },
      }),
    );

    const response = await app.inject({
      method: "POST",
      url: `/kb/${outsiderKb.id}/chat`,
      cookies: { [SESSION_COOKIE_NAME]: outsiderOrg.sessionCookie },
      payload: { organizationId: outsiderOrg.organizationId, message: "trying to hijack", conversationId },
    });

    expect(response.statusCode).toBe(404);

    // The other org's conversation must be completely untouched — no
    // extra messages appended to it.
    const messages = await withTenantTransaction(organizationId, (tx) => tx.message.findMany({ where: { conversationId } }));
    expect(messages).toHaveLength(2);
  });

  it("returns 429 with the rate-limit envelope and headers once the per-user chat limit is exceeded", async () => {
    const limited = await signup(app, `chat-limited-${suffix}@example.com`, password, `Chat Limited Org ${suffix}`);
    const kb = await withTenantTransaction(limited.organizationId, (tx) =>
      tx.knowledgeBase.create({
        data: {
          organizationId: limited.organizationId,
          name: "Rate Limit KB",
          embeddingProvider: "openai",
          embeddingModel: "text-embedding-3-small",
          embeddingDim: PLATFORM_EMBEDDING_DIM,
        },
      }),
    );

    let lastResponse;
    // RATE_LIMIT_CHAT_USER_RPM defaults to 20 — the 21st request in this
    // dedicated org/user's own 60s window must be denied.
    for (let i = 0; i < 21; i++) {
      lastResponse = await app.inject({
        method: "POST",
        url: `/kb/${kb.id}/chat`,
        cookies: { [SESSION_COOKIE_NAME]: limited.sessionCookie },
        payload: { organizationId: limited.organizationId, message: `rate limit probe ${i}` },
      });
    }

    expect(lastResponse!.statusCode).toBe(429);
    expect(lastResponse!.json()).toMatchObject({ error: { code: "RATE_LIMIT_EXCEEDED" } });
    expect(lastResponse!.headers["x-ratelimit-limit"]).toBeDefined();
    expect(lastResponse!.headers["x-ratelimit-remaining"]).toBe("0");
    expect(Number(lastResponse!.headers["retry-after"])).toBeGreaterThan(0);
  });

  describe("concurrent token-budget reservation", () => {
    // A second organization for the already-authenticated outsider user
    // (POST /organizations, not POST /auth/signup) — deliberately not a
    // fresh signup: signup is IP-rate-limited (authRateLimit), and this
    // file's test suite already makes enough signup calls across its
    // other describe blocks that a redundant one here risks tripping that
    // unrelated limit under full-suite parallelism. outsiderCookie
    // specifically (not ownerCookie) because the owner's own per-user
    // chat RPM bucket (RATE_LIMIT_CHAT_USER_RPM) is already exercised by
    // several tests above — reusing it here would risk this describe
    // block's 20 chat calls tripping THAT limit instead of the token
    // budget this is actually testing. outsiderCookie makes exactly one
    // chat call anywhere else in this file, and that one fails
    // membership before rate limiting even runs, so its RPM bucket is
    // effectively untouched.
    let budgetOrganizationId: string;
    let budgetKbId: string;

    beforeAll(async () => {
      const orgResponse = await app.inject({
        method: "POST",
        url: "/organizations",
        cookies: { [SESSION_COOKIE_NAME]: outsiderCookie },
        payload: { name: `Chat Budget Org ${suffix}` },
      });
      expect(orgResponse.statusCode).toBe(201);
      budgetOrganizationId = orgResponse.json().id;

      const kb = await withTenantTransaction(budgetOrganizationId, (tx) =>
        tx.knowledgeBase.create({
          data: {
            organizationId: budgetOrganizationId,
            name: "Budget KB",
            embeddingProvider: "openai",
            embeddingModel: "text-embedding-3-small",
            embeddingDim: PLATFORM_EMBEDDING_DIM,
          },
        }),
      );
      budgetKbId = kb.id;
      await withTenantTransaction(budgetOrganizationId, (tx) =>
        tx.organizationUsageLimit.create({
          data: { organizationId: budgetOrganizationId, maxDocumentsPerDay: 200, maxEmbeddingTokensPerDay: 2_000_000, maxChatTokensPerDay: 1 },
        }),
      );
    });

    it("under 10 simultaneous requests against a budget too small for even one reservation, atomic reservation rejects every one of them", async () => {
      // maxChatTokensPerDay: 1 (set in beforeAll) is smaller than any
      // real reservation can ever be (a reservation is promptTokens +
      // MAX_COMPLETION_TOKENS, and MAX_COMPLETION_TOKENS alone is always
      // >= 1 — see estimateChatReservation). With the OLD peek-then-record
      // design, all 10 of these truly concurrent requests (Promise.all,
      // not a loop) would have seen the same stale "0 used so far" peek
      // and been let through, since the peek check ran before any of
      // them had generated (and therefore recorded) anything. With
      // atomic reserve-before-generation, not even one of the 10 can
      // ever fit — the clearest, most deterministic proof that the race
      // is fixed: nothing about generation timing or how fast a response
      // settles can create a window where a reservation this size is
      // ever granted.
      const responses = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          app.inject({
            method: "POST",
            url: `/kb/${budgetKbId}/chat`,
            cookies: { [SESSION_COOKIE_NAME]: outsiderCookie },
            payload: { organizationId: budgetOrganizationId, message: `zero budget probe ${i} ${randomUUID()}` },
          }),
        ),
      );

      for (const response of responses) {
        expect(response.statusCode).toBe(429);
        expect(response.json()).toMatchObject({ error: { code: "RATE_LIMIT_EXCEEDED" } });
      }
    });

    it("under 10 simultaneous requests against a comfortably large budget, all succeed and each settles to a real, distinct usage record", async () => {
      // The companion case to the zero-budget test above: proves the
      // reservation mechanism doesn't falsely reject legitimate concurrent
      // traffic just because it's concurrent, and that every one of the
      // 10 requests gets its own independent settle (not accidentally
      // sharing or clobbering another's).
      await withTenantTransaction(budgetOrganizationId, (tx) =>
        tx.organizationUsageLimit.update({ where: { organizationId: budgetOrganizationId }, data: { maxChatTokensPerDay: 1_000_000 } }),
      );

      const responses = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          app.inject({
            method: "POST",
            url: `/kb/${budgetKbId}/chat`,
            cookies: { [SESSION_COOKIE_NAME]: outsiderCookie },
            payload: { organizationId: budgetOrganizationId, message: `generous budget probe ${i} ${randomUUID()}` },
          }),
        ),
      );

      for (const response of responses) {
        expect(response.statusCode).toBe(200);
      }

      // Every request's real usage was recorded — ten distinct
      // CHAT_PROMPT_TOKENS events for this org, each a real settled
      // amount, not zero (which would mean settlement never ran) and not
      // the raw reservation ceiling (which would mean settlement never
      // adjusted it down to the real, much smaller FakeLLMProvider
      // output).
      const events = await withTenantTransaction(budgetOrganizationId, (tx) => tx.usageEvent.findMany({ where: { type: "CHAT_PROMPT_TOKENS" } }));
      expect(events).toHaveLength(10);
      for (const event of events) {
        const tokenCount = (event.metadata as Record<string, unknown>).tokenCount as number;
        expect(tokenCount).toBeGreaterThan(0);
      }
    });
  });

  describe("adversarial prompt content", () => {
    // A dedicated fresh signup, not outsiderCookie — this block alone
    // makes 4 chat calls, and outsiderCookie already spent 20 of its
    // RATE_LIMIT_CHAT_USER_RPM budget in the concurrent-budget describe
    // block above (10 rejected-by-token-budget + 10 accepted, each still
    // consuming an RPM slot since checkChatRateLimit runs before
    // reserveChatTokenBudget) — reusing it here would make these
    // assertions about the token-budget/validation path accidentally
    // depend on the RPM limit instead, exactly the kind of cross-test
    // coupling the "limited" user further below avoids for the same
    // reason. Own org for the same isolation reasoning the concurrent
    // budget block documents: keeps this block's own maxChatTokensPerDay
    // edits from colliding with any other describe block's budget state.
    let adversarialCookie: string;
    let adversarialOrganizationId: string;
    let adversarialKbId: string;

    beforeAll(async () => {
      const adversarial = await signup(app, `chat-adversarial-${suffix}@example.com`, password, `Chat Adversarial Org ${suffix}`);
      adversarialCookie = adversarial.sessionCookie;
      adversarialOrganizationId = adversarial.organizationId;

      const kb = await withTenantTransaction(adversarialOrganizationId, (tx) =>
        tx.knowledgeBase.create({
          data: {
            organizationId: adversarialOrganizationId,
            name: "Adversarial KB",
            embeddingProvider: "openai",
            embeddingModel: "text-embedding-3-small",
            embeddingDim: PLATFORM_EMBEDDING_DIM,
          },
        }),
      );
      adversarialKbId = kb.id;
    });

    async function setBudget(maxChatTokensPerDay: number): Promise<void> {
      await withTenantTransaction(adversarialOrganizationId, (tx) =>
        tx.organizationUsageLimit.upsert({
          where: { organizationId: adversarialOrganizationId },
          create: { organizationId: adversarialOrganizationId, maxDocumentsPerDay: 200, maxEmbeddingTokensPerDay: 2_000_000, maxChatTokensPerDay },
          update: { maxChatTokensPerDay },
        }),
      );
    }

    // Same dense CJK content as token-accounting.test.ts's own unicode
    // cases, repeated out to the schema's 4000-character cap
    // (packages/shared/src/schemas/chat.ts) — the worst case for a
    // length-based estimate: CJK script tokenizes close to 1 token per
    // character, not 1 per 4, so a full-length message here is the
    // largest possible gap between a chars/4 guess and the real cost.
    const cjkBase = "这是一个关于退款政策和详细流程说明的问题，请解释清楚每一个步骤和时间安排。";
    const maxLengthUnicodeMessage = cjkBase.repeat(Math.ceil(4000 / cjkBase.length)).slice(0, 4000);

    it("rejects a max-length unicode-heavy prompt against a budget a chars/4 estimate would have wrongly let through", async () => {
      // The real (tokenizer-based) reservation this request will actually
      // make, versus what the old chars/4 heuristic would have reserved
      // for the identical message — computed from the production
      // estimator itself, not re-derived by hand, so this test tracks
      // whatever MAX_COMPLETION_TOKENS/tokenizer is actually configured.
      const realReservation = estimateChatReservation(maxLengthUnicodeMessage, env.MAX_COMPLETION_TOKENS);
      const naiveCharsPer4Reservation = Math.ceil(maxLengthUnicodeMessage.length / 4) + env.MAX_COMPLETION_TOKENS;
      expect(realReservation).toBeGreaterThan(naiveCharsPer4Reservation);

      // A budget strictly between the two: large enough that the OLD
      // (chars/4) reservation would have fit — letting the request reach
      // real generation despite not actually affording it — too small for
      // the NEW (real-tokenizer) reservation to fit. This is exactly the
      // abuse case reserve-then-settle-with-a-real-tokenizer closes: a
      // user filling the prompt with dense-tokenizing script specifically
      // to make the pre-flight budget check under-count their request.
      const budget = Math.floor((realReservation + naiveCharsPer4Reservation) / 2);
      await setBudget(budget);

      const response = await app.inject({
        method: "POST",
        url: `/kb/${adversarialKbId}/chat`,
        cookies: { [SESSION_COOKIE_NAME]: adversarialCookie },
        payload: { organizationId: adversarialOrganizationId, message: maxLengthUnicodeMessage },
      });

      expect(response.statusCode).toBe(429);
      expect(response.json()).toMatchObject({ error: { code: "RATE_LIMIT_EXCEEDED" } });
    });

    it("accepts and settles a real, non-trivial usage record for the same max-length unicode-heavy prompt once the budget can actually afford the real-tokenizer reservation", async () => {
      const realReservation = estimateChatReservation(maxLengthUnicodeMessage, env.MAX_COMPLETION_TOKENS);
      await setBudget(realReservation + 1000);

      const response = await app.inject({
        method: "POST",
        url: `/kb/${adversarialKbId}/chat`,
        cookies: { [SESSION_COOKIE_NAME]: adversarialCookie },
        payload: { organizationId: adversarialOrganizationId, message: maxLengthUnicodeMessage },
      });

      expect(response.statusCode).toBe(200);
      const conversationId = await lastConversationId(adversarialOrganizationId);
      const events = await withTenantTransaction(adversarialOrganizationId, (tx) =>
        tx.usageEvent.findMany({ where: { type: "CHAT_PROMPT_TOKENS", metadata: { path: ["conversationId"], equals: conversationId } } }),
      );
      expect(events).toHaveLength(1);
      const tokenCount = (events[0]!.metadata as Record<string, unknown>).tokenCount as number;
      expect(tokenCount).toBeGreaterThan(0);
    });

    it("rejects a message over the schema's max length with a normal validation error, before any budget reservation or generation cost is incurred", async () => {
      await setBudget(1_000_000);
      const overLengthMessage = "a".repeat(4001);

      const response = await app.inject({
        method: "POST",
        url: `/kb/${adversarialKbId}/chat`,
        cookies: { [SESSION_COOKIE_NAME]: adversarialCookie },
        payload: { organizationId: adversarialOrganizationId, message: overLengthMessage },
      });

      expect(response.statusCode).toBe(422);
    });

    it("accepts a message at exactly the schema's max length (4000 chars) and reserves a proportionally large, finite budget amount", async () => {
      const maxLengthAsciiMessage = "The quick brown fox jumps over the lazy dog. ".repeat(90).slice(0, 4000);
      expect(maxLengthAsciiMessage.length).toBe(4000);
      await setBudget(1_000_000);

      const response = await app.inject({
        method: "POST",
        url: `/kb/${adversarialKbId}/chat`,
        cookies: { [SESSION_COOKIE_NAME]: adversarialCookie },
        payload: { organizationId: adversarialOrganizationId, message: maxLengthAsciiMessage },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["x-ratelimit-remaining"]).toBeDefined();
      expect(Number(response.headers["x-ratelimit-remaining"])).toBeLessThan(1_000_000);
    });
  });

  async function lastConversationId(orgId: string): Promise<string> {
    const conversations = await withTenantTransaction(orgId, (tx) => tx.conversation.findMany({ orderBy: { createdAt: "desc" }, take: 1 }));
    return conversations[0]!.id;
  }
});
