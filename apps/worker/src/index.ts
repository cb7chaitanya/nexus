import { JOB_NAMES, QUEUE_NAMES } from "@raas/shared";
import { createLogger } from "@raas/logger";
import { Queue, Worker } from "bullmq";

import { env } from "./env.js";
import { createJobLogger } from "./lib/job-logger.js";
import { redisConnection } from "./lib/redis.js";
import { chunkTextProcessor } from "./processors/chunk-text.js";
import { embedChunksProcessor } from "./processors/embed-chunks.js";
import { extractTextProcessor } from "./processors/extract-text.js";
import { processDocumentProcessor } from "./processors/process-document.js";
import { sweepStuckDocuments } from "./processors/sweep-stuck-documents.js";
import { documentEmbeddingQueue } from "./queue/queues.js";

const logger = createLogger({ service: "worker" });

const sharedWorkerOptions = {
  connection: redisConnection,
  lockDuration: env.WORKER_LOCK_DURATION_MS,
  stalledInterval: env.WORKER_STALLED_INTERVAL_MS,
};

async function main(): Promise<void> {
  const pong = await redisConnection.ping();
  logger.info({ redisUrl: env.REDIS_URL, pong, embeddingProvider: env.EMBEDDING_PROVIDER }, "worker connected to redis");

  // Separate named queues by concern for independent concurrency control
  // (see docs/architecture.md §6.1): document-processing just orchestrates,
  // document-extraction is CPU-bound (PDF parsing + chunking), and
  // document-embedding is rate-limited by the provider's quota rather than
  // server CPU — sized much lower than the others for that reason.
  const processingWorker = new Worker(QUEUE_NAMES.processing, processDocumentProcessor, {
    ...sharedWorkerOptions,
    concurrency: 10,
  });
  const extractionWorker = new Worker(
    QUEUE_NAMES.extraction,
    async (job) => {
      if (job.name === JOB_NAMES.extractText) {
        return extractTextProcessor(job);
      }
      return chunkTextProcessor(job);
    },
    { ...sharedWorkerOptions, concurrency: 4 },
  );
  const embeddingWorker = new Worker(QUEUE_NAMES.embedding, embedChunksProcessor, {
    ...sharedWorkerOptions,
    concurrency: 2,
  });

  // Scheduled maintenance (docs/architecture.md §6.2, decisions.md R8),
  // not part of the ingestion flow — its own queue, its own low
  // concurrency (a sweep pass touching many orgs shouldn't compete with
  // real ingestion work for worker capacity).
  const documentSweepQueue = new Queue(QUEUE_NAMES.sweep, { connection: redisConnection });
  await documentSweepQueue.add(
    JOB_NAMES.sweepStuckDocuments,
    {},
    {
      repeat: { every: env.STUCK_DOCUMENT_SWEEP_INTERVAL_MS },
      // Fixed jobId so restarting the worker doesn't accumulate a second,
      // third, ... repeatable schedule for the same logical job.
      jobId: "sweep-stuck-documents-schedule",
    },
  );
  const sweepWorker = new Worker(QUEUE_NAMES.sweep, (job) => sweepStuckDocuments({ job }), {
    ...sharedWorkerOptions,
    concurrency: 1,
  });
  sweepWorker.on("completed", (job) => {
    createJobLogger({ jobId: job.id }).info({ result: job.returnvalue as unknown }, "stuck-document sweep completed");
  });

  const workers = [processingWorker, extractionWorker, embeddingWorker, sweepWorker];
  for (const worker of workers) {
    worker.on("failed", (job, err) => {
      // job.data's shape varies by queue (extraction/chunking/embedding
      // jobs carry organizationId/documentId; sweep jobs carry neither,
      // since one sweep job spans many documents — see
      // sweep-stuck-documents.ts's own per-document logging for that
      // case). Reading them off optionally here is what makes this one
      // handler cover every queue consistently instead of one per queue.
      const data = job?.data as { organizationId?: string; documentId?: string } | undefined;
      createJobLogger({ jobId: job?.id, organizationId: data?.organizationId, documentId: data?.documentId }).error(
        { jobName: job?.name, err },
        "job failed",
      );
    });
  }

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "worker shutting down");
    await Promise.all(workers.map((w) => w.close()));
    await documentEmbeddingQueue.close();
    await documentSweepQueue.close();
    await redisConnection.quit();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  logger.info(
    { sweepIntervalMs: env.STUCK_DOCUMENT_SWEEP_INTERVAL_MS, sweepThresholdMs: env.STUCK_DOCUMENT_THRESHOLD_MS },
    "worker ready — listening on document-processing, document-extraction, document-embedding, document-sweep",
  );
}

main().catch((err: unknown) => {
  logger.error({ err }, "worker failed to start");
  process.exit(1);
});
