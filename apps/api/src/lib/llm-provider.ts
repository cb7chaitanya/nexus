import { decryptSecret } from "@raas/crypto";
import { withTenantTransaction } from "@raas/db";
import { AnthropicChatProvider, FakeLLMProvider, type LLMProvider, OpenAIChatProvider } from "@raas/providers";
import type { LlmConfigProvider } from "@raas/shared";

import { env } from "../env.js";

// Groq has no SDK/API shape of its own here — it exposes an
// OpenAI-compatible Chat Completions endpoint, so OpenAIChatProvider
// (unchanged) is reused with its baseUrl pointed at Groq instead of a new
// provider class. Groq has no embeddings API, so this only ever applies
// to LLM_PROVIDER, never EMBEDDING_PROVIDER.
const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

// Module-level singleton for the platform-managed (Nexus-paying-for-it)
// provider — one instance per process, same convention as
// getEmbeddingProvider. This is the fallback every organization without
// its own OrganizationLlmConfig row uses, and is entirely unchanged from
// before bring-your-own-LLM existed.
let platformProvider: LLMProvider | undefined;

function getPlatformProvider(): LLMProvider {
  if (!platformProvider) {
    if (env.LLM_PROVIDER === "fake") {
      platformProvider = new FakeLLMProvider({ delayMs: env.FAKE_LLM_DELAY_MS });
    } else if (env.LLM_PROVIDER === "groq") {
      platformProvider = new OpenAIChatProvider({
        apiKey: env.GROQ_API_KEY,
        model: env.GROQ_CHAT_MODEL,
        baseUrl: GROQ_BASE_URL,
        maxCompletionTokens: env.MAX_COMPLETION_TOKENS,
      });
    } else {
      platformProvider = new OpenAIChatProvider({ apiKey: env.OPENAI_API_KEY, model: env.OPENAI_CHAT_MODEL, maxCompletionTokens: env.MAX_COMPLETION_TOKENS });
    }
  }
  return platformProvider;
}

function getPlatformModelName(): string {
  if (env.LLM_PROVIDER === "fake") return "fake";
  if (env.LLM_PROVIDER === "groq") return env.GROQ_CHAT_MODEL;
  return env.OPENAI_CHAT_MODEL;
}

/** Constructs a fresh, one-request provider instance for a decrypted
 * customer-supplied key — never cached across requests (see
 * resolveLlmProvider's own doc comment for why). */
export function buildCustomProvider(provider: LlmConfigProvider, model: string, apiKey: string): LLMProvider {
  if (provider === "anthropic") {
    return new AnthropicChatProvider({ apiKey, model, maxCompletionTokens: env.MAX_COMPLETION_TOKENS });
  }
  if (provider === "groq") {
    return new OpenAIChatProvider({ apiKey, model, baseUrl: GROQ_BASE_URL, maxCompletionTokens: env.MAX_COMPLETION_TOKENS });
  }
  return new OpenAIChatProvider({ apiKey, model, maxCompletionTokens: env.MAX_COMPLETION_TOKENS });
}

export interface ResolvedLlmProvider {
  provider: LLMProvider;
  modelName: string;
}

/**
 * The per-request provider lookup every chat request goes through (see
 * routes/chat.ts) — replaces what used to be a single bare
 * getLLMProvider() singleton call. No organization-level in-memory
 * caching of decrypted keys or constructed provider instances: each call
 * re-reads OrganizationLlmConfig and re-decrypts fresh. This is a
 * deliberate simplicity/security choice, not an oversight — a chat
 * request is not hot enough (nowhere near, e.g., an embedding batch call)
 * for one extra indexed primary-key lookup plus one AES-GCM decrypt to
 * matter, and it means a revoked/changed BYO key takes effect on the very
 * next message, not "whenever some cache happens to expire."
 *
 * Deliberately does NOT fall back to the platform provider when a
 * configured custom provider fails — see buildCustomProvider's callers
 * in routes/chat.ts: a thrown error here (bad key, decryption failure)
 * propagates as a real chat failure. Silently spending Nexus's own
 * platform key on behalf of an org that specifically configured its own
 * would defeat the reason most orgs configure this in the first place
 * (often data-residency/compliance), not a resilience improvement.
 */
export async function resolveLlmProvider(organizationId: string): Promise<ResolvedLlmProvider> {
  const config = await withTenantTransaction(organizationId, (tx) => tx.organizationLlmConfig.findUnique({ where: { organizationId } }));

  if (!config) {
    return { provider: getPlatformProvider(), modelName: getPlatformModelName() };
  }

  if (!env.LLM_KEY_ENCRYPTION_SECRET) {
    // A config row exists but the platform's own decryption key is
    // unset — this is a deployment misconfiguration (the key must have
    // been set when the row was created), not a normal "BYO isn't
    // configured" state. Fail loudly rather than silently using the
    // platform provider, which would spend Nexus's own key without
    // anyone noticing the org's own configuration was ignored.
    throw new Error(`OrganizationLlmConfig exists for org ${organizationId} but LLM_KEY_ENCRYPTION_SECRET is unset. Refusing to guess.`);
  }

  const apiKey = decryptSecret(config.encryptedApiKey, env.LLM_KEY_ENCRYPTION_SECRET);
  const provider = buildCustomProvider(config.provider as LlmConfigProvider, config.model, apiKey);
  return { provider, modelName: config.model };
}

export type LlmConnectionTestResult = { ok: true } | { ok: false; message: string };

/**
 * Makes one minimal real request against a candidate (provider, model,
 * apiKey) — the "Test connection" button's backend, and what a save
 * validates against before persisting. maxRetries: 0 and a short
 * connectTimeoutMs deliberately, unlike the defaults buildCustomProvider
 * uses for real chat traffic: a UI test click should fail fast on a bad
 * key, not sit through the same exponential-backoff budget a real chat
 * request gets. Never throws — every failure mode (bad key, network
 * error, provider outage) is normalized into `{ ok: false, message }` so
 * callers don't need their own try/catch.
 */
export async function testProviderConnection(provider: LlmConfigProvider, model: string, apiKey: string): Promise<LlmConnectionTestResult> {
  const testOptions = { apiKey, model, maxCompletionTokens: 1, maxRetries: 0, connectTimeoutMs: 10_000 };
  const instance =
    provider === "anthropic"
      ? new AnthropicChatProvider(testOptions)
      : new OpenAIChatProvider(provider === "groq" ? { ...testOptions, baseUrl: GROQ_BASE_URL } : testOptions);

  try {
    // Draining the stream (not just calling streamCompletion, which does
    // no I/O by itself) is what actually reaches the provider — a
    // one-token completion is enough to prove the key/model combination
    // is real and authorized without meaningfully affecting the
    // customer's own usage/cost.
    for await (const _delta of instance.streamCompletion([{ role: "user", content: "Say OK." }])) {
      // no-op
    }
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Connection test failed";
    return { ok: false, message };
  }
}
