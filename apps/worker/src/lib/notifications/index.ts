import { createLogger, type Logger } from "@raas/logger";

import { env } from "../../env.js";
import { NoopNotifier } from "./noop-notifier.js";
import type { Notifier } from "./types.js";
import { WebhookNotifier } from "./webhook-notifier.js";

export type { JobFailureEvent, Notifier } from "./types.js";
export { WebhookNotifier } from "./webhook-notifier.js";
export { NoopNotifier } from "./noop-notifier.js";

const logger = createLogger({ service: "worker" });

export interface CreateNotifierConfig {
  alertWebhookUrl?: string;
  alertWebhookTimeoutMs?: number;
}

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
 *
 * `config`/`log` default to the real env/logger — the production call
 * site (index.ts) calls this with no arguments, same as before. Both are
 * accepted as parameters (same injectable-config shape as
 * sweepStuckDocuments's options or processEmbedChunksJob's deps
 * elsewhere in this app) so a test can exercise "webhook configured" vs.
 * "not configured" directly, without process.env/module-reset gymnastics.
 */
export function createNotifier(
  config: CreateNotifierConfig = { alertWebhookUrl: env.ALERT_WEBHOOK_URL, alertWebhookTimeoutMs: env.ALERT_WEBHOOK_TIMEOUT_MS },
  log: Logger = logger,
): Notifier {
  if (config.alertWebhookUrl) {
    return new WebhookNotifier({ url: config.alertWebhookUrl, timeoutMs: config.alertWebhookTimeoutMs });
  }
  log.warn(
    "ALERT_WEBHOOK_URL is not set — permanently-failed jobs will only be logged, no external notification will be sent. Set ALERT_WEBHOOK_URL to enable alerting.",
  );
  return new NoopNotifier();
}
