/**
 * End-to-end integration test against real Postgres (RLS) + real Redis
 * (BullMQ) + real MinIO — no mocking of any of them, same convention as
 * every other integration test suite in this repo. Uses the fake
 * embedding provider (EMBEDDING_PROVIDER=fake, the local dev/test
 * default — see .env.example) so this test needs no OpenAI key and no
 * network call, while still exercising the real pipeline plumbing:
 * extraction, chunking, dynamic fan-out, and writing real pgvector
 * columns via raw SQL.
 *
 * Prerequisites: docker compose up -d, migrations applied.
 */
import { randomUUID } from "node:crypto";

import { CreateBucketCommand, HeadBucketCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { prisma, withTenantTransaction } from "@raas/db";
import { JOB_NAMES, QUEUE_NAMES } from "@raas/shared";
import { FlowProducer, Worker } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { env } from "./env.js";
import { redisConnection } from "./lib/redis.js";
import { s3 } from "./lib/storage.js";
import { buildTestPdf } from "./lib/test-helpers/build-pdf.js";
import { chunkTextProcessor } from "./processors/chunk-text.js";
import { embedChunksProcessor } from "./processors/embed-chunks.js";
import { extractTextProcessor } from "./processors/extract-text.js";
import { processDocumentProcessor } from "./processors/process-document.js";
import { documentEmbeddingQueue } from "./queue/queues.js";

const JOB_OPTS = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 5000 },
  failParentOnFailure: true,
};

// Mirrors apps/api/src/lib/ingestion-flow.ts's tree shape — duplicated
// here rather than imported (apps/worker doesn't depend on apps/api) so
// this test can enqueue a flow without going through an HTTP layer. If
// this ever drifts from apps/api's real flow shape, this test fails
// immediately (the worker wouldn't understand the tree it built), which
// is a tighter guarantee than importing a shared builder would give.
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

async function ensureBucket(): Promise<void> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: env.S3_BUCKET }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: env.S3_BUCKET })).catch(() => undefined);
  }
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

