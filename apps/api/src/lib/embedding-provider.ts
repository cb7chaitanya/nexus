import { type EmbeddingProvider, FakeEmbeddingProvider, OpenAIEmbeddingProvider } from "@raas/providers";

import { env } from "../env.js";

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
