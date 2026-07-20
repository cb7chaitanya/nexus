/**
 * Integration tests against real Postgres + Redis + MinIO via
 * app.inject() — no mocking of any of them. Prerequisites: docker compose
 * up -d, migrations applied (pnpm --filter @raas/db migrate:deploy).
 */
import { randomUUID } from "node:crypto";

import { PutObjectCommand } from "@aws-sdk/client-s3";
import { prisma, withTenantTransaction } from "@raas/db";
import { JOB_NAMES, PLATFORM_EMBEDDING_DIM, QUEUE_NAMES } from "@raas/shared";
import { Queue } from "bullmq";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { buildApp } from "../app.js";
import { env } from "../env.js";
import { redis } from "../lib/redis.js";
import { objectExists, s3 } from "../lib/storage.js";
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
    // Presigned POST (not PUT — see lib/storage.ts's createPresignedUpload):
    // the storage key travels as a form field, not embedded in the URL
    // itself, and the returned fields must include a content-length-range
    // policy condition bounding the upload to what was just declared.
    expect(typeof body.uploadUrl).toBe("string");
    expect(body.uploadFields.key).toBe(body.document.storageKey);
    expect(typeof body.uploadFields.Policy).toBe("string");
    const decodedPolicy = JSON.parse(Buffer.from(body.uploadFields.Policy, "base64").toString("utf8")) as {
      conditions: unknown[];
    };
    expect(decodedPolicy.conditions).toContainEqual(["content-length-range", 1, 1024]);
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

  describe("ingestion rate limiting on POST /kb", () => {
    it("returns 429 with the rate-limit envelope and headers once the org's ingestion RPM limit is exceeded", async () => {
      const limited = await signup(app, `kb-ratelimit-${suffix}@example.com`, password, `KB Rate Limit Org ${suffix}`);

      let lastResponse;
      // RATE_LIMIT_INGESTION_ORG_RPM defaults to 20 — the 21st request in
      // this dedicated org's own 60s window must be denied.
      for (let i = 0; i < 21; i++) {
        lastResponse = await app.inject({
          method: "POST",
          url: "/kb",
          cookies: { [SESSION_COOKIE_NAME]: limited.sessionCookie },
          payload: {
            organizationId: limited.organizationId,
            name: `Rate Limit Probe ${i}`,
            embeddingProvider: "openai",
            embeddingModel: "text-embedding-3-small",
            embeddingDim: PLATFORM_EMBEDDING_DIM,
          },
        });
      }

      expect(lastResponse!.statusCode).toBe(429);
      expect(lastResponse!.json()).toMatchObject({ error: { code: "RATE_LIMIT_EXCEEDED" } });
      expect(lastResponse!.headers["x-ratelimit-limit"]).toBeDefined();
      expect(lastResponse!.headers["x-ratelimit-remaining"]).toBe("0");
      expect(Number(lastResponse!.headers["retry-after"])).toBeGreaterThan(0);
    });

    it("keeps ingestion rate limits fully isolated between organizations", async () => {
      const orgA = await signup(app, `kb-ratelimit-a-${suffix}@example.com`, password, `KB Rate Limit Org A ${suffix}`);
      const orgB = await signup(app, `kb-ratelimit-b-${suffix}@example.com`, password, `KB Rate Limit Org B ${suffix}`);

      let lastResponseA;
      for (let i = 0; i < 21; i++) {
        lastResponseA = await app.inject({
          method: "POST",
          url: "/kb",
          cookies: { [SESSION_COOKIE_NAME]: orgA.sessionCookie },
          payload: {
            organizationId: orgA.organizationId,
            name: `Org A Probe ${i}`,
            embeddingProvider: "openai",
            embeddingModel: "text-embedding-3-small",
            embeddingDim: PLATFORM_EMBEDDING_DIM,
          },
        });
      }
      expect(lastResponseA!.statusCode).toBe(429);

      // Org A's exhausted limit must not affect Org B's own counter.
      const responseB = await app.inject({
        method: "POST",
        url: "/kb",
        cookies: { [SESSION_COOKIE_NAME]: orgB.sessionCookie },
        payload: {
          organizationId: orgB.organizationId,
          name: "Org B First Request",
          embeddingProvider: "openai",
          embeddingModel: "text-embedding-3-small",
          embeddingDim: PLATFORM_EMBEDDING_DIM,
        },
      });
      expect(responseB.statusCode).toBe(201);
    });
  });

  describe("GET/PATCH/DELETE /kb/:id", () => {
    async function createKb(cookie: string, orgId: string, name: string): Promise<string> {
      const response = await app.inject({
        method: "POST",
        url: "/kb",
        cookies: { [SESSION_COOKIE_NAME]: cookie },
        payload: {
          organizationId: orgId,
          name,
          embeddingProvider: "openai",
          embeddingModel: "text-embedding-3-small",
          embeddingDim: PLATFORM_EMBEDDING_DIM,
        },
      });
      return response.json().id;
    }

    /** Invites and accepts a MEMBER-role user into ownerCookie's org —
     * used to test that PATCH/DELETE require ADMIN+, not just membership. */
    async function inviteMember(email: string): Promise<string> {
      const invite = await app.inject({
        method: "POST",
        url: `/organizations/${organizationId}/invites`,
        cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
        payload: { email, role: "MEMBER" },
      });
      const { token } = invite.json();

      const signedUp = await signup(app, email, password, `Member Personal Org ${randomUUID().slice(0, 8)}`);
      await app.inject({
        method: "POST",
        url: `/invites/${token}/accept`,
        cookies: { [SESSION_COOKIE_NAME]: signedUp.sessionCookie },
      });
      return signedUp.sessionCookie;
    }

    it("returns KB details with document/chunk/storage stats", async () => {
      const kbId = await createKb(ownerCookie, organizationId, "Detail KB");

      const response = await app.inject({
        method: "GET",
        url: `/kb/${kbId}?organizationId=${organizationId}`,
        cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.id).toBe(kbId);
      expect(body.stats).toEqual({ documentCount: 0, chunkCount: 0, storageBytes: 0 });
    });

    it("returns 404 for a KB belonging to another organization (tenant isolation)", async () => {
      const outsiderOrg = await signup(app, `kb-detail-outsider-${suffix}@example.com`, password, `KB Detail Outsider ${suffix}`);
      const kbId = await createKb(ownerCookie, organizationId, "Isolated KB");

      const response = await app.inject({
        method: "GET",
        url: `/kb/${kbId}?organizationId=${outsiderOrg.organizationId}`,
        cookies: { [SESSION_COOKIE_NAME]: outsiderOrg.sessionCookie },
      });

      expect(response.statusCode).toBe(404);
    });

    it("returns 404 for a KB id that doesn't exist", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/kb/${randomUUID()}?organizationId=${organizationId}`,
        cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      });
      expect(response.statusCode).toBe(404);
    });

    it("updates name and description via PATCH", async () => {
      const kbId = await createKb(ownerCookie, organizationId, "Patchable KB");

      const response = await app.inject({
        method: "PATCH",
        url: `/kb/${kbId}`,
        cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
        payload: { organizationId, name: "Renamed KB", description: "a description" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ name: "Renamed KB", description: "a description" });
    });

    it("rejects PATCH from a MEMBER — requires ADMIN or higher", async () => {
      const kbId = await createKb(ownerCookie, organizationId, "Role Gated KB");
      const memberCookie = await inviteMember(`kb-patch-member-${suffix}@example.com`);

      const response = await app.inject({
        method: "PATCH",
        url: `/kb/${kbId}`,
        cookies: { [SESSION_COOKIE_NAME]: memberCookie },
        payload: { organizationId, name: "Should Not Work" },
      });

      expect(response.statusCode).toBe(403);
    });

    it("embeddingProvider/embeddingModel/embeddingDim are silently ignored by PATCH (immutable)", async () => {
      const kbId = await createKb(ownerCookie, organizationId, "Immutable Fields KB");

      const response = await app.inject({
        method: "PATCH",
        url: `/kb/${kbId}`,
        cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
        // updateKnowledgeBaseSchema has no embeddingProvider field at all —
        // zod strips unrecognized keys by default (same as every other
        // schema in this codebase), so this parses as a no-op update
        // rather than a validation error; the real assertion is that the
        // stored value never changes.
        payload: { organizationId, embeddingProvider: "cohere" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().embeddingProvider).toBe("openai");
    });

    it("small KB: DELETE removes it synchronously and returns 204", async () => {
      const kbId = await createKb(ownerCookie, organizationId, "Small Delete KB");

      const response = await app.inject({
        method: "DELETE",
        url: `/kb/${kbId}?organizationId=${organizationId}`,
        cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      });
      expect(response.statusCode).toBe(204);

      const stored = await withTenantTransaction(organizationId, (tx) => tx.knowledgeBase.findUnique({ where: { id: kbId } }));
      expect(stored).toBeNull();

      // Gone from the list too.
      const listResponse = await app.inject({
        method: "GET",
        url: `/kb?organizationId=${organizationId}`,
        cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      });
      expect(listResponse.json().data.some((kb: { id: string }) => kb.id === kbId)).toBe(false);
    });

    it("rejects DELETE from a MEMBER — requires ADMIN or higher", async () => {
      const kbId = await createKb(ownerCookie, organizationId, "Delete Role Gated KB");
      const memberCookie = await inviteMember(`kb-delete-member-${suffix}@example.com`);

      const response = await app.inject({
        method: "DELETE",
        url: `/kb/${kbId}?organizationId=${organizationId}`,
        cookies: { [SESSION_COOKIE_NAME]: memberCookie },
      });

      expect(response.statusCode).toBe(403);
    });

    it("returns 404 deleting a KB id that doesn't exist", async () => {
      const response = await app.inject({
        method: "DELETE",
        url: `/kb/${randomUUID()}?organizationId=${organizationId}`,
        cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      });
      expect(response.statusCode).toBe(404);
    });

    it("large KB (chunk count over threshold): DELETE marks it DELETING, enqueues cleanup, returns 202", async () => {
      const kbId = await createKb(ownerCookie, organizationId, "Large Delete KB");

      // Directly seed chunk rows past KB_DELETION_ASYNC_CHUNK_THRESHOLD
      // (default 5000) — real ingestion to reach that count would be far
      // too slow for a test; this exercises DELETE's own threshold
      // decision, not the ingestion pipeline (already covered elsewhere).
      const document = await withTenantTransaction(organizationId, (tx) =>
        tx.document.create({
          data: {
            organizationId,
            knowledgeBaseId: kbId,
            fileName: "big.pdf",
            mimeType: "application/pdf",
            sizeBytes: 1,
            storageKey: `${organizationId}/${kbId}/${randomUUID()}`,
            status: "READY",
          },
        }),
      );
      const chunkRows = Array.from({ length: 5001 }, (_, i) => ({
        organizationId,
        knowledgeBaseId: kbId,
        documentId: document.id,
        chunkIndex: i,
        content: "x",
        tokenCount: 1,
        charStart: 0,
        charEnd: 1,
      }));
      await withTenantTransaction(organizationId, (tx) => tx.documentChunk.createMany({ data: chunkRows }));

      const response = await app.inject({
        method: "DELETE",
        url: `/kb/${kbId}?organizationId=${organizationId}`,
        cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      });

      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({ id: kbId, status: "DELETING" });

      // Immediately invisible to reads, even though the row (and its
      // chunks) still exist until the async worker job finishes — DELETE's
      // contract is "gone now," not "will eventually be gone."
      const getResponse = await app.inject({
        method: "GET",
        url: `/kb/${kbId}?organizationId=${organizationId}`,
        cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      });
      expect(getResponse.statusCode).toBe(404);

      const stillInDb = await withTenantTransaction(organizationId, (tx) => tx.knowledgeBase.findUnique({ where: { id: kbId } }));
      expect(stillInDb?.status).toBe("DELETING");
    });

    it("small KB: when inline S3 cleanup fails, falls back to the async retry job (202) instead of orphaning the objects", async () => {
      const kbId = await createKb(ownerCookie, organizationId, "S3-Failure Delete KB");
      const storageKey = `${organizationId}/${kbId}/${randomUUID()}-doc.pdf`;
      await s3.send(new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: storageKey, Body: "fake pdf bytes", ContentType: "application/pdf" }));
      const document = await withTenantTransaction(organizationId, (tx) =>
        tx.document.create({
          data: { organizationId, knowledgeBaseId: kbId, fileName: "doc.pdf", mimeType: "application/pdf", sizeBytes: 15, storageKey, status: "READY" },
        }),
      );

      const sendSpy = vi.spyOn(s3, "send").mockRejectedValueOnce(new Error("simulated S3 outage"));

      const response = await app.inject({
        method: "DELETE",
        url: `/kb/${kbId}?organizationId=${organizationId}`,
        cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      });
      sendSpy.mockRestore();

      // Degrades to the same 202/DELETING contract the large-KB path
      // already has — cleanup didn't finish synchronously, so it's
      // handed off, exactly like the large-KB case above.
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({ id: kbId, status: "DELETING" });

      // Not orphaned: the KB row was never cascaded (only flipped to
      // DELETING), so the Document row — and therefore the storageKey a
      // retry needs — is still there, and the S3 object itself is still
      // genuinely present (nothing was lost track of).
      const stillInDb = await withTenantTransaction(organizationId, (tx) => tx.knowledgeBase.findUnique({ where: { id: kbId } }));
      expect(stillInDb?.status).toBe("DELETING");
      const stillHasDocument = await withTenantTransaction(organizationId, (tx) => tx.document.findUnique({ where: { id: document.id } }));
      expect(stillHasDocument).not.toBeNull();
      expect(await objectExists(storageKey)).toBe(true);

      // Retry is possible: the same job the large-KB path uses was
      // actually enqueued, under its deterministic id (see
      // lib/kb-cleanup.ts).
      const kbCleanupQueue = new Queue(QUEUE_NAMES.kbCleanup, { connection: redis });
      try {
        const job = await kbCleanupQueue.getJob(`${JOB_NAMES.cleanupKnowledgeBase}-${kbId}`);
        expect(job).toBeDefined();
        expect(job?.data).toMatchObject({ organizationId, knowledgeBaseId: kbId });
      } finally {
        await kbCleanupQueue.close();
      }
    });
  });
});