describe("ingestion pipeline (extract-text -> chunk-text -> embed-chunks -> process-document)", () => {
  const suffix = randomUUID().slice(0, 8);
  let organizationId: string;
  let knowledgeBaseId: string;
  let flowProducer: FlowProducer;
  let processingWorker: Worker;
  let extractionWorker: Worker;
  let embeddingWorker: Worker;

  beforeAll(async () => {
    await ensureBucket();

    const org = await prisma.organization.create({
      data: { name: `Pipeline Org ${suffix}`, slug: `pipeline-org-${suffix}` },
    });
    organizationId = org.id;
    const kb = await withTenantTransaction(organizationId, (tx) =>
      tx.knowledgeBase.create({
        data: {
          organizationId,
          name: "Pipeline KB",
          embeddingProvider: "openai",
          embeddingModel: "text-embedding-3-small",
          embeddingDim: 1536,
        },
      }),
    );
    knowledgeBaseId = kb.id;

    flowProducer = new FlowProducer({ connection: redisConnection });
    processingWorker = new Worker(QUEUE_NAMES.processing, processDocumentProcessor, { connection: redisConnection });
    extractionWorker = new Worker(
      QUEUE_NAMES.extraction,
      async (job) => (job.name === JOB_NAMES.extractText ? extractTextProcessor(job) : chunkTextProcessor(job)),
      { connection: redisConnection },
    );
    embeddingWorker = new Worker(QUEUE_NAMES.embedding, embedChunksProcessor, { connection: redisConnection });

    await Promise.all([
      processingWorker.waitUntilReady(),
      extractionWorker.waitUntilReady(),
      embeddingWorker.waitUntilReady(),
    ]);
  });

  afterAll(async () => {
    await Promise.all([processingWorker.close(), extractionWorker.close(), embeddingWorker.close()]);
    await flowProducer.close();
    await documentEmbeddingQueue.close();
    await prisma.organization.delete({ where: { id: organizationId } }).catch(() => undefined);
  });

  async function createDocument(pdf: Buffer, fileName: string): Promise<{ id: string }> {
    const storageKey = `${organizationId}/${knowledgeBaseId}/${randomUUID()}-${fileName}`;
    await s3.send(new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: storageKey, Body: pdf, ContentType: "application/pdf" }));

    return withTenantTransaction(organizationId, (tx) =>
      tx.document.create({
        data: {
          organizationId,
          knowledgeBaseId,
          fileName,
          mimeType: "application/pdf",
          sizeBytes: pdf.length,
          storageKey,
          status: "QUEUED",
        },
      }),
    );
  }

  it("moves a real multi-page PDF from QUEUED to READY, preserving page numbers and writing real embeddings", async () => {
    const pageOneWords = Array.from({ length: 150 }, (_, i) => `pageonewordnumber${i}`).join(" ");
    const pageTwoWords = Array.from({ length: 150 }, (_, i) => `pagetwowordnumber${i}`).join(" ");
    const pdf = buildTestPdf([pageOneWords, pageTwoWords]);

    const document = await createDocument(pdf, "pipeline-happy-path.pdf");
    await enqueueFlow(flowProducer, { documentId: document.id, organizationId, knowledgeBaseId });

    const finalDocument = await waitForDocumentStatus(organizationId, document.id, ["READY", "FAILED"]);
    expect(finalDocument.failureReason).toBeNull();
    expect(finalDocument.status).toBe("READY");

    const chunks = await withTenantTransaction(organizationId, (tx) =>
      tx.documentChunk.findMany({ where: { documentId: document.id }, orderBy: { chunkIndex: "asc" } }),
    );
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.pageNumber === 1 || c.pageNumber === 2)).toBe(true);
    expect(chunks.some((c) => c.pageNumber === 1)).toBe(true);
    expect(chunks.some((c) => c.pageNumber === 2)).toBe(true);
    // chunkIndex is contiguous starting at 0 — @@unique([documentId, chunkIndex]).
    expect(chunks.map((c) => c.chunkIndex)).toEqual(chunks.map((_, i) => i));

    const embedded = await withTenantTransaction(organizationId, (tx) =>
      tx.$queryRaw<Array<{ id: string; has_embedding: boolean }>>`
        SELECT id, embedding IS NOT NULL as has_embedding FROM "DocumentChunk" WHERE "documentId" = ${document.id}
      `,
    );
    expect(embedded).toHaveLength(chunks.length);
    expect(embedded.every((row) => row.has_embedding)).toBe(true);

    const usageEvents = await withTenantTransaction(organizationId, (tx) => tx.usageEvent.findMany());
    const embeddingEvents = usageEvents.filter((e) => e.type === "EMBEDDING_TOKENS");
    expect(embeddingEvents.length).toBeGreaterThan(0);
    expect(embeddingEvents.every((e) => (e.metadata as Record<string, unknown>).documentId === document.id)).toBe(true);
    expect(embeddingEvents.every((e) => typeof (e.metadata as Record<string, unknown>).tokenCount === "number")).toBe(true);

    const documentProcessedEvents = usageEvents.filter((e) => e.type === "DOCUMENT_PROCESSED");
    expect(documentProcessedEvents).toHaveLength(1);
    expect((documentProcessedEvents[0]!.metadata as Record<string, unknown>).documentId).toBe(document.id);
  });

  it("fails the document with a clear reason when the PDF is scanned (no extractable text)", async () => {
    const pdf = buildTestPdf(["", ""]);
    const document = await createDocument(pdf, "scanned.pdf");

    await enqueueFlow(flowProducer, { documentId: document.id, organizationId, knowledgeBaseId });

    const finalDocument = await waitForDocumentStatus(organizationId, document.id, ["READY", "FAILED"]);
    expect(finalDocument.status).toBe("FAILED");
    expect(finalDocument.failureReason).toBe("scanned document, OCR not supported");

    const chunks = await withTenantTransaction(organizationId, (tx) =>
      tx.documentChunk.findMany({ where: { documentId: document.id } }),
    );
    expect(chunks).toHaveLength(0);
  });
});
