import type { Redis } from "ioredis";

/** Only what gracefulShutdown actually calls — deliberately narrower than
 * @raas/logger's Logger (pino.Logger) type, which app.log's own type
 * (FastifyBaseLogger) is runtime-compatible with but not structurally
 * assignable to (see app.ts's own comment on that exact mismatch). Typing
 * this narrowly sidesteps that entirely and lets a test pass a minimal
 * fake logger with no cast. */
export interface ShutdownLogger {
  warn(obj: Record<string, unknown>, msg?: string): void;
}

export interface ApiShutdownDeps {
  /** Narrowed to what this function actually calls — Fastify's own
   * close() returns Promise<void> when called with no callback, and
   * `server` is the underlying Node http.Server Fastify always exposes —
   * so a test double doesn't need to be a real FastifyInstance. */
  app: {
    close(): Promise<void>;
    server: { closeIdleConnections?(): void };
  };
  redisConnection: Redis;
  timeoutMs: number;
  log: ShutdownLogger;
}

/** How often, during the shutdown race, to sweep for connections that
 * have gone idle (their response finished, but the socket itself is
 * still open — normal HTTP/1.1 keep-alive behavior, and exactly what
 * POST /kb/:id/chat's SSE response sends: `Connection: keep-alive`) —
 * see gracefulShutdown's own doc comment for why this polling exists at
 * all instead of a single call. Frequent enough that a connection which
 * just finished doesn't add meaningfully to total shutdown time, cheap
 * enough (one native call, no I/O) that polling it is a non-issue. */
const IDLE_CONNECTION_SWEEP_INTERVAL_MS = 250;

export interface ApiShutdownResult {
  /** True when Fastify's close() resolved on its own — every open
   * connection (including a hijacked, still-streaming SSE response; see
   * routes/chat.ts) ended before timeoutMs elapsed. False means the
   * timeout won the race — this process is exiting anyway, but at least
   * one connection was still open. */
  drainedGracefully: boolean;
}

/**
 * SIGTERM/SIGINT handler body, extracted out of index.ts so it's testable
 * without importing index.ts itself (which self-executes main(), attaches
 * real process signal handlers, and calls process.exit — none of which a
 * test can safely trigger). Same shape as apps/worker/src/lib/shutdown.ts's
 * gracefulShutdown — ported here because apps/api had the identical
 * unbounded-shutdown gap, just with Fastify connections (specifically
 * POST /kb/:id/chat's hijacked SSE response) in place of BullMQ's active
 * jobs as the thing that can legitimately still be running when a signal
 * arrives.
 *
 * With `forceCloseConnections: false` set on the Fastify instance (see
 * app.ts's own doc comment for why that's load-bearing, not a default —
 * without it, Fastify's close() destroys every open socket
 * unconditionally, active or not, killing a live chat stream instantly
 * rather than after any grace period), `app.close()` correctly waits for
 * every open connection — including an active hijacked one — to end on
 * its own. The gap that's left: a connection whose response already
 * finished but whose socket is still open under normal HTTP/1.1
 * keep-alive (which is what the chat SSE response actually sends —
 * `Connection: keep-alive`, chat.ts) is NOT "still working", but
 * `app.close()` has no way to distinguish that from a connection that's
 * genuinely still active, so it would wait for the client to eventually
 * close it — verified empirically this can take arbitrarily long (a real
 * fetch client's connection pool routinely holds a completed connection
 * open for reuse). Periodically calling the underlying Node http.Server's
 * closeIdleConnections() — a real check Node itself makes on whether a
 * connection currently has an in-flight request/response, verified
 * empirically to leave an actively-streaming connection alone — sweeps up
 * exactly those actually-finished-but-still-open connections as soon as
 * they go idle, which is what lets app.close() resolve promptly once
 * every REAL response is done, rather than only via the timeout below.
 *
 * The timeoutMs race is still the actual ceiling, for a connection that's
 * still genuinely active when it fires (a slow generation, or a client
 * that never disconnects): this makes SIGTERM always result in this
 * process actually exiting within a known window, instead of potentially
 * hanging until Docker's own (typically shorter, and out of this
 * process's control — see docker-compose.prod.yml, which sets no
 * stop_grace_period and so gets Docker's 10s default) SIGKILL, which
 * would truncate a live chat stream mid-token with no warning and no
 * chance to log anything first.
 *
 * If the timeout wins the race, the in-flight `app.close()` promise is
 * simply abandoned, not cancelled — there is no Fastify/Node API to force
 * an already-in-progress close to stop waiting for open sockets. That's
 * fine here: this function proceeds to close the Redis connection and
 * returns either way, and the caller (index.ts) calls process.exit()
 * right after, which tears the process down — and anything still in
 * flight inside it, including that abandoned close() and whatever
 * connection it was waiting on — regardless of any promise still pending.
 */
export async function gracefulShutdown(deps: ApiShutdownDeps): Promise<ApiShutdownResult> {
  const { app, redisConnection, timeoutMs, log } = deps;

  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });

  const idleSweep = setInterval(() => app.server.closeIdleConnections?.(), IDLE_CONNECTION_SWEEP_INTERVAL_MS);

  const drainedGracefully = await Promise.race([app.close().then(() => true as const), timeout]);
  clearTimeout(timer!);
  clearInterval(idleSweep);

  if (!drainedGracefully) {
    log.warn(
      { timeoutMs },
      "graceful shutdown timed out waiting for active connections (e.g. an in-progress chat stream) to finish — proceeding to exit anyway",
    );
  }

  // Best-effort regardless of drain outcome — the process is terminating
  // either way, and a failure closing the Redis connection should never
  // prevent shutdown from completing.
  await redisConnection.quit().catch((err: unknown) => {
    log.warn({ err }, "error closing redis connection during shutdown");
  });

  return { drainedGracefully };
}
