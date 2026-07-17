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
}

/**
 * Builds and enqueues the process-document flow: process-document (parent,
 * marks Document READY once every descendant completes) <- chunk-text
 * (depends on extract-text) <- extract-text (leaf, runs first). embed-chunks
 * jobs aren't part of this static tree — chunk-text's processor adds them
 * dynamically as additional children of process-document once it knows how
 * many batches there are (see apps/worker's processors/chunk-text.ts).
 *
 * Deterministic jobIds (keyed on documentId) make this idempotent: calling
 * this twice for the same document reuses the existing flow rather than
 * creating a duplicate one. In practice POST /documents/:id/complete
 * already prevents a second call (its own PENDING_UPLOAD -> QUEUED
 * transition check returns 409), so this is defense in depth, not the
 * only thing preventing a double-enqueue.
 */
export async function enqueueDocumentIngestion(input: EnqueueDocumentIngestionInput): Promise<void> {
  const data = {
    organizationId: input.organizationId,
    documentId: input.documentId,
    knowledgeBaseId: input.knowledgeBaseId,
  };

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
