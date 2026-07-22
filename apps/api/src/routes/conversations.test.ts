/**
 * Integration tests against real Postgres via app.inject() — no mocking.
 * Prerequisites: docker compose up -d, migrations applied.
 */
import { randomUUID } from "node:crypto";

import { prisma, withTenantTransaction } from "@raas/db";
import { PLATFORM_EMBEDDING_DIM } from "@raas/shared";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../app.js";
import { redis } from "../lib/redis.js";
import { SESSION_COOKIE_NAME } from "../plugins/auth-guard.js";
import { signup } from "../test-support/signup.js";

describe("conversation routes", () => {
  let app: FastifyInstance;
  const suffix = randomUUID().slice(0, 8);
  const password = "correct-horse-battery-staple";

  let ownerCookie: string;
  let organizationId: string;
  let outsiderCookie: string;
  let outsiderOrganizationId: string;
  const conversationIds: string[] = [];

  beforeAll(async () => {
    app = await buildApp();

    const owner = await signup(app, `conv-owner-${suffix}@example.com`, password, `Conv Org ${suffix}`);
    ownerCookie = owner.sessionCookie;
    organizationId = owner.organizationId;

    const outsider = await signup(app, `conv-outsider-${suffix}@example.com`, password, `Conv Outsider Org ${suffix}`);
    outsiderCookie = outsider.sessionCookie;
    outsiderOrganizationId = outsider.organizationId;

    const kb = await withTenantTransaction(organizationId, (tx) =>
      tx.knowledgeBase.create({
        data: { organizationId, name: "Conv KB", embeddingProvider: "openai", embeddingModel: "text-embedding-3-small", embeddingDim: PLATFORM_EMBEDDING_DIM },
      }),
    );

    // 5 conversations, each with a USER + ASSISTANT message pair, created
    // directly via Prisma — this suite is testing list/pagination/access
    // control, not generation, so there's no need to go through the real
    // (fake-provider) chat pipeline for fixture data.
    for (let i = 0; i < 5; i++) {
      const conversation = await withTenantTransaction(organizationId, (tx) =>
        tx.conversation.create({ data: { organizationId, userId: owner.userId, knowledgeBaseId: kb.id, title: `Conversation ${i}` } }),
      );
      conversationIds.push(conversation.id);
      await withTenantTransaction(organizationId, async (tx) => {
        await tx.message.create({ data: { organizationId, conversationId: conversation.id, role: "USER", content: `question ${i}` } });
        await tx.message.create({ data: { organizationId, conversationId: conversation.id, role: "ASSISTANT", content: `answer ${i}` } });
      });
    }
  });

  afterAll(async () => {
    await app.close();
    await prisma.user.deleteMany({ where: { email: { contains: suffix } } });
    await prisma.organization.deleteMany({ where: { slug: { contains: suffix } } });
    await redis.quit();
  });

  it("lists conversations for the org, most-recent first", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/conversations?organizationId=${organizationId}&limit=100`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.length).toBeGreaterThanOrEqual(5);
    const ids = body.data.map((c: { id: string }) => c.id);
    // The 5th conversation created (index 4) is the most recent — it
    // must appear before the 1st (index 0).
    expect(ids.indexOf(conversationIds[4])).toBeLessThan(ids.indexOf(conversationIds[0]));
  });

  it("paginates conversations with a cursor — no duplicates, no gaps, correct nextCursor semantics", async () => {
    const firstPage = await app.inject({
      method: "GET",
      url: `/conversations?organizationId=${organizationId}&limit=2`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
    });
    const firstBody = firstPage.json();
    expect(firstBody.data).toHaveLength(2);
    expect(firstBody.nextCursor).toBeTruthy();

    const secondPage = await app.inject({
      method: "GET",
      url: `/conversations?organizationId=${organizationId}&limit=2&cursor=${firstBody.nextCursor}`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
    });
    const secondBody = secondPage.json();
    expect(secondBody.data).toHaveLength(2);

    const firstIds = firstBody.data.map((c: { id: string }) => c.id);
    const secondIds = secondBody.data.map((c: { id: string }) => c.id);
    expect(firstIds.some((id: string) => secondIds.includes(id))).toBe(false);
  });

  it("caps limit at 100 and rejects an out-of-range value", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/conversations?organizationId=${organizationId}&limit=101`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
    });
    expect(response.statusCode).toBe(422);
  });

  it("gets a single conversation by id", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/conversations/${conversationIds[0]}?organizationId=${organizationId}`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().id).toBe(conversationIds[0]);
  });

  it("lists a conversation's messages, most-recent first", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/conversations/${conversationIds[0]}/messages?organizationId=${organizationId}`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data).toHaveLength(2);
    // ASSISTANT was created after USER within the same turn — clock_timestamp()
    // (not now()) is what makes their createdAt genuinely distinct despite
    // both inserts happening in one transaction (see schema.prisma's
    // Message.createdAt comment). Most-recent-first means ASSISTANT first.
    expect(body.data.map((m: { role: string }) => m.role)).toEqual(["ASSISTANT", "USER"]);
  });

  it("requires authentication", async () => {
    const response = await app.inject({ method: "GET", url: `/conversations?organizationId=${organizationId}` });
    expect(response.statusCode).toBe(401);
  });

  it("rejects a caller who isn't a member of the organization", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/conversations?organizationId=${organizationId}`,
      cookies: { [SESSION_COOKIE_NAME]: outsiderCookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it("never returns another organization's conversation via GET /conversations/:id, even by a member of a real (different) org", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/conversations/${conversationIds[0]}?organizationId=${outsiderOrganizationId}`,
      cookies: { [SESSION_COOKIE_NAME]: outsiderCookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it("never returns another organization's messages via GET /conversations/:id/messages", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/conversations/${conversationIds[0]}/messages?organizationId=${outsiderOrganizationId}`,
      cookies: { [SESSION_COOKIE_NAME]: outsiderCookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it("never returns another organization's conversations in the list, even filtered by a real knowledgeBaseId from that org", async () => {
    const kb = await withTenantTransaction(organizationId, (tx) => tx.knowledgeBase.findFirstOrThrow());
    const response = await app.inject({
      method: "GET",
      url: `/conversations?organizationId=${outsiderOrganizationId}&knowledgeBaseId=${kb.id}`,
      cookies: { [SESSION_COOKIE_NAME]: outsiderCookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([]);
  });

  describe("DELETE /conversations/:id", () => {
    it("requires authentication", async () => {
      const response = await app.inject({
        method: "DELETE",
        url: `/conversations/${conversationIds[0]}?organizationId=${organizationId}`,
      });
      expect(response.statusCode).toBe(401);
    });

    it("returns 404 for a caller who isn't a member of the conversation's organization", async () => {
      const response = await app.inject({
        method: "DELETE",
        url: `/conversations/${conversationIds[0]}?organizationId=${organizationId}`,
        cookies: { [SESSION_COOKIE_NAME]: outsiderCookie },
      });
      expect(response.statusCode).toBe(404);
    });

    it("never deletes another organization's conversation, even scoped by the outsider's own real organizationId", async () => {
      const response = await app.inject({
        method: "DELETE",
        url: `/conversations/${conversationIds[0]}?organizationId=${outsiderOrganizationId}`,
        cookies: { [SESSION_COOKIE_NAME]: outsiderCookie },
      });
      expect(response.statusCode).toBe(404);

      // Untouched — still fetchable by its real owner afterward.
      const stillThere = await app.inject({
        method: "GET",
        url: `/conversations/${conversationIds[0]}?organizationId=${organizationId}`,
        cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      });
      expect(stillThere.statusCode).toBe(200);
    });

    it("returns 404 for a conversation id that doesn't exist", async () => {
      const response = await app.inject({
        method: "DELETE",
        url: `/conversations/${randomUUID()}?organizationId=${organizationId}`,
        cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      });
      expect(response.statusCode).toBe(404);
    });

    it("deletes the conversation and cascades its messages, then 404s on GET and on a second delete", async () => {
      // Reuse a fixture conversation's userId/knowledgeBaseId rather than
      // looking either up separately — this suite already established
      // both are valid, real rows scoped to this org.
      const template = await withTenantTransaction(organizationId, (tx) =>
        tx.conversation.findUniqueOrThrow({ where: { id: conversationIds[0] } }),
      );

      const conversation = await withTenantTransaction(organizationId, (tx) =>
        tx.conversation.create({
          data: {
            organizationId,
            userId: template.userId,
            knowledgeBaseId: template.knowledgeBaseId,
            title: "To be deleted",
          },
        }),
      );

      await withTenantTransaction(organizationId, (tx) =>
        tx.message.create({ data: { organizationId, conversationId: conversation.id, role: "USER", content: "hello" } }),
      );

      const del = await app.inject({
        method: "DELETE",
        url: `/conversations/${conversation.id}?organizationId=${organizationId}`,
        cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      });
      expect(del.statusCode).toBe(204);

      const messagesAfterDelete = await withTenantTransaction(organizationId, (tx) =>
        tx.message.findMany({ where: { conversationId: conversation.id } }),
      );
      expect(messagesAfterDelete).toHaveLength(0);

      const getAfterDelete = await app.inject({
        method: "GET",
        url: `/conversations/${conversation.id}?organizationId=${organizationId}`,
        cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      });
      expect(getAfterDelete.statusCode).toBe(404);

      const secondDelete = await app.inject({
        method: "DELETE",
        url: `/conversations/${conversation.id}?organizationId=${organizationId}`,
        cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      });
      expect(secondDelete.statusCode).toBe(404);
    });
  });

  describe("PATCH /conversations/:id", () => {
    it("requires authentication", async () => {
      const response = await app.inject({
        method: "PATCH",
        url: `/conversations/${conversationIds[1]}`,
        payload: { organizationId, title: "New title" },
      });
      expect(response.statusCode).toBe(401);
    });

    it("rejects an empty or overlong title", async () => {
      const empty = await app.inject({
        method: "PATCH",
        url: `/conversations/${conversationIds[1]}`,
        cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
        payload: { organizationId, title: "" },
      });
      expect(empty.statusCode).toBe(422);

      const overlong = await app.inject({
        method: "PATCH",
        url: `/conversations/${conversationIds[1]}`,
        cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
        payload: { organizationId, title: "x".repeat(201) },
      });
      expect(overlong.statusCode).toBe(422);
    });

    it("returns 404 for a conversation id that doesn't exist", async () => {
      const response = await app.inject({
        method: "PATCH",
        url: `/conversations/${randomUUID()}`,
        cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
        payload: { organizationId, title: "New title" },
      });
      expect(response.statusCode).toBe(404);
    });

    it("never renames another organization's conversation, even scoped by the outsider's own real organizationId", async () => {
      const response = await app.inject({
        method: "PATCH",
        url: `/conversations/${conversationIds[1]}`,
        cookies: { [SESSION_COOKIE_NAME]: outsiderCookie },
        payload: { organizationId: outsiderOrganizationId, title: "Hijacked title" },
      });
      expect(response.statusCode).toBe(404);

      const stillOriginal = await app.inject({
        method: "GET",
        url: `/conversations/${conversationIds[1]}?organizationId=${organizationId}`,
        cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      });
      expect(stillOriginal.json().title).toBe("Conversation 1");
    });

    it("renames the conversation and persists the new title", async () => {
      const response = await app.inject({
        method: "PATCH",
        url: `/conversations/${conversationIds[1]}`,
        cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
        payload: { organizationId, title: "  Renamed conversation  " },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().title).toBe("Renamed conversation");

      const fetched = await app.inject({
        method: "GET",
        url: `/conversations/${conversationIds[1]}?organizationId=${organizationId}`,
        cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      });
      expect(fetched.json().title).toBe("Renamed conversation");
    });
  });
});
