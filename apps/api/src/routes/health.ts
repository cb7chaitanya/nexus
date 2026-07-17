import { prisma } from "@raas/db";
import type { FastifyInstance } from "fastify";

import { redis } from "../lib/redis.js";

// Long enough to tolerate a slow-but-fine connection, short enough that a
// truly hung dependency doesn't leave a probe hanging past a Kubernetes
// probe's own timeout (default 1s, commonly raised to a few seconds).
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

// Deliberately swallows the real error everywhere below — a health check
// response is reachable without authentication (Kubernetes/load-balancer
// probes never send credentials), so it must never leak a connection
// string, stack trace, or driver error message. "unhealthy" is the only
// signal a caller needs.
async function checkDatabase(): Promise<CheckStatus> {
  try {
    // Plain prisma client, not withTenantTransaction — this is an
    // infrastructure check with no org context, not a tenant-scoped
    // query; SELECT 1 only proves the connection/pool itself works.
    await withTimeout(prisma.$queryRaw`SELECT 1`, CHECK_TIMEOUT_MS);
    return "healthy";
  } catch {
    return "unhealthy";
  }
}

async function checkRedis(): Promise<CheckStatus> {
  try {
    const pong = await withTimeout(redis.ping(), CHECK_TIMEOUT_MS);
    return pong === "PONG" ? "healthy" : "unhealthy";
  } catch {
    return "unhealthy";
  }
}

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  // Liveness: is this process able to handle HTTP at all — no external
  // dependency checks. A transient Postgres/Redis outage must NOT fail
  // this, or Kubernetes would restart a perfectly healthy pod instead of
  // just routing traffic away from it via the readiness check below
  // (restarting doesn't fix an external outage — it just adds churn).
  // No auth, no rate limit: probes hit this frequently and carry no
  // session.
  app.get("/health/live", async (_request, reply) => {
    reply.status(200).send({ status: "healthy" });
  });

  // Readiness: is this instance actually able to serve real requests —
  // checks the two hard dependencies almost every route touches. 503 (not
  // 200 with a false "healthy" body) on failure, so a load balancer's or
  // Kubernetes's own HTTP-status-based readiness check works without
  // parsing the response body.
  app.get("/health", async (_request, reply) => {
    const [database, redisStatus] = await Promise.all([checkDatabase(), checkRedis()]);
    const healthy = database === "healthy" && redisStatus === "healthy";

    reply.status(healthy ? 200 : 503).send({
      status: healthy ? "healthy" : "unhealthy",
      checks: { database, redis: redisStatus },
    });
  });
}
