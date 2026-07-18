import type { ErrorContext, ErrorTracker } from "./types.js";

/**
 * The default tracker — does nothing. Every unexpected error in this
 * codebase is already logged (request.log.error in apps/api's
 * error-handler.ts, createJobLogger in apps/worker's
 * job-failure-alerts.ts) independently of whatever ErrorTracker is
 * active, so a deployment that never configures a real one loses nothing
 * beyond the aggregation/alerting a dedicated error-tracking service adds
 * on top of logs — it does not silently swallow errors that would
 * otherwise have been surfaced.
 */
export class NoopErrorTracker implements ErrorTracker {
  captureException(_error: unknown, _context?: ErrorContext): void {
    // Intentionally does nothing.
  }
}
