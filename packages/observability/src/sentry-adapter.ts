import type { ErrorContext, ErrorTracker } from "./types.js";

/**
 * The minimal shape of Sentry's own Node SDK this adapter needs —
 * structurally typed, not imported from `@sentry/node`. `@sentry/node`'s
 * real `captureException(exception, captureContext)` satisfies this
 * interface as-is (its `captureContext` type is a superset of what's
 * used here), so passing the real `Sentry` module import in from a
 * consuming app works with no shim required. Nothing in this package
 * imports or depends on `@sentry/node` itself — see this package's
 * package.json, which has zero runtime dependencies — so a deployment
 * that never installs the real SDK never pays for it, and this package
 * never forces the choice.
 */
export interface SentryLikeClient {
  captureException(exception: unknown, captureContext?: { extra?: Record<string, unknown>; tags?: Record<string, string> }): unknown;
}

/**
 * Wraps any SentryLikeClient (the real `@sentry/node` module, a
 * self-rolled shim, or a test double) behind this package's ErrorTracker
 * interface. Usage (deliberately not wired up by this package or any app
 * in this repo yet — see docs/OBSERVABILITY.md for the adoption steps):
 *
 *   import * as Sentry from "@sentry/node";
 *   import { setErrorTracker, SentryAdapter } from "@raas/observability";
 *
 *   Sentry.init({ dsn: process.env.SENTRY_DSN });
 *   setErrorTracker(new SentryAdapter(Sentry));
 *
 * `@sentry/node` only becomes a real dependency once a consuming app
 * chooses to add it — this package itself never requires it.
 */
export class SentryAdapter implements ErrorTracker {
  constructor(private readonly client: SentryLikeClient) {}

  captureException(error: unknown, context?: ErrorContext): void {
    this.client.captureException(error, context ? { extra: context } : undefined);
  }
}
