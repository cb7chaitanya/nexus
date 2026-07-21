import {
  ApiError,
  loginSchema,
  parseOrThrow,
  resendSignupOtpSchema,
  signupSchema,
  verifySignupOtpSchema,
} from "@raas/shared";
import { prisma, setTenantContext, withUserContext } from "@raas/db";
import type { FastifyInstance } from "fastify";

import { env } from "../env.js";
import { clearSessionCookie, setSessionCookie } from "../lib/cookies.js";
import { buildSignupOtpEmail } from "../lib/email-templates.js";
import { enqueueTransactionalEmail } from "../lib/email-queue.js";
import { hashOtp } from "../lib/otp.js";
import { hashPassword, verifyPassword } from "../lib/passwords.js";
import {
  consumePendingSignup,
  getPendingSignup,
  recordFailedAttempt,
  refreshOtp,
  createPendingSignup,
} from "../lib/pending-signup.js";
import { authRateLimit } from "../lib/rate-limit.js";
import { toPublicUser } from "../lib/serializers.js";
import { createSession, destroySession, resolveSession } from "../lib/session.js";
import { generateUniqueSlug } from "../lib/slugify.js";
import { requireAuth, SESSION_COOKIE_NAME } from "../plugins/auth-guard.js";

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // Stages the signup and emails a 6-digit code — does NOT create the
  // User/Organization or a session. See lib/pending-signup.ts for why
  // this lives in Redis rather than a Postgres table.
  app.post("/auth/signup", { preHandler: authRateLimit }, async (request, reply) => {
    const input = parseOrThrow(signupSchema, request.body);

    const existing = await prisma.user.findUnique({ where: { email: input.email } });
    if (existing) {
      throw ApiError.conflict("An account with this email already exists");
    }

    const passwordHash = await hashPassword(input.password);
    const { pendingSignupId, otp } = await createPendingSignup({
      email: input.email,
      passwordHash,
      name: input.name,
      organizationName: input.organizationName,
      organizationSlug: input.organizationSlug,
    });

    const email = buildSignupOtpEmail({ name: input.name, otp });
    await enqueueTransactionalEmail({ to: input.email, ...email });

    reply.status(202).send({
      pendingSignupId,
      email: input.email,
      expiresInSeconds: env.SIGNUP_OTP_TTL_SECONDS,
    });
  });

  // Completes a pending signup: verifies the code, THEN creates the
  // User/Organization/OWNER-membership (same atomic transaction the old
  // signup handler ran inline) with emailVerified already true, and logs
  // the new user in.
  app.post("/auth/signup/verify", { preHandler: authRateLimit }, async (request, reply) => {
    const input = parseOrThrow(verifySignupOtpSchema, request.body);

    const record = await getPendingSignup(input.pendingSignupId);
    if (!record) {
      throw ApiError.notFound("This signup has expired. Please sign up again.");
    }

    if (record.attempts >= env.MAX_OTP_ATTEMPTS) {
      await consumePendingSignup(input.pendingSignupId);
      throw ApiError.unauthorized("Too many incorrect attempts. Please sign up again.");
    }

    if (hashOtp(input.code) !== record.hashedOtp) {
      await recordFailedAttempt(input.pendingSignupId, record);
      const remaining = env.MAX_OTP_ATTEMPTS - (record.attempts + 1);
      throw ApiError.unauthorized(
        remaining > 0 ? `Incorrect code. ${remaining} attempt(s) remaining.` : "Incorrect code. Please sign up again.",
      );
    }

    // Re-check for a conflicting email here too — another signup for the
    // same address could have completed verification first during this
    // one's OTP wait window.
    const existing = await prisma.user.findUnique({ where: { email: record.email } });
    if (existing) {
      await consumePendingSignup(input.pendingSignupId);
      throw ApiError.conflict("An account with this email already exists");
    }

    const slug = await generateUniqueSlug(
      record.organizationSlug ?? record.organizationName,
      async (candidate) => (await prisma.organization.findUnique({ where: { slug: candidate } })) !== null,
    );

    const { user, organization } = await prisma.$transaction(async (tx) => {
      const createdUser = await tx.user.create({
        data: { email: record.email, passwordHash: record.passwordHash, name: record.name, emailVerified: true },
      });
      const createdOrg = await tx.organization.create({
        data: { name: record.organizationName, slug },
      });
      await setTenantContext(tx, createdOrg.id);
      await tx.organizationMember.create({
        data: { organizationId: createdOrg.id, userId: createdUser.id, role: "OWNER" },
      });
      return { user: createdUser, organization: createdOrg };
    });

    await consumePendingSignup(input.pendingSignupId);

    const session = await createSession(user.id);
    setSessionCookie(reply, session.token);

    reply.status(201).send({
      user: toPublicUser(user),
      organizations: [{ ...organization, role: "OWNER" as const }],
    });
  });

  app.post("/auth/signup/resend-otp", { preHandler: authRateLimit }, async (request, reply) => {
    const input = parseOrThrow(resendSignupOtpSchema, request.body);

    const record = await getPendingSignup(input.pendingSignupId);
    if (!record) {
      throw ApiError.notFound("This signup has expired. Please sign up again.");
    }

    const { otp } = await refreshOtp(input.pendingSignupId, record);
    const email = buildSignupOtpEmail({ name: record.name, otp });
    await enqueueTransactionalEmail({ to: record.email, ...email });

    reply.status(202).send({ expiresInSeconds: env.SIGNUP_OTP_TTL_SECONDS });
  });

  app.post("/auth/login", { preHandler: authRateLimit }, async (request, reply) => {
    const input = parseOrThrow(loginSchema, request.body);

    // Same generic error for "no such user" and "wrong password" — a
    // distinct message for either would let a caller enumerate registered
    // emails.
    const invalidCredentials = (): ApiError => ApiError.unauthorized("Invalid email or password");

    const user = await prisma.user.findUnique({ where: { email: input.email } });
    if (!user || !user.passwordHash) {
      throw invalidCredentials();
    }

    const validPassword = await verifyPassword(user.passwordHash, input.password);
    if (!validPassword) {
      throw invalidCredentials();
    }

    const session = await createSession(user.id);
    setSessionCookie(reply, session.token);

    const memberships = await withUserContext(user.id, (tx) => tx.organizationMember.findMany({ include: { organization: true } }));

    reply.send({
      user: toPublicUser(user),
      organizations: memberships.map((m) => ({ ...m.organization, role: m.role })),
    });
  });

  app.post("/auth/logout", async (request, reply) => {
    // Deliberately not gated by requireAuth — logging out with no/expired
    // session must still succeed from the client's perspective, not 401.
    const token = request.cookies[SESSION_COOKIE_NAME];
    if (token) {
      const session = await resolveSession(token);
      if (session) {
        await destroySession(session.sessionId);
      }
    }
    clearSessionCookie(reply);
    reply.send({ success: true });
  });

  app.get("/auth/me", { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      throw ApiError.unauthorized();
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw ApiError.unauthorized();
    }

    const memberships = await withUserContext(userId, (tx) => tx.organizationMember.findMany({ include: { organization: true } }));

    reply.send({
      user: toPublicUser(user),
      organizations: memberships.map((m) => ({ ...m.organization, role: m.role })),
    });
  });
}
