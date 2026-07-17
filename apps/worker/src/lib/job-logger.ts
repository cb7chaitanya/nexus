import { createLogger } from "@raas/logger";
import type { Logger } from "@raas/logger";

export interface JobLogContext {
  jobId?: string;
  organizationId?: string;
  documentId?: string;
}

/**
 * Per-job logger — every worker log line should be traceable back to the
 * job, org, and document that produced it (mirrors apps/api's per-request
 * logger binding in plugins/auth-guard.ts/lib/membership.ts). Uses
 * @raas/logger's existing createLogger/LogBindings mechanism directly,
 * not a new logging path — this is just the one place that shape gets
 * assembled so every processor (extraction/chunking/embedding/sweep)
 * binds the same fields the same way.
 */
export function createJobLogger(context: JobLogContext): Logger {
  return createLogger({ service: "worker", ...context });
}
