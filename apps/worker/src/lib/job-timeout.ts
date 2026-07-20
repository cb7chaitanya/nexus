import type { Job } from "bullmq";

export class JobTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Job exceeded the configured maximum duration of ${timeoutMs}ms`);
    this.name = "JobTimeoutError";
  }
}

/**
 * Wraps any BullMQ processor function with a generic wall-clock ceiling —
 * a Promise.race against a timer, not true cancellation. If `processor`
 * doesn't settle within `timeoutMs`, the returned promise rejects with
 * JobTimeoutError and BullMQ treats this attempt as failed (retried per
 * the queue's normal attempts/backoff policy, same as any other error —
 * see queue/queues.ts's DEFAULT_JOB_OPTS), freeing this worker's
 * concurrency slot for its next job. The original processor call is NOT
 * aborted — Node has no way to forcibly stop arbitrary in-flight work
 * without cooperative cancellation (an AbortSignal each internal call
 * would have to accept and wire through: the S3 download, the PDF parse,
 * the DB transaction), which would mean threading a signal through every
 * processor and every library call they make — a real architecture
 * change, not a wrapper. What this DOES give: a job that would otherwise
 * hold a slot (and whatever memory it downloaded) forever now fails
 * loudly and predictably instead, and BullMQ's own stalled-job detection
 * (lockDuration/stalledInterval) is what eventually reassigns the
 * underlying work if the original attempt is still silently running in
 * the background — the same caveat BullMQ's own docs already describe for
 * stalled jobs in general, not a new failure mode this introduces.
 *
 * Preserves BullMQ's exact Processor signature — `(job, token?, signal?)
 * => Promise<R>` — so this can wrap any of this app's processors at their
 * `new Worker(queue, processor, opts)` call site with no change to the
 * processor itself (see index.ts).
 */
export function withJobTimeout<T, R, N extends string = string>(
  processor: (job: Job<T, R, N>, token?: string, signal?: AbortSignal) => Promise<R>,
  timeoutMs: number,
): (job: Job<T, R, N>, token?: string, signal?: AbortSignal) => Promise<R> {
  return async (job, token, signal) => {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new JobTimeoutError(timeoutMs)), timeoutMs);
    });

    try {
      return await Promise.race([processor(job, token, signal), timeout]);
    } finally {
      clearTimeout(timer!);
    }
  };
}
