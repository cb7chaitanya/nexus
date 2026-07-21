/**
 * Integration tests against real Postgres + Redis via app.inject() — no
 * mocking of either. Prerequisites: docker compose up -d.
 */
import { randomUUID } from "node:crypto";

import { prisma } from "@raas/db";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../app.js";
import { redis } from "../lib/redis.js";
import { SESSION_COOKIE_NAME } from "../plugins/auth-guard.js";
import { signup } from "../test-support/signup.js";

describe("workspace routes", () => {
  let app: FastifyInstance;
  const suffix = randomUUID().slice(0, 8);
  const password = "correct-horse-battery-staple";

  let ownerCookie: string;
  let organizationId: string;
  let outsiderCookie: string;
  let memberCookie: string;

  beforeAll(async () => {
    app = await buildApp();

    const owner = await signup(app, `ws-owner-${suffix}@example.com`, password, `Workspace Org ${suffix}`);
    ownerCookie = owner.sessionCookie;
    organizationId = owner.organizationId;

    const outsider = await signup(app, `ws-outsider-${suffix}@example.com`, password, `Workspace Outsider Org ${suffix}`);
    outsiderCookie = outsider.sessionCookie;

    const invite = await app.inject({
      method: "POST",
      url: `/organizations/${organizationId}/invites`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      payload: { email: `ws-member-${suffix}@example.com`, role: "MEMBER" },
    });
    const { token } = invite.json();
    const memberSignup = await signup(app, `ws-member-${suffix}@example.com`, password, `Workspace Member Org ${suffix}`);
    memberCookie = memberSignup.sessionCookie;
    await app.inject({ method: "POST", url: `/invites/${token}/accept`, cookies: { [SESSION_COOKIE_NAME]: memberCookie } });
  });

  afterAll(async () => {
    await app.close();
    await prisma.user.deleteMany({ where: { email: { contains: suffix } } });
    await prisma.organization.deleteMany({ where: { slug: { contains: suffix } } });
    await redis.quit();
  });

  it("lets any member create a workspace, auto-generating a slug", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/organizations/${organizationId}/workspaces`,
      cookies: { [SESSION_COOKIE_NAME]: memberCookie },
      payload: { name: "Support Team" },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.name).toBe("Support Team");
    expect(body.slug).toBe("support-team");
    expect(body.organizationId).toBe(organizationId);
  });

  it("rejects workspace creation for an organization the caller isn't a member of", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/organizations/${organizationId}/workspaces`,
      cookies: { [SESSION_COOKIE_NAME]: outsiderCookie },
      payload: { name: "Sneaky Workspace" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("generates a unique slug on a collision", async () => {
    const first = await app.inject({
      method: "POST",
      url: `/organizations/${organizationId}/workspaces`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      payload: { name: "Engineering" },
    });
    const second = await app.inject({
      method: "POST",
      url: `/organizations/${organizationId}/workspaces`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      payload: { name: "Engineering" },
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(first.json().slug).not.toBe(second.json().slug);
  });

  it("lists workspaces for the organization, paginated", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/organizations/${organizationId}/workspaces`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
  });

  it("rejects listing workspaces for an organization the caller isn't a member of", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/organizations/${organizationId}/workspaces`,
      cookies: { [SESSION_COOKIE_NAME]: outsiderCookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it("lets an OWNER/ADMIN rename a workspace via PATCH", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/organizations/${organizationId}/workspaces`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      payload: { name: "Renamable" },
    });
    const workspaceId = created.json().id;

    const response = await app.inject({
      method: "PATCH",
      url: `/organizations/${organizationId}/workspaces/${workspaceId}`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      payload: { name: "Renamed" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().name).toBe("Renamed");
  });

  it("rejects PATCH from a plain MEMBER — requires ADMIN or higher", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/organizations/${organizationId}/workspaces`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      payload: { name: "Role Gated Workspace" },
    });
    const workspaceId = created.json().id;

    const response = await app.inject({
      method: "PATCH",
      url: `/organizations/${organizationId}/workspaces/${workspaceId}`,
      cookies: { [SESSION_COOKIE_NAME]: memberCookie },
      payload: { name: "Should Not Work" },
    });
    expect(response.statusCode).toBe(403);
  });

  it("returns 404 patching a workspace id that doesn't exist", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: `/organizations/${organizationId}/workspaces/${randomUUID()}`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      payload: { name: "Nonexistent" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("lets an OWNER/ADMIN delete a workspace", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/organizations/${organizationId}/workspaces`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      payload: { name: "Deletable" },
    });
    const workspaceId = created.json().id;

    const response = await app.inject({
      method: "DELETE",
      url: `/organizations/${organizationId}/workspaces/${workspaceId}`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
    });
    expect(response.statusCode).toBe(204);

    const listResponse = await app.inject({
      method: "GET",
      url: `/organizations/${organizationId}/workspaces`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
    });
    expect(listResponse.json().data.some((ws: { id: string }) => ws.id === workspaceId)).toBe(false);
  });

  it("rejects DELETE from a plain MEMBER — requires ADMIN or higher", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/organizations/${organizationId}/workspaces`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      payload: { name: "Delete Role Gated" },
    });
    const workspaceId = created.json().id;

    const response = await app.inject({
      method: "DELETE",
      url: `/organizations/${organizationId}/workspaces/${workspaceId}`,
      cookies: { [SESSION_COOKIE_NAME]: memberCookie },
    });
    expect(response.statusCode).toBe(403);
  });

  it("keeps workspaces fully isolated across organizations (tenant isolation)", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/organizations/${organizationId}/workspaces`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      payload: { name: "Tenant Isolated Workspace" },
    });
    const workspaceId = created.json().id;

    const patchAttempt = await app.inject({
      method: "PATCH",
      url: `/organizations/${organizationId}/workspaces/${workspaceId}`,
      cookies: { [SESSION_COOKIE_NAME]: outsiderCookie },
      payload: { name: "Hijacked" },
    });
    expect(patchAttempt.statusCode).toBe(404);
  });
});
