/**
 * Integration tests against real Postgres + Redis via app.inject() — no
 * mocking of either. testProviderConnection (the one call that would hit
 * a real OpenAI/Anthropic/Groq account) is spied on and given a
 * deterministic result instead — same "never calls the real third-party
 * API" boundary billing.test.ts already draws around
 * customerPortalSessions.create, for the same reason: there's no
 * account/credential this suite can use that wouldn't be either fake
 * (defeating the point) or a real secret that doesn't belong in a test
 * file. Everything else — auth, RLS, persistence, the response shape,
 * idempotency — is exercised for real.
 *
 * Prerequisites: docker compose up -d, LLM_KEY_ENCRYPTION_SECRET set
 * (see .env) — these routes aren't registered at all otherwise.
 */
import { randomUUID } from "node:crypto";

import { decryptSecret } from "@raas/crypto";
import { prisma, withTenantTransaction } from "@raas/db";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { buildApp } from "../app.js";
import { env } from "../env.js";
import * as llmProviderModule from "../lib/llm-provider.js";
import { redis } from "../lib/redis.js";
import { SESSION_COOKIE_NAME } from "../plugins/auth-guard.js";
import { signup } from "../test-support/signup.js";

describe("LLM config routes", () => {
  let app: FastifyInstance;
  const suffix = randomUUID().slice(0, 8);
  const password = "correct-horse-battery-staple";

  let ownerCookie: string;
  let organizationId: string;
  let outsiderCookie: string;
  let memberCookie: string;

  beforeAll(async () => {
    app = await buildApp();

    const owner = await signup(app, `llmcfg-owner-${suffix}@example.com`, password, `Llm Config Org ${suffix}`);
    ownerCookie = owner.sessionCookie;
    organizationId = owner.organizationId;

    const outsider = await signup(app, `llmcfg-outsider-${suffix}@example.com`, password, `Llm Config Outsider Org ${suffix}`);
    outsiderCookie = outsider.sessionCookie;

    const invite = await app.inject({
      method: "POST",
      url: `/organizations/${organizationId}/invites`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      payload: { email: `llmcfg-member-${suffix}@example.com`, role: "MEMBER" },
    });
    const { token } = invite.json();
    const memberSignup = await signup(app, `llmcfg-member-${suffix}@example.com`, password, `Llm Config Member Org ${suffix}`);
    memberCookie = memberSignup.sessionCookie;
    await app.inject({ method: "POST", url: `/invites/${token}/accept`, cookies: { [SESSION_COOKIE_NAME]: memberCookie } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await app.close();
    await prisma.user.deleteMany({ where: { email: { contains: suffix } } });
    await prisma.organization.deleteMany({ where: { slug: { contains: suffix } } });
    await redis.quit();
  });

  describe("GET /organizations/:id/llm-config", () => {
    it("returns config: null for an organization that hasn't configured anything", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/organizations/${organizationId}/llm-config`,
        cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ config: null });
    });

    it("requires authentication", async () => {
      const response = await app.inject({ method: "GET", url: `/organizations/${organizationId}/llm-config` });
      expect(response.statusCode).toBe(401);
    });

    it("returns 403 for a MEMBER (ADMIN-or-higher only)", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/organizations/${organizationId}/llm-config`,
        cookies: { [SESSION_COOKIE_NAME]: memberCookie },
      });
      expect(response.statusCode).toBe(403);
    });

    it("returns 404 for a non-member (never distinguishes missing-org from not-your-org)", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/organizations/${organizationId}/llm-config`,
        cookies: { [SESSION_COOKIE_NAME]: outsiderCookie },
      });
      expect(response.statusCode).toBe(404);
    });
  });

  describe("PATCH /organizations/:id/llm-config", () => {
    it("rejects a model that isn't in the curated list for the given provider", async () => {
      const response = await app.inject({
        method: "PATCH",
        url: `/organizations/${organizationId}/llm-config`,
        cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
        payload: { provider: "openai", model: "not-a-real-model", apiKey: "sk-test" },
      });

      expect(response.statusCode).toBe(422);
    });

    it("tests the connection before saving, and never persists when the test fails", async () => {
      vi.spyOn(llmProviderModule, "testProviderConnection").mockResolvedValue({ ok: false, message: "Incorrect API key provided" });

      const response = await app.inject({
        method: "PATCH",
        url: `/organizations/${organizationId}/llm-config`,
        cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
        payload: { provider: "openai", model: "gpt-4o-mini", apiKey: "sk-bad" },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.message).toContain("Incorrect API key provided");

      const stored = await withTenantTransaction(organizationId, (tx) => tx.organizationLlmConfig.findUnique({ where: { organizationId } }));
      expect(stored).toBeNull();
    });

    it("saves the config (encrypted, decryptable) when the connection test passes, and never returns the key", async () => {
      vi.spyOn(llmProviderModule, "testProviderConnection").mockResolvedValue({ ok: true });

      const response = await app.inject({
        method: "PATCH",
        url: `/organizations/${organizationId}/llm-config`,
        cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
        payload: { provider: "openai", model: "gpt-4o-mini", apiKey: "sk-real-looking-key" },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.config).toEqual({ provider: "openai", model: "gpt-4o-mini", lastValidatedAt: expect.any(String), lastValidationError: null });
      expect(body.config).not.toHaveProperty("apiKey");
      expect(body.config).not.toHaveProperty("encryptedApiKey");

      const stored = await withTenantTransaction(organizationId, (tx) => tx.organizationLlmConfig.findUniqueOrThrow({ where: { organizationId } }));
      expect(stored.encryptedApiKey).not.toContain("sk-real-looking-key");
      expect(decryptSecret(stored.encryptedApiKey, env.LLM_KEY_ENCRYPTION_SECRET!)).toBe("sk-real-looking-key");
    });

    it("requires ADMIN — a MEMBER gets 403", async () => {
      const response = await app.inject({
        method: "PATCH",
        url: `/organizations/${organizationId}/llm-config`,
        cookies: { [SESSION_COOKIE_NAME]: memberCookie },
        payload: { provider: "openai", model: "gpt-4o-mini", apiKey: "sk-test" },
      });
      expect(response.statusCode).toBe(403);
    });
  });

  describe("DELETE /organizations/:id/llm-config", () => {
    it("reverts to Nexus-managed and is idempotent", async () => {
      vi.spyOn(llmProviderModule, "testProviderConnection").mockResolvedValue({ ok: true });
      await app.inject({
        method: "PATCH",
        url: `/organizations/${organizationId}/llm-config`,
        cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
        payload: { provider: "groq", model: "llama-3.1-8b-instant", apiKey: "gsk-test" },
      });

      const first = await app.inject({
        method: "DELETE",
        url: `/organizations/${organizationId}/llm-config`,
        cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      });
      expect(first.statusCode).toBe(204);
      expect(await withTenantTransaction(organizationId, (tx) => tx.organizationLlmConfig.findUnique({ where: { organizationId } }))).toBeNull();

      const second = await app.inject({
        method: "DELETE",
        url: `/organizations/${organizationId}/llm-config`,
        cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      });
      expect(second.statusCode).toBe(204);
    });
  });

  describe("POST /organizations/:id/llm-config/test", () => {
    it("returns 400 when there's nothing saved and no apiKey is provided", async () => {
      await app.inject({
        method: "DELETE",
        url: `/organizations/${organizationId}/llm-config`,
        cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      });

      const response = await app.inject({
        method: "POST",
        url: `/organizations/${organizationId}/llm-config/test`,
        cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
        payload: { provider: "openai", model: "gpt-4o-mini" },
      });

      expect(response.statusCode).toBe(400);
    });

    it("re-tests the already-saved key (decrypted) when apiKey is omitted, and updates health status", async () => {
      const testSpy = vi.spyOn(llmProviderModule, "testProviderConnection").mockResolvedValue({ ok: true });
      await app.inject({
        method: "PATCH",
        url: `/organizations/${organizationId}/llm-config`,
        cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
        payload: { provider: "openai", model: "gpt-4o-mini", apiKey: "sk-saved-key" },
      });

      testSpy.mockResolvedValue({ ok: false, message: "Rate limited" });
      const response = await app.inject({
        method: "POST",
        url: `/organizations/${organizationId}/llm-config/test`,
        cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
        payload: { provider: "openai", model: "gpt-4o-mini" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: false, message: "Rate limited" });
      // Re-tested with the real, decrypted saved key — not a placeholder.
      expect(testSpy).toHaveBeenLastCalledWith("openai", "gpt-4o-mini", "sk-saved-key");

      const stored = await withTenantTransaction(organizationId, (tx) => tx.organizationLlmConfig.findUniqueOrThrow({ where: { organizationId } }));
      expect(stored.lastValidationError).toBe("Rate limited");
    });
  });

  describe("cross-tenant isolation", () => {
    it("an org's config is never visible to another organization's admin", async () => {
      vi.spyOn(llmProviderModule, "testProviderConnection").mockResolvedValue({ ok: true });
      await app.inject({
        method: "PATCH",
        url: `/organizations/${organizationId}/llm-config`,
        cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
        payload: { provider: "anthropic", model: "claude-3-5-haiku-latest", apiKey: "sk-ant-owner-key" },
      });

      const outsiderOrg = await signup(app, `llmcfg-isolation-${suffix}@example.com`, password, `Llm Config Isolation Org ${suffix}`);
      const response = await app.inject({
        method: "GET",
        url: `/organizations/${outsiderOrg.organizationId}/llm-config`,
        cookies: { [SESSION_COOKIE_NAME]: outsiderOrg.sessionCookie },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ config: null });
    });
  });
});
