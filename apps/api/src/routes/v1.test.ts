/**
 * Integration tests for requireApiKeyAuth (plugins/api-key-auth.ts) via
 * the one real route it gates, GET /v1/knowledge-bases/:id/documents —
 * against real Postgres + Redis via app.inject(), no mocking of either,
 * same convention as every other integration suite in this repo.
 * Prerequisites: docker compose up -d.
 */
import { randomUUID } from "node:crypto";

import { prisma } from "@raas/db";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../app.js";
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

async function createKnowledgeBase(app: FastifyInstance, sessionCookie: string, organizationId: string, name: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/kb",
    cookies: { [SESSION_COOKIE_NAME]: sessionCookie },
    payload: { organizationId, name, embeddingProvider: "openai", embeddingModel: "text-embedding-3-small", embeddingDim: 1536 },
  });
  return response.json().id;
}

async function createApiKey(app: FastifyInstance, sessionCookie: string, organizationId: string, name: string, expiresAt?: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: `/organizations/${organizationId}/api-keys`,
    cookies: { [SESSION_COOKIE_NAME]: sessionCookie },
    payload: expiresAt ? { name, expiresAt } : { name },
  });
  return response.json().key;
}

describe("requireApiKeyAuth (GET /v1/knowledge-bases/:id/documents)", () => {
  let app: FastifyInstance;
  const suffix = randomUUID().slice(0, 8);
  const password = "correct-horse-battery-staple";

  let orgAId: string;
  let orgACookie: string;
  let orgAKbId: string;

  let orgBId: string;
  let orgBCookie: string;
  let orgBKbId: string;

  beforeAll(async () => {
    app = await buildApp();

    const orgA = await signup(app, `v1auth-a-${suffix}@example.com`, password, `V1 Auth Org A ${suffix}`);
    orgAId = orgA.organizationId;
    orgACookie = orgA.sessionCookie;
    orgAKbId = await createKnowledgeBase(app, orgACookie, orgAId, "Org A KB");

    const orgB = await signup(app, `v1auth-b-${suffix}@example.com`, password, `V1 Auth Org B ${suffix}`);
    orgBId = orgB.organizationId;
    orgBCookie = orgB.sessionCookie;
    orgBKbId = await createKnowledgeBase(app, orgBCookie, orgBId, "Org B KB");
  });

  afterAll(async () => {
    await app.close();
    await prisma.user.deleteMany({ where: { email: { contains: suffix } } });
    await prisma.organization.deleteMany({ where: { slug: { contains: suffix } } });
    await redis.quit();
  });

  it("rejects a request with no Authorization header at all", async () => {
    const response = await app.inject({ method: "GET", url: `/v1/knowledge-bases/${orgAKbId}/documents` });
    expect(response.statusCode).toBe(401);
  });

  it("rejects a malformed Authorization header (not a Bearer token)", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/knowledge-bases/${orgAKbId}/documents`,
      headers: { authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects a syntactically well-formed but unknown API key", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/knowledge-bases/${orgAKbId}/documents`,
      headers: { authorization: "Bearer rk_live_this_key_was_never_issued" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("a valid API key succeeds and resolves to the right organization's knowledge base", async () => {
    const rawKey = await createApiKey(app, orgACookie, orgAId, "Valid Key");

    const response = await app.inject({
      method: "GET",
      url: `/v1/knowledge-bases/${orgAKbId}/documents`,
      headers: { authorization: `Bearer ${rawKey}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ data: [], nextCursor: null });
  });

  it("a valid API key records lastUsedAt on successful authentication", async () => {
    const rawKey = await createApiKey(app, orgACookie, orgAId, "Usage Tracked Key");
    const listed = await app.inject({
      method: "GET",
      url: `/organizations/${orgAId}/api-keys`,
      cookies: { [SESSION_COOKIE_NAME]: orgACookie },
    });
    const created = listed.json().data.find((k: { name: string }) => k.name === "Usage Tracked Key");
    expect(created.lastUsedAt).toBeNull();

    await app.inject({
      method: "GET",
      url: `/v1/knowledge-bases/${orgAKbId}/documents`,
      headers: { authorization: `Bearer ${rawKey}` },
    });

    const listedAgain = await app.inject({
      method: "GET",
      url: `/organizations/${orgAId}/api-keys`,
      cookies: { [SESSION_COOKIE_NAME]: orgACookie },
    });
    const afterUse = listedAgain.json().data.find((k: { name: string }) => k.name === "Usage Tracked Key");
    expect(afterUse.lastUsedAt).not.toBeNull();
  });

  it("rejects a revoked API key", async () => {
    const rawKey = await createApiKey(app, orgACookie, orgAId, "Revoked Key");
    const listed = await app.inject({
      method: "GET",
      url: `/organizations/${orgAId}/api-keys`,
      cookies: { [SESSION_COOKIE_NAME]: orgACookie },
    });
    const keyId = listed.json().data.find((k: { name: string }) => k.name === "Revoked Key").id;

    await app.inject({
      method: "DELETE",
      url: `/organizations/${orgAId}/api-keys/${keyId}`,
      cookies: { [SESSION_COOKIE_NAME]: orgACookie },
    });

    const response = await app.inject({
      method: "GET",
      url: `/v1/knowledge-bases/${orgAKbId}/documents`,
      headers: { authorization: `Bearer ${rawKey}` },
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects an expired API key", async () => {
    const rawKey = await createApiKey(app, orgACookie, orgAId, "Expiring Soon Key", new Date(Date.now() + 1000).toISOString());

    await new Promise((resolve) => setTimeout(resolve, 1100));

    const response = await app.inject({
      method: "GET",
      url: `/v1/knowledge-bases/${orgAKbId}/documents`,
      headers: { authorization: `Bearer ${rawKey}` },
    });
    expect(response.statusCode).toBe(401);
  }, 10_000);

  it("an org A API key cannot access org B's knowledge base — 404, not another org's data", async () => {
    const rawKey = await createApiKey(app, orgACookie, orgAId, "Cross Org Attempt Key");

    const response = await app.inject({
      method: "GET",
      url: `/v1/knowledge-bases/${orgBKbId}/documents`,
      headers: { authorization: `Bearer ${rawKey}` },
    });
    expect(response.statusCode).toBe(404);
  });

  it("an org B API key still succeeds against org B's own knowledge base — proves the 404 above is tenant isolation, not a general failure", async () => {
    const rawKey = await createApiKey(app, orgBCookie, orgBId, "Org B Own Key");

    const response = await app.inject({
      method: "GET",
      url: `/v1/knowledge-bases/${orgBKbId}/documents`,
      headers: { authorization: `Bearer ${rawKey}` },
    });
    expect(response.statusCode).toBe(200);
  });

  it("never accepts a session cookie in place of an API key on the v1 route", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/knowledge-bases/${orgAKbId}/documents`,
      cookies: { [SESSION_COOKIE_NAME]: orgACookie },
    });
    expect(response.statusCode).toBe(401);
  });
});
