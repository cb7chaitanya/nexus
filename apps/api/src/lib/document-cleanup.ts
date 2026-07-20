import { JOB_NAMES, QUEUE_NAMES } from "@raas/shared";
import { Queue } from "bullmq";

import { redis } from "./redis.js";

// Same reasoning as kb-cleanup.ts's own queue — a Queue never issues
// blocking commands, so it has no maxRetriesPerRequest requirement of its
// own and can safely reuse apps/api's existing Redis connection.
const documentCleanupQueue = new Queue(QUEUE_NAMES.documentCleanup, { connection: redis });

const JOB_OPTS = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 5000 },
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 5000 },
};

export interface EnqueueDocumentStorageCleanupInput {
  organizationId: string;
  documentId: string;
}

/**
 * DELETE /documents/:id's retry-safe fallback — enqueued only when that
 * route's own inline S3 delete fails after the Document row has already
 * been soft-deleted (see documents.ts). See apps/worker's
 * cleanup-document-storage processor for what actually runs.
 *
 * Deterministic jobId (keyed on documentId) makes re-enqueuing
 * idempotent — same reasoning as enqueueKnowledgeBaseCleanup: BullMQ
 * treats adding a job whose id already exists as a no-op, so this is
 * safe to call from more than one failed delete attempt for the same
 * document without creating duplicate cleanup jobs.
 */
export async function enqueueDocumentStorageCleanup(input: EnqueueDocumentStorageCleanupInput): Promise<void> {
  await documentCleanupQueue.add(JOB_NAMES.cleanupDocumentStorage, input, {
    ...JOB_OPTS,
    jobId: `${JOB_NAMES.cleanupDocumentStorage}-${input.documentId}`,
  });
}
