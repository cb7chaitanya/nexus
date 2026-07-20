import { baseLogger } from "@raas/logger";

import { buildApp } from "./app.js";
import { env } from "./env.js";
import { redis } from "./lib/redis.js";
import { gracefulShutdown } from "./lib/shutdown.js";

async function main(): Promise<void> {
  const app = await buildApp();

  await app.listen({ port: env.API_PORT, host: env.API_HOST });
  app.log.info({ port: env.API_PORT, host: env.API_HOST }, "api listening");

  // Idempotency guard: a second SIGTERM/SIGINT arriving while the first is
  // still draining (a human resending it, or both signals arriving close
  // together) must not kick off a second concurrent shutdown — calling
  // app.close() twice concurrently has no defined behavior worth relying
  // on. Same pattern as apps/worker/src/index.ts's own shutdown guard.
  let shuttingDown: Promise<void> | null = null;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      app.log.info({ signal }, "shutdown already in progress — ignoring duplicate signal");
      return;
    }
    shuttingDown = (async () => {
      app.log.info({ signal }, "api shutting down");
      const { drainedGracefully } = await gracefulShutdown({
        app,
        redisConnection: redis,
        timeoutMs: env.API_SHUTDOWN_TIMEOUT_MS,
        log: app.log,
      });
      app.log.info({ signal, drainedGracefully }, "api shutdown complete");
      process.exit(0);
    })();
  };

  // Both signals route through the exact same handler — a container
  // orchestrator's stop and a locally-run Ctrl+C should behave identically.
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  baseLogger.error({ err }, "api failed to start");
  process.exit(1);
});
