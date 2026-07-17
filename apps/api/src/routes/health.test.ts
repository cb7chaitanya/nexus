/**
 * Integration tests against a real Fastify instance via app.inject() —
 * real Postgres + Redis for the "healthy" cases (Kubernetes/LB probes hit
 * these constantly; correctness against the real dependencies matters
 * more than a mock would prove). Prerequisites: docker compose up -d.
 */
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../app.js";
import { redis } from "../lib/redis.js";

describe("health endpoints", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
    await redis.quit();
  });

  describe("GET /health/live", () => {
    it("returns 200 with a minimal healthy body, no auth required", async () => {
      const response = await app.inject({ method: "GET", url: "/health/live" });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: "healthy" });
    });
  });

  describe("GET /health", () => {
    it("returns 200 with both dependencies healthy against the real stack, no auth required", async () => {
      const response = await app.inject({ method: "GET", url: "/health" });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        status: "healthy",
        checks: { database: "healthy", redis: "healthy" },
      });
    });

    it("never exposes connection details in the response body", async () => {
      const response = await app.inject({ method: "GET", url: "/health" });
      const body = JSON.stringify(response.json());

      expect(body).not.toMatch(/postgres|redis:\/\/|password|secret/i);
    });

    it("reports redis: unhealthy and returns 503 when Redis is actually unreachable", async () => {
      // Real Redis, genuinely disconnected — not a mock of redis.ping().
      // health.ts's checkRedis() calls .ping() on this exact same shared
      // client (lib/redis.js), so disconnecting it here reproduces the
      // real failure path the route's error handling has to cope with.
      // Reconnected immediately after so the rest of this suite (and
      // afterAll's redis.quit()) still has a live connection.
      redis.disconnect();
      try {
        const response = await app.inject({ method: "GET", url: "/health" });

        expect(response.statusCode).toBe(503);
        expect(response.json()).toEqual({
          status: "unhealthy",
          checks: { database: "healthy", redis: "unhealthy" },
        });
      } finally {
        // connect() resolves once the connection is actually re-established.
        await redis.connect();
      }
    });

    it("recovers to 200/healthy once Redis reconnects", async () => {
      const response = await app.inject({ method: "GET", url: "/health" });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        status: "healthy",
        checks: { database: "healthy", redis: "healthy" },
      });
    });
  });
});
