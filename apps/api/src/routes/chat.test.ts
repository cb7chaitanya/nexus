/**
 * Integration tests against real Postgres + Redis via app.inject() — no
 * mocking of either. Uses EMBEDDING_PROVIDER=fake / LLM_PROVIDER=fake (the
 * local dev/test default — see .env.example) so this test needs no OpenAI
 * key and no network call, while still exercising the real retrieval ->
 * generation -> streaming -> citation-validation pipeline end to end.
 * Prerequisites: docker compose up -d, migrations applied.
 */
import { randomUUID } from "node:crypto";

import { prisma, withTenantTransaction } from "@raas/db";
import { FakeEmbeddingProvider } from "@raas/providers";
import { PLATFORM_EMBEDDING_DIM } from "@raas/shared";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../app.js";
import { redis } from "../lib/redis.js";
import { SESSION_COOKIE_NAME } from "../plugins/auth-guard.js";

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

async function signup(
  app: FastifyInstance,
  email: string,
  password: string,
  organizationName: string,
): Promise<{ sessionCookie: string; userId: string; organizationId: string }> {
  const response = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { email, password, organizationName },
  });
  const cookie = response.cookies.find((c) => c.name === SESSION_COOKIE_NAME);
  const body = response.json();
  return { sessionCookie: cookie!.value, userId: body.user.id, organizationId: body.organizations[0].id };
}

describe("chat route", () => {
  let app: FastifyInstance;
  const suffix = randomUUID().slice(0, 8);
  const password = "correct-horse-battery-staple";

  let ownerCookie: string;
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
    expect(citations).toEqual([{ chunkId, documentId, pageNumber: 3, quote: expect.any(String) }]);
    expect((citations[0]!.quote as string).length).toBeGreaterThan(0);
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
});
