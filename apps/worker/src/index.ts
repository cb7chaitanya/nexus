import { createLogger } from "@raas/logger";
import { Redis } from "ioredis";

// Foundation layer only: proves Redis connectivity and keeps the process
// alive. No BullMQ queues/processors are wired up here on purpose — see
// docs/implementation-plan.md ("Do NOT add: business logic"). The
// ingestion pipeline (extract/chunk/embed) is a later ticket (RAAS-19+).

const logger = createLogger({ service: "worker" });

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";

async function main(): Promise<void> {
  const redis = new Redis(redisUrl, {
    // Fail fast on boot if Redis is unreachable, rather than retrying
    // silently forever with no signal that anything is wrong.
    maxRetriesPerRequest: 3,
  });

  redis.on("error", (err: Error) => {
    logger.error({ err }, "redis connection error");
  });

  const pong = await redis.ping();
  logger.info({ redisUrl, pong }, "worker connected to redis");

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "worker shutting down");
    await redis.quit();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // The open Redis connection keeps the event loop alive; this heartbeat
  // just gives visible proof of life in dev logs.
  setInterval(() => {
    logger.debug("worker heartbeat");
  }, 30_000);
}

main().catch((err: unknown) => {
  logger.error({ err }, "worker failed to start");
  process.exit(1);
});
