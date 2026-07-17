import { createRateLimiter } from "@raas/rate-limit";

import { redisConnection } from "./redis.js";

// Reuses the same connection BullMQ's own Queue/Worker/FlowProducer share
// (see redis.ts) rather than opening a second Redis connection just for
// this — createRateLimiter's own doc comment says it's fine with any
// ioredis-compatible client, and its GET/INCR/EXPIRE calls are ordinary
// (non-blocking) commands, so sharing the connection BullMQ needs
// maxRetriesPerRequest: null for doesn't change this package's behavior.
export const rateLimiter = createRateLimiter(redisConnection);
