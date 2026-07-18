/**
 * MAX_CHUNKS_PER_DOCUMENT enforcement — real Postgres + real Redis/BullMQ
 * flow (same "real infra, controllable seams" convention as pipeline.test.ts),
 * but with a stubbed extract-text stage: this test cares about
 * chunk-text.ts's cap, not PDF parsing, and buildTestPdf's real PDFs
 * truncate per-page text to a fixed line count (see
 * lib/test-helpers/build-pdf.ts), which makes constructing an
 * over-the-cap real PDF impractical. Feeding chunk-text a large synthetic
 * ExtractedDocument directly exercises the exact same code path
 * (job.getChildrenValues()) with none of that overhead.
 *
 * Prerequisites: docker compose up -d, migrations applied.
 */
import { randomUUID } from "node:crypto";

import { prisma, withTenantTransaction } from "@raas/db";
import { JOB_NAMES, MAX_CHUNKS_PER_DOCUMENT, QUEUE_NAMES } from "@raas/shared";
import { FlowProducer, Worker } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { redisConnection } from "../lib/redis.js";
import type { ExtractedDocument } from "../lib/extract-pdf.js";
import { chunkTextProcessor } from "./chunk-text.js";
import { processDocumentProcessor } from "./process-document.js";

const JOB_OPTS = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 5000 },
  failParentOnFailure: true,
};

// Comfortably over MAX_CHUNKS_PER_DOCUMENT regardless of exact word-length
// assumptions — chunk-text.ts targets ~700 tokens/chunk (~2800 chars) with
// ~15% overlap, so even a generous per-word overhead estimate keeps this
// well above the cap.
function buildOversizedExtractedDocument(): ExtractedDocument {
  const words = Array.from({ length: 500_000 }, (_, i) => `w${i}`).join(" ");
  return { pages: [{ pageNumber: 1, text: words }] };
}

async function enqueueFlow(
  flowProducer: FlowProducer,
  input: { documentId: string; organizationId: string; knowledgeBaseId: string },
): Promise<void> {
  const data = input;
  await flowProducer.add({
    name: JOB_NAMES.processDocument,
    queueName: QUEUE_NAMES.processing,
    data,
    opts: { ...JOB_OPTS, jobId: `${JOB_NAMES.processDocument}-${input.documentId}` },
    children: [
      {
        name: JOB_NAMES.chunkText,
        queueName: QUEUE_NAMES.extraction,
        data,
        opts: { ...JOB_OPTS, jobId: `${JOB_NAMES.chunkText}-${input.documentId}` },
        children: [
          {
            name: JOB_NAMES.extractText,
            queueName: QUEUE_NAMES.extraction,
            data,
            opts: { ...JOB_OPTS, jobId: `${JOB_NAMES.extractText}-${input.documentId}` },
          },
        ],
      },
    ],
  });
}

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

describe("chunk-text: MAX_CHUNKS_PER_DOCUMENT cost-safety cap", () => {
  const suffix = randomUUID().slice(0, 8);
  let organizationId: string;
  let knowledgeBaseId: string;
  let flowProducer: FlowProducer;
  let processingWorker: Worker;
  let extractionWorker: Worker;

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: `Chunk Cap Org ${suffix}`, slug: `chunk-cap-org-${suffix}` },
    });
    organizationId = org.id;
    const kb = await withTenantTransaction(organizationId, (tx) =>
      tx.knowledgeBase.create({
        data: {
          organizationId,
          name: "Chunk Cap KB",
          embeddingProvider: "openai",
          embeddingModel: "text-embedding-3-small",
          embeddingDim: 1536,
        },
      }),
    );
    knowledgeBaseId = kb.id;

    flowProducer = new FlowProducer({ connection: redisConnection });
    processingWorker = new Worker(QUEUE_NAMES.processing, processDocumentProcessor, { connection: redisConnection });
    // Stubs extract-text (no real PDF/S3 involved — see module doc
    // comment) and runs the real chunk-text processor for its own job name.
    extractionWorker = new Worker(
      QUEUE_NAMES.extraction,
      async (job) => (job.name === JOB_NAMES.extractText ? buildOversizedExtractedDocument() : chunkTextProcessor(job)),
      { connection: redisConnection },
    );

    await Promise.all([processingWorker.waitUntilReady(), extractionWorker.waitUntilReady()]);
  });

  afterAll(async () => {
    await Promise.all([processingWorker.close(), extractionWorker.close()]);
    await flowProducer.close();
    await prisma.organization.delete({ where: { id: organizationId } }).catch(() => undefined);
  });

  it("fails the document immediately (no retries) when chunking would exceed MAX_CHUNKS_PER_DOCUMENT, without enqueueing any embed-chunks job", async () => {
    const document = await withTenantTransaction(organizationId, (tx) =>
      tx.document.create({
        data: {
          organizationId,
          knowledgeBaseId,
          fileName: "oversized.pdf",
          mimeType: "application/pdf",
          sizeBytes: 1024,
          storageKey: `${organizationId}/${knowledgeBaseId}/${randomUUID()}-oversized.pdf`,
          status: "QUEUED",
        },
      }),
    );

    await enqueueFlow(flowProducer, { documentId: document.id, organizationId, knowledgeBaseId });

    // A tight timeout, well under the ~35s a full 3-attempt exponential
    // backoff cycle would take — reaching FAILED within it is itself proof
    // this was thrown as an UnrecoverableError (immediate terminal
    // failure), preserving the same no-retry behavior as every other
    // UnrecoverableError case in this pipeline (see pipeline.test.ts's
    // scanned-document and budget-exhausted tests).
    const finalDocument = await waitForDocumentStatus(organizationId, document.id, ["READY", "FAILED"]);
    expect(finalDocument.status).toBe("FAILED");
    expect(finalDocument.failureReason).toContain(`exceeding the ${MAX_CHUNKS_PER_DOCUMENT}-chunk-per-document limit`);

    // No chunk rows were ever upserted — the cap is checked before the
    // chunk-write transaction, not after.
    const chunks = await withTenantTransaction(organizationId, (tx) =>
      tx.documentChunk.findMany({ where: { documentId: document.id } }),
    );
    expect(chunks).toHaveLength(0);
  }, 20_000);
});
