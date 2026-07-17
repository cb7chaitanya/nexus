import { JOB_NAMES, QUEUE_NAMES } from "@raas/shared";
import { Queue } from "bullmq";

import { redis } from "./redis.js";

// Mirrors ingestion-flow.ts's own reasoning for reusing apps/api's
// existing Redis connection rather than opening a second one — a Queue
// (unlike a BullMQ Worker) never issues blocking commands, so it has no
// maxRetriesPerRequest requirement of its own.
const kbCleanupQueue = new Queue(QUEUE_NAMES.kbCleanup, { connection: redis });

const JOB_OPTS = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 5000 },
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 5000 },
};

export interface EnqueueKnowledgeBaseCleanupInput {
  organizationId: string;
  knowledgeBaseId: string;
}

/**
 * Enqueues the async cleanup DELETE /kb/:id hands off to apps/worker once
 * a KB has more chunks than KB_DELETION_ASYNC_CHUNK_THRESHOLD (see
 * env.ts) — deleting the S3 objects for every document, then the KB row
 * itself (which cascades documents/chunks at the DB level — see
 * apps/worker's cleanup-knowledge-base processor for why the row delete
 * comes last, after S3 cleanup succeeds).
 *
 * Deterministic jobId (keyed on knowledgeBaseId) makes re-enqueuing
 * idempotent — BullMQ treats adding a job with an id that already exists
 * as a no-op, so a route that somehow gets called twice for the same KB
 * (its own PENDING->DELETING transition check already prevents this in
 * practice, same defense-in-depth reasoning as
 * enqueueDocumentIngestion) doesn't create a duplicate cleanup job.
 */
export async function enqueueKnowledgeBaseCleanup(input: EnqueueKnowledgeBaseCleanupInput): Promise<void> {
  await kbCleanupQueue.add(JOB_NAMES.cleanupKnowledgeBase, input, {
    ...JOB_OPTS,
    jobId: `${JOB_NAMES.cleanupKnowledgeBase}-${input.knowledgeBaseId}`,
  });
}
