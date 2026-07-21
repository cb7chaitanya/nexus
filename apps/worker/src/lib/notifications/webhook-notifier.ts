import { createLogger } from "@raas/logger";

import type { JobFailureEvent, Notifier } from "./types.js";

export interface WebhookNotifierOptions {
  url: string;
  /** Defaults to 5000ms (see env.ts's ALERT_WEBHOOK_TIMEOUT_MS) — long
   * enough for a normal webhook receiver, short enough that a hung
   * receiver can't back up job-failure handling behind it indefinitely. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Default Notifier implementation (see types.ts): POSTs a JobFailureEvent
 * as JSON to a configured URL. Deliberately generic — no Slack/PagerDuty/
 * Sentry-specific payload shaping here; a receiver on the other end (e.g.
 * a small relay function) is expected to translate this generic event
 * into whichever provider-specific format it needs. That's what keeps
 * this notifier itself provider-agnostic rather than one of several
 * hardcoded options.
 *
 * Every failure mode — network error, DNS failure, non-2xx response,
 * timeout — is caught and logged here, never rethrown. This is not a
 * best-effort nicety: a webhook receiver being down must never be able to
 * take the worker process down with it, since notifyJobFailure runs
 * inline in the same "job permanently failed" handler that every queue's
 * Worker shares (see index.ts) — an uncaught rejection there would surface
 * as an unhandled rejection on the whole process, not just a lost alert.
 */
export class WebhookNotifier implements Notifier {
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly log = createLogger({ service: "worker", component: "webhook-notifier" });

  constructor(options: WebhookNotifierOptions) {
    this.url = options.url;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async notifyJobFailure(event: JobFailureEvent): Promise<void> {
    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // `content` is additive, purely for chat-style receivers that
        // require a top-level message field to accept the payload at
        // all (verified against a real Discord incoming webhook: the
        // structured fields alone get rejected with "Cannot send an
        // empty message" since Discord looks for content/embeds/file
        // specifically) — every existing field is unchanged, so a
        // receiver that only reads the structured shape (the documented
        // "small relay function" case) is unaffected.
        body: JSON.stringify({
          event: "job.failed",
          content: `Job ${event.jobName} (${event.jobId}) in queue ${event.queueName} permanently failed after ${event.retryCount} attempt(s): ${event.failureReason}`,
          ...event,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        this.log.error(
          { jobId: event.jobId, organizationId: event.organizationId, status: response.status },
          "webhook notifier: receiver returned a non-2xx response",
        );
      }
    } catch (err) {
      // Network error, DNS failure, or AbortSignal.timeout firing — all
      // land here. Logged, not rethrown; see the class doc comment.
      this.log.error({ err, jobId: event.jobId, organizationId: event.organizationId }, "webhook notifier: failed to deliver job-failure event");
    }
  }
}
