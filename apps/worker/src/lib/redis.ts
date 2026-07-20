import { createLogger } from "@raas/logger";
import { Redis } from "ioredis";

import { env } from "../env.js";

const logger = createLogger({ service: "worker", component: "redis" });

// Shared by every BullMQ Queue/Worker/FlowProducer in this process — BullMQ
// explicitly supports reusing one ioredis connection across all of them
// (fewer connections than one-per-queue) as long as maxRetriesPerRequest is
// null, which BullMQ requires for its own blocking commands to behave
// correctly; setting anything else here causes BullMQ to throw at
// construction time.
export const redisConnection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

redisConnection.on("error", (err) => {
  // ioredis retries connecting on its own (default backoff strategy) —
  // this is not fatal and must never throw, which is why this listener
  // exists at all (an unhandled "error" event with no listener crashes
  // the process). Logging it (rather than swallowing silently) is what
  // makes a sustained Redis outage visible in this process's own logs
  // instead of only inferable from BullMQ's per-instance error events or
  // GET /health turning unhealthy.
  logger.warn({ err }, "redis connection error — ioredis will retry automatically");
});
