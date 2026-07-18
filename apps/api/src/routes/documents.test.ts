/**
 * Integration tests against real Postgres + Redis + MinIO via
 * app.inject() — no mocking of any of them. Prerequisites: docker compose
 * up -d, migrations applied (pnpm --filter @raas/db migrate:deploy).
 */
import { randomUUID } from "node:crypto";

import { prisma, withTenantTransaction } from "@raas/db";
import { JOB_NAMES, PLATFORM_EMBEDDING_DIM, QUEUE_NAMES } from "@raas/shared";
import { Queue } from "bullmq";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../app.js";
import { redis } from "../lib/redis.js";
import { objectExists } from "../lib/storage.js";
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

/**
 * Creates a Document row directly via Prisma, bypassing the real
 * POST /kb/:id/documents/presign HTTP call — for tests below that need
 * *some* real, valid document row (with a real, if never-actually-
 * uploaded, storageKey) but aren't testing the presign flow itself.
 * Deliberately not routed through the API: the GET/DELETE/retry describe
 * blocks each make several of these, and going through the real endpoint
 * for every one would burn through RATE_LIMIT_INGESTION_ORG_RPM against
 * the single shared `organizationId` this whole file reuses, the same
 * reason the "daily document processing quota" tests below give
 * themselves their own fresh orgs instead of sharing this one.
 */
