import * as Sentry from "@sentry/node";
import { SentryAdapter, setErrorTracker } from "@raas/observability";

import { env } from "../env.js";

/**
 * Wires up the real Sentry client behind @raas/observability's
 * ErrorTracker interface (see that package's SentryAdapter doc comment,
 * which documents exactly this call sequence) — call once, at process
 * startup, before anything that could fail. SENTRY_DSN is optional: unset
 * (the default for local dev and any deployment that hasn't adopted
 * Sentry) leaves captureException calls throughout apps/api going to
 * NoopErrorTracker, same as before this existed. `environment` lets
 * errors from different deployments (staging vs. production, or a
 * developer's own local run if they set the DSN) show up distinguishable
 * in Sentry rather than mixed into one bucket.
 */
export function initSentry(): void {
  if (!env.SENTRY_DSN) return;
  Sentry.init({ dsn: env.SENTRY_DSN, environment: env.NODE_ENV });
  setErrorTracker(new SentryAdapter(Sentry));
}
