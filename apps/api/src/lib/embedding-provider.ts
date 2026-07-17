import { type EmbeddingProvider, FakeEmbeddingProvider, OpenAIEmbeddingProvider } from "@raas/providers";
import { getOrganizationDailyLimit, withEmbeddingBudgetGuard } from "@raas/usage";

import { env } from "../env.js";
import { rateLimiter } from "./rate-limit.js";

// Module-level singleton, same convention as apps/worker/src/lib/embedding-provider.ts
// (which this mirrors) — one provider instance per process, not
// re-constructed per request.
let provider: EmbeddingProvider | undefined;

export function getEmbeddingProvider(): EmbeddingProvider {
  if (!provider) {
    provider =
      env.EMBEDDING_PROVIDER === "fake"
        ? new FakeEmbeddingProvider({ delayMs: env.FAKE_EMBEDDING_DELAY_MS })
        : new OpenAIEmbeddingProvider({ apiKey: env.OPENAI_API_KEY, model: "text-embedding-3-small", batchSize: env.OPENAI_EMBEDDING_BATCH_SIZE });
  }
  return provider;
}

/**
 * The embedding provider wrapped with a pre-flight daily budget check
 * (see @raas/usage's withEmbeddingBudgetGuard) for `organizationId` —
 * used for chat's per-query embedding call (see routes/chat.ts). Resolved
 * fresh per call, not cached like getEmbeddingProvider() itself: the
 * organization's ceiling can differ per caller and per request, unlike
 * the underlying provider instance, which is genuinely process-wide.
 */
export async function getBudgetGuardedEmbeddingProvider(organizationId: string): Promise<EmbeddingProvider> {
  const dailyTokenLimit = await getOrganizationDailyLimit(
    organizationId,
    "maxEmbeddingTokensPerDay",
    env.RATE_LIMIT_EMBEDDING_TOKEN_BUDGET_DAILY_DEFAULT,
  );
  return withEmbeddingBudgetGuard({ provider: getEmbeddingProvider(), rateLimiter, organizationId, dailyTokenLimit });
}
