import { Redis } from "ioredis";

import { env } from "../env.js";

// Shared by every BullMQ Queue/Worker/FlowProducer in this process — BullMQ
// explicitly supports reusing one ioredis connection across all of them
// (fewer connections than one-per-queue) as long as maxRetriesPerRequest is
// null, which BullMQ requires for its own blocking commands to behave
// correctly; setting anything else here causes BullMQ to throw at
// construction time.
export const redisConnection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

redisConnection.on("error", () => {
  // BullMQ already logs connection errors per-instance; this listener only
  // exists to stop ioredis's default behavior of throwing an unhandled
  // "error" event when nothing else is listening.
});
