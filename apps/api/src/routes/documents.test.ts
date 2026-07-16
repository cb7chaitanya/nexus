/**
 * Integration tests against real Postgres + Redis + MinIO via
 * app.inject() — no mocking of any of them. Prerequisites: docker compose
 * up -d, migrations applied (pnpm --filter @raas/db migrate:deploy).
 */
import { randomUUID } from "node:crypto";

import { prisma, withTenantTransaction } from "@raas/db";
import { PLATFORM_EMBEDDING_DIM } from "@raas/shared";
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

async function presignDocument(
  app: FastifyInstance,
  sessionCookie: string,
  organizationId: string,
  knowledgeBaseId: string,
): Promise<{ documentId: string; uploadUrl: string }> {
  const response = await app.inject({
    method: "POST",
    url: `/kb/${knowledgeBaseId}/documents/presign`,
    cookies: { [SESSION_COOKIE_NAME]: sessionCookie },
    payload: {
      organizationId,
      fileName: "report.txt",
      mimeType: "text/plain",
      sizeBytes: 11,
    },
  });
  const body = response.json();
  return { documentId: body.document.id, uploadUrl: body.uploadUrl };
}

describe("document routes", () => {
  let app: FastifyInstance;
  const suffix = randomUUID().slice(0, 8);
  const password = "correct-horse-battery-staple";

  let ownerCookie: string;
  let organizationId: string;
  let knowledgeBaseId: string;
  let outsiderCookie: string;

  beforeAll(async () => {
    app = await buildApp();

    const owner = await signup(app, `doc-owner-${suffix}@example.com`, password, `Doc Org ${suffix}`);
    ownerCookie = owner.sessionCookie;
    organizationId = owner.organizationId;

    const outsider = await signup(app, `doc-outsider-${suffix}@example.com`, password, `Doc Outsider Org ${suffix}`);
    outsiderCookie = outsider.sessionCookie;

    const kbResponse = await app.inject({
      method: "POST",
      url: "/kb",
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      payload: {
        organizationId,
        name: "Ingestion Docs",
        embeddingProvider: "openai",
        embeddingModel: "text-embedding-3-small",
        embeddingDim: PLATFORM_EMBEDDING_DIM,
      },
    });
    knowledgeBaseId = kbResponse.json().id;
  });

  afterAll(async () => {
    await app.close();
    await prisma.user.deleteMany({ where: { email: { contains: suffix } } });
    await prisma.organization.deleteMany({ where: { slug: { contains: suffix } } });
    await redis.quit();
  });

  it("rejects completing a document whose object was never actually uploaded", async () => {
    const { documentId } = await presignDocument(app, ownerCookie, organizationId, knowledgeBaseId);

    const response = await app.inject({
      method: "POST",
      url: `/documents/${documentId}/complete`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      payload: { organizationId },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("CONFLICT");

    const stored = await withTenantTransaction(organizationId, (tx) =>
      tx.document.findUnique({ where: { id: documentId } }),
    );
    expect(stored?.status).toBe("PENDING_UPLOAD");
  });

  it("completes a document after the object is actually uploaded, transitioning PENDING_UPLOAD -> QUEUED", async () => {
    const { documentId, uploadUrl } = await presignDocument(app, ownerCookie, organizationId, knowledgeBaseId);

    const putResponse = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: "hello world",
    });
    expect(putResponse.ok).toBe(true);

    const response = await app.inject({
      method: "POST",
      url: `/documents/${documentId}/complete`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      payload: { organizationId },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("QUEUED");
  });

  it("rejects completing a document that isn't PENDING_UPLOAD anymore", async () => {
    const { documentId, uploadUrl } = await presignDocument(app, ownerCookie, organizationId, knowledgeBaseId);

    await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": "text/plain" }, body: "hello again" });

    const first = await app.inject({
      method: "POST",
      url: `/documents/${documentId}/complete`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      payload: { organizationId },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: `/documents/${documentId}/complete`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      payload: { organizationId },
    });
    expect(second.statusCode).toBe(409);
  });

  it("rejects completing a document for an organization the caller isn't a member of", async () => {
    const { documentId } = await presignDocument(app, ownerCookie, organizationId, knowledgeBaseId);

    const response = await app.inject({
      method: "POST",
      url: `/documents/${documentId}/complete`,
      cookies: { [SESSION_COOKIE_NAME]: outsiderCookie },
      payload: { organizationId },
    });

    expect(response.statusCode).toBe(404);
  });

  it("rejects completing a document id that doesn't exist", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/documents/${randomUUID()}/complete`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      payload: { organizationId },
    });

    expect(response.statusCode).toBe(404);
  });

  it("requires authentication to complete a document", async () => {
    const { documentId } = await presignDocument(app, ownerCookie, organizationId, knowledgeBaseId);

    const response = await app.inject({
      method: "POST",
      url: `/documents/${documentId}/complete`,
      payload: { organizationId },
    });

    expect(response.statusCode).toBe(401);
  });
});
