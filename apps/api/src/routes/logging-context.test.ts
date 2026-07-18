/**
 * Integration tests against a real Fastify instance via app.inject() —
 * verifies requestId/userId/organizationId/method/route get bound onto
 * request.log (see plugins/auth-guard.ts, lib/membership.ts, and
 * plugins/metrics.ts for method/route), not just that the routes behave
 * correctly.
 *
 * request.log.bindings() (a real pino API — the merged bindings from
 * every .child() call in this logger's lineage) is inspected directly
 * rather than parsing captured stdout: it's deterministic, doesn't
 * depend on the pino-pretty transport this app uses outside production,
 * and is exactly the mechanism a call site relies on when it logs
 * anything mid-request.
 */
import { randomUUID } from "node:crypto";

import type { Logger } from "@raas/logger";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../app.js";
import { redis } from "../lib/redis.js";
import { SESSION_COOKIE_NAME } from "../plugins/auth-guard.js";

interface CapturedBindings {
  url: string;
  bindings: Record<string, unknown>;
}

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

describe("request logging context", () => {
  let app: FastifyInstance;
  const suffix = randomUUID().slice(0, 8);
  const captured: CapturedBindings[] = [];

  beforeAll(async () => {
    app = await buildApp();
    // Observes the FINAL state of request.log for each request — after
    // requireAuth/requireMembership/requireOrgMembership have had a
    // chance to bind userId/organizationId, and after the handler itself
    // has run. Test-side only: production code never does this.
    app.addHook("onResponse", (request, _reply, done) => {
      // request.log is typed as Fastify's own FastifyBaseLogger, which
      // deliberately exposes a narrower surface (no .bindings()) than the
      // real pino instance underneath it — app.ts casts the other
      // direction (Logger -> FastifyBaseLogger) for the same reason when
      // constructing it. .bindings() is a real pino API and genuinely
      // exists on this object at runtime.
      const bindings = (request.log as unknown as Logger).bindings();
      captured.push({ url: request.url, bindings });
      done();
    });
  });

  afterAll(async () => {
    await app.close();
    await redis.quit();
  });

  it("binds requestId, userId, organizationId, method, and route on an authenticated, org-scoped request", async () => {
    const owner = await signup(app, `logctx-${suffix}@example.com`, "correct-horse-battery-staple", `Log Ctx Org ${suffix}`);
    captured.length = 0;

    const response = await app.inject({
      method: "POST",
      url: "/kb",
      cookies: { [SESSION_COOKIE_NAME]: owner.sessionCookie },
      payload: {
        organizationId: owner.organizationId,
        name: "Logging Context KB",
        embeddingProvider: "openai",
        embeddingModel: "text-embedding-3-small",
        embeddingDim: 1536,
      },
    });
    expect(response.statusCode).toBe(201);

    const entry = captured.find((c) => c.url === "/kb");
    expect(entry).toBeDefined();
    expect(entry!.bindings).toMatchObject({
      service: "api",
      requestId: expect.any(String),
      userId: expect.any(String),
      organizationId: owner.organizationId,
      method: "POST",
      route: "/kb",
    });
  });

  it("binds requestId, method, and route, and userId, but no organizationId, on an authenticated request with no org context (GET /organizations)", async () => {
    const owner = await signup(app, `logctx-noorg-${suffix}@example.com`, "correct-horse-battery-staple", `Log Ctx No Org ${suffix}`);
    captured.length = 0;

    const response = await app.inject({
      method: "GET",
      url: "/organizations",
      cookies: { [SESSION_COOKIE_NAME]: owner.sessionCookie },
    });
    expect(response.statusCode).toBe(200);

    const entry = captured.find((c) => c.url === "/organizations");
    expect(entry).toBeDefined();
    expect(entry!.bindings).toMatchObject({
      service: "api",
      requestId: expect.any(String),
      userId: expect.any(String),
      method: "GET",
      route: "/organizations",
    });
    expect(entry!.bindings.organizationId).toBeUndefined();
  });

  it("binds requestId, method, and route (but no userId, no organizationId) on an anonymous auth route", async () => {
    captured.length = 0;

    const response = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { email: `logctx-anon-${suffix}@example.com`, password: "correct-horse-battery-staple", organizationName: "Anon Org" },
    });
    expect(response.statusCode).toBe(201);

    const entry = captured.find((c) => c.url === "/auth/signup");
    expect(entry).toBeDefined();
    expect(entry!.bindings).toMatchObject({ service: "api", requestId: expect.any(String), method: "POST", route: "/auth/signup" });
    expect(entry!.bindings.userId).toBeUndefined();
    expect(entry!.bindings.organizationId).toBeUndefined();
  });

  it("binds requestId, method, and route on the unauthenticated health check", async () => {
    captured.length = 0;

    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);

    const entry = captured.find((c) => c.url === "/health");
    expect(entry).toBeDefined();
    expect(entry!.bindings).toMatchObject({ service: "api", requestId: expect.any(String), method: "GET", route: "/health" });
    expect(entry!.bindings.userId).toBeUndefined();
    expect(entry!.bindings.organizationId).toBeUndefined();
  });

  it("binds route as a fixed placeholder, not the raw URL, for a request that matches no route at all", async () => {
    captured.length = 0;

    const response = await app.inject({ method: "GET", url: "/this-route-does-not-exist" });
    expect(response.statusCode).toBe(404);

    const entry = captured.find((c) => c.url === "/this-route-does-not-exist");
    expect(entry).toBeDefined();
    expect(entry!.bindings).toMatchObject({ service: "api", method: "GET", route: "unmatched_route" });
  });

  it("never binds the raw session token/cookie value as a logged field", async () => {
    const owner = await signup(app, `logctx-notoken-${suffix}@example.com`, "correct-horse-battery-staple", `Log Ctx No Token Org ${suffix}`);
    captured.length = 0;

    await app.inject({
      method: "GET",
      url: "/organizations",
      cookies: { [SESSION_COOKIE_NAME]: owner.sessionCookie },
    });

    const entry = captured.find((c) => c.url === "/organizations");
    const values = Object.values(entry!.bindings).map((v) => String(v));
    expect(values).not.toContain(owner.sessionCookie);
  });
});
