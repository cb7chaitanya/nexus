/**
 * WORKER_MAX_DOCUMENT_BYTES enforcement — real Postgres + real Redis/BullMQ,
 * same "real infra, controllable seams" convention as chunk-text.test.ts's
 * own MAX_CHUNKS_PER_DOCUMENT test. Uses a storageKey that was never
 * actually uploaded to MinIO — if the size check ever stopped running
 * BEFORE downloadObject, the job would instead fail with an S3
 * "object not found" error (a different, generic failureReason — see
 * apps/worker/src/lib/job-failure.ts's allowlist), not this test's
 * expected message, so the exact failureReason text is itself proof
 * downloadObject was never reached.
 *
 * Prerequisites: docker compose up -d, migrations applied.
 */
import { randomUUID } from "node:crypto";

import { prisma, withTenantTransaction } from "@raas/db";
import { JOB_NAMES, QUEUE_NAMES } from "@raas/shared";
import { Queue, Worker } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { env } from "../env.js";
import { redisConnection } from "../lib/redis.js";
import { extractTextProcessor } from "./extract-text.js";

async function waitForDocumentStatus(
  organizationId: string,
  documentId: string,
  terminalStatuses: string[],
  timeoutMs = 15_000,
): Promise<{ status: string; failureReason: string | null }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const document = await withTenantTransaction(organizationId, (tx) =>
      tx.document.findUnique({ where: { id: documentId }, select: { status: true, failureReason: true } }),
    );
    if (document && terminalStatuses.includes(document.status)) {
      return document;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Document ${documentId} did not reach ${terminalStatuses.join("/")} within ${timeoutMs}ms`);
}

describe("extract-text: WORKER_MAX_DOCUMENT_BYTES memory guardrail", () => {
  const suffix = randomUUID().slice(0, 8);
  let organizationId: string;
  let knowledgeBaseId: string;
  let queue: Queue;
  let worker: Worker;

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: `Doc Size Cap Org ${suffix}`, slug: `doc-size-cap-org-${suffix}` },
    });
    organizationId = org.id;
    const kb = await withTenantTransaction(organizationId, (tx) =>
      tx.knowledgeBase.create({
        data: {
          organizationId,
          name: "Doc Size Cap KB",
          embeddingProvider: "openai",
          embeddingModel: "text-embedding-3-small",
          embeddingDim: 1536,
        },
      }),
    );
    knowledgeBaseId = kb.id;

    queue = new Queue(QUEUE_NAMES.extraction, { connection: redisConnection });
    worker = new Worker(QUEUE_NAMES.extraction, extractTextProcessor, { connection: redisConnection });
    await worker.waitUntilReady();
  });

  afterAll(async () => {
    await worker.close();
    await queue.close();
    await prisma.organization.delete({ where: { id: organizationId } }).catch(() => undefined);
  });

  it("fails the document immediately (no retries), before ever downloading it, when sizeBytes exceeds WORKER_MAX_DOCUMENT_BYTES", async () => {
    const oversizedBytes = env.WORKER_MAX_DOCUMENT_BYTES + 1;
    const document = await withTenantTransaction(organizationId, (tx) =>
      tx.document.create({
        data: {
          organizationId,
          knowledgeBaseId,
          fileName: "huge.pdf",
          mimeType: "application/pdf",
          sizeBytes: oversizedBytes,
          // Never actually uploaded — see module doc comment for why that's
          // deliberate.
          storageKey: `${organizationId}/${knowledgeBaseId}/${randomUUID()}-huge.pdf`,
          status: "QUEUED",
        },
      }),
    );

    await queue.add(
      JOB_NAMES.extractText,
      { organizationId, documentId: document.id, knowledgeBaseId },
      { attempts: 3, backoff: { type: "exponential", delay: 5000 } },
    );

    // A tight timeout, well under a full 3-attempt exponential backoff
    // cycle — reaching FAILED within it is itself proof this was an
    // UnrecoverableError (DocumentValidationError), not a retried failure.
    const finalDocument = await waitForDocumentStatus(organizationId, document.id, ["READY", "FAILED"]);
    expect(finalDocument.status).toBe("FAILED");
    expect(finalDocument.failureReason).toBe(
      `Document is ${oversizedBytes} bytes, exceeding this worker's configured processing limit of ${env.WORKER_MAX_DOCUMENT_BYTES} bytes`,
    );
  }, 20_000);

  it("does not reject a document at or under the limit for this reason (the mimeType check would fire first here, proving size alone didn't block it)", async () => {
    const document = await withTenantTransaction(organizationId, (tx) =>
      tx.document.create({
        data: {
          organizationId,
          knowledgeBaseId,
          fileName: "borderline.pdf",
          mimeType: "application/pdf",
          sizeBytes: env.WORKER_MAX_DOCUMENT_BYTES,
          storageKey: `${organizationId}/${knowledgeBaseId}/${randomUUID()}-borderline.pdf`,
          status: "QUEUED",
        },
      }),
    );

    await queue.add(
      JOB_NAMES.extractText,
      { organizationId, documentId: document.id, knowledgeBaseId },
      { attempts: 1 },
    );

    const finalDocument = await waitForDocumentStatus(organizationId, document.id, ["READY", "FAILED"]);
    // Still fails — the object genuinely doesn't exist in MinIO — but for a
    // DIFFERENT reason than the size guardrail, proving a document exactly
    // AT the limit passes that specific check and reaches the real
    // download attempt.
    expect(finalDocument.status).toBe("FAILED");
    expect(finalDocument.failureReason).not.toContain("exceeding this worker's configured processing limit");
  }, 20_000);
});
