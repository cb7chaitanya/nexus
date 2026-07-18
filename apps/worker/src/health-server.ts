import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { Queue, Worker } from "bullmq";

import { getLastSuccessfulJobAt } from "./lib/health-state.js";
import { redisConnection } from "./lib/redis.js";

// Long enough to tolerate a slow-but-fine connection, short enough that a
// truly hung dependency doesn't leave a probe hanging past a Kubernetes
// probe's own timeout — same reasoning and shape as apps/api's own
// health.ts (this is a separate, small, deliberately-duplicated helper
// rather than a shared cross-app utility; there's nothing here specific
// enough to either app to be worth coupling them over).
const CHECK_TIMEOUT_MS = 2000;

type CheckStatus = "healthy" | "unhealthy";

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("health check timed out")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

async function checkRedis(): Promise<CheckStatus> {
  try {
    const pong = await withTimeout(redisConnection.ping(), CHECK_TIMEOUT_MS);
    return pong === "PONG" ? "healthy" : "unhealthy";
  } catch {
    return "unhealthy";
  }
}

/**
 * Distinct from checkRedis above: a raw PING proves the underlying
 * connection works, but not that BullMQ itself is functioning correctly
 * over it (Lua-script incompatibilities, ACL restrictions on specific
 * commands, etc. wouldn't show up in a bare ping) — and even a perfectly
 * healthy connection is useless if the consumer loop attached to it has
 * stopped. This check exercises a real BullMQ queue operation on every
 * registered queue AND confirms every registered Worker is actually
 * running, not just constructed.
 */
async function checkQueues(queues: Queue[], workers: Worker[]): Promise<CheckStatus> {
  if (queues.length === 0 || workers.length === 0) return "unhealthy";

  try {
    await withTimeout(Promise.all(queues.map((q) => q.getJobCounts())), CHECK_TIMEOUT_MS);
  } catch {
    return "unhealthy";
  }

  return workers.every((w) => w.isRunning()) ? "healthy" : "unhealthy";
}

export interface HealthServerDeps {
  queues: Queue[];
  workers: Worker[];
}

export interface HealthPayload {
  status: CheckStatus;
  uptimeSeconds: number;
  timestamp: string;
  lastSuccessfulJobAt: string | null;
  checks: {
    redis: CheckStatus;
    queues: CheckStatus;
  };
}

export async function buildHealthPayload(deps: HealthServerDeps): Promise<{ payload: HealthPayload; httpStatus: number }> {
  const [redis, queues] = await Promise.all([checkRedis(), checkQueues(deps.queues, deps.workers)]);
  const healthy = redis === "healthy" && queues === "healthy";
  const lastSuccessfulJobAt = getLastSuccessfulJobAt();

  return {
    payload: {
      status: healthy ? "healthy" : "unhealthy",
      uptimeSeconds: process.uptime(),
      timestamp: new Date().toISOString(),
      lastSuccessfulJobAt: lastSuccessfulJobAt ? lastSuccessfulJobAt.toISOString() : null,
      checks: { redis, queues },
    },
    // 503 (not 200 with a false "healthy" body) on failure, so an
    // orchestrator's HTTP-status-based readiness check works without
    // parsing the response body — mirrors apps/api's own GET /health.
    httpStatus: healthy ? 200 : 503,
  };
}

export async function handleHealthRequest(deps: HealthServerDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "GET" || req.url !== "/health") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }

  const { payload, httpStatus } = await buildHealthPayload(deps);
  res.writeHead(httpStatus, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

/**
 * No framework (no Fastify, unlike apps/api) — deliberately: this is one
 * route, on a process that's fundamentally a queue consumer, not a web
 * server. Node's own http module is the whole dependency footprint.
 */
export function startHealthServer(deps: HealthServerDeps, port: number, host: string): Server {
  const server = createServer((req, res) => {
    handleHealthRequest(deps, req, res).catch(() => {
      // handleHealthRequest's own checks already catch everything
      // meaningful (see checkRedis/checkQueues) — this only guards
      // against something going wrong in response serialization itself,
      // so the health server can never crash the worker process it's
      // reporting on.
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
      }
      res.end(JSON.stringify({ status: "unhealthy", error: "internal error" }));
    });
  });
  server.listen(port, host);
  return server;
}
