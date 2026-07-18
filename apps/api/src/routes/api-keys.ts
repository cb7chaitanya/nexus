import { ApiError, createApiKeySchema, listApiKeysQuerySchema, parseOrThrow } from "@raas/shared";
import { withTenantTransaction } from "@raas/db";
import type { FastifyInstance } from "fastify";

import { generateApiKey, hashApiKey } from "../lib/api-keys.js";
import { paginate } from "../lib/pagination.js";
import { requireAuth, requireOrgMembership, requireRole } from "../plugins/auth-guard.js";

/** Never the hash, never the raw key — the public shape every response
 * below returns. */
function toPublicApiKey(key: {
  id: string;
  name: string;
  prefix: string;
  createdBy: string | null;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}) {
  const { id, name, prefix, createdBy, lastUsedAt, expiresAt, revokedAt, createdAt } = key;
  return { id, name, prefix, createdBy, lastUsedAt, expiresAt, revokedAt, createdAt };
}

/**
 * API key management (docs/architecture.md's "API keys" section) — the
 * session-authenticated create/list/revoke surface only. The
 * API-key-AUTHENTICATED public request path (architecture.md's "Public
 * API" section, /v1/...) is a separate concern (see
 * plugins/api-key-auth.ts's requireApiKeyAuth and routes/v1.ts) — this
 * file is only ever reached via a session (requireAuth), never a bearer
 * token.
 *
 * ApiKey has a real RLS policy (see migration 20260718100000_add_apikey_rls)
 * — every query here goes through withTenantTransaction, scoped by the
 * organizationId requireOrgMembership already confirmed real membership
 * for, same as every other tenant-scoped route in this codebase.
 */
export async function apiKeyRoutes(app: FastifyInstance): Promise<void> {
  // ADMIN-or-higher on every route — API keys grant programmatic access
  // to the whole organization, a higher-privilege resource than a KB or
  // workspace, matching the bar POST /organizations/:id/invites already
  // sets for a comparable secret-issuing action.
  app.post(
    "/organizations/:id/api-keys",
    { preHandler: [requireAuth, requireOrgMembership, requireRole("ADMIN")] },
    async (request, reply) => {
      const { id: organizationId } = request.params as { id: string };
      const input = parseOrThrow(createApiKeySchema, request.body);
      const userId = request.userId;
      if (!userId) throw ApiError.unauthorized();

      const { raw, prefix } = generateApiKey();
      const apiKey = await withTenantTransaction(organizationId, (tx) =>
        tx.apiKey.create({
          data: {
            organizationId,
            name: input.name,
            hashedKey: hashApiKey(raw),
            prefix,
            createdBy: userId,
            expiresAt: input.expiresAt,
          },
        }),
      );

      // The only time `raw` is ever returned — never stored, never
      // retrievable again after this response (see schema.prisma's
      // comment on the model).
      reply.status(201).send({ apiKey: toPublicApiKey(apiKey), key: raw });
    },
  );

  app.get(
    "/organizations/:id/api-keys",
    { preHandler: [requireAuth, requireOrgMembership, requireRole("ADMIN")] },
    async (request, reply) => {
      const { id: organizationId } = request.params as { id: string };
      const input = parseOrThrow(listApiKeysQuerySchema, request.query);

      const apiKeys = await withTenantTransaction(organizationId, (tx) =>
        tx.apiKey.findMany({
          orderBy: { createdAt: "asc" },
          take: input.limit,
          ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        }),
      );

      reply.send(paginate(apiKeys.map(toPublicApiKey), input.limit));
    },
  );

  app.delete(
    "/organizations/:id/api-keys/:keyId",
    { preHandler: [requireAuth, requireOrgMembership, requireRole("ADMIN")] },
    async (request, reply) => {
      const { id: organizationId, keyId } = request.params as { id: string; keyId: string };

      const existing = await withTenantTransaction(organizationId, (tx) => tx.apiKey.findUnique({ where: { id: keyId } }));
      if (!existing) {
        throw ApiError.notFound("API key not found");
      }

      // Idempotent: revoking an already-revoked key preserves the
      // original revokedAt rather than overwriting it with a later
      // timestamp, but still returns success either way.
      if (!existing.revokedAt) {
        await withTenantTransaction(organizationId, (tx) => tx.apiKey.update({ where: { id: keyId }, data: { revokedAt: new Date() } }));
      }

      reply.status(204).send();
    },
  );
}
