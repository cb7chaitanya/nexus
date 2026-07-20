/**
 * Real Postgres integration test — cross-org iteration and the
 * updatedAt-threshold behavior can't be meaningfully verified without a
 * live database. Prerequisites: docker compose up -d, migrations
 * applied.
 */
import { randomUUID } from "node:crypto";

import { prisma, withTenantTransaction } from "@raas/db";
import { JOB_NAMES, QUEUE_NAMES } from "@raas/shared";
import { Queue } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { redisConnection } from "../lib/redis.js";
import { sweepStuckDocuments } from "./sweep-stuck-documents.js";

const THRESHOLD_MS = 1000;

describe("sweepStuckDocuments", () => {
  const suffix = randomUUID().slice(0, 8);
  let orgA: { id: string };
  let orgB: { id: string };
  let kbA: { id: string };
  let kbB: { id: string };

  beforeAll(async () => {
    orgA = await prisma.organization.create({ data: { name: `Sweep Org A ${suffix}`, slug: `sweep-org-a-${suffix}` } });
    orgB = await prisma.organization.create({ data: { name: `Sweep Org B ${suffix}`, slug: `sweep-org-b-${suffix}` } });
    kbA = await withTenantTransaction(orgA.id, (tx) =>
      tx.knowledgeBase.create({ data: { organizationId: orgA.id, name: "KB A", embeddingProvider: "openai", embeddingModel: "text-embedding-3-small", embeddingDim: 1536 } }),
    );
    kbB = await withTenantTransaction(orgB.id, (tx) =>
      tx.knowledgeBase.create({ data: { organizationId: orgB.id, name: "KB B", embeddingProvider: "openai", embeddingModel: "text-embedding-3-small", embeddingDim: 1536 } }),
    );
  });

  afterAll(async () => {
    await prisma.organization.delete({ where: { id: orgA.id } }).catch(() => undefined);
    await prisma.organization.delete({ where: { id: orgB.id } }).catch(() => undefined);
  });

  async function createDocument(
    orgId: string,
    kbId: string,
    status: "QUEUED" | "PROCESSING",
    backdateMs: number,
    retryCount = 0,
  ): Promise<string> {
    const doc = await withTenantTransaction(orgId, (tx) =>
      tx.document.create({
        data: { organizationId: orgId, knowledgeBaseId: kbId, fileName: "x.pdf", mimeType: "application/pdf", sizeBytes: 1, storageKey: `${orgId}/${randomUUID()}`, status, retryCount },
      }),
    );
    if (backdateMs > 0) {
      const backdated = new Date(Date.now() - backdateMs);
      await withTenantTransaction(orgId, (tx) => tx.$executeRaw`UPDATE "Document" SET "updatedAt" = ${backdated} WHERE id = ${doc.id}`);
    }
    return doc.id;
  }

  it("marks a stuck QUEUED document FAILED with a clear reason, and leaves a recent one alone", async () => {
    const stuckId = await createDocument(orgA.id, kbA.id, "QUEUED", THRESHOLD_MS * 3);
    const freshId = await createDocument(orgA.id, kbA.id, "QUEUED", 0);

    const result = await sweepStuckDocuments({ thresholdMs: THRESHOLD_MS });

    const stuck = await withTenantTransaction(orgA.id, (tx) => tx.document.findUnique({ where: { id: stuckId } }));
    const fresh = await withTenantTransaction(orgA.id, (tx) => tx.document.findUnique({ where: { id: freshId } }));

    expect(stuck!.status).toBe("FAILED");
    expect(stuck!.failureReason).toContain("stuck");
    expect(fresh!.status).toBe("QUEUED");
    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect(result.retried).toBe(0);
  });

  it("marks a stuck PROCESSING document FAILED too", async () => {
    const stuckId = await createDocument(orgA.id, kbA.id, "PROCESSING", THRESHOLD_MS * 3);

    await sweepStuckDocuments({ thresholdMs: THRESHOLD_MS });

    const doc = await withTenantTransaction(orgA.id, (tx) => tx.document.findUnique({ where: { id: stuckId } }));
    expect(doc!.status).toBe("FAILED");
  });

  it("sweeps stuck documents across multiple organizations in one pass", async () => {
    const stuckAId = await createDocument(orgA.id, kbA.id, "QUEUED", THRESHOLD_MS * 3);
    const stuckBId = await createDocument(orgB.id, kbB.id, "QUEUED", THRESHOLD_MS * 3);

    await sweepStuckDocuments({ thresholdMs: THRESHOLD_MS });

    const docA = await withTenantTransaction(orgA.id, (tx) => tx.document.findUnique({ where: { id: stuckAId } }));
    const docB = await withTenantTransaction(orgB.id, (tx) => tx.document.findUnique({ where: { id: stuckBId } }));
    expect(docA!.status).toBe("FAILED");
    expect(docB!.status).toBe("FAILED");
  });

  it("never touches a document outside QUEUED/PROCESSING, no matter how old", async () => {
    const readyId = await createDocument(orgA.id, kbA.id, "QUEUED", 0);
    await withTenantTransaction(orgA.id, (tx) => tx.document.update({ where: { id: readyId }, data: { status: "READY" } }));
    await withTenantTransaction(
      orgA.id,
      (tx) => tx.$executeRaw`UPDATE "Document" SET "updatedAt" = ${new Date(Date.now() - THRESHOLD_MS * 3)} WHERE id = ${readyId}`,
    );

    await sweepStuckDocuments({ thresholdMs: THRESHOLD_MS });

    const doc = await withTenantTransaction(orgA.id, (tx) => tx.document.findUnique({ where: { id: readyId } }));
    expect(doc!.status).toBe("READY");
  });

  it("with autoRetry enabled, enqueues a fresh process-document job for the stuck document", async () => {
    const stuckId = await createDocument(orgA.id, kbA.id, "PROCESSING", THRESHOLD_MS * 3);

    const result = await sweepStuckDocuments({ thresholdMs: THRESHOLD_MS, autoRetry: true });
    expect(result.retried).toBeGreaterThanOrEqual(1);

    // Verifying against the queue directly, not Document.status: once a
    // job is enqueued to the real, shared document-processing queue, a
    // real worker (this same apps/worker, in production; potentially
    // another test file's in-process worker here) may legitimately pick
    // it up and move status again before an assertion could read it —
    // that's correct retry behavior, not something to race against. What
    // sweepStuckDocuments actually promises is that a fresh job exists.
    const processingQueue = new Queue(QUEUE_NAMES.processing, { connection: redisConnection });
    try {
      // process-document is the flow's PARENT job — it starts in
      // "waiting-children" (chunk-text/extract-text haven't completed
      // yet), not "waiting", so that state has to be included here too.
      const jobs = await processingQueue.getJobs(["waiting", "waiting-children", "active", "delayed", "completed", "failed"]);
      const retryJob = jobs.find((job) => job.name === JOB_NAMES.processDocument && (job.data as { documentId?: string }).documentId === stuckId);
      expect(retryJob).toBeDefined();
      expect(retryJob!.id).not.toBe(`${JOB_NAMES.processDocument}-${stuckId}`); // a fresh id, not the original
    } finally {
      await processingQueue.close();
    }
  });

  it("with autoRetry enabled, increments retryCount on every automatic re-enqueue", async () => {
    const stuckId = await createDocument(orgA.id, kbA.id, "PROCESSING", THRESHOLD_MS * 3, 1);

    await sweepStuckDocuments({ thresholdMs: THRESHOLD_MS, autoRetry: true, maxAutoRetries: 5 });

    const doc = await withTenantTransaction(orgA.id, (tx) => tx.document.findUnique({ where: { id: stuckId } }));
    expect(doc!.retryCount).toBe(2);
    expect(doc!.status).toBe("QUEUED");
  });

  it("with autoRetry enabled, leaves a document that already hit maxAutoRetries permanently FAILED instead of re-enqueuing it again", async () => {
    const stuckId = await createDocument(orgA.id, kbA.id, "PROCESSING", THRESHOLD_MS * 3, 3);

    const result = await sweepStuckDocuments({ thresholdMs: THRESHOLD_MS, autoRetry: true, maxAutoRetries: 3 });

    const doc = await withTenantTransaction(orgA.id, (tx) => tx.document.findUnique({ where: { id: stuckId } }));
    expect(doc!.status).toBe("FAILED");
    expect(doc!.retryCount).toBe(3); // unchanged — never re-enqueued, so never incremented
    expect(doc!.failureReason).toContain("automatic retry limit (3) reached");

    const processingQueue = new Queue(QUEUE_NAMES.processing, { connection: redisConnection });
    try {
      const jobs = await processingQueue.getJobs(["waiting", "waiting-children", "active", "delayed", "completed", "failed"]);
      const retryJob = jobs.find((job) => job.name === JOB_NAMES.processDocument && (job.data as { documentId?: string }).documentId === stuckId);
      expect(retryJob).toBeUndefined();
    } finally {
      await processingQueue.close();
    }
    // No new job means result.retried counts only documents actually
    // re-enqueued this pass — a capped document contributes to `failed`,
    // never to `retried`.
    expect(result.retried).toBe(0);
  });
});
