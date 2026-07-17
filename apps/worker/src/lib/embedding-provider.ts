import { FakeEmbeddingProvider, OpenAIEmbeddingProvider } from "@raas/providers";
import type { EmbeddingProvider } from "@raas/providers";

import { env } from "../env.js";

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
