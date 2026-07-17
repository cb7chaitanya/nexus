/**
 * Chaos tests: kill a real worker process mid-stage for each of the three
 * ingestion stages that can crash mid-write (extract-text, chunk-text,
 * embed-chunks), restart a fresh one, and verify BullMQ's stalled-job
 * recovery finishes the job exactly once — no duplicate rows, no corrupted
 * state, and the document still reaches READY. This is the one thing
 * pipeline.test.ts's in-process workers can't exercise: a process actually
 * dying mid-transaction.
 *
 * Workers under test run as real child processes (via the locally-built
 * tsx binary, not `pnpm exec tsx`, so SIGKILL lands on a process actually
 * running the worker rather than on a wrapping pnpm process) with a
 * calibrated FAKE_*_DELAY_MS per stage (so that stage's transaction/work
 * takes long enough to reliably land a kill inside it) and shrunk
 * WORKER_LOCK_DURATION_MS/WORKER_STALLED_INTERVAL_MS (so BullMQ notices the
 * crash and reclaims the job quickly instead of waiting out its 30s
 * production defaults).
 *
 * spawnWorker/killAndWait spawn with `detached: true` and signal the whole
 * process GROUP (negative pid), not just the tracked pid — necessary
 * because tsx's own CLI spawns a further child to actually run the target
 * script with the loader flags it needs, so the pid spawn() returns is one
 * level removed from the process really holding the Redis connection.
 * Verified directly (not assumed): killing only the tracked pid left that
 * real worker process running, reparented to pid 1, quietly finishing the
 * job — every assertion below would have passed whether or not a crash
 * ever actually happened. Each test additionally asserts the crashed
 * stage's own BullMQ job genuinely shows a stalled/reprocessed attempt
 * (not just a completed final state), so a regression in this kill
 * mechanism fails loudly instead of silently turning these back into
 * no-op tests.
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
import { FlowProducer, Queue } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { env } from "./env.js";
import { chunkPages } from "./lib/chunk-text.js";
import { extractPdfText } from "./lib/extract-pdf.js";
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
// Smaller than CHAOS_DELAY_MS specifically for chunk-text's per-chunk
// upsert loop: that loop's own test PDF produces several chunks (~6-7),
// each one paying this delay INSIDE one open Prisma transaction — at
// CHAOS_DELAY_MS (700ms) that would be 4.2-4.9s, uncomfortably close to
// Prisma's own default 5s transaction timeout (a real risk of the
// transaction itself failing with P2028, independent of anything this
// test is trying to verify). 300ms leaves comfortable headroom
// (~1.8-2.1s total) while still being far more than enough for a
// 100ms-granularity poll to detect the job active and land a kill inside
// the loop.
const CHUNK_UPSERT_DELAY_MS = 300;

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

async function waitForJobActive(queue: Queue, jobId: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = await queue.getJob(jobId);
    if (job && (await job.getState()) === "active") return;
    await sleep(100);
  }
  throw new Error(`job ${jobId} never became active within ${timeoutMs}ms`);
}

function spawnWorker(label: string, envOverrides: Record<string, string>): ChildProcess {
  const child = spawn(tsxBin, ["src/index.ts"], {
    cwd: workerDir,
    env: { ...process.env, ...envOverrides },
    stdio: ["ignore", "pipe", "pipe"],
    // tsx's CLI (dist/cli.mjs) spawns its OWN child process to actually
    // run the target script with the `--require`/`--import` flags it
    // needs — the shell wrapper's `exec` only gets tsx as far as cli.mjs,
    // which then forks again. That means the pid spawn() hands back is
    // NOT the process that ends up holding the Redis connection and
    // running BullMQ's Worker — it's the process one level up. Verified
    // directly, not assumed: after killing just that pid, `ps -o ppid`
    // showed a second, still-running node process whose parent WAS that
    // just-killed pid (reparented to launchd/pid 1), quietly finishing
    // the job and completely defeating the point of this test — a "kill"
    // that doesn't kill the process actually doing the work makes every
    // assertion below pass whether or not real crash-recovery ever
    // happened. `detached: true` makes this child the leader of its own
    // process GROUP, so killAndWait can signal the whole group (negative
    // pid) instead of just the one tracked pid — that reaches the
    // grandchild too.
    detached: true,
  });
  child.stdout?.on("data", (chunk: Buffer) => process.stdout.write(`[${label}:${child.pid}] ${chunk}`));
  child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`[${label}:${child.pid}] ${chunk}`));
  return child;
}

function killAndWait(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once("exit", () => resolve());
    // Negative pid = signal the whole process group (see spawnWorker's
    // detached: true) — this is what actually reaches tsx's grandchild
    // process, not just the tracked wrapper.
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
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
      await waitForJobActive(documentEmbeddingQueue, embedJobId, 20_000);

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

      // Genuinely recovered from a crash, not a fluke where the kill
      // missed the process actually doing the work (see spawnWorker's own
      // comment): the embed-chunks job must show at least one
      // stalled/reprocessed attempt, not a single uninterrupted completion.
      const embedJob = await documentEmbeddingQueue.getJob(embedJobId);
      expect(await embedJob?.getState()).toBe("completed");
      expect(embedJob?.attemptsMade ?? 0).toBeGreaterThanOrEqual(1);

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

describe("chaos: worker crash during extract-text", () => {
  const suffix = randomUUID().slice(0, 8);
  let organizationId: string;
  let knowledgeBaseId: string;
  let flowProducer: FlowProducer;
  let extractionQueue: Queue;
  let workerA: ChildProcess | undefined;
  let workerB: ChildProcess | undefined;

  beforeAll(async () => {
    await ensureBucket();

    const org = await prisma.organization.create({
      data: { name: `Chaos Extract Org ${suffix}`, slug: `chaos-extract-org-${suffix}` },
    });
    organizationId = org.id;
    const kb = await withTenantTransaction(organizationId, (tx) =>
      tx.knowledgeBase.create({
        data: {
          organizationId,
          name: "Chaos Extract KB",
          embeddingProvider: "openai",
          embeddingModel: "text-embedding-3-small",
          embeddingDim: 1536,
        },
      }),
    );
    knowledgeBaseId = kb.id;

    flowProducer = new FlowProducer({ connection: redisConnection });
    extractionQueue = new Queue(QUEUE_NAMES.extraction, { connection: redisConnection });
  });

  afterAll(async () => {
    if (workerA) await killAndWait(workerA);
    if (workerB) await killAndWait(workerB);
    await flowProducer.close();
    await extractionQueue.close();
    await prisma.organization.delete({ where: { id: organizationId } }).catch(() => undefined);
  });

  it(
    "recovers from a worker crash mid-extraction with no duplicate document state and a READY document",
    async () => {
      const pages = Array.from({ length: 3 }, (_, p) => Array.from({ length: 60 }, (_, i) => `extractword${p}x${i}`).join(" "));
      const pdf = buildTestPdf(pages);
      const fileName = "chaos-extraction-crash.pdf";
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

      // FAKE_EXTRACTION_DELAY_MS is what makes a kill "mid-extraction"
      // reliably possible at all — a real parse of this tiny test PDF
      // would otherwise finish in low single-digit milliseconds, racing
      // (and usually beating) the kill below. Chunking/embedding stay at
      // their fast defaults: this scenario isolates the crash to
      // extract-text specifically.
      const chaosEnv = {
        EMBEDDING_PROVIDER: "fake",
        FAKE_EXTRACTION_DELAY_MS: String(CHAOS_DELAY_MS),
        WORKER_LOCK_DURATION_MS: String(CHAOS_LOCK_DURATION_MS),
        WORKER_STALLED_INTERVAL_MS: String(CHAOS_STALLED_INTERVAL_MS),
      };

      workerA = spawnWorker("extract-worker-a", chaosEnv);

      await enqueueFlow(flowProducer, { documentId: document.id, organizationId, knowledgeBaseId });

      const extractJobId = `${JOB_NAMES.extractText}-${document.id}`;
      await waitForJobActive(extractionQueue, extractJobId, 20_000);

      // Document.status flips to PROCESSING synchronously, right at the
      // start of extract-text, well before the artificial delay — by the
      // time the job is "active" that write has already committed, so any
      // point during the delay is genuinely mid-extraction, not a race
      // with the status transition itself.
      await sleep(Math.floor(CHAOS_DELAY_MS * 0.4));
      await killAndWait(workerA);

      workerB = spawnWorker("extract-worker-b", chaosEnv);

      // Generous: stalled-job detection plus a full re-extraction plus
      // chunking plus embedding plus process-document.
      const finalDocument = await waitForDocumentStatus(organizationId, document.id, ["READY", "FAILED"], 45_000);
      expect(finalDocument.failureReason).toBeNull();
      expect(finalDocument.status).toBe("READY");

      // Genuinely recovered from a crash, not a fluke where the kill
      // missed the process actually doing the work (see spawnWorker's own
      // comment on why that was a real risk here): the extract-text job
      // must show at least one stalled/reprocessed attempt, not a single
      // uninterrupted completion.
      const extractJob = await extractionQueue.getJob(extractJobId);
      expect(await extractJob?.getState()).toBe("completed");
      expect(extractJob?.attemptsMade ?? 0).toBeGreaterThanOrEqual(1);

      // No duplicate document state: exactly one Document row for this
      // id, still — extract-text's only write is an idempotent status
      // update (see extract-text.ts's own comment), never a row create,
      // so a retry can't produce a second Document row for the same
      // upload; asserted directly against the database rather than
      // assumed from the row having been created with a specific id.
      const documentRows = await withTenantTransaction(organizationId, (tx) => tx.document.findMany({ where: { id: document.id } }));
      expect(documentRows).toHaveLength(1);
      expect(documentRows[0]!.status).toBe("READY");

      // The crash-and-retry must not have corrupted anything downstream
      // either — the whole pipeline (chunk-text, embed-chunks,
      // process-document) has to have actually completed correctly off
      // the recovered extraction, not just left the document status
      // looking right.
      const chunks = await withTenantTransaction(organizationId, (tx) =>
        tx.documentChunk.findMany({ where: { documentId: document.id }, orderBy: { chunkIndex: "asc" } }),
      );
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.map((c) => c.chunkIndex)).toEqual(chunks.map((_, i) => i));
      expect(new Set(chunks.map((c) => c.id)).size).toBe(chunks.length);

      const embedded = await withTenantTransaction(organizationId, (tx) =>
        tx.$queryRaw<Array<{ has_embedding: boolean }>>`
          SELECT embedding IS NOT NULL as has_embedding FROM "DocumentChunk" WHERE "documentId" = ${document.id}
        `,
      );
      expect(embedded.every((row) => row.has_embedding)).toBe(true);
    },
    60_000,
  );
});

describe("chaos: worker crash during chunk-text", () => {
  const suffix = randomUUID().slice(0, 8);
  let organizationId: string;
  let knowledgeBaseId: string;
  let flowProducer: FlowProducer;
  let extractionQueue: Queue;
  let workerA: ChildProcess | undefined;
  let workerB: ChildProcess | undefined;

  beforeAll(async () => {
    await ensureBucket();

    const org = await prisma.organization.create({
      data: { name: `Chaos Chunk Org ${suffix}`, slug: `chaos-chunk-org-${suffix}` },
    });
    organizationId = org.id;
    const kb = await withTenantTransaction(organizationId, (tx) =>
      tx.knowledgeBase.create({
        data: {
          organizationId,
          name: "Chaos Chunk KB",
          embeddingProvider: "openai",
          embeddingModel: "text-embedding-3-small",
          embeddingDim: 1536,
        },
      }),
    );
    knowledgeBaseId = kb.id;

    flowProducer = new FlowProducer({ connection: redisConnection });
    extractionQueue = new Queue(QUEUE_NAMES.extraction, { connection: redisConnection });
  });

  afterAll(async () => {
    if (workerA) await killAndWait(workerA);
    if (workerB) await killAndWait(workerB);
    await flowProducer.close();
    await extractionQueue.close();
    await prisma.organization.delete({ where: { id: organizationId } }).catch(() => undefined);
  });

  it(
    "recovers from a worker crash mid-chunk-upsert with no duplicate DocumentChunk rows and a READY document",
    async () => {
      const pages = Array.from({ length: 6 }, (_, p) => Array.from({ length: 180 }, (_, i) => `chunkword${p}x${i}`).join(" "));
      const pdf = buildTestPdf(pages);
      const fileName = "chaos-chunking-crash.pdf";
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

      // Real production chunking logic run here purely to know the exact
      // expected chunk count ahead of time, for precise kill timing — not
      // a re-implementation or a mock of it. chunk-text.ts's own upsert
      // loop is what the killed job actually runs.
      const extracted = await extractPdfText(pdf);
      const expectedChunks = chunkPages(extracted.pages);
      expect(expectedChunks.length).toBeGreaterThan(1);

      // FAKE_CHUNK_UPSERT_DELAY_MS is what makes a kill mid-upsert-loop
      // (some chunks written within the still-open transaction, not yet
      // committed) reliably possible — a real batch of upserts against a
      // local Postgres would otherwise finish in low single-digit
      // milliseconds. Extraction/embedding stay at their fast defaults:
      // this scenario isolates the crash to chunk-text specifically.
      const chaosEnv = {
        EMBEDDING_PROVIDER: "fake",
        FAKE_CHUNK_UPSERT_DELAY_MS: String(CHUNK_UPSERT_DELAY_MS),
        WORKER_LOCK_DURATION_MS: String(CHAOS_LOCK_DURATION_MS),
        WORKER_STALLED_INTERVAL_MS: String(CHAOS_STALLED_INTERVAL_MS),
      };

      workerA = spawnWorker("chunk-worker-a", chaosEnv);

      await enqueueFlow(flowProducer, { documentId: document.id, organizationId, knowledgeBaseId });

      const chunkJobId = `${JOB_NAMES.chunkText}-${document.id}`;
      await waitForJobActive(extractionQueue, chunkJobId, 20_000);

      // Land the kill partway through the upsert loop (never at the very
      // start or the very end), same calibration approach as the
      // embed-chunks chaos test.
      const killAfterMs = Math.max(150, Math.floor(expectedChunks.length * CHUNK_UPSERT_DELAY_MS * 0.4));
      await sleep(killAfterMs);
      await killAndWait(workerA);

      workerB = spawnWorker("chunk-worker-b", chaosEnv);

      const finalDocument = await waitForDocumentStatus(organizationId, document.id, ["READY", "FAILED"], 45_000);
      expect(finalDocument.failureReason).toBeNull();
      expect(finalDocument.status).toBe("READY");

      // Genuinely recovered from a crash, not a fluke where the kill
      // missed the process actually doing the work (see spawnWorker's own
      // comment): the chunk-text job must show at least one
      // stalled/reprocessed attempt, not a single uninterrupted completion.
      const chunkJob = await extractionQueue.getJob(chunkJobId);
      expect(await chunkJob?.getState()).toBe("completed");
      expect(chunkJob?.attemptsMade ?? 0).toBeGreaterThanOrEqual(1);

      const chunks = await withTenantTransaction(organizationId, (tx) =>
        tx.documentChunk.findMany({ where: { documentId: document.id }, orderBy: { chunkIndex: "asc" } }),
      );
      // No duplicates, exact expected count: the killed transaction never
      // committed (a dropped connection mid-transaction rolls back on
      // Postgres's side), and the upsert-on-(documentId, chunkIndex) retry
      // is idempotent even if it had partially persisted — either way, the
      // final set must be exactly the chunks chunkPages actually produced,
      // no more and no less.
      expect(chunks).toHaveLength(expectedChunks.length);
      expect(chunks.map((c) => c.chunkIndex)).toEqual(chunks.map((_, i) => i));
      expect(new Set(chunks.map((c) => c.id)).size).toBe(chunks.length);

      // unique(documentId, chunkIndex) preserved: checked directly against
      // the database, not inferred from the row count above — zero
      // (documentId, chunkIndex) pairs with more than one row.
      const duplicatePairs = await withTenantTransaction(organizationId, (tx) =>
        tx.$queryRaw<Array<{ chunkIndex: number; count: bigint }>>`
          SELECT "chunkIndex", COUNT(*) as count
          FROM "DocumentChunk"
          WHERE "documentId" = ${document.id}
          GROUP BY "chunkIndex"
          HAVING COUNT(*) > 1
        `,
      );
      expect(duplicatePairs).toHaveLength(0);

      const embedded = await withTenantTransaction(organizationId, (tx) =>
        tx.$queryRaw<Array<{ has_embedding: boolean }>>`
          SELECT embedding IS NOT NULL as has_embedding FROM "DocumentChunk" WHERE "documentId" = ${document.id}
        `,
      );
      expect(embedded).toHaveLength(expectedChunks.length);
      expect(embedded.every((row) => row.has_embedding)).toBe(true);
    },
    60_000,
  );
});
