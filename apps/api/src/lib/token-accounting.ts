import type { TokenUsage } from "@raas/providers";

const CHARS_PER_TOKEN = 4;

export interface ChatTokenAccounting extends TokenUsage {
  /** "provider" when these are OpenAI's own billed counts (see
   * @raas/providers's OpenAIChatProvider stream_options.include_usage);
   * "estimated" when the stream didn't report usage and this fell back to
   * a chars/4 estimate instead. Persisted alongside the counts themselves
   * (Message.usageMetadata, UsageEvent.metadata) so a real vs. estimated
   * record is distinguishable after the fact, not just in the moment. */
  source: "provider" | "estimated";
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Resolves the token counts to persist and bill for one chat turn.
 *
 * Prefers `usage` — the real, billed prompt/completion/total counts
 * OpenAI reports on the final chunk of a stream started with
 * stream_options.include_usage: true (see @raas/providers's
 * OpenAIChatProvider) — over estimating. This is what closes the gap the
 * previous chars/4-only implementation had: that estimate is
 * script-dependent (dense-tokenizing content like CJK text produces far
 * more real tokens than its character count suggests), so it could
 * under-record against the daily token budget relative to what OpenAI
 * actually billed, regardless of who was asking or why.
 *
 * Falls back to the chars/4 estimate only when `usage` is null — a
 * provider/response that didn't report it (the fake provider's explicit
 * test double for this, or a real OpenAI-compatible endpoint without
 * stream_options support). The daily budget still needs *some* number to
 * record even then; an approximate number is better than recording zero
 * and letting the budget never move for that request.
 */
export function resolveChatTokenUsage(usage: TokenUsage | null, promptText: string, completionText: string): ChatTokenAccounting {
  if (usage) {
    return { ...usage, source: "provider" };
  }

  const promptTokens = estimateTokens(promptText);
  const completionTokens = estimateTokens(completionText);
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, source: "estimated" };
}
