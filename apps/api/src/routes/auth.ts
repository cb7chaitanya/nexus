import { ApiError, loginSchema, parseOrThrow, signupSchema } from "@raas/shared";
import { prisma, setTenantContext, withUserContext } from "@raas/db";
import type { FastifyInstance } from "fastify";

import { clearSessionCookie, setSessionCookie } from "../lib/cookies.js";
import { hashPassword, verifyPassword } from "../lib/passwords.js";
import { authRateLimit } from "../lib/rate-limit.js";
import { toPublicUser } from "../lib/serializers.js";
import { createSession, destroySession, resolveSession } from "../lib/session.js";
import { generateUniqueSlug } from "../lib/slugify.js";
import { requireAuth, SESSION_COOKIE_NAME } from "../plugins/auth-guard.js";

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/auth/signup", { preHandler: authRateLimit }, async (request, reply) => {
    const input = parseOrThrow(signupSchema, request.body);

    const existing = await prisma.user.findUnique({ where: { email: input.email } });
    if (existing) {
      throw ApiError.conflict("An account with this email already exists");
    }

    const passwordHash = await hashPassword(input.password);
    const slug = await generateUniqueSlug(
      input.organizationSlug ?? input.organizationName,
      async (candidate) => (await prisma.organization.findUnique({ where: { slug: candidate } })) !== null,
    );

    // Atomic: user, org, AND the owner membership are all created in ONE
    // transaction — a failure anywhere rolls back everything, so signup
    // is genuinely all-or-nothing, not "mostly atomic with a
    // compensating delete if the last step fails" (which still had a
    // real gap: a process crash between steps could orphan a user+org
    // with no owner and no way to clean it up). setTenantContext sets
    // app.current_org_id for the rest of THIS transaction using the org
    // id just created — withTenantTransaction can't be used here since
    // it always opens its own new transaction, and the org doesn't exist
    // yet before this one starts.
    const { user, organization } = await prisma.$transaction(async (tx) => {
      const createdUser = await tx.user.create({
        data: { email: input.email, passwordHash, name: input.name },
      });
      const createdOrg = await tx.organization.create({
        data: { name: input.organizationName, slug },
      });
      await setTenantContext(tx, createdOrg.id);
      await tx.organizationMember.create({
        data: { organizationId: createdOrg.id, userId: createdUser.id, role: "OWNER" },
      });
      return { user: createdUser, organization: createdOrg };
    });

    const session = await createSession(user.id);
    setSessionCookie(reply, session.token);

    reply.status(201).send({
      user: toPublicUser(user),
      organizations: [{ ...organization, role: "OWNER" as const }],
    });
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
