import { withTenantTransaction } from "@raas/db";
import type { Job } from "bullmq";

import { failDocument, isLastAttempt } from "../lib/job-failure.js";
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
  const { organizationId, documentId } = job.data;

  try {
    await withTenantTransaction(organizationId, (tx) =>
      tx.document.update({
        where: { id: documentId },
        data: { status: "READY", processedAt: new Date() },
      }),
    );
  } catch (err) {
    if (isLastAttempt(job)) {
      await failDocument(organizationId, documentId, err instanceof Error ? err.message : String(err));
    }
    throw err;
  }
}
