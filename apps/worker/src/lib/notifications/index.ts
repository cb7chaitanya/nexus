import { env } from "../../env.js";
import { NoopNotifier } from "./noop-notifier.js";
import type { Notifier } from "./types.js";
import { WebhookNotifier } from "./webhook-notifier.js";

export type { JobFailureEvent, Notifier } from "./types.js";
export { WebhookNotifier } from "./webhook-notifier.js";
export { NoopNotifier } from "./noop-notifier.js";

/**
 * The single place that decides which Notifier implementation is active
 * — "do not hardcode providers" means every call site (currently just
 * lib/job-failure-alerts.ts) depends only on the Notifier interface, and
 * this factory is the only thing that knows a concrete implementation
 * exists. Adding Slack/PagerDuty/Sentry later is a branch added here
 * (plus, if it needs its own env var, a config value read into that
 * branch, following ALERT_WEBHOOK_URL's own model below) — never a
 * change to how job-failure-alerts.ts calls notifyJobFailure.
 */
export function createNotifier(): Notifier {
  if (env.ALERT_WEBHOOK_URL) {
    return new WebhookNotifier({ url: env.ALERT_WEBHOOK_URL, timeoutMs: env.ALERT_WEBHOOK_TIMEOUT_MS });
  }
  return new NoopNotifier();
}
