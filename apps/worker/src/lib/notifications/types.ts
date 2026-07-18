/**
 * Fired exactly once per job, the moment BullMQ has definitively given up
 * on it — see lib/job-failure-alerts.ts for how "definitively" is
 * determined (job.finishedOn, not attempt-counting arithmetic of our
 * own). Never fired for an attempt that's about to be retried.
 */
export interface JobFailureEvent {
  organizationId?: string;
  documentId?: string;
  jobId: string;
  jobName: string;
  queueName: string;
  failureReason: string;
  /** BullMQ's job.attemptsMade at the point of permanent failure — total
   * attempts made, including the first one, not just the retries after
   * it. Named `retryCount` to match how this is referred to at the
   * integration boundary (the webhook payload); documented here so a
   * consumer doesn't have to guess which convention it uses. */
  retryCount: number;
  occurredAt: string;
}

/**
 * Provider-agnostic sink for operational alerts. WebhookNotifier (see
 * webhook-notifier.ts) is the only implementation today; Slack, PagerDuty,
 * and Sentry notifiers are expected future implementations of this same
 * interface, not providers baked into call sites — see index.ts's
 * createNotifier(), the single place that decides which implementation is
 * active. Every implementation MUST resolve rather than reject on its own
 * failure (network error, non-2xx response, timeout) — a broken alerting
 * channel must never be able to crash the worker process that's trying to
 * report through it. See webhook-notifier.test.ts for this being verified,
 * not just asserted in a comment.
 */
export interface Notifier {
  notifyJobFailure(event: JobFailureEvent): Promise<void>;
}
