import { FakeLLMProvider, type LLMProvider, OpenAIChatProvider } from "@raas/providers";

import { env } from "../env.js";

// Groq has no SDK/API shape of its own here — it exposes an
// OpenAI-compatible Chat Completions endpoint, so OpenAIChatProvider
// (unchanged) is reused with its baseUrl pointed at Groq instead of a new
// provider class. Groq has no embeddings API, so this only ever applies
// to LLM_PROVIDER, never EMBEDDING_PROVIDER.
const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

// Module-level singleton, same convention as getEmbeddingProvider — one
// provider instance per process.
let provider: LLMProvider | undefined;

export function getLLMProvider(): LLMProvider {
  if (!provider) {
    if (env.LLM_PROVIDER === "fake") {
      provider = new FakeLLMProvider({ delayMs: env.FAKE_LLM_DELAY_MS });
    } else if (env.LLM_PROVIDER === "groq") {
      provider = new OpenAIChatProvider({
        apiKey: env.GROQ_API_KEY,
        model: env.GROQ_CHAT_MODEL,
        baseUrl: GROQ_BASE_URL,
        maxCompletionTokens: env.MAX_COMPLETION_TOKENS,
      });
    } else {
      provider = new OpenAIChatProvider({ apiKey: env.OPENAI_API_KEY, model: env.OPENAI_CHAT_MODEL, maxCompletionTokens: env.MAX_COMPLETION_TOKENS });
    }
  }
  return provider;
}

/** The model name recorded on CHAT_PROMPT_TOKENS/CHAT_COMPLETION_TOKENS
 * usage events and Message.usageMetadata — kept in sync with
 * getLLMProvider's own selection logic rather than duplicated at each
 * call site. */
export function getLLMModelName(): string {
  if (env.LLM_PROVIDER === "fake") return "fake";
  if (env.LLM_PROVIDER === "groq") return env.GROQ_CHAT_MODEL;
  return env.OPENAI_CHAT_MODEL;
}
