/**
 * Real BullMQ Queue/Worker against real Redis — handleJobFailure is
 * wired directly into a Worker's "failed" event, same as index.ts does
 * in production, so these tests exercise BullMQ's actual retry/
 * permanent-failure semantics (job.finishedOn, attemptsMade) rather than
 * a guess at how they behave.
 *
 * Prerequisites: docker compose up -d.
 */
import { randomUUID } from "node:crypto";

import { resetErrorTrackerForTesting, setErrorTracker } from "@raas/observability";
import { Queue, Worker } from "bullmq";
import { afterEach, describe, expect, it } from "vitest";

import { handleJobFailure } from "./job-failure-alerts.js";
import type { JobFailureEvent, Notifier } from "./notifications/types.js";
import { redisConnection } from "./redis.js";

class RecordingNotifier implements Notifier {
  calls: JobFailureEvent[] = [];

  async notifyJobFailure(event: JobFailureEvent): Promise<void> {
    this.calls.push(event);
  }
}

class ThrowingNotifier implements Notifier {
  calls = 0;

  async notifyJobFailure(_event: JobFailureEvent): Promise<void> {
    this.calls++;
    throw new Error("simulated notifier failure — this must never crash the worker");
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("condition not met within timeout");
}

describe("handleJobFailure", () => {
  let queue: Queue | undefined;
  let worker: Worker | undefined;

  afterEach(async () => {
    if (worker) {
      await worker.close();
      worker = undefined;
    }
    if (queue) {
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close();
      queue = undefined;
    }
    resetErrorTrackerForTesting();
  });

  it("does not notify on an attempt that BullMQ will still retry, only on the definitively final one", async () => {
    const queueName = `test-job-failure-alerts-retry-${randomUUID().slice(0, 8)}`;
    queue = new Queue(queueName, { connection: redisConnection });
    const notifier = new RecordingNotifier();
    const handledAttempts: number[] = [];

    worker = new Worker(queueName, () => Promise.reject(new Error("always fails")), { connection: redisConnection });
    worker.on("failed", (job, err) => {
      void handleJobFailure(notifier, job, err).then(() => {
        if (job) handledAttempts.push(job.attemptsMade);
      });
    });
    await worker.waitUntilReady();

    await queue.add(
      "always-fails",
      { organizationId: "org-retry", documentId: "doc-retry" },
      { attempts: 2, backoff: { type: "fixed", delay: 100 } },
    );

    await waitFor(() => handledAttempts.length >= 1);
    expect(notifier.calls).toHaveLength(0);

    await waitFor(() => handledAttempts.length >= 2);
    expect(notifier.calls).toHaveLength(1);
    expect(notifier.calls[0]).toMatchObject({
      organizationId: "org-retry",
      documentId: "doc-retry",
      failureReason: "always fails",
      retryCount: 2,
    });
  }, 20_000);

  it("notifies immediately when a job has no retries at all (attempts: 1)", async () => {
    const queueName = `test-job-failure-alerts-immediate-${randomUUID().slice(0, 8)}`;
    queue = new Queue(queueName, { connection: redisConnection });
    const notifier = new RecordingNotifier();

    worker = new Worker(queueName, () => Promise.reject(new Error("permanent failure")), { connection: redisConnection });
    worker.on("failed", (job, err) => {
      void handleJobFailure(notifier, job, err);
    });
    await worker.waitUntilReady();

    await queue.add("permanent", { organizationId: "org-1", documentId: "doc-1" }, { attempts: 1, jobId: "permanent-job-1" });

    await waitFor(() => notifier.calls.length >= 1);
    expect(notifier.calls[0]).toMatchObject({
      organizationId: "org-1",
      documentId: "doc-1",
      jobId: "permanent-job-1",
      failureReason: "permanent failure",
      retryCount: 1,
    });
    expect(typeof notifier.calls[0]?.occurredAt).toBe("string");
  }, 20_000);

  it("reports a permanently-failed job to the active error tracker with job/tenant context, but never a retryable attempt", async () => {
    const queueName = `test-job-failure-alerts-capture-${randomUUID().slice(0, 8)}`;
    queue = new Queue(queueName, { connection: redisConnection });
    const notifier = new RecordingNotifier();
    const captured: Array<{ error: unknown; context?: Record<string, unknown> }> = [];
    setErrorTracker({
      captureException: (error, context) => {
        captured.push({ error, context });
      },
    });

    worker = new Worker(queueName, () => Promise.reject(new Error("captured failure")), { connection: redisConnection });
    worker.on("failed", (job, err) => {
      void handleJobFailure(notifier, job, err);
    });
    await worker.waitUntilReady();

    await queue.add(
      "captured",
      { organizationId: "org-capture", documentId: "doc-capture", knowledgeBaseId: "kb-capture", requestId: "req-capture" },
      { attempts: 2, backoff: { type: "fixed", delay: 100 }, jobId: "capture-job-1" },
    );

    await waitFor(() => notifier.calls.length >= 1);

    // Exactly one capture — the retryable first attempt never reached
    // captureException, only the definitively final one did (mirrors the
    // notifier's own retry-vs-permanent distinction above).
    expect(captured).toHaveLength(1);
    expect(captured[0]!.error).toBeInstanceOf(Error);
    expect((captured[0]!.error as Error).message).toBe("captured failure");
    expect(captured[0]!.context).toMatchObject({
      jobId: "capture-job-1",
      jobName: "captured",
      queueName,
      organizationId: "org-capture",
      documentId: "doc-capture",
      knowledgeBaseId: "kb-capture",
      requestId: "req-capture",
    });
  }, 20_000);

  it("a notifier that throws never crashes the worker — it keeps running and can still process the next job", async () => {
    const queueName = `test-job-failure-alerts-notifier-throws-${randomUUID().slice(0, 8)}`;
    queue = new Queue(queueName, { connection: redisConnection });
    const notifier = new ThrowingNotifier();

    let secondJobProcessed = false;
    worker = new Worker(
      queueName,
      async (job) => {
        if (job.name === "will-fail") {
          throw new Error("boom");
        }
        secondJobProcessed = true;
        return { ok: true };
      },
      { connection: redisConnection },
    );

    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      worker.on("failed", (job, err) => {
        void handleJobFailure(notifier, job, err);
      });
      await worker.waitUntilReady();

      await queue.add("will-fail", {}, { attempts: 1 });
      await waitFor(() => notifier.calls >= 1);

      // The failing job's own handleJobFailure call has resolved (however
      // it internally handled the throwing notifier) — give any stray
      // unhandled rejection a moment to actually surface before checking.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(unhandledRejections).toHaveLength(0);
      expect(worker.isRunning()).toBe(true);

      await queue.add("will-succeed", {}, { attempts: 1 });
      await waitFor(() => secondJobProcessed);
      expect(secondJobProcessed).toBe(true);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  }, 20_000);
});
