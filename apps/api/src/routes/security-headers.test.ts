/**
 * Integration tests against a real Fastify instance via app.inject() —
 * verifies the @fastify/helmet configuration in app.ts.
 */
import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../app.js";
import { env } from "../env.js";
import { redis } from "../lib/redis.js";
import { SESSION_COOKIE_NAME } from "../plugins/auth-guard.js";

async function signup(
  app: FastifyInstance,
  email: string,
  password: string,
  organizationName: string,
): Promise<{ sessionCookie: string; organizationId: string }> {
  const response = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { email, password, organizationName },
  });
  const cookie = response.cookies.find((c) => c.name === SESSION_COOKIE_NAME);
  const body = response.json();
  return { sessionCookie: cookie!.value, organizationId: body.organizations[0].id };
}

describe("security headers (@fastify/helmet)", () => {
  let app: FastifyInstance;
  const suffix = randomUUID().slice(0, 8);

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
    await redis.quit();
  });

  it("sets X-Content-Type-Options: nosniff on a plain JSON route", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("sets X-Frame-Options: DENY — this API is never legitimately framed", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.headers["x-frame-options"]).toBe("DENY");
  });

  it("sets a locked-down Content-Security-Policy appropriate for a JSON-only API", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    const csp = response.headers["content-security-policy"];
    expect(csp).toBeTruthy();
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("sets Cross-Origin-Resource-Policy: cross-origin, so apps/web's cross-origin fetch still works", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.headers["cross-origin-resource-policy"]).toBe("cross-origin");
  });

  it("does not send Strict-Transport-Security outside production (this suite runs with NODE_ENV != production)", async () => {
    expect(env.NODE_ENV).not.toBe("production");
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.headers["strict-transport-security"]).toBeUndefined();
  });

  it("applies the same headers to an authenticated JSON route", async () => {
    const owner = await signup(app, `helmet-${suffix}@example.com`, "correct-horse-battery-staple", `Helmet Org ${suffix}`);

    const response = await app.inject({
      method: "GET",
      url: "/organizations",
      cookies: { [SESSION_COOKIE_NAME]: owner.sessionCookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-frame-options"]).toBe("DENY");
  });

  it("still applies security headers to the hijacked SSE chat response", async () => {
    // chat.ts calls reply.hijack() and writes headers directly onto
    // reply.raw — helmet applies its headers in an onRequest hook (before
    // the handler runs, and therefore before hijack()), via
    // res.setHeader() on the same raw response, so they must survive
    // into the final writeHead() call the same way lib/rate-limit.ts's
    // own headers do. Verified here directly rather than assumed.
    const owner = await signup(app, `helmet-sse-${suffix}@example.com`, "correct-horse-battery-staple", `Helmet SSE Org ${suffix}`);
    const kbResponse = await app.inject({
      method: "POST",
      url: "/kb",
      cookies: { [SESSION_COOKIE_NAME]: owner.sessionCookie },
      payload: {
        organizationId: owner.organizationId,
        name: "Helmet SSE KB",
        embeddingProvider: "openai",
        embeddingModel: "text-embedding-3-small",
        embeddingDim: 1536,
      },
    });
    const kbId = kbResponse.json().id;

    const response = await app.inject({
      method: "POST",
      url: `/kb/${kbId}/chat`,
      cookies: { [SESSION_COOKIE_NAME]: owner.sessionCookie },
      payload: { organizationId: owner.organizationId, message: "does helmet survive the hijack" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-frame-options"]).toBe("DENY");
  });
});
