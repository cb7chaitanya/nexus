import pino, { type Logger } from "pino";

import type { LogBindings } from "./types.js";

export type { LogBindings } from "./types.js";
export type { Logger } from "pino";

const level = process.env.LOG_LEVEL ?? "info";
const isProduction = process.env.NODE_ENV === "production";

/**
 * Base process-wide logger. Prefer `createLogger()` for anything that has
 * request/tenant/user context to attach — this instance should only be
 * used for logging that happens outside of that context (process
 * startup/shutdown, top-level crash handlers).
 */
export const baseLogger: Logger = pino({
  level,
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
