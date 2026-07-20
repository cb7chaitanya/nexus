/**
 * Real BullMQ Queue/Worker against real Redis — same convention as
 * job-failure-alerts.test.ts: gracefulShutdown's actual job is racing
 * Worker#close() (which really does wait for an active job) against a
 * timer, so a real Worker/real active job is what proves that race
 * behaves correctly, not a mock.
 *
 * `redisConnection` passed into gracefulShutdown is a connection dedicated
 * to each test, NOT the shared apps/worker/src/lib/redis.js singleton —
 * gracefulShutdown calls .quit() on it, and quitting the shared connection
 * would break every other test file that reuses it.
 *
 * Prerequisites: docker compose up -d.
 */
import { randomUUID } from "node:crypto";

import { createLogger } from "@raas/logger";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { afterEach, describe, expect, it } from "vitest";

import { env } from "../env.js";
import { redisConnection } from "./redis.js";
import { gracefulShutdown } from "./shutdown.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** ioredis's .quit() resolves once the QUIT command's reply arrives, but
 * the connection's own `status` only flips to "end" on a later tick (the
 * underlying socket's "close" event) — polling briefly here avoids a
 * flaky race against that, rather than asserting immediately after
 * gracefulShutdown resolves. */
async function waitForRedisEnd(redis: Redis, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (redis.status !== "end" && Date.now() - start < timeoutMs) {
    await delay(20);
  }
}

interface StubHealthServer {
  closed: boolean;
  close(cb: () => void): void;
}

function stubHealthServer(): StubHealthServer {
  return {
    closed: false,
    close(cb) {
      this.closed = true;
      cb();
    },
  };
}

describe("gracefulShutdown", () => {
  let queue: Queue | undefined;
  let worker: Worker | undefined;
  let testRedis: Redis | undefined;

  afterEach(async () => {
    if (worker) {
      await worker.close().catch(() => undefined);
      worker = undefined;
    }
    if (queue) {
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close().catch(() => undefined);
      queue = undefined;
    }
    if (testRedis && testRedis.status !== "end") {
      await testRedis.quit().catch(() => undefined);
    }
    testRedis = undefined;
  });

  it("waits for an active job to finish when it completes well within the timeout, and reports drainedGracefully: true", async () => {
    const queueName = `test-shutdown-graceful-${randomUUID().slice(0, 8)}`;
    queue = new Queue(queueName, { connection: redisConnection });
    testRedis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

    let jobCompleted = false;
    worker = new Worker(
      queueName,
      async () => {
        await delay(150);
        jobCompleted = true;
      },
      { connection: redisConnection },
    );
    await worker.waitUntilReady();
    await queue.add("slow-but-fine", {}, { attempts: 1 });
    await delay(30); // let the job actually become "active" before shutdown races it

    const health = stubHealthServer();
    const result = await gracefulShutdown({
      workers: [worker],
      queues: [queue],
      redisConnection: testRedis,
      healthServer: health,
      timeoutMs: 5000,
      log: createLogger({ service: "worker", component: "test" }),
    });

    expect(result.drainedGracefully).toBe(true);
    expect(jobCompleted).toBe(true); // proves it actually WAITED, not just claimed success
    expect(health.closed).toBe(true);
    await waitForRedisEnd(testRedis);
    expect(testRedis.status).toBe("end");
  }, 20_000);

  it("gives up waiting once the timeout elapses, reports drainedGracefully: false, and still closes the health server and Redis connection", async () => {
    const queueName = `test-shutdown-timeout-${randomUUID().slice(0, 8)}`;
    queue = new Queue(queueName, { connection: redisConnection });
    testRedis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

    let jobCompleted = false;
    worker = new Worker(
      queueName,
      async () => {
        await delay(2000); // deliberately much longer than the 100ms shutdown timeout below
        jobCompleted = true;
      },
      { connection: redisConnection },
    );
    await worker.waitUntilReady();
    await queue.add("too-slow", {}, { attempts: 1 });
    await delay(30);

    const health = stubHealthServer();
    const startedAt = Date.now();
    const result = await gracefulShutdown({
      workers: [worker],
      queues: [queue],
      redisConnection: testRedis,
      healthServer: health,
      timeoutMs: 100,
      log: createLogger({ service: "worker", component: "test" }),
    });
    const elapsedMs = Date.now() - startedAt;

    expect(result.drainedGracefully).toBe(false);
    expect(jobCompleted).toBe(false); // the 2s job hadn't finished yet when shutdown gave up
    expect(elapsedMs).toBeLessThan(1000); // resolved because of the 100ms timeout, not the 2s job
    expect(health.closed).toBe(true);
    await waitForRedisEnd(testRedis);
    expect(testRedis.status).toBe("end");
  }, 20_000);
});
