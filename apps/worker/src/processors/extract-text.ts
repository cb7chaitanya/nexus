import { withTenantTransaction } from "@raas/db";
import { UnrecoverableError, type Job } from "bullmq";

import { env } from "../env.js";
import { extractPdfText, ScannedDocumentError, type ExtractedDocument } from "../lib/extract-pdf.js";
import { DocumentValidationError, failDocument, isLastAttempt } from "../lib/job-failure.js";
import { createJobLogger } from "../lib/job-logger.js";
import { downloadObject } from "../lib/storage.js";
import type { DocumentJobData } from "./types.js";

/**
 * Leaf stage of the flow — runs first, downloads the uploaded object and
 * extracts text. Its return value is read back by chunk-text via
 * `job.getChildrenValues()` (BullMQ persists it), so no intermediate DB
 * write is needed to hand extracted text to the next stage.
 */
export async function extractTextProcessor(job: Job<DocumentJobData>): Promise<ExtractedDocument> {
  const { organizationId, documentId, knowledgeBaseId, requestId } = job.data;
  const log = createJobLogger({ jobId: job.id, organizationId, documentId, requestId, knowledgeBaseId });

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
      throw new DocumentValidationError(`Unsupported file type "${document.mimeType}" — only application/pdf is supported`);
    }

    // Worker-operational memory guardrail (see env.ts's
    // WORKER_MAX_DOCUMENT_BYTES doc comment) — checked before downloadObject
    // is ever called, so an oversized document never gets buffered into
    // memory at all. Independent of, and always <=, @raas/shared's
    // MAX_UPLOAD_SIZE_BYTES (the platform's accepted-upload ceiling,
    // enforced at presign/complete time) — this can be tuned per worker
    // deployment without touching what the platform accepts from
    // customers. Real streaming PDF parsing was evaluated and rejected for
    // now: pdfjs-dist (the library extractPdfText's pdf-parse wraps)
    // supports a PDFDataRangeTransport for partial/range-based loading,
    // but wiring that against S3 GetObject range requests would mean
    // extractPdfText taking a transport instead of a Buffer — a real
    // change to this processor's I/O contract, not a config change. Bounded
    // concurrency (WORKER_EXTRACTION_CONCURRENCY) x a bounded per-document
    // size is the static half of the in-scope mitigation; see this var's
    // own comment for the worst-case-memory formula that follows from it.
    // The runtime half — actual RSS-based backpressure for when a parse's
    // real memory use exceeds that static assumption — lives in index.ts's
    // wiring of lib/memory-backpressure.ts, not here.
    if (document.sizeBytes > env.WORKER_MAX_DOCUMENT_BYTES) {
      throw new DocumentValidationError(
        `Document is ${document.sizeBytes} bytes, exceeding this worker's configured processing limit of ${env.WORKER_MAX_DOCUMENT_BYTES} bytes`,
      );
    }

    // No-op outside chaos testing (see env.ts) — lets a test's kill land
    // reliably inside the download+parse window below instead of racing
    // a fast real PDF parse.
    if (env.FAKE_EXTRACTION_DELAY_MS > 0) {
      await new Promise((resolve) => setTimeout(resolve, env.FAKE_EXTRACTION_DELAY_MS));
    }

    const buffer = await downloadObject(document.storageKey);
    // Page/character counts only — never the extracted text itself.
    const extracted = await extractPdfText(buffer);
    log.info({ pageCount: extracted.pages.length }, "text extracted");
    return extracted;
  } catch (err) {
    if (err instanceof ScannedDocumentError) {
      await failDocument(organizationId, documentId, err);
      log.warn({ err }, "extract-text failed: scanned document");
      throw new UnrecoverableError(err.message);
    }
    if (err instanceof UnrecoverableError) {
      await failDocument(organizationId, documentId, err);
      log.warn({ err }, "extract-text failed: unrecoverable");
      throw err;
    }
    if (isLastAttempt(job)) {
      await failDocument(organizationId, documentId, err);
    }
    log.error({ err }, "extract-text failed");
    throw err;
  }
}
