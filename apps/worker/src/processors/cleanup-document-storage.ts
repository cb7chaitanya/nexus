import { withTenantTransaction } from "@raas/db";
import type { Job } from "bullmq";

import { createJobLogger } from "../lib/job-logger.js";
import { deleteObjects } from "../lib/storage.js";

export interface CleanupDocumentStorageJobData {
  organizationId: string;
  documentId: string;
}

/**
 * DELETE /documents/:id's retry-safe fallback (see
 * apps/api/src/lib/document-cleanup.ts) — enqueued only when the route's
 * own inline deleteObjects call fails, after the Document row has
 * already been soft-deleted (status: DELETED, see documents.ts).
 *
 * Unlike cleanup-knowledge-base, there's no DB row left to cascade
 * afterward: DELETE /documents/:id keeps the Document row permanently as
 * an audit record, so its storageKey is never at risk of being lost the
 * way an un-cascaded KnowledgeBase's Document rows would be — this job
 * has exactly one thing to finish. Re-running it (a BullMQ retry, or a
 * manually re-enqueued job for an old failure) is safe: deleting an
 * already-gone S3 key is a no-op, not an error (see lib/storage.ts's own
 * doc comment).
 */
export async function cleanupDocumentStorageProcessor(job: Job<CleanupDocumentStorageJobData>): Promise<void> {
  const { organizationId, documentId } = job.data;
  const log = createJobLogger({ jobId: job.id, organizationId, documentId });

  const document = await withTenantTransaction(organizationId, (tx) => tx.document.findUnique({ where: { id: documentId } }));
  if (!document) {
    // Shouldn't happen — DELETE /documents/:id only ever soft-deletes, it
    // never hard-deletes a Document row — but a defensive no-op here
    // (rather than throwing, which would just trigger a pointless retry)
    // is cheap and correct if it ever somehow did.
    log.warn("document row not found — nothing left to clean up");
    return;
  }

  await deleteObjects([document.storageKey]);
  log.info({ storageKey: document.storageKey }, "document storage cleanup complete");
}
