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
        : new OpenAIChatProvider({ apiKey: env.OPENAI_API_KEY, model: env.OPENAI_CHAT_MODEL, maxCompletionTokens: env.MAX_COMPLETION_TOKENS });
  }
  return provider;
}

/** The model name recorded on CHAT_PROMPT_TOKENS/CHAT_COMPLETION_TOKENS
 * usage events and Message.usageMetadata — kept in sync with
 * getLLMProvider's own selection logic rather than duplicated at each
 * call site. */
export function getLLMModelName(): string {
  return env.LLM_PROVIDER === "fake" ? "fake" : env.OPENAI_CHAT_MODEL;
}
