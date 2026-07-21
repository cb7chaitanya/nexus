import { JOB_NAMES, QUEUE_NAMES } from "@raas/shared";
import { createLogger } from "@raas/logger";
import {
  documentIngestionDurationSeconds,
  documentProcessingDurationSeconds,
  ingestionJobsCompletedTotal,
  ingestionJobsFailedTotal,
  ingestionJobsRetriedTotal,
  ingestionJobsStartedTotal,
  registerQueueForMetrics,
} from "@raas/metrics";
import { captureException } from "@raas/observability";
import { Queue, Worker, type Job } from "bullmq";

import { env } from "./env.js";
import { startHealthServer } from "./health-server.js";
import { recordJobSuccess } from "./lib/health-state.js";
import { handleJobFailure } from "./lib/job-failure-alerts.js";
import { withJobTimeout } from "./lib/job-timeout.js";
import { createJobLogger } from "./lib/job-logger.js";
import { backOffIfMemoryConstrained } from "./lib/memory-backpressure.js";
import { createNotifier } from "./lib/notifications/index.js";
import { redisConnection } from "./lib/redis.js";
import { initSentry } from "./lib/sentry.js";
import { gracefulShutdown } from "./lib/shutdown.js";
import { chunkTextProcessor } from "./processors/chunk-text.js";
import { cleanupDocumentStorageProcessor } from "./processors/cleanup-document-storage.js";
import { cleanupKnowledgeBaseProcessor } from "./processors/cleanup-knowledge-base.js";
import { embedChunksProcessor } from "./processors/embed-chunks.js";
import { extractTextProcessor } from "./processors/extract-text.js";
import { processDocumentProcessor } from "./processors/process-document.js";
import { sendEmailProcessor } from "./processors/send-email.js";
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
  // Before anything else can fail — see lib/sentry.ts's own doc comment
  // (apps/api/src/lib/sentry.ts's copy has the fuller reasoning this
  // mirrors).
  initSentry();

  const pong = await pingRedisOrFail();
  // Host/port only, never the full REDIS_URL — it carries the Redis
  // password (redis://:<password>@host:port) and this line is
  // structured JSON shipped straight to whatever log aggregator is
  // configured (see DEPLOYMENT.md's Observability section), same
  // "never log the secret itself" discipline env.ts's required-secret
  // checks and the alertWebhookConfigured boolean below already apply.
  const redisEndpoint = new URL(env.REDIS_URL);
  logger.info(
    { redisHost: redisEndpoint.hostname, redisPort: redisEndpoint.port || "6379", pong, embeddingProvider: env.EMBEDDING_PROVIDER },
    "worker connected to redis",
  );

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
  // Own Queue handle constructed up front (rather than down with the
  // other standalone Queues below) because the extraction processor
  // itself needs it: backOffIfMemoryConstrained sets this queue's
  // rate-limiter key, which is how a memory-backpressured job actually
  // gets delayed rather than immediately re-picked-up (see
  // lib/memory-backpressure.ts's own doc comment). Reused, not
  // duplicated, by the standalone-Queue list further down.
  const documentExtractionQueue = new Queue(QUEUE_NAMES.extraction, { connection: redisConnection });
  const extractionWorker = new Worker(
    QUEUE_NAMES.extraction,
    withJobTimeout(async (job: Job<DocumentJobData>) => {
      if (job.name === JOB_NAMES.extractText) {
        // Only the extract-text stage buffers a whole document into
        // memory (chunk-text works off already-persisted chunks) — see
        // WORKER_MEMORY_RSS_LIMIT_BYTES's own comment for why this check
        // exists alongside the static per-document/concurrency budget.
        await backOffIfMemoryConstrained(documentExtractionQueue, createJobLogger({ jobId: job.id, organizationId: job.data.organizationId, documentId: job.data.documentId }));
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

  // DELETE /documents/:id's retry-safe fallback (apps/api/src/lib/document-cleanup.ts)
  // — same reliability pattern as kbCleanupWorker above, its own queue for
  // the same "independent concurrency control" reasoning (see this
  // function's opening comment): a burst of document-storage cleanup
  // retries shouldn't compete with, or be conflated in metrics/health
  // with, whole-KB cleanup capacity.
  const documentCleanupWorker = new Worker(QUEUE_NAMES.documentCleanup, withJobTimeout(cleanupDocumentStorageProcessor, env.WORKER_MAX_JOB_DURATION_MS), {
    ...sharedWorkerOptions,
    concurrency: env.WORKER_DOCUMENT_CLEANUP_CONCURRENCY,
  });

  // Signup-OTP codes today (apps/api/src/routes/auth.ts), generic enough
  // for any future transactional email — see processors/send-email.ts.
  const emailWorker = new Worker(QUEUE_NAMES.email, withJobTimeout(sendEmailProcessor, env.WORKER_MAX_JOB_DURATION_MS), {
    ...sharedWorkerOptions,
    concurrency: env.WORKER_EMAIL_CONCURRENCY,
  });

  const workers = [processingWorker, extractionWorker, embeddingWorker, sweepWorker, kbCleanupWorker, documentCleanupWorker, emailWorker];

  // Standalone Queue handles for processing/kb-cleanup/document-cleanup —
  // distinct from the Worker objects above (a BullMQ Worker is a
  // consumer, it doesn't expose getJobCounts()/introspection the way a
  // Queue does). document-embedding and document-sweep already have
  // their own Queue instances (documentEmbeddingQueue, above — needed by
  // processors/chunk-text.ts's own fan-out; documentSweepQueue, needed to
  // schedule the repeatable sweep job), and document-extraction's is
  // already constructed above (documentExtractionQueue — the memory
  // backpressure guard needs it), so only these three are new here.
  // Exist for two things: queue-depth/active-jobs metrics below, and
  // widening the health check (below) and graceful-shutdown queue list
  // (see the shutdown() closure further down) to cover all six queues
  // instead of two.
  const documentProcessingQueue = new Queue(QUEUE_NAMES.processing, { connection: redisConnection });
  const kbCleanupQueue = new Queue(QUEUE_NAMES.kbCleanup, { connection: redisConnection });
  const documentCleanupQueue = new Queue(QUEUE_NAMES.documentCleanup, { connection: redisConnection });
  const emailDeliveryQueue = new Queue(QUEUE_NAMES.email, { connection: redisConnection });
  const allQueues = [
    documentProcessingQueue,
    documentExtractionQueue,
    documentEmbeddingQueue,
    documentSweepQueue,
    kbCleanupQueue,
    documentCleanupQueue,
    emailDeliveryQueue,
  ];

  // registerQueueForMetrics (@raas/metrics) — queueDepth/queueActiveJobs
  // sample every registered queue's real BullMQ state at each /metrics
  // scrape (see that package's queue-metrics.ts for why this is a
  // registration + pull model rather than event-driven like the counters
  // below). Every queue this worker owns, not just the ingestion three —
  // depth/active-jobs is meaningful operational signal for sweep and
  // kb-cleanup too.
  for (const queue of allQueues) {
    registerQueueForMetrics(queue);
  }

  // See notifications/index.ts: selects WebhookNotifier when
  // ALERT_WEBHOOK_URL is configured, a no-op otherwise. Constructed once
  // and shared across every queue's "failed" handler below, same as the
  // provider singletons elsewhere in this file.
  const notifier = createNotifier();

  // Every worker this process runs, not just the ingestion pipeline three
  // — completed/failed/duration/retry signal is meaningful for the sweep
  // and kb-cleanup maintenance workers too, and this loop is what closes
  // that gap (previously only processing/extraction/embedding were wired
  // into @raas/metrics's counters/histograms at all). Pure event
  // listeners on top of BullMQ's own Worker lifecycle events — no
  // processor file is touched, so this cannot change what any of them
  // decide, only observe it after the fact.
  for (const worker of workers) {
    // job-failure-alerts.ts owns both the existing per-attempt log line
    // and the new "permanently failed -> notify" decision — see its own
    // doc comment for why job.finishedOn (not attemptsMade arithmetic
    // redone here) is what determines "permanently".
    worker.on("failed", (job, err) => {
      void handleJobFailure(notifier, job, err);
      if (job) {
        ingestionJobsFailedTotal.inc({ queue: job.queueName, job_name: job.name });
        // Distinct counter from the one above — see
        // @raas/metrics's ingestionJobsRetriedTotal doc comment. Same
        // "has BullMQ already decided not to retry" signal
        // job-failure-alerts.ts's own finishedOn check uses, checked
        // independently here rather than threading a boolean out of that
        // async call, since this increment has to happen synchronously
        // in the same event tick regardless of how long notifying takes.
        if (!job.finishedOn) {
          ingestionJobsRetriedTotal.inc({ queue: job.queueName, job_name: job.name });
        }
      }
    });
    worker.on("active", (job) => {
      ingestionJobsStartedTotal.inc({ queue: job.queueName, job_name: job.name });
    });
    worker.on("completed", (job) => {
      recordJobSuccess();
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
  }

  const healthServer = startHealthServer({ queues: allQueues, workers }, env.WORKER_HEALTH_PORT, env.WORKER_HEALTH_HOST);

  // Idempotency guard: a second SIGTERM/SIGINT arriving while the first is
  // still draining (a human resending it, or both signals arriving close
  // together) must not kick off a second concurrent shutdown — gracefulShutdown
  // closes the health server/queues/Redis connection, and doing that twice
  // concurrently has no defined behavior worth relying on. Also shared
  // with the crash handlers below — see apps/api/src/index.ts's identical
  // guard for the reasoning on the double-fault case.
  let shuttingDown: Promise<void> | null = null;
  const shutdown = (reason: string, exitCode = 0): void => {
    if (shuttingDown) {
      logger.info({ reason }, "shutdown already in progress — ignoring duplicate trigger");
      return;
    }
    shuttingDown = (async () => {
      logger.info({ reason }, "worker shutting down");
      const { drainedGracefully } = await gracefulShutdown({
        workers,
        queues: allQueues,
        redisConnection,
        healthServer,
        timeoutMs: env.WORKER_SHUTDOWN_TIMEOUT_MS,
        log: logger,
      });
      logger.info({ reason, drainedGracefully }, "worker shutdown complete");
      process.exit(exitCode);
    })();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Node's own default behavior for an uncaught exception/unhandled
  // rejection with no listener is to print it and exit(1) — registering a
  // handler here takes over that responsibility entirely, so this must
  // still end in process.exit with a non-zero code on every path,
  // including a failure inside this handler itself (the outer try/catch),
  // or a genuine crash would leave the process hanging instead of
  // actually going down — see apps/api/src/index.ts's identical handler
  // for the fuller reasoning this mirrors. Reuses the same
  // gracefulShutdown as a clean SIGTERM (letting whatever job each worker
  // is actively processing finish within WORKER_SHUTDOWN_TIMEOUT_MS)
  // rather than a bare process.exit.
  const onFatalError = (kind: "uncaughtException" | "unhandledRejection") => (err: unknown): void => {
    try {
      captureException(err, { source: kind });
      logger.error({ err, source: kind }, `${kind} — shutting down`);
      shutdown(kind, 1);
    } catch (handlerErr) {
      logger.error({ err: handlerErr, original: err, source: kind }, "error while handling a fatal error — forcing exit");
      process.exit(1);
    }
  };
  process.on("uncaughtException", onFatalError("uncaughtException"));
  process.on("unhandledRejection", onFatalError("unhandledRejection"));

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
        documentCleanup: env.WORKER_DOCUMENT_CLEANUP_CONCURRENCY,
        email: env.WORKER_EMAIL_CONCURRENCY,
      },
      maxJobDurationMs: env.WORKER_MAX_JOB_DURATION_MS,
      shutdownTimeoutMs: env.WORKER_SHUTDOWN_TIMEOUT_MS,
      maxDocumentBytes: env.WORKER_MAX_DOCUMENT_BYTES,
      memoryRssLimitBytes: env.WORKER_MEMORY_RSS_LIMIT_BYTES,
      memoryBackpressureDelayMs: env.WORKER_MEMORY_BACKPRESSURE_DELAY_MS,
      lockDurationMs: env.WORKER_LOCK_DURATION_MS,
      stalledIntervalMs: env.WORKER_STALLED_INTERVAL_MS,
      sweepIntervalMs: env.STUCK_DOCUMENT_SWEEP_INTERVAL_MS,
      sweepThresholdMs: env.STUCK_DOCUMENT_THRESHOLD_MS,
      stuckDocumentAutoRetry: env.STUCK_DOCUMENT_AUTO_RETRY,
      stuckDocumentMaxAutoRetries: env.STUCK_DOCUMENT_MAX_AUTO_RETRIES,
      embeddingProvider: env.EMBEDDING_PROVIDER,
      emailProvider: env.EMAIL_PROVIDER,
      alertWebhookConfigured: Boolean(env.ALERT_WEBHOOK_URL),
      healthPort: env.WORKER_HEALTH_PORT,
    },
    "worker ready — listening on document-processing, document-extraction, document-embedding, document-sweep, kb-cleanup, document-cleanup, email-delivery",
  );
}

main().catch((err: unknown) => {
  captureException(err, { source: "startup" });
  logger.error({ err }, "worker failed to start");
  process.exit(1);
});
