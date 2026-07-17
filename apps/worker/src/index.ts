import { JOB_NAMES, QUEUE_NAMES } from "@raas/shared";
import { createLogger } from "@raas/logger";
import { Worker } from "bullmq";

import { env } from "./env.js";
import { redisConnection } from "./lib/redis.js";
import { chunkTextProcessor } from "./processors/chunk-text.js";
import { embedChunksProcessor } from "./processors/embed-chunks.js";
import { extractTextProcessor } from "./processors/extract-text.js";
import { processDocumentProcessor } from "./processors/process-document.js";
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

  const workers = [processingWorker, extractionWorker, embeddingWorker];
  for (const worker of workers) {
    worker.on("failed", (job, err) => {
      logger.error({ jobId: job?.id, jobName: job?.name, err }, "job failed");
    });
  }

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "worker shutting down");
    await Promise.all(workers.map((w) => w.close()));
    await documentEmbeddingQueue.close();
    await redisConnection.quit();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  logger.info("worker ready — listening on document-processing, document-extraction, document-embedding");
}

main().catch((err: unknown) => {
  logger.error({ err }, "worker failed to start");
  process.exit(1);
});
