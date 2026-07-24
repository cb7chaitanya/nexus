import { z } from "zod";

// Curated, not free-text — every model here is known to work with the
// existing chat pipeline's message shape and streaming parser (see
// @raas/providers' OpenAIChatProvider/AnthropicChatProvider). Extending
// this is a one-line change; a customer typing an arbitrary model string
// is not something either provider class validates before the request
// is already mid-stream.
export const LLM_PROVIDERS = ["openai", "anthropic", "groq"] as const;
export type LlmConfigProvider = (typeof LLM_PROVIDERS)[number];

export const LLM_PROVIDER_MODELS: Record<LlmConfigProvider, readonly string[]> = {
  openai: ["gpt-4o", "gpt-4o-mini"],
  anthropic: ["claude-3-5-sonnet-latest", "claude-3-5-haiku-latest"],
  groq: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
};

export const setLlmConfigSchema = z
  .object({
    provider: z.enum(LLM_PROVIDERS),
    model: z.string().min(1),
    apiKey: z.string().min(1),
  })
  .refine((input) => (LLM_PROVIDER_MODELS[input.provider] as readonly string[]).includes(input.model), {
    message: "model is not one of the supported models for this provider",
    path: ["model"],
  });
export type SetLlmConfigInput = z.infer<typeof setLlmConfigSchema>;

// Same shape, but without an apiKey — testing a candidate key before
// switching provider/model, or re-testing an already-saved config
// (apiKey omitted means "use the one already on file").
export const testLlmConfigSchema = z.object({
  provider: z.enum(LLM_PROVIDERS),
  model: z.string().min(1),
  apiKey: z.string().min(1).optional(),
});
export type TestLlmConfigInput = z.infer<typeof testLlmConfigSchema>;
