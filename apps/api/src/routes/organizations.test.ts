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

describe("organization routes", () => {
  let app: FastifyInstance;
  const suffix = randomUUID().slice(0, 8);
  const password = "correct-horse-battery-staple";

  const ownerEmail = `owner-${suffix}@example.com`;
  const memberEmail = `member-${suffix}@example.com`;
  const outsiderEmail = `outsider-${suffix}@example.com`;

  let ownerCookie: string;
  let ownerId: string;
  let organizationId: string;
  let outsiderCookie: string;

  beforeAll(async () => {
    app = await buildApp();

    const owner = await signup(app, ownerEmail, password, `Org ${suffix}`);
    ownerCookie = owner.sessionCookie;
    ownerId = owner.userId;
    organizationId = owner.organizationId;

    const outsider = await signup(app, outsiderEmail, password, `Outsider Org ${suffix}`);
    outsiderCookie = outsider.sessionCookie;
  });

  afterAll(async () => {
    await app.close();
    await prisma.user.deleteMany({ where: { email: { contains: suffix } } });
    await prisma.organization.deleteMany({ where: { slug: { contains: suffix } } });
    await redis.quit();
  });

  it("lists organizations for the caller", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/organizations",
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.organizations.some((o: { id: string }) => o.id === organizationId)).toBe(true);
  });

  it("returns 404 (not 403) for a non-member trying to view org members", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/organizations/${organizationId}/members`,
      cookies: { [SESSION_COOKIE_NAME]: outsiderCookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it("lets the owner view members of their own org", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/organizations/${organizationId}/members`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().members).toHaveLength(1);
  });

  let inviteToken: string;

  it("lets an owner invite a new member", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/organizations/${organizationId}/invites`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      payload: { email: memberEmail, role: "MEMBER" },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.token).toBeTruthy();
    inviteToken = body.token;
  });

  it("rejects inviting a new OWNER via the invite endpoint", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/organizations/${organizationId}/invites`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      payload: { email: `another-${suffix}@example.com`, role: "OWNER" },
    });
    expect(response.statusCode).toBe(422);
  });

  it("forbids a non-admin... — outsider is not even a member, so invites 404s", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/organizations/${organizationId}/invites`,
      cookies: { [SESSION_COOKIE_NAME]: outsiderCookie },
      payload: { email: `whoever-${suffix}@example.com`, role: "MEMBER" },
    });
    expect(response.statusCode).toBe(404);
  });

  let memberCookie: string;
  let memberUserId: string;

  it("lets the invited user sign up and accept the invite", async () => {
    const signedUp = await signup(app, memberEmail, password, `Member Personal Org ${suffix}`);
    memberCookie = signedUp.sessionCookie;
    memberUserId = signedUp.userId;

    const accept = await app.inject({
      method: "POST",
      url: `/invites/${inviteToken}/accept`,
      cookies: { [SESSION_COOKIE_NAME]: memberCookie },
    });
    expect(accept.statusCode).toBe(201);
    expect(accept.json().role).toBe("MEMBER");
    expect(accept.json().organizationId).toBe(organizationId);
  });

  it("accepting the same invite again is idempotent", async () => {
    const accept = await app.inject({
      method: "POST",
      url: `/invites/${inviteToken}/accept`,
      cookies: { [SESSION_COOKIE_NAME]: memberCookie },
    });
    expect(accept.statusCode).toBe(200);
    expect(accept.json().role).toBe("MEMBER");
  });

  it("rejects invite acceptance from a mismatched email", async () => {
    const invite = await app.inject({
      method: "POST",
      url: `/organizations/${organizationId}/invites`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      payload: { email: `someone-else-${suffix}@example.com`, role: "MEMBER" },
    });
    const token = invite.json().token;

    const accept = await app.inject({
      method: "POST",
      url: `/invites/${token}/accept`,
      cookies: { [SESSION_COOKIE_NAME]: outsiderCookie },
    });
    expect(accept.statusCode).toBe(403);
  });

  it("forbids a MEMBER from changing anyone's role", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: `/organizations/${organizationId}/members/${memberUserId}`,
      cookies: { [SESSION_COOKIE_NAME]: memberCookie },
      payload: { role: "ADMIN" },
    });
    expect(response.statusCode).toBe(403);
  });

  it("lets the owner promote the member to ADMIN", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: `/organizations/${organizationId}/members/${memberUserId}`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      payload: { role: "ADMIN" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().role).toBe("ADMIN");
  });

  it("forbids the new ADMIN from granting themselves OWNER", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: `/organizations/${organizationId}/members/${memberUserId}`,
      cookies: { [SESSION_COOKIE_NAME]: memberCookie },
      payload: { role: "OWNER" },
    });
    expect(response.statusCode).toBe(403);
  });

  it("prevents demoting the last remaining owner, even by themselves", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: `/organizations/${organizationId}/members/${ownerId}`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
      payload: { role: "ADMIN" },
    });
    expect(response.statusCode).toBe(409);
  });

  it("prevents removing the last remaining owner, even by themselves", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: `/organizations/${organizationId}/members/${ownerId}`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
    });
    expect(response.statusCode).toBe(409);
  });

  it("lets the ADMIN remove themselves from the organization", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: `/organizations/${organizationId}/members/${memberUserId}`,
      cookies: { [SESSION_COOKIE_NAME]: memberCookie },
    });
    expect(response.statusCode).toBe(204);

    const members = await app.inject({
      method: "GET",
      url: `/organizations/${organizationId}/members`,
      cookies: { [SESSION_COOKIE_NAME]: ownerCookie },
    });
    expect(members.json().members).toHaveLength(1);
  });

  it("keeps organization membership isolated across tenants through the API", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/organizations/${organizationId}/members`,
      cookies: { [SESSION_COOKIE_NAME]: outsiderCookie },
    });
    expect(response.statusCode).toBe(404);
  });
});
