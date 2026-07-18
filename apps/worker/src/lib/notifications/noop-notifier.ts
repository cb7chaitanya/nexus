import type { JobFailureEvent, Notifier } from "./types.js";

/**
 * Selected by createNotifier() when no alerting channel is configured
 * (see env.ts's ALERT_WEBHOOK_URL) — lets local dev and any deployment
 * that hasn't set up alerting yet run without one, rather than forcing a
 * webhook URL to exist just to start the worker.
 */
export class NoopNotifier implements Notifier {
  async notifyJobFailure(_event: JobFailureEvent): Promise<void> {
    // Intentionally does nothing.
  }
}
