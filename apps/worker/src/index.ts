import { JOB_NAMES, QUEUE_NAMES } from "@raas/shared";
import { createLogger } from "@raas/logger";
import {
  documentIngestionDurationSeconds,
  documentProcessingDurationSeconds,
  ingestionJobsCompletedTotal,
  ingestionJobsFailedTotal,
  ingestionJobsStartedTotal,
} from "@raas/metrics";
import { Queue, Worker, type Job } from "bullmq";

import { env } from "./env.js";
import { startHealthServer } from "./health-server.js";
import { recordJobSuccess } from "./lib/health-state.js";
import { handleJobFailure } from "./lib/job-failure-alerts.js";
import { withJobTimeout } from "./lib/job-timeout.js";
import { createJobLogger } from "./lib/job-logger.js";
import { createNotifier } from "./lib/notifications/index.js";
import { redisConnection } from "./lib/redis.js";
import { gracefulShutdown } from "./lib/shutdown.js";
import { chunkTextProcessor } from "./processors/chunk-text.js";
import { cleanupKnowledgeBaseProcessor } from "./processors/cleanup-knowledge-base.js";
import { embedChunksProcessor } from "./processors/embed-chunks.js";
import { extractTextProcessor } from "./processors/extract-text.js";
import { processDocumentProcessor } from "./processors/process-document.js";
import { sweepStuckDocuments } from "./processors/sweep-stuck-documents.js";
import type { DocumentJobData } from "./processors/types.js";
import { documentEmbeddingQueue } from "./queue/queues.js";

const logger = createLogger({ service: "worker" });

const sharedWorkerOptions = {
  connection: redisConnection,
  lockDuration: env.WORKER_LOCK_DURATION_MS,
  stalledInterval: env.WORKER_STALLED_INTERVAL_MS,
};

/** Bounds the startup connectivity check — see WORKER_REDIS_CONNECT_TIMEOUT_MS's
 * own doc comment for why this exists at all (ioredis retries forever by
 * default, which would otherwise hang main() indefinitely on a
 * misconfigured REDIS_URL instead of failing fast like every other
 * required dependency in this app). */
