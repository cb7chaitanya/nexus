import { countTokens } from "gpt-tokenizer";
import type { TokenUsage } from "@raas/providers";

export interface ChatTokenAccounting extends TokenUsage {
  /** "provider" when these are OpenAI's own billed counts (see
   * @raas/providers's OpenAIChatProvider stream_options.include_usage);
   * "estimated" when the stream didn't report usage and this fell back to
   * a real-tokenizer estimate instead. Persisted alongside the counts
   * themselves (Message.usageMetadata, UsageEvent.metadata) so a real vs.
   * estimated record is distinguishable after the fact, not just in the
   * moment. */
  source: "provider" | "estimated";
}

/**
 * gpt-tokenizer's default export is the o200k_base BPE encoding — the one
 * OPENAI_CHAT_MODEL's default (gpt-4o-mini) actually uses, and close
 * enough for older cl100k_base-family models (gpt-3.5/gpt-4) that this is
 * still a large accuracy improvement over a length-based heuristic for
 * them too. Replaces the previous chars/4 estimate, which was
 * script-dependent and gameable: dense-tokenizing content (CJK script in
 * particular, closer to 1 token per character than 1 token per 4)
 * produced a real token count several times what chars/4 predicted,
 * meaning both the pre-generation budget reservation
 * (estimateChatReservation) and the post-generation fallback
 * (resolveChatTokenUsage, only used when the provider itself didn't
 * report real usage) could under-reserve/under-record for exactly the
 * input an org would need it to be accurate for. A real BPE tokenizer
 * isn't script-dependent the way a fixed character ratio is — it's still
 * an estimate (not the exact count OpenAI itself computes server-side for
 * billing), but no longer one an attacker can undercut just by choosing
 * what script to write the prompt in.
 */
function estimateTokens(text: string): number {
  return countTokens(text);
}

/**
 * Resolves the token counts to persist and bill for one chat turn.
 *
 * Prefers `usage` — the real, billed prompt/completion/total counts
 * OpenAI reports on the final chunk of a stream started with
 * stream_options.include_usage: true (see @raas/providers's
 * OpenAIChatProvider) — over estimating, since that's the exact number
 * OpenAI itself billed, not an approximation of it.
 *
 * Falls back to the tokenizer-based estimate (see estimateTokens above)
 * only when `usage` is null — a provider/response that didn't report it
 * (the fake provider's explicit test double for this, or a real
 * OpenAI-compatible endpoint without stream_options support). The daily
 * budget still needs *some* number to record even then; an approximate
 * number is better than recording zero and letting the budget never move
 * for that request.
 */
export function resolveChatTokenUsage(usage: TokenUsage | null, promptText: string, completionText: string): ChatTokenAccounting {
  if (usage) {
    return { ...usage, source: "provider" };
  }

  const promptTokens = estimateTokens(promptText);
  const completionTokens = estimateTokens(completionText);
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, source: "estimated" };
}

/**
 * Worst-case reservation made BEFORE generation starts (see
 * apps/api/src/lib/rate-limit.ts's reserveChatTokenBudget) — prompt
 * tokens estimated the same tokenizer-based way resolveChatTokenUsage's
 * fallback does, plus `maxCompletionTokens`, the hard ceiling the
 * provider is configured to enforce on every request (see
 * @raas/providers's OpenAIChatProvider) rather than an estimate of what
 * the model will actually produce. Real completions can never exceed
 * that ceiling, so this reservation is a genuine upper bound on the
 * request's real cost for the completion side — it only needs to be
 * reasonable for the prompt side, not exact, because settling against
 * resolveChatTokenUsage's result afterward corrects for any remaining
 * gap. A real tokenizer here (rather than a chars/4 heuristic) matters
 * specifically because this number gates the pre-flight budget check: an
 * under-estimated reservation is what would let a request past a budget
 * it can't actually afford, not just a bookkeeping inaccuracy corrected
 * later — see estimateTokens's own comment for the CJK-gaming case this
 * closes.
 */
export function estimateChatReservation(promptText: string, maxCompletionTokens: number): number {
  return estimateTokens(promptText) + maxCompletionTokens;
}
