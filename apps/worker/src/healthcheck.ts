import { redisConnection } from "./lib/redis.js";

// The worker has no HTTP server (see docs/architecture.md) — it's a pure
// BullMQ consumer, so there's no port for an orchestrator to probe. This
// script is invoked directly by the Docker HEALTHCHECK instruction instead:
// a successful Redis PING is a reasonable proxy for "the worker process is
// alive and its connection to the queue is functional." It intentionally
// reuses the exact same redisConnection the real workers run on, not a
// fresh one, so it can't report healthy on a build that would fail to
// connect for a real job too.
redisConnection
  .ping()
  .then(() => process.exit(0))
  .catch(() => process.exit(1))
  .finally(() => redisConnection.disconnect());
