import { withTenantTransaction } from "@raas/db";
import { ApiError } from "@raas/shared";
import { UnrecoverableError, type Job } from "bullmq";

import { ScannedDocumentError } from "./extract-pdf.js";

/**
 * True exactly when this is the processor's last permitted attempt at a
 * job — verified against BullMQ's own Job#shouldRetryJob source (job.js):
 * a retry happens when `attemptsMade + 1 < opts.attempts`, so this is its
 * negation. `job.attemptsMade` reflects attempts completed *before* the
 * current one while the processor is running (it's only incremented after
 * this attempt finishes, success or fail) — off-by-one here would either
 * mark Document FAILED on a transient error that was about to succeed on
 * retry, or leave it stuck PROCESSING after retries are actually exhausted.
 */
export function isLastAttempt(job: Job): boolean {
  const maxAttempts = job.opts.attempts ?? 1;
  return job.attemptsMade + 1 >= maxAttempts;
}

/**
 * A document-content problem worth describing precisely to the tenant —
 * "this specific file can't be processed, here's why" — as opposed to an
 * internal bug or infrastructure failure, which never gets that treatment
 * (see toSafeFailureReason below). Extends bullmq's own UnrecoverableError
 * rather than a fresh Error class so `err instanceof UnrecoverableError`
 * still holds everywhere a processor's catch block already checks for it
 * (job.js: bullmq matches by `instanceof` on the exact export, which class
 * inheritance satisfies) — this only adds a label, not a new error
 * hierarchy or a change to retry behavior.
 */
export class DocumentValidationError extends UnrecoverableError {
  constructor(message: string) {
    super(message);
    this.name = "DocumentValidationError";
  }
}

const GENERIC_FAILURE_REASON = "Document processing failed. Please contact support.";

/**
 * Maps any thrown value to text safe to persist in Document.failureReason
 * and serve back to the tenant via GET /documents/:id and GET
 * /kb/:id/documents (see apps/api/src/routes/documents.ts,
 * knowledge-bases.ts — both `reply.send` the raw row, failureReason
 * included). This is an ALLOWLIST, not a blocklist: only messages from a
 * known-safe, explicitly-checked set of error types are ever passed
 * through unmodified —
 *
 *   - ScannedDocumentError (apps/worker/src/lib/extract-pdf.ts) — "scanned
 *     document, OCR not supported".
 *   - DocumentValidationError (above) — unsupported file type, no
 *     extractable text, per-document chunk-count ceiling exceeded.
 *   - ApiError (@raas/shared) — this codebase's existing "safe to show the
 *     caller" error type everywhere else (see apps/api's error-handler.ts);
 *     reused here rather than reinvented, covers the daily embedding-token
 *     budget rejection (embed-chunks.ts) the same way it already covers
 *     every API-level validation/rate-limit error.
 *
 * Everything else — a dropped Postgres connection, an S3 SDK exception, a
 * network failure, a bug — collapses to one fixed, non-identifying
 * message. A new internal error type is safe by default (falls into the
 * generic bucket) rather than leaked by default, which is the property
 * that actually matters here: this function can never be the reason a
 * database URL, an S3 endpoint/bucket detail, or a stack trace ends up in
 * a column a customer can read.
 *
 * The original error is never lost — every call site logs it in full
 * (message, stack, requestId, documentId, organizationId) via its own
 * createJobLogger call around this; only what gets persisted and served
 * back to the tenant is narrowed here.
 */
export function toSafeFailureReason(err: unknown): string {
  if (err instanceof ScannedDocumentError || err instanceof DocumentValidationError || err instanceof ApiError) {
    return err.message;
  }
  return GENERIC_FAILURE_REASON;
}

/**
 * Terminally fails a document. Every stage processor calls this before
 * throwing on a non-retryable error (UnrecoverableError cases) or on the
 * final retry attempt of a transient one — never on an attempt that's
 * still going to be retried, so Document.status doesn't flicker to FAILED
 * and back while a transient error is being retried. Takes the raw thrown
 * value (not a pre-formatted string) so the safe/generic mapping above is
 * applied in exactly one place, not left to each call site's discipline.
 */
export async function failDocument(organizationId: string, documentId: string, err: unknown): Promise<void> {
  await withTenantTransaction(organizationId, (tx) =>
    tx.document.update({
      where: { id: documentId },
      data: { status: "FAILED", failureReason: toSafeFailureReason(err) },
    }),
  );
}
