import type { EmbeddingProvider } from "@raas/providers";
import type { RateLimiter } from "@raas/rate-limit";

import { checkAndConsumeDailyBudget } from "./budget-guard.js";

// Same chars-per-token approximation used elsewhere in this codebase
// (apps/worker's embed-chunks.ts, apps/api's chat.ts) — neither
// EmbeddingProvider's interface nor a real OpenAI response exposes a
// token count before the call completes, so this is an up-front estimate,
// not billing-grade accounting.
const CHARS_PER_TOKEN = 4;

function estimateTokens(texts: string[]): number {
  const totalChars = texts.reduce((sum, text) => sum + text.length, 0);
  return Math.ceil(totalChars / CHARS_PER_TOKEN);
}

export interface EmbeddingBudgetGuardOptions {
  provider: EmbeddingProvider;
  rateLimiter: RateLimiter;
  organizationId: string;
  dailyTokenLimit: number;
}

/**
 * Wraps an EmbeddingProvider with a pre-flight daily token-budget check —
 * "before OpenAI calls: check organization daily budget; reject if
 * exceeded" (see docs/decisions.md's cost-protection ticket). Decorates
 * the existing EmbeddingProvider abstraction (packages/providers) rather
 * than reaching into a specific implementation or coupling providers to
 * the database directly — organizationId and dailyTokenLimit are passed
 * in already resolved by the caller (see getOrganizationDailyLimit), so
 * this function's only dependencies are the provider interface and the
 * existing @raas/rate-limit primitive.
 *
 * The estimated cost is consumed immediately, before delegating to the
 * real provider — not peeked-then-recorded-after — so concurrent calls
 * against the same organization can't all pass a stale check at once.
 * Used by both apps/api (the per-query embedding call in chat) and
 * apps/worker (the bulk ingestion embedding call) — the same guard, the
 * same budget dimension, regardless of which process is spending it.
 */
export function withEmbeddingBudgetGuard(options: EmbeddingBudgetGuardOptions): EmbeddingProvider {
  const { provider, rateLimiter, organizationId, dailyTokenLimit } = options;

  return {
    async embed(texts: string[]): Promise<number[][]> {
      const estimatedTokens = estimateTokens(texts);
      if (estimatedTokens > 0) {
        await checkAndConsumeDailyBudget({
          rateLimiter,
          organizationId,
          dimension: "embedding-tokens",
          limit: dailyTokenLimit,
          amount: estimatedTokens,
          rejectionMessage: `Organization ${organizationId} has exceeded its daily embedding token budget`,
        });
      }
      return provider.embed(texts);
    },
  };
}
