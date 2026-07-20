/**
 * End-to-end integration test against real Postgres (RLS) + real Redis
 * (BullMQ) + real MinIO — no mocking of any of them, same convention as
 * every other integration test suite in this repo.
 *
 * Prerequisites: docker compose up -d, migrations applied.
 */
import { randomUUID } from "node:crypto";

import { CreateBucketCommand, HeadBucketCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { prisma, withTenantTransaction } from "@raas/db";
import { JOB_NAMES, QUEUE_NAMES } from "@raas/shared";
import { Queue, Worker } from "bullmq";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { env } from "../env.js";
import { redisConnection } from "../lib/redis.js";
import { deleteObjects, s3 } from "../lib/storage.js";
import { cleanupKnowledgeBaseProcessor } from "./cleanup-knowledge-base.js";

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

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

describe("cleanupKnowledgeBaseProcessor", () => {
  const suffix = randomUUID().slice(0, 8);
  let organizationId: string;
  let queue: Queue;
  let worker: Worker;

  beforeAll(async () => {
    await ensureBucket();

    const org = await prisma.organization.create({ data: { name: `Cleanup Org ${suffix}`, slug: `cleanup-org-${suffix}` } });
    organizationId = org.id;

    queue = new Queue(QUEUE_NAMES.kbCleanup, { connection: redisConnection });
    worker = new Worker(QUEUE_NAMES.kbCleanup, cleanupKnowledgeBaseProcessor, { connection: redisConnection });
    await worker.waitUntilReady();
  });

  afterAll(async () => {
    await worker.close();
    await queue.close();
    await prisma.organization.delete({ where: { id: organizationId } }).catch(() => undefined);
  });

  async function createKbWithDocuments(documentCount: number): Promise<{ knowledgeBaseId: string; storageKeys: string[] }> {
    const kb = await withTenantTransaction(organizationId, (tx) =>
      tx.knowledgeBase.create({
        data: { organizationId, name: "Cleanup KB", embeddingProvider: "openai", embeddingModel: "text-embedding-3-small", embeddingDim: 1536, status: "DELETING" },
      }),
    );

    const storageKeys: string[] = [];
    for (let i = 0; i < documentCount; i++) {
      const storageKey = `${organizationId}/${kb.id}/${randomUUID()}-doc-${i}.pdf`;
      await s3.send(new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: storageKey, Body: "fake pdf bytes", ContentType: "application/pdf" }));
      storageKeys.push(storageKey);

      const document = await withTenantTransaction(organizationId, (tx) =>
        tx.document.create({
          data: { organizationId, knowledgeBaseId: kb.id, fileName: `doc-${i}.pdf`, mimeType: "application/pdf", sizeBytes: 15, storageKey, status: "READY" },
        }),
      );
      await withTenantTransaction(organizationId, (tx) =>
        tx.documentChunk.create({
          data: { organizationId, knowledgeBaseId: kb.id, documentId: document.id, chunkIndex: 0, content: "chunk content", tokenCount: 2, charStart: 0, charEnd: 13 },
        }),
      );
    }

    return { knowledgeBaseId: kb.id, storageKeys };
  }

  it("deletes every document's S3 object, then the KB row (cascading documents/chunks)", async () => {
    const { knowledgeBaseId, storageKeys } = await createKbWithDocuments(3);

    for (const key of storageKeys) {
      expect(await objectExists(key)).toBe(true);
    }

    await queue.add(JOB_NAMES.cleanupKnowledgeBase, { organizationId, knowledgeBaseId });

    await waitUntil(async () => {
      const kb = await withTenantTransaction(organizationId, (tx) => tx.knowledgeBase.findUnique({ where: { id: knowledgeBaseId } }));
      return kb === null;
    });

    for (const key of storageKeys) {
      expect(await objectExists(key)).toBe(false);
    }

    const remainingDocuments = await withTenantTransaction(organizationId, (tx) => tx.document.findMany({ where: { knowledgeBaseId } }));
    expect(remainingDocuments).toHaveLength(0);
    const remainingChunks = await withTenantTransaction(organizationId, (tx) => tx.documentChunk.findMany({ where: { knowledgeBaseId } }));
    expect(remainingChunks).toHaveLength(0);
  });

  it("handles a KB with no documents (nothing to delete from S3, KB row still removed)", async () => {
    const kb = await withTenantTransaction(organizationId, (tx) =>
      tx.knowledgeBase.create({
        data: { organizationId, name: "Empty Cleanup KB", embeddingProvider: "openai", embeddingModel: "text-embedding-3-small", embeddingDim: 1536, status: "DELETING" },
      }),
    );

    await queue.add(JOB_NAMES.cleanupKnowledgeBase, { organizationId, knowledgeBaseId: kb.id });

    await waitUntil(async () => {
      const found = await withTenantTransaction(organizationId, (tx) => tx.knowledgeBase.findUnique({ where: { id: kb.id } }));
      return found === null;
    });
  });

  it("re-running cleanup for an already-cleaned-up KB is safe (idempotent re-delete of already-gone S3 objects)", async () => {
    const { knowledgeBaseId, storageKeys } = await createKbWithDocuments(1);

    // Delete the S3 object directly first, simulating a prior partial
    // attempt — the processor must not fail just because a key is
    // already gone (S3's own DeleteObjects semantics: deleting a
    // nonexistent key is not an error).
    await deleteObjects(storageKeys);

    await queue.add(JOB_NAMES.cleanupKnowledgeBase, { organizationId, knowledgeBaseId });

    await waitUntil(async () => {
      const kb = await withTenantTransaction(organizationId, (tx) => tx.knowledgeBase.findUnique({ where: { id: knowledgeBaseId } }));
      return kb === null;
    });
  });

  it("recovers from a partial prior cleanup attempt — some objects already deleted, others not — removing the remainder and then the KB row", async () => {
    const { knowledgeBaseId, storageKeys } = await createKbWithDocuments(3);

    // Simulates a prior attempt that got partway through before failing
    // (a crash, a timeout, a transient error partway through a
    // multi-batch delete) — only ONE of the three objects is gone, the
    // rest are still there. The processor has no per-key checkpoint of
    // its own; it just re-lists every still-present Document and
    // re-attempts deleting all of them, so this is exactly the same code
    // path as a full retry, not special-cased partial-recovery logic.
    await deleteObjects([storageKeys[0]!]);
    expect(await objectExists(storageKeys[0]!)).toBe(false);
    expect(await objectExists(storageKeys[1]!)).toBe(true);
    expect(await objectExists(storageKeys[2]!)).toBe(true);

    await queue.add(JOB_NAMES.cleanupKnowledgeBase, { organizationId, knowledgeBaseId });

    await waitUntil(async () => {
      const kb = await withTenantTransaction(organizationId, (tx) => tx.knowledgeBase.findUnique({ where: { id: knowledgeBaseId } }));
      return kb === null;
    });

    for (const key of storageKeys) {
      expect(await objectExists(key)).toBe(false);
    }
  });

  it("S3 failure during deletion: the job throws and the KB row (with its Document rows) survives intact for a retry", async () => {
    const { knowledgeBaseId, storageKeys } = await createKbWithDocuments(2);

    // Pauses the live worker (constructed in beforeAll, already
    // consuming this queue) for the duration of this test — it fetches
    // jobs the instant they're added, which would otherwise race this
    // test's own direct, mock-controlled invocation of the processor
    // below: whichever of the two reaches deleteObjects first "wins" the
    // single mocked rejection, and the other proceeds against the real,
    // unmocked S3 client, silently deleting the objects for real and
    // making this test flaky rather than deterministic.
    await worker.pause();
    try {
      // Simulates a genuine S3-side failure (network error, permission
      // error, an outage) rather than a partial per-key result — the
      // whole call rejects, none of the objects are touched.
      const sendSpy = vi.spyOn(s3, "send").mockRejectedValueOnce(new Error("simulated S3 outage"));
      const job = await queue.add(JOB_NAMES.cleanupKnowledgeBase, { organizationId, knowledgeBaseId });
      await expect(cleanupKnowledgeBaseProcessor(job)).rejects.toThrow("simulated S3 outage");
      sendSpy.mockRestore();

      // Not lost: deleteObjects throwing happens BEFORE the
      // KnowledgeBase row delete (see the processor's own S3-before-DB
      // doc comment), so the row — and every Document row recording
      // which S3 objects need cleaning up — is still exactly as it was,
      // and the objects themselves are still genuinely present in the
      // bucket.
      const stillInDb = await withTenantTransaction(organizationId, (tx) => tx.knowledgeBase.findUnique({ where: { id: knowledgeBaseId } }));
      expect(stillInDb).not.toBeNull();
      const stillHasDocuments = await withTenantTransaction(organizationId, (tx) => tx.document.findMany({ where: { knowledgeBaseId } }));
      expect(stillHasDocuments).toHaveLength(2);
      for (const key of storageKeys) {
        expect(await objectExists(key)).toBe(true);
      }

      // Retry recovers: re-running the identical job (S3 no longer
      // mocked) finishes the job that failed above.
      await cleanupKnowledgeBaseProcessor(job);
      const afterRetry = await withTenantTransaction(organizationId, (tx) => tx.knowledgeBase.findUnique({ where: { id: knowledgeBaseId } }));
      expect(afterRetry).toBeNull();
      for (const key of storageKeys) {
        expect(await objectExists(key)).toBe(false);
      }
    } finally {
      await worker.resume();
    }
  });
});
