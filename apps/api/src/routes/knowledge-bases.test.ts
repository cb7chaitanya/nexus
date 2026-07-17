/**
 * Integration tests against real Postgres + Redis + MinIO via
 * app.inject() — no mocking of any of them. Prerequisites: docker compose
 * up -d, migrations applied (pnpm --filter @raas/db migrate:deploy).
 */
import { randomUUID } from "node:crypto";

import { prisma } from "@raas/db";
import { PLATFORM_EMBEDDING_DIM } from "@raas/shared";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../app.js";
import { redis } from "../lib/redis.js";
import { SESSION_COOKIE_NAME } from "../plugins/auth-guard.js";

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

describe("knowledge base routes", () => {
  let app: FastifyInstance;
  const suffix = randomUUID().slice(0, 8);
  const password = "correct-horse-battery-staple";

  let ownerCookie: string;
  let organizationId: string;
  let outsiderCookie: string;

  beforeAll(async () => {
    app = await buildApp();

    const owner = await signup(app, `kb-owner-${suffix}@example.com`, password, `KB Org ${suffix}`);
    ownerCookie = owner.sessionCookie;
    organizationId = owner.organizationId;

    const outsider = await signup(app, `kb-outsider-${suffix}@example.com`, password, `KB Outsider Org ${suffix}`);
    outsiderCookie = outsider.sessionCookie;
  });

  afterAll(async () => {
    await app.close();
    await prisma.user.deleteMany({ where: { email: { contains: suffix } } });
    await prisma.organization.deleteMany({ where: { slug: { contains: suffix } } });
    await redis.quit();
  });

  it("creates a knowledge base with the platform's fixed embedding dimension", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/kb",
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      payload: {
        organizationId,
        name: "Support Docs",
        embeddingProvider: "openai",
        embeddingModel: "text-embedding-3-small",
        embeddingDim: PLATFORM_EMBEDDING_DIM,
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.name).toBe("Support Docs");
    expect(body.embeddingDim).toBe(PLATFORM_EMBEDDING_DIM);
    expect(body.organizationId).toBe(organizationId);
  });

  it("rejects a knowledge base creation with any other embedding dimension", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/kb",
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      payload: {
        organizationId,
        name: "Bad Dim Docs",
        embeddingProvider: "openai",
        embeddingModel: "text-embedding-ada-002",
        embeddingDim: 768,
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects knowledge base creation for an organization the caller isn't a member of", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/kb",
      cookies: { [SESSION_COOKIE_NAME]: outsiderCookie },
      payload: {
        organizationId,
        name: "Sneaky Docs",
        embeddingProvider: "openai",
        embeddingModel: "text-embedding-3-small",
        embeddingDim: PLATFORM_EMBEDDING_DIM,
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("NOT_FOUND");
  });

  it("requires authentication to create a knowledge base", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/kb",
      payload: {
        organizationId,
        name: "No Auth Docs",
        embeddingProvider: "openai",
        embeddingModel: "text-embedding-3-small",
        embeddingDim: PLATFORM_EMBEDDING_DIM,
      },
    });

    expect(response.statusCode).toBe(401);
  });

  it("lists knowledge bases for the caller's organization", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/kb?organizationId=${organizationId}`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data.every((kb: { organizationId: string }) => kb.organizationId === organizationId)).toBe(
      true,
    );
  });

  it("rejects listing knowledge bases for an organization the caller isn't a member of", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/kb?organizationId=${organizationId}`,
      cookies: { [SESSION_COOKIE_NAME]: outsiderCookie },
    });

    expect(response.statusCode).toBe(404);
  });

  let knowledgeBaseId: string;

  it("presigns a document upload, creating a PENDING_UPLOAD document row", async () => {
    const kbResponse = await app.inject({
      method: "POST",
      url: "/kb",
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      payload: {
        organizationId,
        name: "Presign Docs",
        embeddingProvider: "openai",
        embeddingModel: "text-embedding-3-small",
        embeddingDim: PLATFORM_EMBEDDING_DIM,
      },
    });
    knowledgeBaseId = kbResponse.json().id;

    const response = await app.inject({
      method: "POST",
      url: `/kb/${knowledgeBaseId}/documents/presign`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      payload: {
        organizationId,
        fileName: "handbook.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1024,
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.document.status).toBe("PENDING_UPLOAD");
    expect(body.document.knowledgeBaseId).toBe(knowledgeBaseId);
    expect(typeof body.uploadUrl).toBe("string");
    expect(body.uploadUrl).toContain(body.document.storageKey);
  });

  it("rejects presigning for an organization the caller isn't a member of", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/kb/${knowledgeBaseId}/documents/presign`,
      cookies: { [SESSION_COOKIE_NAME]: outsiderCookie },
      payload: {
        organizationId,
        fileName: "handbook.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1024,
      },
    });

    expect(response.statusCode).toBe(404);
  });

  it("rejects presigning against a knowledge base id that doesn't exist", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/kb/${randomUUID()}/documents/presign`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      payload: {
        organizationId,
        fileName: "handbook.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1024,
      },
    });

    expect(response.statusCode).toBe(404);
  });

  it("paginates GET /kb with a cursor — no duplicates, correct nextCursor semantics", async () => {
    // At least 3 KBs already exist from earlier tests in this file; that's
    // enough to exercise a 2-item page plus a following page.
    const firstPage = await app.inject({
      method: "GET",
      url: `/kb?organizationId=${organizationId}&limit=2`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
    });
    const firstBody = firstPage.json();
    expect(firstBody.data).toHaveLength(2);
    expect(firstBody.nextCursor).toBeTruthy();

    const secondPage = await app.inject({
      method: "GET",
      url: `/kb?organizationId=${organizationId}&limit=2&cursor=${firstBody.nextCursor}`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
    });
    const secondBody = secondPage.json();
    const firstIds = firstBody.data.map((kb: { id: string }) => kb.id);
    const secondIds = secondBody.data.map((kb: { id: string }) => kb.id);
    expect(firstIds.some((id: string) => secondIds.includes(id))).toBe(false);
  });

  describe("GET /kb/:id/documents", () => {
    let docsKbId: string;
    const documentIds: string[] = [];

    beforeAll(async () => {
      const kbResponse = await app.inject({
        method: "POST",
        url: "/kb",
        cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
        payload: {
          organizationId,
          name: "Docs List KB",
          embeddingProvider: "openai",
          embeddingModel: "text-embedding-3-small",
          embeddingDim: PLATFORM_EMBEDDING_DIM,
        },
      });
      docsKbId = kbResponse.json().id;

      for (let i = 0; i < 3; i++) {
        const response = await app.inject({
          method: "POST",
          url: `/kb/${docsKbId}/documents/presign`,
          cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
          payload: { organizationId, fileName: `doc-${i}.pdf`, mimeType: "application/pdf", sizeBytes: 100 },
        });
        documentIds.push(response.json().document.id);
      }
    });

    it("lists documents for the KB, most-recent first", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/kb/${docsKbId}/documents?organizationId=${organizationId}&limit=100`,
        cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data).toHaveLength(3);
      expect(body.data[0].id).toBe(documentIds[2]);
      expect(body.data.every((d: { knowledgeBaseId: string }) => d.knowledgeBaseId === docsKbId)).toBe(true);
    });

    it("paginates documents with a cursor", async () => {
      const firstPage = await app.inject({
        method: "GET",
        url: `/kb/${docsKbId}/documents?organizationId=${organizationId}&limit=2`,
        cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      });
      const firstBody = firstPage.json();
      expect(firstBody.data).toHaveLength(2);
      expect(firstBody.nextCursor).toBeTruthy();

      const secondPage = await app.inject({
        method: "GET",
        url: `/kb/${docsKbId}/documents?organizationId=${organizationId}&limit=2&cursor=${firstBody.nextCursor}`,
        cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      });
      const secondBody = secondPage.json();
      expect(secondBody.data).toHaveLength(1);
      expect(secondBody.nextCursor).toBeNull();
    });

    it("rejects listing documents for an organization the caller isn't a member of", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/kb/${docsKbId}/documents?organizationId=${organizationId}`,
        cookies: { [SESSION_COOKIE_NAME]: outsiderCookie },
      });
      expect(response.statusCode).toBe(404);
    });

    it("returns 404 for a knowledge base id that doesn't exist", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/kb/${randomUUID()}/documents?organizationId=${organizationId}`,
        cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      });
      expect(response.statusCode).toBe(404);
    });
  });
});
