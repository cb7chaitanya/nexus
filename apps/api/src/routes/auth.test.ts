/**
 * Integration tests against real Postgres + Redis via app.inject() — no
 * mocking of either. Prerequisites: docker compose up -d, migrations
 * applied (pnpm --filter @raas/db migrate:deploy).
 */
import { randomUUID } from "node:crypto";

import { prisma } from "@raas/db";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../app.js";
import { redis } from "../lib/redis.js";
import { SESSION_COOKIE_NAME } from "../plugins/auth-guard.js";

describe("auth routes", () => {
  let app: FastifyInstance;
  const suffix = randomUUID().slice(0, 8);
  const email = `signup-${suffix}@example.com`;
  const password = "correct-horse-battery-staple";

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
    await prisma.user.deleteMany({ where: { email: { contains: suffix } } });
    await prisma.organization.deleteMany({ where: { slug: { contains: suffix } } });
    await redis.quit();
  });

  it("signs up a new user with a new organization, setting a session cookie", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: {
        email,
        password,
        name: "Signup Test",
        organizationName: `Signup Org ${suffix}`,
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.user.email).toBe(email);
    expect(body.user.passwordHash).toBeUndefined();
    expect(body.organizations).toHaveLength(1);
    expect(body.organizations[0].role).toBe("OWNER");

    const cookie = response.cookies.find((c) => c.name === SESSION_COOKIE_NAME);
    expect(cookie).toBeDefined();
    expect(cookie?.httpOnly).toBe(true);
  });

  it("rejects signup with a duplicate email", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { email, password, organizationName: `Dup Org ${suffix}` },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("CONFLICT");
  });

  it("rejects invalid signup input with a structured validation error", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { email: "not-an-email", password: "short", organizationName: "" },
    });

    expect(response.statusCode).toBe(422);
    const body = response.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.requestId).toBeTruthy();
    expect(Array.isArray(body.error.details)).toBe(true);
    expect(body.error.details.length).toBeGreaterThan(0);
  });

  it("logs in with the correct password and returns organizations", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email, password },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.user.email).toBe(email);
    expect(body.organizations).toHaveLength(1);
  });

  it("rejects a wrong password and an unknown email with the identical message", async () => {
    const wrongPassword = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email, password: "wrong-password-entirely" },
    });
    const unknownEmail = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: `nobody-${suffix}@example.com`, password },
    });

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownEmail.statusCode).toBe(401);
    expect(wrongPassword.json().error.message).toBe(unknownEmail.json().error.message);
  });

  it("returns the current user and organizations from /auth/me when authenticated", async () => {
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
    const sessionCookie = login.cookies.find((c) => c.name === SESSION_COOKIE_NAME);

    const response = await app.inject({
      method: "GET",
      url: "/auth/me",
      cookies: { [SESSION_COOKIE_NAME]: sessionCookie!.value },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.user.email).toBe(email);
    expect(body.organizations).toHaveLength(1);
  });

  it("rejects /auth/me with no session cookie", async () => {
    const response = await app.inject({ method: "GET", url: "/auth/me" });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("UNAUTHORIZED");
  });

  it("logs out, revoking the session so it can no longer be used", async () => {
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
    const sessionCookie = login.cookies.find((c) => c.name === SESSION_COOKIE_NAME);

    const logout = await app.inject({
      method: "POST",
      url: "/auth/logout",
      cookies: { [SESSION_COOKIE_NAME]: sessionCookie!.value },
    });
    expect(logout.statusCode).toBe(200);
    expect(logout.json()).toEqual({ success: true });

    const me = await app.inject({
      method: "GET",
      url: "/auth/me",
      cookies: { [SESSION_COOKIE_NAME]: sessionCookie!.value },
    });
    expect(me.statusCode).toBe(401);
  });

  it("logout is idempotent — succeeds even with no session", async () => {
    const response = await app.inject({ method: "POST", url: "/auth/logout" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true });
  });
});
