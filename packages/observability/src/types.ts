/**
 * Extra, structured facts about the request/job an error happened in —
 * requestId, organizationId, documentId, jobId, route, whatever the call
 * site already has to hand. Never put anything secret in here (see
 * @raas/logger's own REDACT_PATHS convention for the fields to avoid) —
 * this is forwarded to whatever error tracker is active, and a real
 * tracker (Sentry or otherwise) is a third-party system.
 */
export interface ErrorContext {
  [key: string]: unknown;
}

/**
 * The single abstraction every app in this repo depends on for error
 * tracking — apps/api and apps/worker call captureException (this
 * package's index.ts) and never reference a concrete error-tracking
 * vendor directly, the same "depend on the interface, not the
 * implementation" shape @raas/logger's Logger and packages/providers'
 * EmbeddingProvider already establish elsewhere in this codebase.
 */
export interface ErrorTracker {
  captureException(error: unknown, context?: ErrorContext): void;
}
