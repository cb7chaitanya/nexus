import { createLogger } from "@raas/logger";

import { env } from "../../env.js";
import { NoopNotifier } from "./noop-notifier.js";
import type { Notifier } from "./types.js";
import { WebhookNotifier } from "./webhook-notifier.js";

export type { JobFailureEvent, Notifier } from "./types.js";
export { WebhookNotifier } from "./webhook-notifier.js";
export { NoopNotifier } from "./noop-notifier.js";

const logger = createLogger({ service: "worker" });

/**
 * The single place that decides which Notifier implementation is active
 * — "do not hardcode providers" means every call site (currently just
 * lib/job-failure-alerts.ts) depends only on the Notifier interface, and
 * this factory is the only thing that knows a concrete implementation
 * exists. Adding Slack/PagerDuty/Sentry later is a branch added here
 * (plus, if it needs its own env var, a config value read into that
 * branch, following ALERT_WEBHOOK_URL's own model below) — never a
 * change to how job-failure-alerts.ts calls notifyJobFailure.
 *
 * Falling back to NoopNotifier is a legitimate, supported configuration
 * (e.g. local dev), never a startup failure — but a production deploy
 * that forgot to set ALERT_WEBHOOK_URL would otherwise fail silently:
 * every permanently-failed job would still only ever produce a log line,
 * with nothing to distinguish "alerting is intentionally off" from "it
 * was supposed to be on and someone forgot". A single loud warning at
 * startup (not repeated per-failure — job-failure-alerts.ts already logs
 * every failure regardless of notifier) makes that gap visible without
 * blocking the worker from starting.
 */
export function createNotifier(): Notifier {
  if (env.ALERT_WEBHOOK_URL) {
    return new WebhookNotifier({ url: env.ALERT_WEBHOOK_URL, timeoutMs: env.ALERT_WEBHOOK_TIMEOUT_MS });
  }
  logger.warn(
    "ALERT_WEBHOOK_URL is not set — permanently-failed jobs will only be logged, no external notification will be sent. Set ALERT_WEBHOOK_URL to enable alerting.",
  );
  return new NoopNotifier();
}
