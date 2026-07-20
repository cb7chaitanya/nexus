/**
 * Integration test against real Postgres (RLS) + real Redis (BullMQ, for
 * realistic Job objects) + real MinIO — no mocking of Postgres or MinIO.
 * Every test invokes cleanupDocumentStorageProcessor directly against a
 * Job obtained from Queue#add rather than through a live, auto-consuming
 * Worker (unlike cleanup-knowledge-base.test.ts's original three tests):
 * several of these tests need precise control over exactly one S3 call
 * (via vi.spyOn(s3, "send")), which a concurrently-running Worker
 * consuming the same job the instant it's added would race against —
 * whichever invocation (the test's own, or the Worker's) reaches
 * deleteObjects first "wins" the mocked rejection, making the other one
 * silently succeed for real and the test flaky. No live Worker means no
 * race: this queue is never anything but a Job-object factory here. The
 * generic "a real BullMQ Worker actually consumes what's added to its
 * queue" wiring is already proven for this exact mechanism elsewhere
 * (e.g. cleanup-knowledge-base.test.ts, worker-concurrency.test.ts) —
 * this file's job is to verify cleanupDocumentStorageProcessor's own
 * logic, not re-prove BullMQ's consumption loop.
 *
 * Prerequisites: docker compose up -d, migrations applied.
 */
import { randomUUID } from "node:crypto";

import { CreateBucketCommand, HeadBucketCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { prisma, withTenantTransaction } from "@raas/db";
import { JOB_NAMES, QUEUE_NAMES } from "@raas/shared";
import { Queue } from "bullmq";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { env } from "../env.js";
import { redisConnection } from "../lib/redis.js";
import { s3 } from "../lib/storage.js";
import { cleanupDocumentStorageProcessor } from "./cleanup-document-storage.js";

async function ensureBucket(): Promise<void> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: env.S3_BUCKET }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: env.S3_BUCKET })).catch(() => undefined);
  }
}

async function objectExists(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

describe("cleanupDocumentStorageProcessor", () => {
  const suffix = randomUUID().slice(0, 8);
  let organizationId: string;
  let knowledgeBaseId: string;
  let queue: Queue;

  beforeAll(async () => {
    await ensureBucket();

    const org = await prisma.organization.create({ data: { name: `Doc Cleanup Org ${suffix}`, slug: `doc-cleanup-org-${suffix}` } });
    organizationId = org.id;
    const kb = await withTenantTransaction(organizationId, (tx) =>
      tx.knowledgeBase.create({
        data: { organizationId, name: "Doc Cleanup KB", embeddingProvider: "openai", embeddingModel: "text-embedding-3-small", embeddingDim: 1536 },
      }),
    );
    knowledgeBaseId = kb.id;

    // No Worker constructed here — see this file's own top-of-file
    // comment for why.
    queue = new Queue(QUEUE_NAMES.documentCleanup, { connection: redisConnection });
  });

  afterAll(async () => {
    await queue.close();
    await prisma.organization.delete({ where: { id: organizationId } }).catch(() => undefined);
  });

  async function createDeletedDocument(): Promise<{ documentId: string; storageKey: string }> {
    const storageKey = `${organizationId}/${knowledgeBaseId}/${randomUUID()}-doc.pdf`;
    await s3.send(new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: storageKey, Body: "fake pdf bytes", ContentType: "application/pdf" }));

    // Mirrors what DELETE /documents/:id itself leaves behind — soft
    // deleted, storageKey intact, row kept as an audit record.
    const document = await withTenantTransaction(organizationId, (tx) =>
      tx.document.create({
        data: {
          organizationId,
          knowledgeBaseId,
          fileName: "doc.pdf",
          mimeType: "application/pdf",
          sizeBytes: 15,
          storageKey,
          status: "DELETED",
          deletedAt: new Date(),
        },
      }),
    );

    return { documentId: document.id, storageKey };
  }

  it("deletes the document's S3 object, leaving the (already soft-deleted) row untouched", async () => {
    const { documentId, storageKey } = await createDeletedDocument();
    expect(await objectExists(storageKey)).toBe(true);

    const job = await queue.add(JOB_NAMES.cleanupDocumentStorage, { organizationId, documentId });
    await cleanupDocumentStorageProcessor(job);

    expect(await objectExists(storageKey)).toBe(false);

    // The row itself is never touched by this job — it was already
    // soft-deleted by the route before this job was ever enqueued (see
    // apps/api/src/lib/document-cleanup.ts), and stays that way as the
    // permanent audit record DELETE /documents/:id promises.
    const stillThere = await withTenantTransaction(organizationId, (tx) => tx.document.findUnique({ where: { id: documentId } }));
    expect(stillThere?.status).toBe("DELETED");
  });

  it("is a safe no-op when the Document row is somehow already gone (defensive — this route never hard-deletes)", async () => {
    const job = await queue.add(JOB_NAMES.cleanupDocumentStorage, { organizationId, documentId: randomUUID() });

    await expect(cleanupDocumentStorageProcessor(job)).resolves.toBeUndefined();
  });

  it("re-running cleanup for an already-cleaned-up document is safe (idempotent re-delete of an already-gone S3 object)", async () => {
    const { documentId, storageKey } = await createDeletedDocument();

    // Simulates a prior attempt that already finished — the processor
    // must not fail just because the key is already gone (S3's own
    // DeleteObjects semantics: deleting a nonexistent key is not an
    // error).
    const job = await queue.add(JOB_NAMES.cleanupDocumentStorage, { organizationId, documentId });
    await cleanupDocumentStorageProcessor(job);
    expect(await objectExists(storageKey)).toBe(false);

    await expect(cleanupDocumentStorageProcessor(job)).resolves.toBeUndefined();
  });

  it("S3 failure during deletion: the job throws and the Document row (with its storageKey) survives intact for a retry", async () => {
    const { documentId, storageKey } = await createDeletedDocument();

    const sendSpy = vi.spyOn(s3, "send").mockRejectedValueOnce(new Error("simulated S3 outage"));
    const job = await queue.add(JOB_NAMES.cleanupDocumentStorage, { organizationId, documentId });
    await expect(cleanupDocumentStorageProcessor(job)).rejects.toThrow("simulated S3 outage");
    sendSpy.mockRestore();

    // Not orphaned: the object is still there, and so is the row (and
    // its storageKey) a retry needs — this job never mutates the
    // Document row at all, so there's nothing for a failure to corrupt.
    expect(await objectExists(storageKey)).toBe(true);
    const stillThere = await withTenantTransaction(organizationId, (tx) => tx.document.findUnique({ where: { id: documentId } }));
    expect(stillThere?.storageKey).toBe(storageKey);

    // Retry recovers: re-running the identical job (S3 no longer mocked)
    // finishes the cleanup that failed above.
    await cleanupDocumentStorageProcessor(job);
    expect(await objectExists(storageKey)).toBe(false);
  });
});
