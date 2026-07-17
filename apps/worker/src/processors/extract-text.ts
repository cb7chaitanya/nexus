import { withTenantTransaction } from "@raas/db";
import { UnrecoverableError, type Job } from "bullmq";

import { extractPdfText, ScannedDocumentError, type ExtractedDocument } from "../lib/extract-pdf.js";
import { failDocument, isLastAttempt } from "../lib/job-failure.js";
import { downloadObject } from "../lib/storage.js";
import type { DocumentJobData } from "./types.js";

/**
 * Leaf stage of the flow — runs first, downloads the uploaded object and
 * extracts text. Its return value is read back by chunk-text via
 * `job.getChildrenValues()` (BullMQ persists it), so no intermediate DB
 * write is needed to hand extracted text to the next stage.
 */
export async function extractTextProcessor(job: Job<DocumentJobData>): Promise<ExtractedDocument> {
  const { organizationId, documentId } = job.data;

  try {
    const document = await withTenantTransaction(organizationId, async (tx) => {
      const existing = await tx.document.findUnique({ where: { id: documentId } });
      if (!existing) {
        throw new UnrecoverableError(`Document ${documentId} not found`);
      }
      if (existing.status === "READY" || existing.status === "FAILED") {
        throw new UnrecoverableError(`Document ${documentId} is already in terminal status ${existing.status}`);
      }
      // Idempotent under retry: re-running this stage after a crash just
      // re-sets the same status.
      return tx.document.update({ where: { id: documentId }, data: { status: "PROCESSING" } });
    });

    if (document.mimeType !== "application/pdf") {
      throw new UnrecoverableError(`Unsupported file type "${document.mimeType}" — only application/pdf is supported`);
    }

    const buffer = await downloadObject(document.storageKey);
    return await extractPdfText(buffer);
  } catch (err) {
    if (err instanceof ScannedDocumentError) {
      await failDocument(organizationId, documentId, err.message);
      throw new UnrecoverableError(err.message);
    }
    if (err instanceof UnrecoverableError) {
      await failDocument(organizationId, documentId, err.message);
      throw err;
    }
    if (isLastAttempt(job)) {
      await failDocument(organizationId, documentId, err instanceof Error ? err.message : String(err));
    }
    throw err;
  }
}
