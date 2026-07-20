/**
 * Real BullMQ Worker against real Redis, proving the concurrency value
 * this codebase now reads from env.ts (WORKER_EXTRACTION_CONCURRENCY etc.
 * — see index.ts) actually bounds how many jobs run at once. This is the
 * other half of the memory-safety story alongside
 * WORKER_MAX_DOCUMENT_BYTES (extract-text.test.ts): worst-case concurrent
 * memory is concurrency x per-document cap, so this confirms the
 * concurrency side of that formula is a real ceiling, not just a
 * configured number nothing enforces.
 *
 * Prerequisites: docker compose up -d.
 */
import { randomUUID } from "node:crypto";

import { Queue, Worker } from "bullmq";
import { afterEach, describe, expect, it } from "vitest";

import { redisConnection } from "./redis.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Worker concurrency", () => {
  let queue: Queue | undefined;
  let worker: Worker | undefined;

  afterEach(async () => {
    if (worker) {
      await worker.close();
      worker = undefined;
    }
    if (queue) {
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close();
      queue = undefined;
    }
  });

  it("never runs more jobs simultaneously than the configured concurrency, even with more jobs queued than that", async () => {
    const queueName = `test-worker-concurrency-${randomUUID().slice(0, 8)}`;
    const concurrency = 2;
    const jobCount = 6;

    let active = 0;
    let maxObservedActive = 0;
    let completed = 0;

    queue = new Queue(queueName, { connection: redisConnection });
    worker = new Worker(
      queueName,
      async () => {
        active++;
        maxObservedActive = Math.max(maxObservedActive, active);
        await delay(100);
        active--;
        completed++;
      },
      { connection: redisConnection, concurrency },
    );
    await worker.waitUntilReady();

    await Promise.all(Array.from({ length: jobCount }, (_, i) => queue!.add(`job-${i}`, {}, { attempts: 1 })));

    const start = Date.now();
    while (completed < jobCount && Date.now() - start < 15_000) {
      await delay(50);
    }

    expect(completed).toBe(jobCount);
    expect(maxObservedActive).toBeLessThanOrEqual(concurrency);
    // Not a fluke of scheduling — with 6 jobs each taking ~100ms and a
    // concurrency of 2, at least one job genuinely had to wait for a slot
    // (proving the limit was load-bearing, not just never exercised).
    expect(maxObservedActive).toBe(concurrency);
  }, 20_000);

  it("keeps a lower concurrency worker capped independently of a higher concurrency worker sharing the same Redis connection", async () => {
    const lowQueueName = `test-worker-concurrency-low-${randomUUID().slice(0, 8)}`;
    const highQueueName = `test-worker-concurrency-high-${randomUUID().slice(0, 8)}`;

    let lowMaxActive = 0;
    let lowActive = 0;
    let highMaxActive = 0;
    let highActive = 0;

    const lowQueue = new Queue(lowQueueName, { connection: redisConnection });
    const highQueue = new Queue(highQueueName, { connection: redisConnection });
    const lowWorker = new Worker(
      lowQueueName,
      async () => {
        lowActive++;
        lowMaxActive = Math.max(lowMaxActive, lowActive);
        await delay(100);
        lowActive--;
      },
      { connection: redisConnection, concurrency: 1 },
    );
    const highWorker = new Worker(
      highQueueName,
      async () => {
        highActive++;
        highMaxActive = Math.max(highMaxActive, highActive);
        await delay(100);
        highActive--;
      },
      { connection: redisConnection, concurrency: 4 },
    );

    try {
      await Promise.all([lowWorker.waitUntilReady(), highWorker.waitUntilReady()]);
      await Promise.all([
        ...Array.from({ length: 4 }, (_, i) => lowQueue.add(`low-${i}`, {}, { attempts: 1 })),
        ...Array.from({ length: 4 }, (_, i) => highQueue.add(`high-${i}`, {}, { attempts: 1 })),
      ]);

      await delay(150); // let both workers pick up as much as they're going to for this window

      // Each Worker's concurrency is scoped to itself — the same isolation
      // index.ts relies on when it gives sweep/kb-cleanup a low concurrency
      // and processing/extraction a higher one, all sharing one Redis
      // connection.
      expect(lowMaxActive).toBe(1);
      expect(highMaxActive).toBeGreaterThan(lowMaxActive);
    } finally {
      await Promise.all([lowWorker.close(), highWorker.close()]);
      await lowQueue.obliterate({ force: true }).catch(() => undefined);
      await highQueue.obliterate({ force: true }).catch(() => undefined);
      await Promise.all([lowQueue.close(), highQueue.close()]);
    }
  }, 20_000);
});
