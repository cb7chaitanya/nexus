import * as Sentry from "@sentry/node";
import { SentryAdapter, setErrorTracker } from "@raas/observability";

import { env } from "../env.js";

/**
 * Same wiring as apps/api/src/lib/sentry.ts's own copy of this function —
 * see that file's doc comment. Duplicated rather than shared because
 * apps/api and apps/worker each read their own env.ts (SENTRY_DSN,
 * NODE_ENV), the same reason lib/shutdown.ts is a per-app file rather
 * than a shared one.
 */
export function initSentry(): void {
  if (!env.SENTRY_DSN) return;
  Sentry.init({ dsn: env.SENTRY_DSN, environment: env.NODE_ENV });
  setErrorTracker(new SentryAdapter(Sentry));
}
