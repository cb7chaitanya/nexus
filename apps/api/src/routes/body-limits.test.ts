/**
 * Integration tests against a real Fastify instance via app.inject() —
 * verifies the explicit body-size ceilings in lib/body-limits.ts (global,
 * plus the tighter override on the document metadata routes).
 */
import { randomUUID } from "node:crypto";

import { prisma } from "@raas/db";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../app.js";
import { DOCUMENT_METADATA_BODY_LIMIT_BYTES, GLOBAL_BODY_LIMIT_BYTES } from "../lib/body-limits.js";
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

describe("body limits", () => {
  let app: FastifyInstance;
  const suffix = randomUUID().slice(0, 8);
  const password = "correct-horse-battery-staple";

  let ownerCookie: string;
  let organizationId: string;

  beforeAll(async () => {
    app = await buildApp();
    const owner = await signup(app, `bodylimit-${suffix}@example.com`, password, `Body Limit Org ${suffix}`);
    ownerCookie = owner.sessionCookie;
    organizationId = owner.organizationId;
  });

  afterAll(async () => {
    await app.close();
    await prisma.user.deleteMany({ where: { email: { contains: suffix } } });
    await prisma.organization.deleteMany({ where: { slug: { contains: suffix } } });
    await redis.quit();
  });

  describe("global default (a normal JSON route, e.g. POST /kb)", () => {
    it("accepts a normally-sized payload", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/kb",
        cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
        payload: {
          organizationId,
          name: "Body Limit KB",
          embeddingProvider: "openai",
          embeddingModel: "text-embedding-3-small",
          embeddingDim: 1536,
        },
      });
      expect(response.statusCode).toBe(201);
    });

    it("rejects a payload larger than the global body limit with the standard error envelope", async () => {
      const oversizedName = "a".repeat(GLOBAL_BODY_LIMIT_BYTES + 1024);
      const response = await app.inject({
        method: "POST",
        url: "/kb",
        cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
        payload: {
          organizationId,
          name: oversizedName,
          embeddingProvider: "openai",
          embeddingModel: "text-embedding-3-small",
          embeddingDim: 1536,
        },
      });

      expect(response.statusCode).toBe(413);
      expect(response.json()).toMatchObject({ error: { code: "BAD_REQUEST" } });
      expect(response.json().error.requestId).toBeTruthy();
    });
  });

  describe("document metadata routes (tighter override)", () => {
    let knowledgeBaseId: string;

    beforeAll(async () => {
      const kbResponse = await app.inject({
        method: "POST",
        url: "/kb",
        cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
        payload: {
          organizationId,
          name: "Body Limit Document KB",
          embeddingProvider: "openai",
          embeddingModel: "text-embedding-3-small",
          embeddingDim: 1536,
        },
      });
      knowledgeBaseId = kbResponse.json().id;
    });

    it("accepts a normally-sized presign request", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/kb/${knowledgeBaseId}/documents/presign`,
        cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
        payload: { organizationId, fileName: "report.pdf", mimeType: "application/pdf", sizeBytes: 1024 },
      });
      expect(response.statusCode).toBe(201);
    });

    it("rejects a presign body over the tighter document-route limit, while still under the global limit", async () => {
      // Larger than DOCUMENT_METADATA_BODY_LIMIT_BYTES but comfortably
      // under GLOBAL_BODY_LIMIT_BYTES — isolates that THIS route's own,
      // tighter override is what's rejecting it, not the app-wide default.
      expect(DOCUMENT_METADATA_BODY_LIMIT_BYTES).toBeLessThan(GLOBAL_BODY_LIMIT_BYTES);
      const oversizedFileName = "a".repeat(DOCUMENT_METADATA_BODY_LIMIT_BYTES + 1024);

      const response = await app.inject({
        method: "POST",
        url: `/kb/${knowledgeBaseId}/documents/presign`,
        cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
        payload: { organizationId, fileName: oversizedFileName, mimeType: "application/pdf", sizeBytes: 1024 },
      });

      expect(response.statusCode).toBe(413);
      expect(response.json()).toMatchObject({ error: { code: "BAD_REQUEST" } });
    });

    it("rejects an oversized POST /documents/:id/complete body the same way", async () => {
      const oversizedPayload = { organizationId, padding: "a".repeat(DOCUMENT_METADATA_BODY_LIMIT_BYTES + 1024) };

      const response = await app.inject({
        method: "POST",
        url: `/documents/${randomUUID()}/complete`,
        cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
        payload: oversizedPayload,
      });

      expect(response.statusCode).toBe(413);
      expect(response.json()).toMatchObject({ error: { code: "BAD_REQUEST" } });
    });
  });
});
