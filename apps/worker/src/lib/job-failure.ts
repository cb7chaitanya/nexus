import { withTenantTransaction } from "@raas/db";
import type { Job } from "bullmq";

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
 * Terminally fails a document. Every stage processor calls this before
 * throwing on a non-retryable error (UnrecoverableError cases) or on the
 * final retry attempt of a transient one — never on an attempt that's
 * still going to be retried, so Document.status doesn't flicker to FAILED
 * and back while a transient error is being retried.
 */
export async function failDocument(organizationId: string, documentId: string, reason: string): Promise<void> {
  await withTenantTransaction(organizationId, (tx) =>
    tx.document.update({
      where: { id: documentId },
      data: { status: "FAILED", failureReason: reason },
    }),
  );
}
