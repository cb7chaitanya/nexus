import { baseLogger } from "@raas/logger";
import { captureException } from "@raas/observability";

import { buildApp } from "./app.js";
import { env } from "./env.js";
import { redis } from "./lib/redis.js";
import { initSentry } from "./lib/sentry.js";
import { gracefulShutdown } from "./lib/shutdown.js";

async function main(): Promise<void> {
  // Before anything else can fail — see lib/sentry.ts's own doc comment.
  // A crash during buildApp()/listen() itself is still caught by this
  // file's own main().catch() below; this only decides whether
  // captureException calls anywhere in that path (or afterward) reach a
  // real tracker or the default no-op one.
  initSentry();

  const app = await buildApp();

  await app.listen({ port: env.API_PORT, host: env.API_HOST });
  app.log.info({ port: env.API_PORT, host: env.API_HOST }, "api listening");

  // Idempotency guard: a second SIGTERM/SIGINT arriving while the first is
  // still draining (a human resending it, or both signals arriving close
  // together) must not kick off a second concurrent shutdown — calling
  // app.close() twice concurrently has no defined behavior worth relying
  // on. Same pattern as apps/worker/src/index.ts's own shutdown guard.
  // Also shared with the crash handlers below: an uncaughtException/
  // unhandledRejection that fires while a signal-triggered shutdown is
  // already draining just lets that shutdown finish rather than racing a
  // second one — the crash is still captured and logged either way, only
  // the exit code of that already-in-flight shutdown (0) wins in that
  // specific double-fault case.
  let shuttingDown: Promise<void> | null = null;
  const shutdown = (reason: string, exitCode = 0): void => {
    if (shuttingDown) {
      app.log.info({ reason }, "shutdown already in progress — ignoring duplicate trigger");
      return;
    }
    shuttingDown = (async () => {
      app.log.info({ reason }, "api shutting down");
      const { drainedGracefully } = await gracefulShutdown({
        app,
        redisConnection: redis,
        timeoutMs: env.API_SHUTDOWN_TIMEOUT_MS,
        log: app.log,
      });
      app.log.info({ reason, drainedGracefully }, "api shutdown complete");
      process.exit(exitCode);
    })();
  };

  // Both signals route through the exact same handler — a container
  // orchestrator's stop and a locally-run Ctrl+C should behave identically.
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Node's own default behavior for an uncaught exception/unhandled
  // rejection with no listener registered is to print it and exit(1) —
  // registering a handler here takes over that responsibility entirely,
  // so this must still end in process.exit with a non-zero code on every
  // path, including a failure inside this handler itself (the outer
  // try/catch below), or a genuine crash would otherwise leave the
  // process hanging in an undefined state instead of actually going down
  // — exactly what "do not swallow crashes" means in practice. Reuses the
  // same gracefulShutdown as a clean SIGTERM (draining in-flight
  // requests, including a hijacked chat SSE stream, within
  // API_SHUTDOWN_TIMEOUT_MS) rather than a bare process.exit — an
  // uncaught exception on one request is not a reason to sever every
  // other in-flight connection instantly.
  const onFatalError = (kind: "uncaughtException" | "unhandledRejection") => (err: unknown): void => {
    try {
      captureException(err, { source: kind });
      app.log.error({ err, source: kind }, `${kind} — shutting down`);
      shutdown(kind, 1);
    } catch (handlerErr) {
      baseLogger.error({ err: handlerErr, original: err, source: kind }, "error while handling a fatal error — forcing exit");
      process.exit(1);
    }
  };
  process.on("uncaughtException", onFatalError("uncaughtException"));
  process.on("unhandledRejection", onFatalError("unhandledRejection"));
}

main().catch((err: unknown) => {
  captureException(err, { source: "startup" });
  baseLogger.error({ err }, "api failed to start");
  process.exit(1);
});
