import { captureException } from "@raas/observability";
import type { Job } from "bullmq";

import type { Notifier } from "./notifications/index.js";
import { createJobLogger } from "./job-logger.js";

/**
 * Called from every queue's Worker "failed" event (see index.ts). BullMQ
 * emits "failed" on EVERY failed attempt, not just the final one — that's
 * the Worker's own event semantics (verified against bullmq's
 * handleFailed/moveToFailed source, not assumed), so this function is
 * what actually decides whether an attempt was DEFINITIVE (no more
 * retries coming) before ever notifying.
 *
 * job.finishedOn is only set by BullMQ's own moveToFailed once it has
 * already decided not to retry (attempts exhausted, job.discard()'d, or
 * an UnrecoverableError) — checking that directly is a more reliable
 * signal than re-deriving "is this the last attempt" from
 * attemptsMade/opts.attempts ourselves, since it can never drift out of
 * sync with whatever BullMQ's own retry decision actually was.
 */
export async function handleJobFailure(notifier: Notifier, job: Job | undefined, err: Error): Promise<void> {
  const data = job?.data as { organizationId?: string; documentId?: string; knowledgeBaseId?: string; requestId?: string } | undefined;
  const log = createJobLogger({
    jobId: job?.id,
    organizationId: data?.organizationId,
    documentId: data?.documentId,
    knowledgeBaseId: data?.knowledgeBaseId,
    requestId: data?.requestId,
  });
  log.error({ jobName: job?.name, err }, "job failed");

  if (!job?.finishedOn) {
    // BullMQ has already scheduled a retry for this job — not a
    // permanent failure yet, nothing to alert on.
    return;
  }

  // Only a job that's DEFINITIVELY done retrying reaches here (see the
  // finishedOn check above) — the worker-side equivalent of
  // error-handler.ts's "only unexpected/bug-class errors" rule: routine
  // per-attempt transient failures never reach this branch, only ones
  // BullMQ has given up on.
  captureException(err, {
    jobId: job.id,
    jobName: job.name,
    queueName: job.queueName,
    organizationId: data?.organizationId,
    documentId: data?.documentId,
    knowledgeBaseId: data?.knowledgeBaseId,
    requestId: data?.requestId,
  });

  try {
    await notifier.notifyJobFailure({
      organizationId: data?.organizationId,
      documentId: data?.documentId,
      jobId: job.id ?? "unknown",
      jobName: job.name,
      queueName: job.queueName,
      failureReason: job.failedReason || err.message,
      retryCount: job.attemptsMade,
      occurredAt: new Date().toISOString(),
    });
  } catch (notifyErr) {
    // Belt-and-suspenders: every Notifier implementation is documented to
    // resolve rather than reject on its own failure (see
    // notifications/types.ts's Notifier doc comment), but this call site
    // doesn't trust that blindly — a bug in a future notifier
    // implementation must still never crash the worker process just
    // because alerting itself is having a bad day.
    log.error({ err: notifyErr }, "notifier threw while sending a job-failure alert (violates Notifier's contract — see notifications/types.ts)");
  }
}
