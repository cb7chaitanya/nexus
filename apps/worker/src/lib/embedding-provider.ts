import { FakeEmbeddingProvider, OpenAIEmbeddingProvider } from "@raas/providers";
import type { EmbeddingProvider } from "@raas/providers";
import { getOrganizationDailyLimit, withEmbeddingBudgetGuard } from "@raas/usage";

import { env } from "../env.js";
import { rateLimiter } from "./rate-limiter.js";

let cached: EmbeddingProvider | undefined;

/**
 * Selected once per process via EMBEDDING_PROVIDER, not per-KB — MVP has
 * exactly one supported (provider, model, dim) triple platform-wide (see
 * PLATFORM_EMBEDDING_DIM), so KnowledgeBase.embeddingProvider/embeddingModel
 * are descriptive metadata, not yet a dispatch key. Revisit when a second
 * dimension is actually offered (docs/decisions.md ADR-6 amendment).
 */
export function getEmbeddingProvider(): EmbeddingProvider {
  if (!cached) {
    cached =
      env.EMBEDDING_PROVIDER === "fake"
        ? new FakeEmbeddingProvider({ delayMs: env.FAKE_EMBEDDING_DELAY_MS })
        : new OpenAIEmbeddingProvider({
            apiKey: env.OPENAI_API_KEY,
            model: "text-embedding-3-small",
            batchSize: env.OPENAI_EMBEDDING_BATCH_SIZE,
          });
  }
  return cached;
}

/** The model name recorded on EMBEDDING_TOKENS usage events — kept in
 * sync with getEmbeddingProvider's own selection logic rather than
 * duplicated at each call site. */
export function getEmbeddingModelName(): string {
  return env.EMBEDDING_PROVIDER === "fake" ? "fake" : "text-embedding-3-small";
}

/**
 * The embedding provider wrapped with a pre-flight daily budget check
 * (see @raas/usage's withEmbeddingBudgetGuard) for `organizationId` — the
 * ingestion pipeline's real, bulk embedding cost (see
 * processors/embed-chunks.ts), the primary driver of the daily
 * embedding-token ceiling this guard enforces. Resolved fresh per call
 * (the org's ceiling varies per document, unlike the underlying provider
 * singleton).
 */
export async function getBudgetGuardedEmbeddingProvider(organizationId: string): Promise<EmbeddingProvider> {
  const dailyTokenLimit = await getOrganizationDailyLimit(
    organizationId,
    "maxEmbeddingTokensPerDay",
    env.RATE_LIMIT_EMBEDDING_TOKEN_BUDGET_DAILY_DEFAULT,
  );
  return withEmbeddingBudgetGuard({ provider: getEmbeddingProvider(), rateLimiter, organizationId, dailyTokenLimit });
}
