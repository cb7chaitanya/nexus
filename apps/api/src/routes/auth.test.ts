/**
 * Integration tests against real Postgres + Redis via app.inject() — no
 * mocking of either. Prerequisites: docker compose up -d, migrations
 * applied (pnpm --filter @raas/db migrate:deploy).
 *
 * Signup no longer creates a session directly (see routes/auth.ts) — it
 * enqueues an OTP email job instead of sending one (no worker process
 * runs in this suite), so tests read the code straight off the
 * email-delivery queue rather than consuming a real inbox.
 */
import { randomUUID } from "node:crypto";

import { JOB_NAMES, QUEUE_NAMES } from "@raas/shared";
import { prisma } from "@raas/db";
import { Queue } from "bullmq";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../app.js";
import { redis } from "../lib/redis.js";
import { SESSION_COOKIE_NAME } from "../plugins/auth-guard.js";

const emailQueue = new Queue(QUEUE_NAMES.email, { connection: redis });

async function getLatestOtpFor(email: string): Promise<string> {
  const jobs = await emailQueue.getJobs(["waiting", "completed"]);
  const match = jobs
    .filter((job) => job.name === JOB_NAMES.sendTransactionalEmail && job.data.to === email)
    .sort((a, b) => b.timestamp - a.timestamp)[0];
  if (!match) throw new Error(`no OTP email job found for ${email}`);
  const otpMatch = (match.data.text as string).match(/verification code is (\d{6})/);
  if (!otpMatch) throw new Error(`could not find a 6-digit code in email body: ${match.data.text}`);
  return otpMatch[1]!;
}

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
    await emailQueue.close();
    await redis.quit();
  });

  it("stages a pending signup and emails an OTP, without creating a session", async () => {
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

    expect(response.statusCode).toBe(202);
    const body = response.json();
    expect(body.pendingSignupId).toBeTruthy();
    expect(body.email).toBe(email);
    expect(response.cookies.find((c) => c.name === SESSION_COOKIE_NAME)).toBeUndefined();
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
  });

  it("rejects the wrong code and reports attempts remaining, then accepts the right one", async () => {
    const signup = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { email: `otp-${suffix}@example.com`, password, organizationName: `OTP Org ${suffix}` },
    });
    const { pendingSignupId } = signup.json();
    const otp = await getLatestOtpFor(`otp-${suffix}@example.com`);

    const wrong = await app.inject({
      method: "POST",
      url: "/auth/signup/verify",
      payload: { pendingSignupId, code: otp === "000000" ? "111111" : "000000" },
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error.message).toContain("attempt(s) remaining");

    const right = await app.inject({
      method: "POST",
      url: "/auth/signup/verify",
      payload: { pendingSignupId, code: otp },
    });
    expect(right.statusCode).toBe(201);
    const body = right.json();
    expect(body.user.email).toBe(`otp-${suffix}@example.com`);
    expect(body.user.emailVerified).toBe(true);
    expect(body.organizations[0].role).toBe("OWNER");
    const cookie = right.cookies.find((c) => c.name === SESSION_COOKIE_NAME);
    expect(cookie).toBeDefined();
    expect(cookie?.httpOnly).toBe(true);
  });

  it("locks out and expires the pending signup after too many wrong attempts", async () => {
    const signup = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { email: `lockout-${suffix}@example.com`, password, organizationName: `Lockout Org ${suffix}` },
    });
    const { pendingSignupId } = signup.json();

    let last;
    for (let i = 0; i < 6; i++) {
      last = await app.inject({
        method: "POST",
        url: "/auth/signup/verify",
        payload: { pendingSignupId, code: "000001" },
      });
    }
    expect(last!.statusCode).toBe(401);
    expect(last!.json().error.message).toContain("Please sign up again");

    const afterLockout = await app.inject({
      method: "POST",
      url: "/auth/signup/verify",
      payload: { pendingSignupId, code: "000001" },
    });
    expect(afterLockout.statusCode).toBe(404);
  });

  it("rejects verification for an unknown or expired pendingSignupId", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/auth/signup/verify",
      payload: { pendingSignupId: randomUUID(), code: "123456" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("resend-otp issues a new code that invalidates the old one", async () => {
    const signup = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { email: `resend-${suffix}@example.com`, password, organizationName: `Resend Org ${suffix}` },
    });
    const { pendingSignupId } = signup.json();
    const firstOtp = await getLatestOtpFor(`resend-${suffix}@example.com`);

    const resend = await app.inject({ method: "POST", url: "/auth/signup/resend-otp", payload: { pendingSignupId } });
    expect(resend.statusCode).toBe(202);
    const secondOtp = await getLatestOtpFor(`resend-${suffix}@example.com`);
    expect(secondOtp).not.toBe(firstOtp);

    const withOldCode = await app.inject({
      method: "POST",
      url: "/auth/signup/verify",
      payload: { pendingSignupId, code: firstOtp },
    });
    expect(withOldCode.statusCode).toBe(401);

    const withNewCode = await app.inject({
      method: "POST",
      url: "/auth/signup/verify",
      payload: { pendingSignupId, code: secondOtp },
    });
    expect(withNewCode.statusCode).toBe(201);
  });

  it("rejects signup with an email that's already a completed account", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { email: `otp-${suffix}@example.com`, password, organizationName: `Dup Org ${suffix}` },
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
      payload: { email: `otp-${suffix}@example.com`, password },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.user.email).toBe(`otp-${suffix}@example.com`);
    expect(body.organizations).toHaveLength(1);
  });

  it("rejects a wrong password and an unknown email with the identical message", async () => {
    const wrongPassword = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: `otp-${suffix}@example.com`, password: "wrong-password-entirely" },
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
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: `otp-${suffix}@example.com`, password },
    });
    const sessionCookie = login.cookies.find((c) => c.name === SESSION_COOKIE_NAME);

    const response = await app.inject({
      method: "GET",
      url: "/auth/me",
      cookies: { [SESSION_COOKIE_NAME]: sessionCookie!.value },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.user.email).toBe(`otp-${suffix}@example.com`);
    expect(body.organizations).toHaveLength(1);
  });

  it("rejects /auth/me with no session cookie", async () => {
    const response = await app.inject({ method: "GET", url: "/auth/me" });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("UNAUTHORIZED");
  });

  it("logs out, revoking the session so it can no longer be used", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: `otp-${suffix}@example.com`, password },
    });
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

  it("does not register the Google OAuth routes when GOOGLE_CLIENT_ID is unset", async () => {
    // This suite's env (see root .env) leaves GOOGLE_CLIENT_ID unset —
    // real coverage of the configured path needs a real Google OAuth
    // client (see google-oauth.test.ts for the pure PKCE/state helpers).
    const start = await app.inject({ method: "GET", url: "/auth/google" });
    expect(start.statusCode).toBe(404);
    const callback = await app.inject({ method: "GET", url: "/auth/google/callback" });
    expect(callback.statusCode).toBe(404);
  });
});
