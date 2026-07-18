import { withTenantTransaction } from "@raas/db";
import { recordUsage } from "@raas/usage";
import type { Job } from "bullmq";

import { failDocument, isLastAttempt } from "../lib/job-failure.js";
import { createJobLogger } from "../lib/job-logger.js";
import type { DocumentJobData } from "./types.js";

/**
 * Parent job — BullMQ only runs this once every child (chunk-text's
 * subtree, plus every dynamically fanned-out embed-chunks batch) has
 * completed. failParentOnFailure on every child (see queue/queues.ts)
 * means this processor never runs at all if any stage permanently failed;
 * that stage's own catch block is what sets Document.status = FAILED in
 * that case, so getting here at all means the whole pipeline actually
 * succeeded.
 */
export async function processDocumentProcessor(job: Job<DocumentJobData>): Promise<void> {
  const { organizationId, documentId, knowledgeBaseId, requestId } = job.data;
  const log = createJobLogger({ jobId: job.id, organizationId, documentId, requestId });

  try {
    await withTenantTransaction(organizationId, async (tx) => {
      await tx.document.update({
        where: { id: documentId },
        data: { status: "READY", processedAt: new Date() },
      });
      await recordUsage({ organizationId, type: "DOCUMENT_PROCESSED", metadata: { documentId, knowledgeBaseId } }, tx);
    });
    log.info("document marked READY");
  } catch (err) {
    if (isLastAttempt(job)) {
      await failDocument(organizationId, documentId, err instanceof Error ? err.message : String(err));
    }
    log.error({ err }, "process-document failed");
    throw err;
  }
}
