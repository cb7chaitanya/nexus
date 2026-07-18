/**
 * Real HTTP requests (via fetch) against a real started health server,
 * backed by a real Redis connection and a real BullMQ Queue/Worker pair —
 * same "real infra, no mocking" convention as the rest of this suite.
 * "Unhealthy" is exercised by actually closing the worker (so
 * Worker.isRunning() genuinely becomes false), not by faking a check
 * result.
 *
 * Prerequisites: docker compose up -d.
 */
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

import { Queue, Worker, type Job } from "bullmq";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { type HealthPayload, startHealthServer } from "./health-server.js";
import { getLastSuccessfulJobAt, recordJobSuccess, resetHealthStateForTesting } from "./lib/health-state.js";
import { redisConnection } from "./lib/redis.js";

const TEST_QUEUE_NAME = `test-health-server-${randomUUID().slice(0, 8)}`;

async function fetchHealth(port: number): Promise<{ status: number; body: HealthPayload }> {
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  const body = (await response.json()) as HealthPayload;
  return { status: response.status, body };
}

describe("worker health server", () => {
  let queue: Queue;
  let worker: Worker;
  let server: ReturnType<typeof startHealthServer>;
  let port: number;

  beforeAll(async () => {
    queue = new Queue(TEST_QUEUE_NAME, { connection: redisConnection });
    worker = new Worker(TEST_QUEUE_NAME, async (_job: Job) => ({ ok: true }), { connection: redisConnection });
    await worker.waitUntilReady();

    server = startHealthServer({ queues: [queue], workers: [worker] }, 0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(() => {
    resetHealthStateForTesting();
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await worker.close().catch(() => undefined);
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close();
  });

  it("returns 200 with healthy status, real checks, and uptime when everything is up", async () => {
    const { status, body } = await fetchHealth(port);

    expect(status).toBe(200);
    expect(body.status).toBe("healthy");
    expect(body.checks.redis).toBe("healthy");
    expect(body.checks.queues).toBe("healthy");
    expect(typeof body.uptimeSeconds).toBe("number");
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(() => new Date(body.timestamp).toISOString()).not.toThrow();
  });

  it("reports lastSuccessfulJobAt as null until a job has actually completed, then reflects it", async () => {
    const before = await fetchHealth(port);
    expect(before.body.lastSuccessfulJobAt).toBeNull();

    const now = new Date();
    recordJobSuccess(now);

    const after = await fetchHealth(port);
    expect(after.body.lastSuccessfulJobAt).toBe(now.toISOString());
    expect(getLastSuccessfulJobAt()).toEqual(now);
  });

  it("returns 503 with unhealthy status once the worker is no longer running", async () => {
    await worker.close();

    const { status, body } = await fetchHealth(port);

    expect(status).toBe(503);
    expect(body.status).toBe("unhealthy");
    expect(body.checks.queues).toBe("unhealthy");
    // Redis itself is unaffected by the worker closing — only the queue
    // (consumer-liveness) check should flip.
    expect(body.checks.redis).toBe("healthy");
  });

  it("returns 404 for anything other than GET /health", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/not-a-real-route`);
    expect(response.status).toBe(404);
  });
});
