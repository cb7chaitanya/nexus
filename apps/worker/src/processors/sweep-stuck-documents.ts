import { prisma, withTenantTransaction } from "@raas/db";
import { JOB_NAMES, QUEUE_NAMES } from "@raas/shared";
import { FlowProducer, type Job } from "bullmq";

import { env } from "../env.js";
import { createJobLogger } from "../lib/job-logger.js";
import { redisConnection } from "../lib/redis.js";

const flowProducer = new FlowProducer({ connection: redisConnection });

const RETRY_JOB_OPTS = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 5000 },
  failParentOnFailure: true,
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 5000 },
};

/**
 * Mirrors apps/api/src/lib/ingestion-flow.ts's flow shape, but with a
 * distinguishing jobId suffix rather than the deterministic
 * documentId-only ids the FIRST enqueue uses: BullMQ dedups by jobId even
 * for a job that already finished (a failed job sticks around up to
 * removeOnFail's count), so reusing the original jobId here would
 * silently no-op instead of actually retrying.
 */
async function enqueueRetryFlow(documentId: string, organizationId: string, knowledgeBaseId: string): Promise<void> {
  const data = { organizationId, documentId, knowledgeBaseId };
  const suffix = `sweep-retry-${Date.now()}`;

  await flowProducer.add({
    name: JOB_NAMES.processDocument,
    queueName: QUEUE_NAMES.processing,
    data,
    opts: { ...RETRY_JOB_OPTS, jobId: `${JOB_NAMES.processDocument}-${documentId}-${suffix}` },
    children: [
      {
        name: JOB_NAMES.chunkText,
        queueName: QUEUE_NAMES.extraction,
        data,
        opts: { ...RETRY_JOB_OPTS, jobId: `${JOB_NAMES.chunkText}-${documentId}-${suffix}` },
        children: [
          {
            name: JOB_NAMES.extractText,
            queueName: QUEUE_NAMES.extraction,
            data,
            opts: { ...RETRY_JOB_OPTS, jobId: `${JOB_NAMES.extractText}-${documentId}-${suffix}` },
          },
        ],
      },
    ],
  });
}

export interface SweepResult {
  checked: number;
  failed: number;
  retried: number;
}

function failureReason(thresholdMs: number): string {
  return `Processing timed out — stuck in a non-terminal status for longer than ${Math.round(thresholdMs / 60_000)} minutes`;
}

/**
 * Scheduled maintenance (docs/architecture.md §6.2): finds every Document
 * sitting in QUEUED or PROCESSING longer than STUCK_DOCUMENT_THRESHOLD_MS
 * and fails it visibly — "a stuck document must always become a visible
 * FAILED state, never silence" (decisions.md R8).
 *
 * Scans across every organization, unlike every other worker operation
 * (all scoped to one org via an explicit job payload). Rather than
 * introduce a new bypass-RLS role for this one cross-tenant maintenance
 * case, this iterates: Organization has no RLS (it IS the tenant
 * boundary, not tenant-scoped data — see schema.prisma), so listing org
 * ids needs no special privilege; each org's stuck documents are then
 * found and fixed through the normal withTenantTransaction path,
 * identically to every other RLS-respecting write in this codebase.
 *
 * Optional auto-retry (STUCK_DOCUMENT_AUTO_RETRY): after marking a
 * document FAILED, immediately re-enqueues a fresh ingestion flow for it
 * instead of leaving it for manual retry. Off by default — it has a real
 * failure mode of its own: a document that's stuck because it's
 * genuinely malformed (not a transient worker crash) could otherwise get
 * marked FAILED and re-enqueued again on every future sweep pass forever.
 * Bounded by STUCK_DOCUMENT_MAX_AUTO_RETRIES, checked against
 * Document.retryCount — the same field POST /documents/:id/retry
 * increments, so a document's total retry count (manual + automatic) is
 * one number, not two separately-tracked ones. A document already at or
 * over the cap is left FAILED with a reason that says so, never
 * re-enqueued; getting there still takes an explicit manual retry (which
 * resets nothing — it just increments the same counter further, same as
 * it always has).
 *
 * All three env-derived numbers are accepted as overridable options — not
 * for production flexibility beyond the env vars themselves, but so tests
 * can exercise the auto-retry path, a tight threshold, and a low retry cap
 * without reloading the env-derived module singleton.
 *
 * `job` is optional so every existing direct caller (tests calling this
 * function outside of BullMQ entirely) keeps working unchanged — the real
 * worker registration (index.ts) passes the actual BullMQ Job so its id
 * can be bound onto every log line this sweep pass produces, the same
 * jobId/organizationId/documentId shape every other processor uses (see
 * lib/job-logger.ts). One sweep job spans many organizations/documents,
 * so jobId is bound once up front and organizationId/documentId are
 * added per document inside the loop.
 */
export async function sweepStuckDocuments(
  options: { thresholdMs?: number; autoRetry?: boolean; maxAutoRetries?: number; job?: Job } = {},
): Promise<SweepResult> {
  const thresholdMs = options.thresholdMs ?? env.STUCK_DOCUMENT_THRESHOLD_MS;
  const autoRetry = options.autoRetry ?? env.STUCK_DOCUMENT_AUTO_RETRY;
  const maxAutoRetries = options.maxAutoRetries ?? env.STUCK_DOCUMENT_MAX_AUTO_RETRIES;
  const threshold = new Date(Date.now() - thresholdMs);
  const result: SweepResult = { checked: 0, failed: 0, retried: 0 };
  const jobLog = createJobLogger({ jobId: options.job?.id });

  // Organization carries no organizationId of its own and has no RLS
  // policy — reading ids off it is not a tenant-data read.
  const organizations = await prisma.organization.findMany({ select: { id: true } });

  for (const org of organizations) {
    const stuck = await withTenantTransaction(org.id, (tx) =>
      tx.document.findMany({
        where: { status: { in: ["QUEUED", "PROCESSING"] }, updatedAt: { lt: threshold } },
      }),
    );
    result.checked += stuck.length;

    for (const document of stuck) {
      const reason = failureReason(thresholdMs);
      const docLog = jobLog.child({ organizationId: org.id, documentId: document.id });

      await withTenantTransaction(org.id, (tx) =>
        tx.document.update({ where: { id: document.id }, data: { status: "FAILED", failureReason: reason } }),
      );
      result.failed++;
      docLog.error({ previousStatus: document.status, stuckSince: document.updatedAt, failureReason: reason }, "stuck document marked FAILED by sweep");

      if (autoRetry) {
        if (document.retryCount >= maxAutoRetries) {
          const cappedReason = `${reason} — automatic retry limit (${maxAutoRetries}) reached; not re-enqueued, marked permanently failed.`;
          await withTenantTransaction(org.id, (tx) =>
            tx.document.update({ where: { id: document.id }, data: { failureReason: cappedReason } }),
          );
          docLog.error({ retryCount: document.retryCount, maxAutoRetries }, "stuck document reached its automatic retry limit — left FAILED");
        } else {
          await enqueueRetryFlow(document.id, org.id, document.knowledgeBaseId);
          await withTenantTransaction(org.id, (tx) =>
            tx.document.update({
              where: { id: document.id },
              data: { status: "QUEUED", failureReason: null, retryCount: { increment: 1 } },
            }),
          );
          result.retried++;
          docLog.info({ retryCount: document.retryCount + 1, maxAutoRetries }, "stuck document automatically re-enqueued for retry");
        }
      }
    }
  }

  jobLog.info({ ...result }, "stuck-document sweep pass complete");
  return result;
}
