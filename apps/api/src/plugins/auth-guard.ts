import { ApiError } from "@raas/shared";
import type { OrgRole } from "@raas/db";
import type { FastifyReply, FastifyRequest } from "fastify";

import { requireMembership } from "../lib/membership.js";
import { resolveSession, type AuthenticatedSession } from "../lib/session.js";
import { hasAtLeastRole } from "../lib/roles.js";

export const SESSION_COOKIE_NAME = "raas_session";

declare module "fastify" {
  interface FastifyRequest {
    userId?: string;
    sessionId?: string;
    membership?: { organizationId: string; role: OrgRole };
  }
}

/**
 * Requires a valid, non-revoked session. Decorates request.userId /
 * request.sessionId on success. This is the ONLY place a cookie is read
 * and turned into an identity — every protected route depends on this
 * having run first, never re-implements session resolution itself.
 */
export async function requireAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const session = await resolveSessionFromRequest(request);
  if (!session) {
    throw ApiError.unauthorized();
  }

  request.userId = session.userId;
  request.sessionId = session.sessionId;
  // Every log line for the rest of this request should carry userId —
  // never the session token/cookie itself, only the id (see
  // @raas/logger's LogBindings and app.ts's requestIdLogLabel).
  request.log = request.log.child({ userId: session.userId });
}

/**
 * Reads every value for SESSION_COOKIE_NAME directly off the raw Cookie
 * header and tries each until one resolves to a live session, rather than
 * trusting request.cookies (Fastify's parsed view, which only exposes one
 * value per name — whichever its parser happens to pick when a name
 * repeats). A repeat happens for any browser still carrying a session
 * cookie from before SESSION_COOKIE_DOMAIN existed (see cookies.ts):
 * that old host-only cookie and the current domain-scoped one are both
 * sent, under the same name, on every request to this API's own host —
 * but NOT to apps/web's host, which only ever matches the domain-scoped
 * one. That asymmetry is exactly what made getServerSession() (web)
 * consistently disagree with requireAuth (api, via the old single-value
 * read) for the same browser, which is what turned one stale cookie into
 * a permanent redirect loop between /login and /dashboard for anyone
 * carrying one — trying every candidate here breaks that outright,
 * immediately, with no login/logout round trip required.
 */
async function resolveSessionFromRequest(request: FastifyRequest): Promise<AuthenticatedSession | null> {
  const rawCookieHeader = request.headers.cookie;
  if (!rawCookieHeader) return null;

  const prefix = `${SESSION_COOKIE_NAME}=`;
  const candidates = rawCookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(prefix))
    .map((part) => decodeURIComponent(part.slice(prefix.length)));

  for (const token of candidates) {
    const session = await resolveSession(token);
    if (session) return session;
  }
  return null;
}

/**
 * Requires the caller to be a member of the :id organization in the
 * route params. Decorates request.membership on success. Deliberately
 * returns 404 (not 403) when the caller has no membership row — whether
 * that's because the org doesn't exist or because they're just not a
 * member is not something a non-member should be able to distinguish.
 * Must run after requireAuth.
 */
export async function requireOrgMembership(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!request.userId) {
    throw ApiError.unauthorized();
  }

  const organizationId = (request.params as { id?: string }).id;
  if (!organizationId) {
    throw ApiError.notFound("Organization not found");
  }

  const role = await requireMembership(request, organizationId, request.userId);
  request.membership = { organizationId, role };
}

/**
 * Factory for a preHandler requiring at least `minRole` in the org
 * resolved by requireOrgMembership. Must run after requireOrgMembership.
 */
export function requireRole(minRole: OrgRole) {
  // Must be async (or otherwise return a promise) even though it does no
  // I/O: Fastify's preHandler hook runner always invokes the hook as
  // fn(request, reply, next) and only knows a *synchronous* hook is done
  // when the hook itself calls that `next` — a plain function that just
  // returns undefined (our earlier, non-async version) makes every request
  // hang until Fastify's own timeout, since nothing ever signals
  // completion. Returning a promise is what the runner actually waits on.
  return async function requireRolePreHandler(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    if (!request.membership) {
      throw ApiError.unauthorized();
    }
    if (!hasAtLeastRole(request.membership.role, minRole)) {
      throw ApiError.forbidden(`This action requires the ${minRole} role or higher`);
    }
  };
}
