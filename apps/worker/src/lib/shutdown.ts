import type { Logger } from "@raas/logger";
import type { Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";

export interface ShutdownDeps {
  workers: Worker[];
  queues: Queue[];
  redisConnection: Redis;
  /** Node's http.Server — typed narrowly to what this function actually
   * calls, so a test double doesn't need to be a real Server instance. */
  healthServer: { close(callback: () => void): unknown };
  timeoutMs: number;
  log: Logger;
}

export interface ShutdownResult {
  /** True when every worker's active job(s) finished on their own before
   * timeoutMs elapsed. False means the timeout won the race — this
   * process is exiting anyway, but at least one job was still running. */
  drainedGracefully: boolean;
}

/**
 * SIGTERM/SIGINT handler body, extracted out of index.ts so it's testable
 * without importing index.ts itself (which self-executes main(), attaches
 * real process signal handlers, and calls process.exit — none of which a
 * test can safely trigger).
 *
 * `Worker#close()` (force=false, BullMQ's default) already does the right
 * thing for a graceful drain: it waits for whatever job(s) that worker is
 * currently processing to finish before releasing its Redis connections.
 * The only thing missing from calling that directly is a ceiling — this
 * races it against timeoutMs so SIGTERM always results in this process
 * actually exiting within a known window, rather than potentially hanging
 * until an orchestrator's own (typically longer, and out of this
 * process's control) SIGKILL grace period.
 *
 * If the timeout wins the race, the in-flight `Worker#close()` promises
 * are simply abandoned, not cancelled — there is no BullMQ API to force
 * an already-in-progress graceful close to stop waiting (calling
 * `close(true)` on a worker that already has a close in flight returns
 * the SAME pending promise, per BullMQ's own close() implementation; it
 * does not switch it to a forced close). That's fine here: this function
 * proceeds to close queues/Redis and returns either way, and the caller
 * (index.ts) calls process.exit() right after, which tears down the
 * process — and anything still in flight inside it — regardless of any
 * promise still pending.
 */
export async function gracefulShutdown(deps: ShutdownDeps): Promise<ShutdownResult> {
  const { workers, queues, redisConnection, healthServer, timeoutMs, log } = deps;

  await new Promise<void>((resolve) => healthServer.close(() => resolve()));

  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });

  const drainedGracefully = await Promise.race([
    Promise.all(workers.map((w) => w.close())).then(() => true as const),
    timeout,
  ]);
  clearTimeout(timer!);

  if (!drainedGracefully) {
    log.warn(
      { timeoutMs },
      "graceful shutdown timed out waiting for active jobs to finish — proceeding to exit anyway; the orchestrator's own restart/health-check cycle will pick up any job left running",
    );
  }

  // Best-effort regardless of drain outcome — the process is terminating
  // either way, and a failure closing a queue/the Redis connection should
  // never prevent shutdown from completing.
  await Promise.all(queues.map((q) => q.close())).catch((err: unknown) => {
    log.warn({ err }, "error closing queues during shutdown");
  });
  await redisConnection.quit().catch((err: unknown) => {
    log.warn({ err }, "error closing redis connection during shutdown");
  });

  return { drainedGracefully };
}
