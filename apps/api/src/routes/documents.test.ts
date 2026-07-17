/**
 * Integration tests against real Postgres + Redis + MinIO via
 * app.inject() — no mocking of any of them. Prerequisites: docker compose
 * up -d, migrations applied (pnpm --filter @raas/db migrate:deploy).
 */
import { randomUUID } from "node:crypto";

import { prisma, withTenantTransaction } from "@raas/db";
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

async function presignDocument(
  app: FastifyInstance,
  sessionCookie: string,
  organizationId: string,
  knowledgeBaseId: string,
): Promise<{ documentId: string; uploadUrl: string }> {
  const response = await app.inject({
    method: "POST",
    url: `/kb/${knowledgeBaseId}/documents/presign`,
    cookies: { [SESSION_COOKIE_NAME]: sessionCookie },
    payload: {
      organizationId,
      fileName: "report.txt",
      mimeType: "text/plain",
      sizeBytes: 11,
    },
  });
  const body = response.json();
  return { documentId: body.document.id, uploadUrl: body.uploadUrl };
}

describe("document routes", () => {
  let app: FastifyInstance;
  const suffix = randomUUID().slice(0, 8);
  const password = "correct-horse-battery-staple";

  let ownerCookie: string;
  let organizationId: string;
  let knowledgeBaseId: string;
  let outsiderCookie: string;

  beforeAll(async () => {
    app = await buildApp();

    const owner = await signup(app, `doc-owner-${suffix}@example.com`, password, `Doc Org ${suffix}`);
    ownerCookie = owner.sessionCookie;
    organizationId = owner.organizationId;

    const outsider = await signup(app, `doc-outsider-${suffix}@example.com`, password, `Doc Outsider Org ${suffix}`);
    outsiderCookie = outsider.sessionCookie;

    const kbResponse = await app.inject({
      method: "POST",
      url: "/kb",
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      payload: {
        organizationId,
        name: "Ingestion Docs",
        embeddingProvider: "openai",
        embeddingModel: "text-embedding-3-small",
        embeddingDim: PLATFORM_EMBEDDING_DIM,
      },
    });
    knowledgeBaseId = kbResponse.json().id;
  });

  afterAll(async () => {
    await app.close();
    await prisma.user.deleteMany({ where: { email: { contains: suffix } } });
    await prisma.organization.deleteMany({ where: { slug: { contains: suffix } } });
    await redis.quit();
  });

  it("rejects completing a document whose object was never actually uploaded", async () => {
    const { documentId } = await presignDocument(app, ownerCookie, organizationId, knowledgeBaseId);

    const response = await app.inject({
      method: "POST",
      url: `/documents/${documentId}/complete`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      payload: { organizationId },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("CONFLICT");

    const stored = await withTenantTransaction(organizationId, (tx) =>
      tx.document.findUnique({ where: { id: documentId } }),
    );
    expect(stored?.status).toBe("PENDING_UPLOAD");
  });

  it("completes a document after the object is actually uploaded, transitioning PENDING_UPLOAD -> QUEUED", async () => {
    const { documentId, uploadUrl } = await presignDocument(app, ownerCookie, organizationId, knowledgeBaseId);

    const putResponse = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: "hello world",
    });
    expect(putResponse.ok).toBe(true);

    const response = await app.inject({
      method: "POST",
      url: `/documents/${documentId}/complete`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      payload: { organizationId },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("QUEUED");
  });

  it("rejects completing a document that isn't PENDING_UPLOAD anymore", async () => {
    const { documentId, uploadUrl } = await presignDocument(app, ownerCookie, organizationId, knowledgeBaseId);

    await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": "text/plain" }, body: "hello again" });

    const first = await app.inject({
      method: "POST",
      url: `/documents/${documentId}/complete`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      payload: { organizationId },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: `/documents/${documentId}/complete`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      payload: { organizationId },
    });
    expect(second.statusCode).toBe(409);
  });

  it("rejects completing a document for an organization the caller isn't a member of", async () => {
    const { documentId } = await presignDocument(app, ownerCookie, organizationId, knowledgeBaseId);

    const response = await app.inject({
      method: "POST",
      url: `/documents/${documentId}/complete`,
      cookies: { [SESSION_COOKIE_NAME]: outsiderCookie },
      payload: { organizationId },
    });

    expect(response.statusCode).toBe(404);
  });

  it("rejects completing a document id that doesn't exist", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/documents/${randomUUID()}/complete`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      payload: { organizationId },
    });

    expect(response.statusCode).toBe(404);
  });

  it("requires authentication to complete a document", async () => {
    const { documentId } = await presignDocument(app, ownerCookie, organizationId, knowledgeBaseId);

    const response = await app.inject({
      method: "POST",
      url: `/documents/${documentId}/complete`,
      payload: { organizationId },
    });

    expect(response.statusCode).toBe(401);
  });

  describe("daily document processing quota", () => {
    // Same Redis key the production checkDocumentQuota (apps/api/src/lib/
    // rate-limit.ts) writes to, via @raas/usage's checkAndConsumeDailyBudget
    // -> the "documents" dimension -> packages/rate-limit's "ratelimit:"
    // prefix. Pre-seeding it directly (rather than making
    // RATE_LIMIT_DOCUMENT_QUOTA_DAILY_DEFAULT real presign+upload+complete
    // round trips) is what keeps this test fast — the counting primitive
    // itself is already verified against real Redis in
    // packages/usage/src/budget-guard.test.ts; this test only checks that
    // the route is actually wired to it and responds with the standard
    // 429 envelope.
    function quotaKey(orgId: string): string {
      return `ratelimit:usage:org:${orgId}:documents:daily`;
    }

    it("returns 429 with the rate-limit envelope once the org's daily document quota is exhausted", async () => {
      const org = await signup(app, `doc-quota-${suffix}@example.com`, password, `Doc Quota Org ${suffix}`);
      const kbResponse = await app.inject({
        method: "POST",
        url: "/kb",
        cookies: { [SESSION_COOKIE_NAME]: org.sessionCookie },
        payload: {
          organizationId: org.organizationId,
          name: "Quota KB",
          embeddingProvider: "openai",
          embeddingModel: "text-embedding-3-small",
          embeddingDim: PLATFORM_EMBEDDING_DIM,
        },
      });
      const kbId = kbResponse.json().id;

      // RATE_LIMIT_DOCUMENT_QUOTA_DAILY_DEFAULT defaults to 200 — pre-seed
      // the counter to exactly that so the very next completion request
      // is the one that crosses it.
      await redis.set(quotaKey(org.organizationId), 200, "EX", 86_400);

      const { documentId, uploadUrl } = await presignDocument(app, org.sessionCookie, org.organizationId, kbId);
      await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": "text/plain" }, body: "quota probe" });

      const response = await app.inject({
        method: "POST",
        url: `/documents/${documentId}/complete`,
        cookies: { [SESSION_COOKIE_NAME]: org.sessionCookie },
        payload: { organizationId: org.organizationId },
      });

      expect(response.statusCode).toBe(429);
      expect(response.json()).toMatchObject({ error: { code: "RATE_LIMIT_EXCEEDED" } });

      // The document must NOT have been transitioned to QUEUED (and
      // therefore never enqueued) once the quota rejected the request.
      const stored = await withTenantTransaction(org.organizationId, (tx) => tx.document.findUnique({ where: { id: documentId } }));
      expect(stored?.status).toBe("PENDING_UPLOAD");
    });

    it("keeps daily document quotas fully isolated between organizations", async () => {
      const orgA = await signup(app, `doc-quota-a-${suffix}@example.com`, password, `Doc Quota Org A ${suffix}`);
      const orgB = await signup(app, `doc-quota-b-${suffix}@example.com`, password, `Doc Quota Org B ${suffix}`);
      const kbAResponse = await app.inject({
        method: "POST",
        url: "/kb",
        cookies: { [SESSION_COOKIE_NAME]: orgA.sessionCookie },
        payload: {
          organizationId: orgA.organizationId,
          name: "Quota KB A",
          embeddingProvider: "openai",
          embeddingModel: "text-embedding-3-small",
          embeddingDim: PLATFORM_EMBEDDING_DIM,
        },
      });
      const kbBResponse = await app.inject({
        method: "POST",
        url: "/kb",
        cookies: { [SESSION_COOKIE_NAME]: orgB.sessionCookie },
        payload: {
          organizationId: orgB.organizationId,
          name: "Quota KB B",
          embeddingProvider: "openai",
          embeddingModel: "text-embedding-3-small",
          embeddingDim: PLATFORM_EMBEDDING_DIM,
        },
      });

      await redis.set(quotaKey(orgA.organizationId), 200, "EX", 86_400);

      const { documentId: docA, uploadUrl: uploadUrlA } = await presignDocument(app, orgA.sessionCookie, orgA.organizationId, kbAResponse.json().id);
      await fetch(uploadUrlA, { method: "PUT", headers: { "Content-Type": "text/plain" }, body: "org a" });
      const responseA = await app.inject({
        method: "POST",
        url: `/documents/${docA}/complete`,
        cookies: { [SESSION_COOKIE_NAME]: orgA.sessionCookie },
        payload: { organizationId: orgA.organizationId },
      });
      expect(responseA.statusCode).toBe(429);

      // Org A's exhausted quota must not affect Org B's own counter.
      const { documentId: docB, uploadUrl: uploadUrlB } = await presignDocument(app, orgB.sessionCookie, orgB.organizationId, kbBResponse.json().id);
      await fetch(uploadUrlB, { method: "PUT", headers: { "Content-Type": "text/plain" }, body: "org b" });
      const responseB = await app.inject({
        method: "POST",
        url: `/documents/${docB}/complete`,
        cookies: { [SESSION_COOKIE_NAME]: orgB.sessionCookie },
        payload: { organizationId: orgB.organizationId },
      });
      expect(responseB.statusCode).toBe(200);
    });

    it("resets once the daily window rolls over", async () => {
      const org = await signup(app, `doc-quota-reset-${suffix}@example.com`, password, `Doc Quota Reset Org ${suffix}`);
      const kbResponse = await app.inject({
        method: "POST",
        url: "/kb",
        cookies: { [SESSION_COOKIE_NAME]: org.sessionCookie },
        payload: {
          organizationId: org.organizationId,
          name: "Quota Reset KB",
          embeddingProvider: "openai",
          embeddingModel: "text-embedding-3-small",
          embeddingDim: PLATFORM_EMBEDDING_DIM,
        },
      });
      const kbId = kbResponse.json().id;

      await redis.set(quotaKey(org.organizationId), 200, "EX", 86_400);

      const first = await presignDocument(app, org.sessionCookie, org.organizationId, kbId);
      await fetch(first.uploadUrl, { method: "PUT", headers: { "Content-Type": "text/plain" }, body: "before reset" });
      const blocked = await app.inject({
        method: "POST",
        url: `/documents/${first.documentId}/complete`,
        cookies: { [SESSION_COOKIE_NAME]: org.sessionCookie },
        payload: { organizationId: org.organizationId },
      });
      expect(blocked.statusCode).toBe(429);

      // The fixed window "resets" by the key's TTL expiring — deleting it
      // directly simulates that rollover without waiting out a real 24h
      // window (the TTL/expiry mechanics themselves are already verified
      // against real Redis in packages/rate-limit/src/rate-limiter.test.ts).
      await redis.del(quotaKey(org.organizationId));

      const second = await presignDocument(app, org.sessionCookie, org.organizationId, kbId);
      await fetch(second.uploadUrl, { method: "PUT", headers: { "Content-Type": "text/plain" }, body: "after reset" });
      const allowed = await app.inject({
        method: "POST",
        url: `/documents/${second.documentId}/complete`,
        cookies: { [SESSION_COOKIE_NAME]: org.sessionCookie },
        payload: { organizationId: org.organizationId },
      });
      expect(allowed.statusCode).toBe(200);
    });
  });
});
