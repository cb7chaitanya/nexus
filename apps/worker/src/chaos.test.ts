/**
 * Chaos test: kill a real worker process mid `embed-chunks` job, restart a
 * fresh one, and verify BullMQ's stalled-job recovery finishes the job
 * exactly once — no duplicate DocumentChunk rows, and the document still
 * reaches READY. This is the one thing pipeline.test.ts's in-process
 * workers can't exercise: a process actually dying mid-transaction-batch.
 *
 * Workers under test run as real child processes (via the locally-built
 * tsx binary, not `pnpm exec tsx`, so SIGKILL lands on the process actually
 * running the worker rather than on a wrapping pnpm process) with a
 * calibrated FAKE_EMBEDDING_DELAY_MS (so the embed-chunks job's single
 * batch transaction takes long enough to reliably land a kill inside it)
 * and shrunk WORKER_LOCK_DURATION_MS/WORKER_STALLED_INTERVAL_MS (so BullMQ
 * notices the crash and reclaims the job quickly instead of waiting out
 * its 30s production defaults).
 *
 * Prerequisites: docker compose up -d, migrations applied.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CreateBucketCommand, HeadBucketCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { prisma, withTenantTransaction } from "@raas/db";
import { JOB_NAMES, QUEUE_NAMES } from "@raas/shared";
import { FlowProducer } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { env } from "./env.js";
import { redisConnection } from "./lib/redis.js";
import { s3 } from "./lib/storage.js";
import { buildTestPdf } from "./lib/test-helpers/build-pdf.js";
import { documentEmbeddingQueue } from "./queue/queues.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workerDir = path.resolve(__dirname, "..");
const tsxBin = path.join(workerDir, "node_modules/.bin/tsx");

// Chaos-only env overrides applied to spawned worker processes. The test
// process itself keeps its normal (fast/instant) settings from .env — only
// the child workers under test need to be slow-and-recoverable.
const CHAOS_DELAY_MS = 700;
const CHAOS_LOCK_DURATION_MS = 2000;
const CHAOS_STALLED_INTERVAL_MS = 1000;

const JOB_OPTS = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 5000 },
  failParentOnFailure: true,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Mirrors apps/api/src/lib/ingestion-flow.ts's tree shape — see
// pipeline.test.ts for why this is duplicated rather than imported.
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
  timeoutMs: number,
): Promise<{ status: string; failureReason: string | null }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const document = await withTenantTransaction(organizationId, (tx) =>
      tx.document.findUnique({ where: { id: documentId }, select: { status: true, failureReason: true } }),
    );
    if (document && terminalStatuses.includes(document.status)) {
      return document;
    }
    await sleep(200);
  }
  throw new Error(`Document ${documentId} did not reach ${terminalStatuses.join("/")} within ${timeoutMs}ms`);
}

async function waitForChunkCount(organizationId: string, documentId: string, timeoutMs: number): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const count = await withTenantTransaction(organizationId, (tx) => tx.documentChunk.count({ where: { documentId } }));
    if (count > 0) return count;
    await sleep(150);
  }
  throw new Error(`document ${documentId} produced no chunks within ${timeoutMs}ms`);
}

async function waitForJobActive(jobId: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = await documentEmbeddingQueue.getJob(jobId);
    if (job && (await job.getState()) === "active") return;
    await sleep(100);
  }
  throw new Error(`embed-chunks job ${jobId} never became active within ${timeoutMs}ms`);
}

function spawnWorker(label: string, envOverrides: Record<string, string>): ChildProcess {
  const child = spawn(tsxBin, ["src/index.ts"], {
    cwd: workerDir,
    env: { ...process.env, ...envOverrides },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => process.stdout.write(`[${label}] ${chunk}`));
  child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`[${label}] ${chunk}`));
  return child;
}

function killAndWait(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once("exit", () => resolve());
    child.kill("SIGKILL");
  });
}

describe("chaos: worker crash during embed-chunks", () => {
  const suffix = randomUUID().slice(0, 8);
  let organizationId: string;
  let knowledgeBaseId: string;
  let flowProducer: FlowProducer;
  let workerA: ChildProcess | undefined;
  let workerB: ChildProcess | undefined;

  beforeAll(async () => {
    await ensureBucket();

    const org = await prisma.organization.create({
      data: { name: `Chaos Org ${suffix}`, slug: `chaos-org-${suffix}` },
    });
    organizationId = org.id;
    const kb = await withTenantTransaction(organizationId, (tx) =>
      tx.knowledgeBase.create({
        data: {
          organizationId,
          name: "Chaos KB",
          embeddingProvider: "openai",
          embeddingModel: "text-embedding-3-small",
          embeddingDim: 1536,
        },
      }),
    );
    knowledgeBaseId = kb.id;

    flowProducer = new FlowProducer({ connection: redisConnection });
  });

  afterAll(async () => {
    if (workerA) await killAndWait(workerA);
    if (workerB) await killAndWait(workerB);
    await flowProducer.close();
    await documentEmbeddingQueue.close();
    await prisma.organization.delete({ where: { id: organizationId } }).catch(() => undefined);
  });

  it(
    "recovers from a mid-batch worker crash with no duplicate chunks and a READY document",
    async () => {
      // 6 pages of 180 words each: enough total text to produce several
      // embed-chunks (see lib/chunk-text.ts's ~700-token target) so the
      // batch's total embed time (chunkCount * CHAOS_DELAY_MS) comfortably
      // covers a mid-batch kill, while staying under build-pdf's
      // per-page line-wrap capacity.
      const pages = Array.from({ length: 6 }, (_, p) =>
        Array.from({ length: 180 }, (_, i) => `chaosword${p}x${i}`).join(" "),
      );
      const pdf = buildTestPdf(pages);
      const fileName = "chaos-worker-crash.pdf";
      const storageKey = `${organizationId}/${knowledgeBaseId}/${randomUUID()}-${fileName}`;
      await s3.send(new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: storageKey, Body: pdf, ContentType: "application/pdf" }));

      const document = await withTenantTransaction(organizationId, (tx) =>
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

      const chaosEnv = {
        EMBEDDING_PROVIDER: "fake",
        FAKE_EMBEDDING_DELAY_MS: String(CHAOS_DELAY_MS),
        WORKER_LOCK_DURATION_MS: String(CHAOS_LOCK_DURATION_MS),
        WORKER_STALLED_INTERVAL_MS: String(CHAOS_STALLED_INTERVAL_MS),
      };

      workerA = spawnWorker("worker-a", chaosEnv);

      await enqueueFlow(flowProducer, { documentId: document.id, organizationId, knowledgeBaseId });

      // chunk-text has upserted its rows (and is about to add the single
      // embed-chunks batch job) once chunks exist for this document.
      const chunkCount = await waitForChunkCount(organizationId, document.id, 20_000);
      expect(chunkCount).toBeGreaterThan(1);

      const embedJobId = `${JOB_NAMES.embedChunks}-${document.id}-0`;
      await waitForJobActive(embedJobId, 20_000);

      // Land the kill partway through the batch's embed work (never at the
      // very start or the very end), so the crash genuinely interrupts an
      // in-flight embed call rather than racing job pickup or completion.
      const killAfterMs = Math.max(300, Math.floor(chunkCount * CHAOS_DELAY_MS * 0.4));
      await sleep(killAfterMs);
      await killAndWait(workerA);

      workerB = spawnWorker("worker-b", chaosEnv);

      // Generous: stalled-job detection (up to ~lockDuration + one
      // stalledInterval tick) plus a full re-embed of the batch plus
      // process-document's own run.
      const finalDocument = await waitForDocumentStatus(organizationId, document.id, ["READY", "FAILED"], 45_000);
      expect(finalDocument.failureReason).toBeNull();
      expect(finalDocument.status).toBe("READY");

      const chunks = await withTenantTransaction(organizationId, (tx) =>
        tx.documentChunk.findMany({ where: { documentId: document.id }, orderBy: { chunkIndex: "asc" } }),
      );
      // No duplicates: same count as before the crash, and chunkIndex is
      // still exactly contiguous from 0 (the DB's
      // @@unique([documentId, chunkIndex]) structurally forbids duplicate
      // rows, but this also checks no rows are missing or renumbered).
      expect(chunks).toHaveLength(chunkCount);
      expect(chunks.map((c) => c.chunkIndex)).toEqual(chunks.map((_, i) => i));
      expect(new Set(chunks.map((c) => c.id)).size).toBe(chunks.length);

      const embedded = await withTenantTransaction(organizationId, (tx) =>
        tx.$queryRaw<Array<{ id: string; has_embedding: boolean }>>`
          SELECT id, embedding IS NOT NULL as has_embedding FROM "DocumentChunk" WHERE "documentId" = ${document.id}
        `,
      );
      expect(embedded).toHaveLength(chunkCount);
      expect(embedded.every((row) => row.has_embedding)).toBe(true);
    },
    60_000,
  );
});
