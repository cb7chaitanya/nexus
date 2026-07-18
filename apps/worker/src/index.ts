import { JOB_NAMES, QUEUE_NAMES } from "@raas/shared";
import { createLogger } from "@raas/logger";
import { Queue, Worker } from "bullmq";

import { env } from "./env.js";
import { startHealthServer } from "./health-server.js";
import { recordJobSuccess } from "./lib/health-state.js";
import { handleJobFailure } from "./lib/job-failure-alerts.js";
import { createJobLogger } from "./lib/job-logger.js";
import { createNotifier } from "./lib/notifications/index.js";
import { redisConnection } from "./lib/redis.js";
import { chunkTextProcessor } from "./processors/chunk-text.js";
import { cleanupKnowledgeBaseProcessor } from "./processors/cleanup-knowledge-base.js";
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

  // DELETE /kb/:id's async path (apps/api/src/lib/kb-cleanup.ts) — its
  // own queue/low concurrency for the same reason sweep has one: a large
  // KB's S3 cleanup is many individual network calls and shouldn't
  // compete with real ingestion work for worker capacity.
  const kbCleanupWorker = new Worker(QUEUE_NAMES.kbCleanup, cleanupKnowledgeBaseProcessor, {
    ...sharedWorkerOptions,
    concurrency: 2,
  });

  const workers = [processingWorker, extractionWorker, embeddingWorker, sweepWorker, kbCleanupWorker];

  // See notifications/index.ts: selects WebhookNotifier when
  // ALERT_WEBHOOK_URL is configured, a no-op otherwise. Constructed once
  // and shared across every queue's "failed" handler below, same as the
  // provider singletons elsewhere in this file.
  const notifier = createNotifier();

  for (const worker of workers) {
    // job-failure-alerts.ts owns both the existing per-attempt log line
    // and the new "permanently failed -> notify" decision — see its own
    // doc comment for why job.finishedOn (not attemptsMade arithmetic
    // redone here) is what determines "permanently".
    worker.on("failed", (job, err) => {
      void handleJobFailure(notifier, job, err);
    });
    worker.on("completed", () => {
      recordJobSuccess();
    });
  }

  const healthServer = startHealthServer(
    { queues: [documentEmbeddingQueue, documentSweepQueue], workers },
    env.WORKER_HEALTH_PORT,
    env.WORKER_HEALTH_HOST,
  );

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "worker shutting down");
    await new Promise<void>((resolve) => healthServer.close(() => resolve()));
    await Promise.all(workers.map((w) => w.close()));
    await documentEmbeddingQueue.close();
    await documentSweepQueue.close();
    await redisConnection.quit();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  logger.info(
    {
      sweepIntervalMs: env.STUCK_DOCUMENT_SWEEP_INTERVAL_MS,
      sweepThresholdMs: env.STUCK_DOCUMENT_THRESHOLD_MS,
      healthPort: env.WORKER_HEALTH_PORT,
    },
    "worker ready — listening on document-processing, document-extraction, document-embedding, document-sweep, kb-cleanup",
  );
}

main().catch((err: unknown) => {
  logger.error({ err }, "worker failed to start");
  process.exit(1);
});
