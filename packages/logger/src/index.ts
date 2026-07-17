import pino, { type Logger } from "pino";

import type { LogBindings } from "./types.js";

export type { LogBindings } from "./types.js";
export type { Logger } from "pino";

const level = process.env.LOG_LEVEL ?? "info";
const isProduction = process.env.NODE_ENV === "production";

// Defense in depth, not the only safeguard — every call site in this
// codebase is expected to never pass a password/token/API key/document
// content into a log call in the first place (LogBindings only ever
// carries requestId/organizationId/userId/job identifiers, never request
// bodies or file content wholesale). These paths exist so a future call
// site that DOES accidentally include one of these fields (e.g. logging
// `request.body` or an object that happens to carry a `password`/`token`
// property) gets it scrubbed rather than written to the log stream.
// Wildcard (`*.password`) covers one level of nesting; pino's redact
// censors the value in place rather than dropping the field, so log
// shape/structure is unaffected.
// Exported so tests can build an equivalent pino instance against a
// captured stream to verify redaction actually happens, without pino's
// worker-thread `transport` (fixed at construction, not redirectable)
// getting in the way — see index.test.ts.
export const REDACT_PATHS = [
  "password",
  "*.password",
  "token",
  "*.token",
  "apiKey",
  "*.apiKey",
  "req.headers.authorization",
  "req.headers.cookie",
];

/**
 * Base process-wide logger. Prefer `createLogger()` for anything that has
 * request/tenant/user context to attach — this instance should only be
 * used for logging that happens outside of that context (process
 * startup/shutdown, top-level crash handlers).
 */
export const baseLogger: Logger = pino({
  level,
  redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
  transport: isProduction
    ? undefined
    : {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "HH:MM:ss.l",
          ignore: "pid,hostname",
        },
      },
});

/**
 * Creates a child logger bound with request/tenant/user context so every
 * log line it produces carries that context automatically, without every
 * call site having to repeat it.
 */
export function createLogger(bindings: LogBindings = {}): Logger {
  return baseLogger.child(bindings);
}
