import { JOB_NAMES, QUEUE_NAMES } from "@raas/shared";
import { FlowProducer } from "bullmq";

import { redis } from "./redis.js";

// Reuses apps/api's existing Redis connection rather than opening a second
// one — safe because FlowProducer never issues blocking commands (unlike
// a BullMQ Worker, which requires maxRetriesPerRequest: null on its
// connection; FlowProducer has no such requirement).
const flowProducer = new FlowProducer({ connection: redis });

const JOB_OPTS = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 5000 },
  failParentOnFailure: true,
  // Bound Redis job-history growth — without this BullMQ keeps every
  // completed/failed job forever.
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 5000 },
};

export interface EnqueueDocumentIngestionInput {
  documentId: string;
  organizationId: string;
  knowledgeBaseId: string;
  /**
   * 0 for the original enqueue (POST /documents/:id/complete), the
   * document's post-increment Document.retryCount for a retry (POST
   * /documents/:id/retry) — see that route. Folded into every jobId
   * below so a retry never collides with the original attempt's (or an
   * earlier retry's) jobs, which — even failed — still exist in Redis
   * (removeOnFail keeps up to 5000). Reusing a jobId BullMQ has already
   * moved to a terminal state doesn't cleanly restart it; it overwrites
   * that job's Redis hash while leaving stale bookkeeping (e.g. its
   * "failed" zset membership) pointing at what's now actually a fresh,
   * active job — verified against addStandardJob's Lua script, which
   * unconditionally HSETs the jobId key with no existence check.
   */
  attempt?: number;
  /**
   * The originating HTTP request's Fastify request.id — carried on every
   * job in this flow's data (and re-carried by chunk-text.ts onto the
   * embed-chunks jobs it dynamically fans out) so a document's worker-side
   * logs can be correlated back to the API request that enqueued it, even
   * though the actual work happens in a different process on a later tick.
   * Undefined for a caller with no request in scope (there are none today,
   * but this stays optional rather than required for exactly that reason).
   */
  requestId?: string;
}

/**
 * Builds and enqueues the process-document flow: process-document (parent,
 * marks Document READY once every descendant completes) <- chunk-text
 * (depends on extract-text) <- extract-text (leaf, runs first). embed-chunks
 * jobs aren't part of this static tree — chunk-text's processor adds them
 * dynamically as additional children of process-document once it knows how
 * many batches there are (see apps/worker's processors/chunk-text.ts).
 *
 * Deterministic jobIds (keyed on documentId + attempt) make a single
 * attempt idempotent: calling this twice with the same (documentId,
 * attempt) pair reuses the existing flow rather than creating a duplicate
 * one. In practice POST /documents/:id/complete and POST
 * /documents/:id/retry both already prevent calling this twice for the
 * same attempt (their own status-transition checks return 409 on a second
 * call), so this is defense in depth, not the only thing preventing a
 * double-enqueue. A *different* attempt (a retry) is deliberately NOT
 * idempotent against the original — see `attempt` above.
 */
export async function enqueueDocumentIngestion(input: EnqueueDocumentIngestionInput): Promise<void> {
  const data = {
    organizationId: input.organizationId,
    documentId: input.documentId,
    knowledgeBaseId: input.knowledgeBaseId,
    requestId: input.requestId,
  };

  // Empty string for attempt 0 (the common case) so the original
  // enqueue's jobIds are textually identical to what they were before
  // `attempt` existed — no behavior change for POST /documents/:id/complete.
  const suffix = input.attempt ? `-retry-${input.attempt}` : "";

  // jobId is namespaced by job name, not just documentId — chunk-text and
  // extract-text both run on QUEUE_NAMES.extraction, and BullMQ dedups
  // jobIds within a queue, so reusing the bare documentId for both would
  // collide and silently drop one of them. Hyphens, not colons — BullMQ
  // rejects a custom jobId containing `:` outside a specific 3-part
  // repeatable-job format (verified against Job#validateOptions).
  await flowProducer.add({
    name: JOB_NAMES.processDocument,
    queueName: QUEUE_NAMES.processing,
    data,
    opts: { ...JOB_OPTS, jobId: `${JOB_NAMES.processDocument}-${input.documentId}${suffix}` },
    children: [
      {
        name: JOB_NAMES.chunkText,
        queueName: QUEUE_NAMES.extraction,
        data,
        opts: { ...JOB_OPTS, jobId: `${JOB_NAMES.chunkText}-${input.documentId}${suffix}` },
        children: [
          {
            name: JOB_NAMES.extractText,
            queueName: QUEUE_NAMES.extraction,
            data,
            opts: { ...JOB_OPTS, jobId: `${JOB_NAMES.extractText}-${input.documentId}${suffix}` },
          },
        ],
      },
    ],
  });
}
