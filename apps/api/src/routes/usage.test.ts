/**
 * Integration tests against real Postgres + Redis via app.inject() — no
 * mocking of either. Prerequisites: docker compose up -d, migrations
 * applied.
 */
import { randomUUID } from "node:crypto";

import { prisma } from "@raas/db";
import { recordUsage } from "@raas/usage";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../app.js";
import { redis } from "../lib/redis.js";
import { SESSION_COOKIE_NAME } from "../plugins/auth-guard.js";
import { signup } from "../test-support/signup.js";

describe("GET /organizations/:id/usage", () => {
  let app: FastifyInstance;
  const suffix = randomUUID().slice(0, 8);
  const password = "correct-horse-battery-staple";

  let ownerCookie: string;
  let organizationId: string;
  let outsiderCookie: string;
  let emptyOrgCookie: string;
  let emptyOrgId: string;

  beforeAll(async () => {
    app = await buildApp();

    const owner = await signup(app, `usage-owner-${suffix}@example.com`, password, `Usage Org ${suffix}`);
    ownerCookie = owner.sessionCookie;
    organizationId = owner.organizationId;

    const outsider = await signup(app, `usage-outsider-${suffix}@example.com`, password, `Usage Outsider Org ${suffix}`);
    outsiderCookie = outsider.sessionCookie;

    const empty = await signup(app, `usage-empty-${suffix}@example.com`, password, `Usage Empty Org ${suffix}`);
    emptyOrgCookie = empty.sessionCookie;
    emptyOrgId = empty.organizationId;

    await recordUsage({ organizationId, type: "CHAT_REQUEST", metadata: { conversationId: randomUUID() } });
    await recordUsage({ organizationId, type: "CHAT_PROMPT_TOKENS", metadata: { tokenCount: 300 } });
    await recordUsage({ organizationId, type: "CHAT_COMPLETION_TOKENS", metadata: { tokenCount: 450 } });
    await recordUsage({ organizationId, type: "EMBEDDING_TOKENS", metadata: { tokenCount: 8000 } });
  });

  afterAll(async () => {
    await app.close();
    await prisma.user.deleteMany({ where: { email: { contains: suffix } } });
    await prisma.organization.deleteMany({ where: { slug: { contains: suffix } } });
    await redis.quit();
  });

  it("returns aggregated totals and breakdown matching the recorded usage events", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/organizations/${organizationId}/usage`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body.period.from).toBeTruthy();
    expect(body.period.to).toBeTruthy();
    expect(body.totals.embeddingTokens).toBe(8000);
    expect(body.totals.completionTokens).toBe(450);
    expect(body.totals.requestCount).toBe(1);
    expect(body.totals.estimatedCost).toBeGreaterThan(0);

    const embeddingRow = body.breakdown.find((row: { eventType: string }) => row.eventType === "EMBEDDING_TOKENS");
    expect(embeddingRow.tokens).toBe(8000);
    expect(embeddingRow.cost).toBeGreaterThan(0);
  });

  it("returns a valid, empty response for an organization with no usage events", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/organizations/${emptyOrgId}/usage`,
      cookies: { [SESSION_COOKIE_NAME]: emptyOrgCookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.breakdown).toEqual([]);
    expect(body.nextCursor).toBeNull();
    expect(body.totals).toEqual({ embeddingTokens: 0, completionTokens: 0, requestCount: 0, estimatedCost: 0 });
  });

  it("returns 404 (not 403) for a non-member trying to query another organization's usage", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/organizations/${organizationId}/usage`,
      cookies: { [SESSION_COOKIE_NAME]: outsiderCookie },
    });

    expect(response.statusCode).toBe(404);
  });

  it("requires authentication", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/organizations/${organizationId}/usage`,
    });

    expect(response.statusCode).toBe(401);
  });

  it("paginates the breakdown with cursor/limit while totals still cover the full period", async () => {
    const firstPage = await app.inject({
      method: "GET",
      url: `/organizations/${organizationId}/usage?limit=2`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
    });
    const firstBody = firstPage.json();
    expect(firstBody.breakdown).toHaveLength(2);
    expect(firstBody.nextCursor).toBeTruthy();
    // Full-period totals, not just this page's two rows.
    expect(firstBody.totals.embeddingTokens).toBe(8000);

    const secondPage = await app.inject({
      method: "GET",
      url: `/organizations/${organizationId}/usage?limit=2&cursor=${firstBody.nextCursor}`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
    });
    const secondBody = secondPage.json();
    expect(secondBody.breakdown).toHaveLength(2);

    const firstIds = firstBody.breakdown.map((r: { date: string; eventType: string }) => `${r.date}|${r.eventType}`);
    const secondIds = secondBody.breakdown.map((r: { date: string; eventType: string }) => `${r.date}|${r.eventType}`);
    expect(firstIds.some((id: string) => secondIds.includes(id))).toBe(false);
  });

  it("rejects a `from` that is not before `to`", async () => {
    const now = new Date().toISOString();
    const response = await app.inject({
      method: "GET",
      url: `/organizations/${organizationId}/usage?from=${now}&to=${now}`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("BAD_REQUEST");
  });

  it("rejects a range wider than 366 days", async () => {
    const from = new Date(0).toISOString();
    const to = new Date().toISOString();
    const response = await app.inject({
      method: "GET",
      url: `/organizations/${organizationId}/usage?from=${from}&to=${to}`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("BAD_REQUEST");
  });
});
