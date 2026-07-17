/**
 * Integration tests against real Postgres + Redis via app.inject() — no
 * mocking of either. Prerequisites: docker compose up -d.
 */
import { randomUUID } from "node:crypto";

import { prisma } from "@raas/db";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../app.js";
import { hashApiKey } from "../lib/api-keys.js";
import { redis } from "../lib/redis.js";
import { SESSION_COOKIE_NAME } from "../plugins/auth-guard.js";

async function signup(
  app: FastifyInstance,
  email: string,
  password: string,
  organizationName: string,
): Promise<{ sessionCookie: string; userId: string; organizationId: string }> {
  const response = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { email, password, organizationName },
  });
  const cookie = response.cookies.find((c) => c.name === SESSION_COOKIE_NAME);
  const body = response.json();
  return { sessionCookie: cookie!.value, userId: body.user.id, organizationId: body.organizations[0].id };
}

describe("API key routes", () => {
  let app: FastifyInstance;
  const suffix = randomUUID().slice(0, 8);
  const password = "correct-horse-battery-staple";

  let ownerCookie: string;
  let organizationId: string;
  let outsiderCookie: string;
  let memberCookie: string;

  beforeAll(async () => {
    app = await buildApp();

    const owner = await signup(app, `apikey-owner-${suffix}@example.com`, password, `Api Key Org ${suffix}`);
    ownerCookie = owner.sessionCookie;
    organizationId = owner.organizationId;

    const outsider = await signup(app, `apikey-outsider-${suffix}@example.com`, password, `Api Key Outsider Org ${suffix}`);
    outsiderCookie = outsider.sessionCookie;

    const invite = await app.inject({
      method: "POST",
      url: `/organizations/${organizationId}/invites`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      payload: { email: `apikey-member-${suffix}@example.com`, role: "MEMBER" },
    });
    const { token } = invite.json();
    const memberSignup = await signup(app, `apikey-member-${suffix}@example.com`, password, `Api Key Member Org ${suffix}`);
    memberCookie = memberSignup.sessionCookie;
    await app.inject({ method: "POST", url: `/invites/${token}/accept`, cookies: { [SESSION_COOKIE_NAME]: memberCookie } });
  });

  afterAll(async () => {
    await app.close();
    await prisma.user.deleteMany({ where: { email: { contains: suffix } } });
    await prisma.organization.deleteMany({ where: { slug: { contains: suffix } } });
    await redis.quit();
  });

  it("creates a key, returning the raw value exactly once alongside the public record", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/organizations/${organizationId}/api-keys`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      payload: { name: "CI deploy key" },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(typeof body.key).toBe("string");
    expect(body.key.startsWith("rk_live_")).toBe(true);
    expect(body.apiKey.prefix).toBe(body.key.slice(0, body.apiKey.prefix.length));
    expect(body.apiKey.name).toBe("CI deploy key");
    expect(body.apiKey).not.toHaveProperty("hashedKey");
    expect(body.apiKey).not.toHaveProperty("key");
  });

  it("stores only the hash — the raw key is not recoverable from the database", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/organizations/${organizationId}/api-keys`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      payload: { name: "Hash Check Key" },
    });
    const { apiKey, key } = response.json();

    const stored = await prisma.apiKey.findUnique({ where: { id: apiKey.id } });
    expect(stored!.hashedKey).toBe(hashApiKey(key));
    expect(stored!.hashedKey).not.toBe(key);
  });

  it("rejects creation from a plain MEMBER — requires ADMIN or higher", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/organizations/${organizationId}/api-keys`,
      cookies: { [SESSION_COOKIE_NAME]: memberCookie },
      payload: { name: "Should Not Be Created" },
    });
    expect(response.statusCode).toBe(403);
  });

  it("rejects creation for an organization the caller isn't a member of", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/organizations/${organizationId}/api-keys`,
      cookies: { [SESSION_COOKIE_NAME]: outsiderCookie },
      payload: { name: "Sneaky Key" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("lists keys without ever exposing the hash or the raw key again", async () => {
    await app.inject({
      method: "POST",
      url: `/organizations/${organizationId}/api-keys`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      payload: { name: "Listed Key" },
    });

    const response = await app.inject({
      method: "GET",
      url: `/organizations/${organizationId}/api-keys`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.length).toBeGreaterThan(0);
    for (const key of body.data) {
      expect(key).not.toHaveProperty("hashedKey");
      expect(key).not.toHaveProperty("key");
      expect(key).toHaveProperty("prefix");
      expect(key).toHaveProperty("lastUsedAt");
    }
  });

  it("rejects listing from a plain MEMBER — requires ADMIN or higher", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/organizations/${organizationId}/api-keys`,
      cookies: { [SESSION_COOKIE_NAME]: memberCookie },
    });
    expect(response.statusCode).toBe(403);
  });

  it("rejects listing for an organization the caller isn't a member of", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/organizations/${organizationId}/api-keys`,
      cookies: { [SESSION_COOKIE_NAME]: outsiderCookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it("revokes a key, setting revokedAt", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/organizations/${organizationId}/api-keys`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      payload: { name: "Revocable Key" },
    });
    const keyId = created.json().apiKey.id;

    const response = await app.inject({
      method: "DELETE",
      url: `/organizations/${organizationId}/api-keys/${keyId}`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
    });
    expect(response.statusCode).toBe(204);

    const stored = await prisma.apiKey.findUnique({ where: { id: keyId } });
    expect(stored!.revokedAt).not.toBeNull();
  });

  it("revoking an already-revoked key is idempotent — 204, revokedAt unchanged", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/organizations/${organizationId}/api-keys`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      payload: { name: "Double Revoke Key" },
    });
    const keyId = created.json().apiKey.id;

    await app.inject({
      method: "DELETE",
      url: `/organizations/${organizationId}/api-keys/${keyId}`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
    });
    const firstRevokedAt = (await prisma.apiKey.findUnique({ where: { id: keyId } }))!.revokedAt;

    const second = await app.inject({
      method: "DELETE",
      url: `/organizations/${organizationId}/api-keys/${keyId}`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
    });
    expect(second.statusCode).toBe(204);

    const secondRevokedAt = (await prisma.apiKey.findUnique({ where: { id: keyId } }))!.revokedAt;
    expect(secondRevokedAt!.getTime()).toBe(firstRevokedAt!.getTime());
  });

  it("rejects revoke from a plain MEMBER — requires ADMIN or higher", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/organizations/${organizationId}/api-keys`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      payload: { name: "Role Gated Revoke Key" },
    });
    const keyId = created.json().apiKey.id;

    const response = await app.inject({
      method: "DELETE",
      url: `/organizations/${organizationId}/api-keys/${keyId}`,
      cookies: { [SESSION_COOKIE_NAME]: memberCookie },
    });
    expect(response.statusCode).toBe(403);
  });

  it("returns 404 revoking a key id that doesn't exist", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: `/organizations/${organizationId}/api-keys/${randomUUID()}`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it("keeps API keys fully isolated across organizations — cannot revoke another org's key", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/organizations/${organizationId}/api-keys`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      payload: { name: "Tenant Isolated Key" },
    });
    const keyId = created.json().apiKey.id;

    const response = await app.inject({
      method: "DELETE",
      url: `/organizations/${organizationId}/api-keys/${keyId}`,
      cookies: { [SESSION_COOKIE_NAME]: outsiderCookie },
    });
    expect(response.statusCode).toBe(404);

    const stored = await prisma.apiKey.findUnique({ where: { id: keyId } });
    expect(stored!.revokedAt).toBeNull();
  });

  it("rejects an expiresAt in the past", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/organizations/${organizationId}/api-keys`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      payload: { name: "Already Expired Key", expiresAt: new Date(Date.now() - 60_000).toISOString() },
    });
    expect(response.statusCode).toBe(422);
  });

  it("accepts a future expiresAt and stores it", async () => {
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const response = await app.inject({
      method: "POST",
      url: `/organizations/${organizationId}/api-keys`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      payload: { name: "Expiring Key", expiresAt: expiresAt.toISOString() },
    });

    expect(response.statusCode).toBe(201);
    expect(new Date(response.json().apiKey.expiresAt).getTime()).toBe(expiresAt.getTime());
  });
});
