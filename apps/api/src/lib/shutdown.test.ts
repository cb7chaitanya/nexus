/**
 * Real Fastify instance listening on a real socket — deliberately NOT
 * app.inject() (light-my-request), which never opens a real TCP
 * connection and so can't exercise Fastify's actual "wait for open
 * sockets" close() behavior, the exact mechanism this file is testing.
 * Same "real infra, controllable seams" convention apps/worker's own
 * lib/shutdown.test.ts uses.
 *
 * A minimal standalone route reproduces exactly the shape that matters —
 * reply.hijack() plus a response that's still being written when shutdown
 * starts — not the full POST /kb/:id/chat pipeline, which has its own
 * tests elsewhere for its own business logic (auth, retrieval, citations).
 * This is what makes it a faithful reproduction of the production bug
 * (an active chat SSE stream getting SIGKILLed mid-token) without
 * dragging in org/KB/document fixtures this mechanism doesn't care about.
 *
 * Prerequisites: docker compose up -d (Redis).
 */
import Fastify, { type FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import { afterEach, describe, expect, it } from "vitest";

import { env } from "../env.js";
import { gracefulShutdown } from "./shutdown.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** ioredis's .quit() resolves once the QUIT command's reply arrives, but
 * the connection's own `status` only flips to "end" on a later tick (the
 * underlying socket's "close" event) — polling briefly avoids a flaky
 * race against that. */
async function waitForRedisEnd(redis: Redis, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (redis.status !== "end" && Date.now() - start < timeoutMs) {
    await delay(20);
  }
}

function listeningPort(app: FastifyInstance): number {
  const address = app.server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected a real TCP address after app.listen()");
  }
  return address.port;
}

describe("gracefulShutdown", () => {
  let app: FastifyInstance | undefined;
  let testRedis: Redis | undefined;

  afterEach(async () => {
    if (app) {
      await app.close().catch(() => undefined);
      app = undefined;
    }
    if (testRedis && testRedis.status !== "end") {
      await testRedis.quit().catch(() => undefined);
    }
    testRedis = undefined;
  });

  it("resolves quickly and reports drainedGracefully: true when there are no active connections", async () => {
    app = Fastify({ forceCloseConnections: false });
    app.get("/ok", async () => ({ ok: true }));
    await app.listen({ port: 0, host: "127.0.0.1" });
    testRedis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3 });

    const result = await gracefulShutdown({
      app,
      redisConnection: testRedis,
      timeoutMs: 5000,
      log: { warn: () => undefined },
    });

    expect(result.drainedGracefully).toBe(true);
    await waitForRedisEnd(testRedis);
    expect(testRedis.status).toBe("end");
  });

  it("waits for an active hijacked SSE connection to finish when it completes well within the timeout", async () => {
    app = Fastify({ forceCloseConnections: false });
    let streamEnded = false;
    app.get("/stream", (_request, reply) => {
      reply.hijack();
      // Connection: keep-alive, same as routes/chat.ts's real SSE
      // response — deliberately reproduced exactly, since it's what
      // makes the socket linger open-but-idle after the response ends
      // (rather than the client/server closing it immediately), the
      // specific case gracefulShutdown's idle-connection sweep exists for.
      reply.raw.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
      reply.raw.write("event: token\ndata: hi\n\n");
      setTimeout(() => {
        reply.raw.end();
        streamEnded = true;
      }, 150);
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = listeningPort(app);
    testRedis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3 });

    // Opens a real socket to /stream and leaves it open (never aborted by
    // the client) — this is what keeps app.close() waiting, exactly the
    // production scenario: a customer's browser still receiving an
    // in-progress chat response.
    const fetchPromise = fetch(`http://127.0.0.1:${port}/stream`).catch(() => undefined);
    await delay(30); // let the connection actually establish before racing shutdown against it

    const result = await gracefulShutdown({
      app,
      redisConnection: testRedis,
      timeoutMs: 5000,
      log: { warn: () => undefined },
    });

    expect(result.drainedGracefully).toBe(true);
    expect(streamEnded).toBe(true); // proves shutdown actually WAITED for the stream, not just claimed success
    await fetchPromise;
  }, 20_000);

  it("gives up waiting once the timeout elapses when a hijacked SSE connection stays open past it, and still closes Redis — proving an active stream cannot hang shutdown forever", async () => {
    app = Fastify({ forceCloseConnections: false });
    app.get("/stream", (_request, reply) => {
      reply.hijack();
      // Connection: keep-alive, same as routes/chat.ts's real SSE
      // response — deliberately reproduced exactly, since it's what
      // makes the socket linger open-but-idle after the response ends
      // (rather than the client/server closing it immediately), the
      // specific case gracefulShutdown's idle-connection sweep exists for.
      reply.raw.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
      reply.raw.write("event: token\ndata: hi\n\n");
      // Deliberately never ends — simulates a chat generation (or a
      // client that never disconnects) that outlives the shutdown window.
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = listeningPort(app);
    testRedis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3 });

    const controller = new AbortController();
    const fetchPromise = fetch(`http://127.0.0.1:${port}/stream`, { signal: controller.signal }).catch(() => undefined);
    await delay(30);

    const warnCalls: unknown[][] = [];
    const startedAt = Date.now();
    const result = await gracefulShutdown({
      app,
      redisConnection: testRedis,
      timeoutMs: 100,
      log: { warn: (...args) => warnCalls.push(args) },
    });
    const elapsedMs = Date.now() - startedAt;

    expect(result.drainedGracefully).toBe(false);
    expect(elapsedMs).toBeLessThan(1000); // resolved via the 100ms timeout, not by waiting for the still-open stream
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]?.[1]).toContain("timed out waiting for active connections");
    await waitForRedisEnd(testRedis);
    expect(testRedis.status).toBe("end"); // Redis is still closed even though the connection never drained

    controller.abort(); // let the still-open request settle so nothing leaks past this test
    await fetchPromise;
  }, 20_000);
});
