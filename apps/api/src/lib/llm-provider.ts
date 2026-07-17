import { FakeLLMProvider, type LLMProvider, OpenAIChatProvider } from "@raas/providers";

import { env } from "../env.js";

// Module-level singleton, same convention as getEmbeddingProvider — one
// provider instance per process.
let provider: LLMProvider | undefined;

export function getLLMProvider(): LLMProvider {
  if (!provider) {
    provider =
      env.LLM_PROVIDER === "fake"
        ? new FakeLLMProvider({ delayMs: env.FAKE_LLM_DELAY_MS })
        : new OpenAIChatProvider({ apiKey: env.OPENAI_API_KEY, model: env.OPENAI_CHAT_MODEL });
  }
  return provider;
}