async function pingRedisOrFail(): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Redis did not respond to PING within ${env.WORKER_REDIS_CONNECT_TIMEOUT_MS}ms — refusing to start`)),
      env.WORKER_REDIS_CONNECT_TIMEOUT_MS,
    );
    redisConnection
      .ping()
      .then((pong) => {
        clearTimeout(timer);
        resolve(pong);
      })
      .catch((err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
  });
}

async function main(): Promise<void> {
  const pong = await pingRedisOrFail();
  logger.info({ redisUrl: env.REDIS_URL, pong, embeddingProvider: env.EMBEDDING_PROVIDER }, "worker connected to redis");

  // Separate named queues by concern for independent concurrency control
  // (see docs/architecture.md §6.1): document-processing just orchestrates,
  // document-extraction is CPU-bound (PDF parsing + chunking) AND the one
  // stage that buffers a whole document into memory (see extract-text.ts's
  // WORKER_MAX_DOCUMENT_BYTES check), and document-embedding is
  // rate-limited by the provider's quota rather than server CPU — sized
  // much lower than the others for that reason. Every processor is wrapped
  // with withJobTimeout — see env.ts's WORKER_MAX_JOB_DURATION_MS comment;
  // this is the only place that wrapping happens, so no processor file
  // itself changes shape.
  const processingWorker = new Worker(QUEUE_NAMES.processing, withJobTimeout(processDocumentProcessor, env.WORKER_MAX_JOB_DURATION_MS), {
    ...sharedWorkerOptions,
    concurrency: env.WORKER_PROCESSING_CONCURRENCY,
  });
  const extractionWorker = new Worker(
    QUEUE_NAMES.extraction,
    withJobTimeout(async (job: Job<DocumentJobData>) => {
      if (job.name === JOB_NAMES.extractText) {
        return extractTextProcessor(job);
      }
      return chunkTextProcessor(job);
    }, env.WORKER_MAX_JOB_DURATION_MS),
    { ...sharedWorkerOptions, concurrency: env.WORKER_EXTRACTION_CONCURRENCY },
  );
  const embeddingWorker = new Worker(QUEUE_NAMES.embedding, withJobTimeout(embedChunksProcessor, env.WORKER_MAX_JOB_DURATION_MS), {
    ...sharedWorkerOptions,
    concurrency: env.WORKER_EMBEDDING_CONCURRENCY,
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
      // Same retry policy as every other queue in this pipeline (see
      // queue/queues.ts's DEFAULT_JOB_OPTS) — previously absent here,
      // which meant a single transient failure (e.g. a Postgres blip
      // mid-pass) permanently skipped that whole sweep run instead of
      // retrying, silently widening the window a genuinely stuck document
      // could sit unnoticed in (docs/decisions.md R8). The next
      // `repeat.every` tick would eventually run anyway, but that's a
      // fixed schedule, not a retry — this makes a failed pass actually
      // retry before falling back to waiting for the next tick.
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
    },
  );
  // Deliberately NOT wrapped with withJobTimeout: unlike every other
  // processor in this file, a sweep pass's natural runtime scales with the
  // number of organizations on the platform, not with one document's
  // size — the same reason it already gets its own concurrency (1) and
  // its own cross-tenant iteration model (see sweep-stuck-documents.ts's
  // doc comment). A fixed per-job ceiling sized for per-document work
  // would eventually become a false-failure trap purely from the platform
  // growing, not an actual safety issue.
  const sweepWorker = new Worker(QUEUE_NAMES.sweep, (job) => sweepStuckDocuments({ job }), {
    ...sharedWorkerOptions,
    concurrency: env.WORKER_SWEEP_CONCURRENCY,
  });
  sweepWorker.on("completed", (job) => {
    createJobLogger({ jobId: job.id }).info({ result: job.returnvalue as unknown }, "stuck-document sweep completed");
  });

  // DELETE /kb/:id's async path (apps/api/src/lib/kb-cleanup.ts) — its
  // own queue/low concurrency for the same reason sweep has one: a large
  // KB's S3 cleanup is many individual network calls and shouldn't
  // compete with real ingestion work for worker capacity.
  const kbCleanupWorker = new Worker(QUEUE_NAMES.kbCleanup, withJobTimeout(cleanupKnowledgeBaseProcessor, env.WORKER_MAX_JOB_DURATION_MS), {
    ...sharedWorkerOptions,
    concurrency: env.WORKER_KB_CLEANUP_CONCURRENCY,
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

  // Ingestion job metrics (@raas/metrics) — scoped to the three workers
  // that make up the actual document-ingestion pipeline (processing,
  // extraction, embedding), not the sweep/kb-cleanup maintenance workers
  // above: "ingestion jobs started/completed/failed" means this pipeline
  // specifically, not every BullMQ job this process ever runs. Pure event
  // listeners on top of BullMQ's own Worker lifecycle events — no
  // processor file is touched, so this cannot change what any of them
  // decide, only observe it after the fact.
  const ingestionWorkers = [processingWorker, extractionWorker, embeddingWorker];
  for (const worker of ingestionWorkers) {
    worker.on("active", (job) => {
      ingestionJobsStartedTotal.inc({ queue: job.queueName, job_name: job.name });
    });
    worker.on("completed", (job) => {
      ingestionJobsCompletedTotal.inc({ queue: job.queueName, job_name: job.name });
      if (job.processedOn && job.finishedOn) {
        documentProcessingDurationSeconds.observe({ queue: job.queueName, job_name: job.name }, (job.finishedOn - job.processedOn) / 1000);
      }
      // process-document only ever completes once the WHOLE flow (every
      // descendant job) has finished — see @raas/metrics's
      // documentIngestionDurationSeconds doc comment for why job.timestamp
      // (this flow's enqueue time) to job.finishedOn is the real,
      // end-to-end document ingestion duration, not just this one job's
      // own slice.
      if (job.name === JOB_NAMES.processDocument && job.finishedOn) {
        documentIngestionDurationSeconds.observe((job.finishedOn - job.timestamp) / 1000);
      }
    });
    worker.on("failed", (job) => {
      if (job) {
        ingestionJobsFailedTotal.inc({ queue: job.queueName, job_name: job.name });
      }
    });
  }

  const healthServer = startHealthServer(
    { queues: [documentEmbeddingQueue, documentSweepQueue], workers },
    env.WORKER_HEALTH_PORT,
    env.WORKER_HEALTH_HOST,
  );

  // Idempotency guard: a second SIGTERM/SIGINT arriving while the first is
  // still draining (a human resending it, or both signals arriving close
  // together) must not kick off a second concurrent shutdown — gracefulShutdown
  // closes the health server/queues/Redis connection, and doing that twice
  // concurrently has no defined behavior worth relying on.
  let shuttingDown: Promise<void> | null = null;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      logger.info({ signal }, "shutdown already in progress — ignoring duplicate signal");
      return;
    }
    shuttingDown = (async () => {
      logger.info({ signal }, "worker shutting down");
      const { drainedGracefully } = await gracefulShutdown({
        workers,
        queues: [documentEmbeddingQueue, documentSweepQueue],
        redisConnection,
        healthServer,
        timeoutMs: env.WORKER_SHUTDOWN_TIMEOUT_MS,
        log: logger,
      });
      logger.info({ signal, drainedGracefully }, "worker shutdown complete");
      process.exit(0);
    })();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Full resource-configuration snapshot at startup (docs/decisions.md's
  // reliability ticket: "worker startup exposes configuration state") —
  // everything relevant to how this process will actually behave under
  // load, in one place, so a misconfigured deployment is visible in the
  // very first log line rather than discovered later from a symptom (an
  // OOM, a slow drain, a silently-disabled alert). Never the alert webhook
  // URL itself — only whether one is configured — since a URL can carry an
  // auth token as a query parameter (same "never log the secret, only that
  // it's set" discipline env.ts's own required-secret checks already
  // apply).
  logger.info(
    {
      concurrency: {
        processing: env.WORKER_PROCESSING_CONCURRENCY,
        extraction: env.WORKER_EXTRACTION_CONCURRENCY,
        embedding: env.WORKER_EMBEDDING_CONCURRENCY,
        sweep: env.WORKER_SWEEP_CONCURRENCY,
        kbCleanup: env.WORKER_KB_CLEANUP_CONCURRENCY,
      },
      maxJobDurationMs: env.WORKER_MAX_JOB_DURATION_MS,
      shutdownTimeoutMs: env.WORKER_SHUTDOWN_TIMEOUT_MS,
      maxDocumentBytes: env.WORKER_MAX_DOCUMENT_BYTES,
      lockDurationMs: env.WORKER_LOCK_DURATION_MS,
      stalledIntervalMs: env.WORKER_STALLED_INTERVAL_MS,
      sweepIntervalMs: env.STUCK_DOCUMENT_SWEEP_INTERVAL_MS,
      sweepThresholdMs: env.STUCK_DOCUMENT_THRESHOLD_MS,
      stuckDocumentAutoRetry: env.STUCK_DOCUMENT_AUTO_RETRY,
      stuckDocumentMaxAutoRetries: env.STUCK_DOCUMENT_MAX_AUTO_RETRIES,
      embeddingProvider: env.EMBEDDING_PROVIDER,
      alertWebhookConfigured: Boolean(env.ALERT_WEBHOOK_URL),
      healthPort: env.WORKER_HEALTH_PORT,
    },
    "worker ready — listening on document-processing, document-extraction, document-embedding, document-sweep, kb-cleanup",
  );
}

main().catch((err: unknown) => {
  logger.error({ err }, "worker failed to start");
  process.exit(1);
});
