import { withTenantTransaction } from "@raas/db";
import type { Job } from "bullmq";

import { createJobLogger } from "../lib/job-logger.js";
import { deleteObjects } from "../lib/storage.js";

export interface CleanupKnowledgeBaseJobData {
  organizationId: string;
  knowledgeBaseId: string;
}

/**
 * DELETE /kb/:id's async path (apps/api/src/lib/kb-cleanup.ts) — for a KB
 * with more chunks than KB_DELETION_ASYNC_CHUNK_THRESHOLD, already marked
 * status: DELETING and therefore already invisible to every other route
 * by the time this job runs.
 *
 * S3 objects are deleted BEFORE the KnowledgeBase row — deliberately the
 * opposite order from a synchronous small-KB delete's convenience, and
 * load-bearing here: if this job fails/retries partway through, the
 * Document rows (and therefore the storageKey list) must still exist so
 * the retry can re-list them. Deleting the KB row first would cascade-
 * delete every Document row (onDelete: Cascade) and permanently lose the
 * only record of which S3 objects need cleaning up, leaking them forever
 * with no way to find them again. Re-deleting an S3 key a previous
 * attempt already removed is a no-op, not an error, which is what makes
 * retrying this safe.
 */
export async function cleanupKnowledgeBaseProcessor(job: Job<CleanupKnowledgeBaseJobData>): Promise<{ documentsDeleted: number }> {
  const { organizationId, knowledgeBaseId } = job.data;
  const log = createJobLogger({ jobId: job.id, organizationId });

  // DELETED documents excluded: their object was already removed by
  // DELETE /documents/:id (see apps/api/src/routes/documents.ts) —
  // re-deleting it here would just be redundant (harmless per this
  // function's own doc comment, but pointless).
  const documents = await withTenantTransaction(organizationId, (tx) =>
    tx.document.findMany({ where: { knowledgeBaseId, status: { not: "DELETED" } }, select: { storageKey: true } }),
  );

  await deleteObjects(documents.map((d) => d.storageKey));

  // Cascades every remaining Document/DocumentChunk/Conversation row for
  // this KB at the DB level (onDelete: Cascade) — fast regardless of row
  // count, an indexed FK cascade, not application-level looping.
  await withTenantTransaction(organizationId, (tx) => tx.knowledgeBase.delete({ where: { id: knowledgeBaseId } }));

  log.info({ documentsDeleted: documents.length }, "knowledge base cleanup complete");
  return { documentsDeleted: documents.length };
}
