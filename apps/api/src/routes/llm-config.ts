import { encryptSecret, decryptSecret } from "@raas/crypto";
import { withTenantTransaction } from "@raas/db";
import { ApiError, setLlmConfigSchema, testLlmConfigSchema, parseOrThrow } from "@raas/shared";
import type { FastifyInstance } from "fastify";

import { env } from "../env.js";
import { testProviderConnection } from "../lib/llm-provider.js";
import { requireAuth, requireOrgMembership, requireRole } from "../plugins/auth-guard.js";

function toPublicLlmConfig(config: { provider: string; model: string; lastValidatedAt: Date | null; lastValidationError: string | null }) {
  const { provider, model, lastValidatedAt, lastValidationError } = config;
  // Never encryptedApiKey — the decrypted value is never sent to the
  // client after it's saved, same "write-only after creation" shape as
  // ApiKey.hashedKey, except here the reason is stronger: this key isn't
  // even ours to casually re-display, it's the customer's own OpenAI/
  // Anthropic/Groq credential.
  return { provider, model, lastValidatedAt, lastValidationError };
}

/**
 * Bring-your-own-LLM configuration (session-authenticated management
 * surface, ADMIN-or-higher — same bar as api-keys.ts, since this
 * redirects real spend and, for many orgs, is a data-residency/
 * compliance decision). Entirely optional: unless LLM_KEY_ENCRYPTION_SECRET
 * is set, these routes aren't registered at all — same "simply not there"
 * shape as billingRoutes/Google OAuth (see env.ts).
 *
 * OrganizationLlmConfig has a real RLS policy (see migration
 * 20260724204854_add_organization_llm_config) — every query here goes
 * through withTenantTransaction, scoped by the organizationId
 * requireOrgMembership already confirmed real membership for, same as
 * every other tenant-scoped route in this codebase.
 */
export async function llmConfigRoutes(app: FastifyInstance): Promise<void> {
  if (!env.LLM_KEY_ENCRYPTION_SECRET) {
    return;
  }

  app.get(
    "/organizations/:id/llm-config",
    { preHandler: [requireAuth, requireOrgMembership, requireRole("ADMIN")] },
    async (request, reply) => {
      const { id: organizationId } = request.params as { id: string };
      const config = await withTenantTransaction(organizationId, (tx) => tx.organizationLlmConfig.findUnique({ where: { organizationId } }));
      reply.send({ config: config ? toPublicLlmConfig(config) : null });
    },
  );

  app.patch(
    "/organizations/:id/llm-config",
    { preHandler: [requireAuth, requireOrgMembership, requireRole("ADMIN")] },
    async (request, reply) => {
      const { id: organizationId } = request.params as { id: string };
      const input = parseOrThrow(setLlmConfigSchema, request.body);

      // Never persisted unless this passes — a broken key is never
      // silently stored (see testProviderConnection's own doc comment).
      const result = await testProviderConnection(input.provider, input.model, input.apiKey);
      if (!result.ok) {
        throw ApiError.badRequest(`Could not connect with the provided key: ${result.message}`);
      }

      const now = new Date();
      const config = await withTenantTransaction(organizationId, (tx) =>
        tx.organizationLlmConfig.upsert({
          where: { organizationId },
          create: {
            organizationId,
            provider: input.provider,
            model: input.model,
            encryptedApiKey: encryptSecret(input.apiKey, env.LLM_KEY_ENCRYPTION_SECRET!),
            lastValidatedAt: now,
            lastValidationError: null,
          },
          update: {
            provider: input.provider,
            model: input.model,
            encryptedApiKey: encryptSecret(input.apiKey, env.LLM_KEY_ENCRYPTION_SECRET!),
            lastValidatedAt: now,
            lastValidationError: null,
          },
        }),
      );

      reply.send({ config: toPublicLlmConfig(config) });
    },
  );

  app.delete(
    "/organizations/:id/llm-config",
    { preHandler: [requireAuth, requireOrgMembership, requireRole("ADMIN")] },
    async (request, reply) => {
      const { id: organizationId } = request.params as { id: string };

      const existing = await withTenantTransaction(organizationId, (tx) => tx.organizationLlmConfig.findUnique({ where: { organizationId } }));
      if (existing) {
        await withTenantTransaction(organizationId, (tx) => tx.organizationLlmConfig.delete({ where: { organizationId } }));
      }

      // Idempotent, like DELETE /organizations/:id/api-keys/:keyId —
      // "already reverted to Nexus-managed" is success, not an error.
      reply.status(204).send();
    },
  );

  app.post(
    "/organizations/:id/llm-config/test",
    { preHandler: [requireAuth, requireOrgMembership, requireRole("ADMIN")] },
    async (request, reply) => {
      const { id: organizationId } = request.params as { id: string };
      const input = parseOrThrow(testLlmConfigSchema, request.body);

      const existing = await withTenantTransaction(organizationId, (tx) => tx.organizationLlmConfig.findUnique({ where: { organizationId } }));

      // No apiKey in the request means "re-test what's already saved" —
      // lets the UI offer a "Test connection" action on an existing
      // config without asking the admin to re-paste the key.
      let apiKey = input.apiKey;
      if (!apiKey) {
        if (!existing) {
          throw ApiError.badRequest("No saved configuration to test — provide an apiKey.");
        }
        apiKey = decryptSecret(existing.encryptedApiKey, env.LLM_KEY_ENCRYPTION_SECRET!);
      }

      const result = await testProviderConnection(input.provider, input.model, apiKey);

      // Re-testing an already-saved config records the result as this
      // config's current health status — this is the only place
      // lastValidatedAt/lastValidationError update outside of PATCH itself,
      // which is what makes the settings UI's health badge meaningful
      // ("as of the last time someone checked") rather than frozen at
      // whatever it was when the key was first saved.
      if (existing && existing.provider === input.provider && existing.model === input.model) {
        await withTenantTransaction(organizationId, (tx) =>
          tx.organizationLlmConfig.update({
            where: { organizationId },
            data: { lastValidatedAt: new Date(), lastValidationError: result.ok ? null : result.message },
          }),
        );
      }

      reply.send(result);
    },
  );
}

