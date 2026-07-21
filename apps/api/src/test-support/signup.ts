/**
 * Shared test helper: drives the full signup -> OTP verify flow (see
 * routes/auth.ts) and returns a logged-in session. POST /auth/signup no
 * longer creates a session directly, so every route test that needs an
 * authenticated user now needs this two-step flow instead of reading a
 * cookie straight off the signup response — pulled out once here rather
 * than duplicated per test file (every route test file used to declare
 * an identical local `signup()` helper against the old contract).
 *
 * Reads the OTP straight off the email-delivery queue rather than a real
 * inbox — no worker process runs in this test suite (see auth.test.ts's
 * own getLatestOtpFor, which this mirrors).
 */
import { JOB_NAMES, QUEUE_NAMES } from "@raas/shared";
import { Queue } from "bullmq";
import type { FastifyInstance } from "fastify";

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

export interface SignupResult {
  sessionCookie: string;
  userId: string;
  organizationId: string;
}

export async function signup(app: FastifyInstance, email: string, password: string, organizationName: string): Promise<SignupResult> {
  const signupResponse = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { email, password, organizationName },
  });
  const { pendingSignupId } = signupResponse.json() as { pendingSignupId: string };
  const otp = await getLatestOtpFor(email);

  const verifyResponse = await app.inject({
    method: "POST",
    url: "/auth/signup/verify",
    payload: { pendingSignupId, code: otp },
  });
  const cookie = verifyResponse.cookies.find((c) => c.name === SESSION_COOKIE_NAME);
  const body = verifyResponse.json();
  return { sessionCookie: cookie!.value, userId: body.user.id, organizationId: body.organizations[0].id };
}
