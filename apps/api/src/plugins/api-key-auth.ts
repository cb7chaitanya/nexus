import { ApiError } from "@raas/shared";
import { withApiKeyLookup } from "@raas/db";
import type { FastifyReply, FastifyRequest } from "fastify";

import { hashApiKey, recordApiKeyUsage } from "../lib/api-keys.js";

const BEARER_PREFIX = "Bearer ";

declare module "fastify" {
  interface FastifyRequest {
    apiKeyId?: string;
    apiKeyOrganizationId?: string;
  }
}

/**
 * Requires a valid, non-revoked, non-expired API key via
 * `Authorization: Bearer <api_key>`. Decorates request.apiKeyId /
 * request.apiKeyOrganizationId on success — the bearer-token equivalent
 * of requireAuth's request.userId/request.sessionId (see auth-guard.ts).
 * A fully separate mechanism: never reads the session cookie, and never
 * runs on a route that only uses requireAuth. Does NOT weaken or touch
 * cookie authentication in any way — this is purely additive.
 *
 * Unlike every session-authenticated route (which takes an explicit
 * organizationId and confirms membership via requireMembership), a
 * bearer token IS the tenant context: the organization a key belongs to
 * is resolved FROM the key itself, not asserted by the caller and then
 * cross-checked. There is nothing to check it against except the row the
 * token's own hash resolves to — which is exactly why a caller holding an
 * org A key can never resolve an org B key's organizationId no matter
 * what URL param it sends: the URL never enters into this resolution at
 * all.
 *
 * "Set tenant transaction context" (this ticket's flow) happens inside
 * the lookup itself, via withApiKeyLookup — a real, scoped Postgres
 * transaction (the ApiKey-table analogue of withUserContext's session-auth
 * self-lookup, see packages/db/src/tenant.ts). It does not stay open past
 * this preHandler returning; a preHandler cannot hand a live transaction
 * across to the route handler that runs after it. The handler opens its
 * own withTenantTransaction(request.apiKeyOrganizationId, ...) afterward,
 * exactly like every other tenant-scoped route in this codebase (see
 * routes/v1.ts).
 */
export async function requireApiKeyAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const header = request.headers.authorization;
  const token = header?.startsWith(BEARER_PREFIX) ? header.slice(BEARER_PREFIX.length).trim() : undefined;
  if (!token) {
    throw ApiError.unauthorized();
  }

  const hashedKey = hashApiKey(token);
  const apiKey = await withApiKeyLookup(hashedKey, (tx) => tx.apiKey.findUnique({ where: { hashedKey } }));

  // An unknown key, a revoked key, and an expired key all read back as
  // the same 401 — same "don't let a caller distinguish these" reasoning
  // requireAuth and requireMembership already apply elsewhere in this
  // file's sibling guards, not three differently-shaped errors that could
  // help an attacker enumerate which case they hit.
  if (!apiKey || apiKey.revokedAt || (apiKey.expiresAt !== null && apiKey.expiresAt.getTime() <= Date.now())) {
    throw ApiError.unauthorized();
  }

  request.apiKeyId = apiKey.id;
  request.apiKeyOrganizationId = apiKey.organizationId;
  // Every log line for the rest of this request should carry
  // organizationId/apiKeyId — never the raw key or its hash (see
  // @raas/logger's LogBindings and app.ts's requestIdLogLabel).
  request.log = request.log.child({ organizationId: apiKey.organizationId, apiKeyId: apiKey.id });

  // Best-effort — per recordApiKeyUsage's own doc comment, must never
  // fail the request that was actually using the key.
  await recordApiKeyUsage(apiKey.organizationId, apiKey.id).catch((err: unknown) => {
    request.log.warn({ err }, "failed to record API key usage");
  });
}
