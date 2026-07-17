/**
 * Integration tests against a real Fastify instance via app.inject() —
 * verifies the CORS policy documented in docs/cors-csrf-policy.md.
 */
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../app.js";
import { env } from "../env.js";
import { redis } from "../lib/redis.js";

describe("CORS policy", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
    await redis.quit();
  });

  it("returns Access-Control-Allow-* headers for a preflight request from the configured origin", async () => {
    const response = await app.inject({
      method: "OPTIONS",
      url: "/kb",
      headers: {
        origin: env.WEB_ORIGIN,
        "access-control-request-method": "GET",
      },
    });

    expect(response.headers["access-control-allow-origin"]).toBe(env.WEB_ORIGIN);
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("never reflects an arbitrary request origin — the header always names exactly the configured origin", async () => {
    // @fastify/cors with a static single-origin config always declares
    // that one fixed value, for any request — it does not conditionally
    // omit/include the header based on the incoming Origin. The actual
    // security property is what this test checks: the header is never
    // the ATTACKER's origin, so a browser evaluating it against
    // evil.example.com's own page origin refuses to expose the response.
    const response = await app.inject({
      method: "OPTIONS",
      url: "/kb",
      headers: {
        origin: "http://evil.example.com",
        "access-control-request-method": "GET",
      },
    });

    expect(response.headers["access-control-allow-origin"]).toBe(env.WEB_ORIGIN);
    expect(response.headers["access-control-allow-origin"]).not.toBe("http://evil.example.com");
  });

  it("includes the CORS header on a normal (non-preflight) request too", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/kb?organizationId=00000000-0000-0000-0000-000000000000",
      headers: { origin: env.WEB_ORIGIN },
    });

    // No session cookie -> 401, but CORS runs as an onRequest-level hook
    // before the route handler, so the header is present regardless of
    // the auth outcome.
    expect(response.statusCode).toBe(401);
    expect(response.headers["access-control-allow-origin"]).toBe(env.WEB_ORIGIN);
  });

  it("never reflects an unlisted origin on a normal request either", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/kb?organizationId=00000000-0000-0000-0000-000000000000",
      headers: { origin: "http://evil.example.com" },
    });

    expect(response.headers["access-control-allow-origin"]).not.toBe("http://evil.example.com");
  });
});