async function createDocumentRow(
  organizationId: string,
  knowledgeBaseId: string,
  status: "PENDING_UPLOAD" | "QUEUED" | "PROCESSING" | "READY" | "FAILED" = "PENDING_UPLOAD",
): Promise<{ documentId: string; storageKey: string }> {
  const storageKey = `${organizationId}/${knowledgeBaseId}/${randomUUID()}-test.txt`;
  const document = await withTenantTransaction(organizationId, (tx) =>
    tx.document.create({
      data: {
        organizationId,
        knowledgeBaseId,
        fileName: "test.txt",
        mimeType: "text/plain",
        sizeBytes: 10,
        storageKey,
        status,
      },
    }),
  );
  return { documentId: document.id, storageKey };
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

  describe("GET /documents/:id", () => {
    it("returns the document for a member of its organization", async () => {
      const { documentId } = await createDocumentRow(organizationId, knowledgeBaseId);

      const response = await app.inject({
        method: "GET",
        url: `/documents/${documentId}?organizationId=${organizationId}`,
        cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ id: documentId, knowledgeBaseId, status: "PENDING_UPLOAD" });
    });

    it("requires authentication", async () => {
      const { documentId } = await createDocumentRow(organizationId, knowledgeBaseId);

      const response = await app.inject({ method: "GET", url: `/documents/${documentId}?organizationId=${organizationId}` });

      expect(response.statusCode).toBe(401);
    });

    it("returns 404 for a caller who isn't a member of the document's organization", async () => {
      const { documentId } = await createDocumentRow(organizationId, knowledgeBaseId);

      const response = await app.inject({
        method: "GET",
        url: `/documents/${documentId}?organizationId=${organizationId}`,
        cookies: { [SESSION_COOKIE_NAME]: outsiderCookie },
      });

      expect(response.statusCode).toBe(404);
    });

    it("returns 404 for a document id that doesn't exist", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/documents/${randomUUID()}?organizationId=${organizationId}`,
        cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe("DELETE /documents/:id", () => {
    it("requires authentication", async () => {
      const { documentId } = await createDocumentRow(organizationId, knowledgeBaseId);

      const response = await app.inject({ method: "DELETE", url: `/documents/${documentId}?organizationId=${organizationId}` });

      expect(response.statusCode).toBe(401);
    });

    it("returns 404 for a caller who isn't a member of the document's organization", async () => {
      const { documentId } = await createDocumentRow(organizationId, knowledgeBaseId);

      const response = await app.inject({
        method: "DELETE",
        url: `/documents/${documentId}?organizationId=${organizationId}`,
        cookies: { [SESSION_COOKIE_NAME]: outsiderCookie },
      });

      expect(response.statusCode).toBe(404);

      // Confirms the outsider's rejected request didn't touch anything —
      // the document must still be there for its actual org to delete.
      const stored = await withTenantTransaction(organizationId, (tx) => tx.document.findUnique({ where: { id: documentId } }));
      expect(stored?.status).not.toBe("DELETED");
    });

    it("returns 404 for a document id that doesn't exist", async () => {
      const response = await app.inject({
        method: "DELETE",
        url: `/documents/${randomUUID()}?organizationId=${organizationId}`,
        cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      });

      expect(response.statusCode).toBe(404);
    });

    it("removes object storage and vectors, but preserves the document row as an inspectable audit record", async () => {
      // The one test in this describe block that needs a genuinely
      // uploaded object — goes through the real presign+PUT flow rather
      // than createDocumentRow, specifically to prove a real S3 object
      // gets deleted.
      const { documentId, uploadUrl } = await presignDocument(app, ownerCookie, organizationId, knowledgeBaseId);
      await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": "text/plain" }, body: "to be deleted" });

      const stored = await withTenantTransaction(organizationId, (tx) => tx.document.findUniqueOrThrow({ where: { id: documentId } }));

      // Simulates chunks having been created by a prior (successful)
      // chunk-text run — DELETE must remove these regardless of how far
      // ingestion got.
      await withTenantTransaction(organizationId, (tx) =>
        tx.documentChunk.create({
          data: {
            organizationId,
            knowledgeBaseId,
            documentId,
            chunkIndex: 0,
            content: "chunk content",
            tokenCount: 2,
            charStart: 0,
            charEnd: 13,
          },
        }),
      );

      const response = await app.inject({
        method: "DELETE",
        url: `/documents/${documentId}?organizationId=${organizationId}`,
        cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      });
      expect(response.statusCode).toBe(204);

      // Object storage: gone. Same authenticated check the app itself
      // uses (lib/storage.ts's objectExists), not a raw fetch against a
      // guessed URL.
      expect(await objectExists(stored.storageKey)).toBe(false);

      // Vectors: gone.
      const chunks = await withTenantTransaction(organizationId, (tx) => tx.documentChunk.findMany({ where: { documentId } }));
      expect(chunks).toHaveLength(0);

      // Audit trail: the row itself is preserved, inspectable via GET,
      // showing what it was and when it was removed — not a 404 as if it
      // had never existed.
      const getResponse = await app.inject({
        method: "GET",
        url: `/documents/${documentId}?organizationId=${organizationId}`,
        cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      });
      expect(getResponse.statusCode).toBe(200);
      const deleted = getResponse.json();
      expect(deleted.status).toBe("DELETED");
      expect(deleted.deletedAt).not.toBeNull();
      expect(deleted.fileName).toBe(stored.fileName);
    });

    it("returns 404 on a second delete of an already-deleted document", async () => {
      const { documentId } = await createDocumentRow(organizationId, knowledgeBaseId);

      const first = await app.inject({
        method: "DELETE",
        url: `/documents/${documentId}?organizationId=${organizationId}`,
        cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      });
      expect(first.statusCode).toBe(204);

      const second = await app.inject({
        method: "DELETE",
        url: `/documents/${documentId}?organizationId=${organizationId}`,
        cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      });
      expect(second.statusCode).toBe(404);
    });

    it("excludes deleted documents from GET /kb/:id/documents and GET /kb/:id's stats", async () => {
      const { documentId } = await createDocumentRow(organizationId, knowledgeBaseId);

      const beforeStats = await app.inject({
        method: "GET",
        url: `/kb/${knowledgeBaseId}?organizationId=${organizationId}`,
        cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      });
      const documentCountBefore = beforeStats.json().stats.documentCount as number;

      await app.inject({
        method: "DELETE",
        url: `/documents/${documentId}?organizationId=${organizationId}`,
        cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      });

      const listResponse = await app.inject({
        method: "GET",
        url: `/kb/${knowledgeBaseId}/documents?organizationId=${organizationId}`,
        cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      });
      const listedIds = (listResponse.json().data as Array<{ id: string }>).map((d) => d.id);
      expect(listedIds).not.toContain(documentId);

      const afterStats = await app.inject({
        method: "GET",
        url: `/kb/${knowledgeBaseId}?organizationId=${organizationId}`,
        cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      });
      expect(afterStats.json().stats.documentCount).toBe(documentCountBefore - 1);
    });
  });

  describe("POST /documents/:id/retry", () => {
    /** Test-only shortcut: writes a document straight into FAILED (with
     * chunks already present, simulating "chunking succeeded, embedding
     * did not") via Prisma directly, rather than driving a real worker
     * through an actual failure — the pipeline's own failure paths are
     * already covered by apps/worker's test suite (pipeline.test.ts,
     * embed-chunks.test.ts); what these tests verify is retry's own
     * contract at the API layer. */
    async function createFailedDocumentWithChunks(chunkCount: number): Promise<{ documentId: string; chunkIds: string[] }> {
      const { documentId } = await createDocumentRow(organizationId, knowledgeBaseId, "FAILED");

      await withTenantTransaction(organizationId, (tx) =>
        tx.document.update({
          where: { id: documentId },
          data: { failureReason: "simulated failure for retry test" },
        }),
      );

      const chunkIds = await withTenantTransaction(organizationId, async (tx) => {
        const ids: string[] = [];
        for (let i = 0; i < chunkCount; i++) {
          const chunk = await tx.documentChunk.create({
            data: {
              organizationId,
              knowledgeBaseId,
              documentId,
              chunkIndex: i,
              content: `chunk ${i}`,
              tokenCount: 2,
              charStart: i * 10,
              charEnd: i * 10 + 7,
            },
          });
          ids.push(chunk.id);
        }
        return ids;
      });

      return { documentId, chunkIds };
    }

    it("clears the failure reason, transitions to QUEUED, and increments retryCount", async () => {
      const { documentId } = await createFailedDocumentWithChunks(2);

      const response = await app.inject({
        method: "POST",
        url: `/documents/${documentId}/retry`,
        cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
        payload: { organizationId },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.status).toBe("QUEUED");
      expect(body.failureReason).toBeNull();
      expect(body.retryCount).toBe(1);

      const stored = await withTenantTransaction(organizationId, (tx) => tx.document.findUniqueOrThrow({ where: { id: documentId } }));
      expect(stored.status).toBe("QUEUED");
      expect(stored.failureReason).toBeNull();
      expect(stored.retryCount).toBe(1);
    });

    it("does not touch existing DocumentChunk rows — no duplicate chunks", async () => {
      const { documentId, chunkIds } = await createFailedDocumentWithChunks(3);

      const response = await app.inject({
        method: "POST",
        url: `/documents/${documentId}/retry`,
        cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
        payload: { organizationId },
      });
      expect(response.statusCode).toBe(200);

      const chunks = await withTenantTransaction(organizationId, (tx) =>
        tx.documentChunk.findMany({ where: { documentId }, orderBy: { chunkIndex: "asc" } }),
      );
      expect(chunks).toHaveLength(3);
      expect(chunks.map((c) => c.id)).toEqual(chunkIds);
      // @@unique([documentId, chunkIndex]) — a duplicate chunkIndex would
      // have thrown a constraint violation had one actually been created;
      // this just double-checks the shape is still exactly what it was.
      expect(chunks.map((c) => c.chunkIndex)).toEqual([0, 1, 2]);
    });

    it("enqueues a fresh ingestion flow, distinct from the original attempt", async () => {
      const { documentId } = await createFailedDocumentWithChunks(1);

      const response = await app.inject({
        method: "POST",
        url: `/documents/${documentId}/retry`,
        cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
        payload: { organizationId },
      });
      const retryCount = response.json().retryCount as number;

      const processingQueue = new Queue(QUEUE_NAMES.processing, { connection: redis });
      try {
        const originalJob = await processingQueue.getJob(`${JOB_NAMES.processDocument}-${documentId}`);
        const retryJob = await processingQueue.getJob(`${JOB_NAMES.processDocument}-${documentId}-retry-${retryCount}`);

        // The original attempt's job was never created by this test (the
        // document was written straight to FAILED — see
        // createFailedDocumentWithChunks), so there's nothing there;
        // what matters is that retry's own job DOES exist, under its own
        // distinct id.
        expect(originalJob).toBeUndefined();
        expect(retryJob).toBeDefined();
        expect(retryJob?.data).toMatchObject({ organizationId, documentId });
      } finally {
        await processingQueue.close();
      }
    });

    it("rejects retrying a document that isn't FAILED", async () => {
      const { documentId } = await createDocumentRow(organizationId, knowledgeBaseId);

      const response = await app.inject({
        method: "POST",
        url: `/documents/${documentId}/retry`,
        cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
        payload: { organizationId },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe("CONFLICT");
    });

    it("returns 404 for a document id that doesn't exist", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/documents/${randomUUID()}/retry`,
        cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
        payload: { organizationId },
      });

      expect(response.statusCode).toBe(404);
    });

    it("requires authentication", async () => {
      const { documentId } = await createFailedDocumentWithChunks(1);

      const response = await app.inject({
        method: "POST",
        url: `/documents/${documentId}/retry`,
        payload: { organizationId },
      });

      expect(response.statusCode).toBe(401);
    });

    it("returns 404 for a caller who isn't a member of the document's organization", async () => {
      const { documentId } = await createFailedDocumentWithChunks(1);

      const response = await app.inject({
        method: "POST",
        url: `/documents/${documentId}/retry`,
        cookies: { [SESSION_COOKIE_NAME]: outsiderCookie },
        payload: { organizationId },
      });

      expect(response.statusCode).toBe(404);

      const stored = await withTenantTransaction(organizationId, (tx) => tx.document.findUniqueOrThrow({ where: { id: documentId } }));
      expect(stored.status).toBe("FAILED");
    });
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
