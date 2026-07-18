import { NoopErrorTracker } from "./noop-tracker.js";
import type { ErrorContext, ErrorTracker } from "./types.js";

export type { ErrorContext, ErrorTracker } from "./types.js";
export { NoopErrorTracker } from "./noop-tracker.js";
export { SentryAdapter } from "./sentry-adapter.js";
export type { SentryLikeClient } from "./sentry-adapter.js";

// Module-level singleton, the same "one active implementation, swapped at
// startup" shape apps/worker's lib/notifications/index.ts already uses
// for Notifier — defaults to NoopErrorTracker so every call site (apps/api's
// error-handler.ts, apps/worker's job-failure-alerts.ts) works unchanged
// whether or not a deployment ever configures a real tracker.
let activeTracker: ErrorTracker = new NoopErrorTracker();

/**
 * Swaps the active error tracker — call once, at process startup, before
 * any request/job could fail. Not called anywhere in this repo today (see
 * SentryAdapter's doc comment): wiring up a real tracker is an adoption
 * decision for whoever operates this deployment, not something this
 * package or its default apps do on their own.
 */
export function setErrorTracker(tracker: ErrorTracker): void {
  activeTracker = tracker;
}

/** Test-only reset — mirrors apps/worker's resetHealthStateForTesting. */
export function resetErrorTrackerForTesting(): void {
  activeTracker = new NoopErrorTracker();
}

/**
 * The one function every app calls — never a concrete tracker directly.
 * Delegates to whatever setErrorTracker last configured (NoopErrorTracker
 * by default). Intended for genuinely unexpected/bug-class errors (an
 * unhandled 500, a permanently-failed job) — never for expected,
 * client-caused failures (a 4xx ApiError, a validation rejection), which
 * would just turn routine traffic into error-tracker noise.
 */
export function captureException(error: unknown, context?: ErrorContext): void {
  activeTracker.captureException(error, context);
}
