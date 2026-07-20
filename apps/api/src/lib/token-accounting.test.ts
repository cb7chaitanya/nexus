import { countTokens } from "gpt-tokenizer";
import { describe, expect, it } from "vitest";

import { estimateChatReservation, resolveChatTokenUsage } from "./token-accounting.js";

// Matches packages/shared/src/schemas/chat.ts's chatSchema — the largest
// message the route will ever accept.
const MAX_MESSAGE_LENGTH = 4000;

describe("resolveChatTokenUsage", () => {
  it("uses the provider's real usage counts for normal English input, unmodified", () => {
    const usage = { promptTokens: 812, completionTokens: 214, totalTokens: 1026 };

    const result = resolveChatTokenUsage(usage, "What is the refund policy?", "Refunds are processed within 30 days.");

    expect(result).toEqual({ ...usage, source: "provider" });
  });

  it("trusts the provider's real usage counts for unicode-heavy input even though they diverge sharply from a chars/4 estimate", () => {
    // Dense CJK text: chars/4 would estimate roughly promptText.length / 4
    // ≈ 10 tokens for a 40-character prompt, wildly under real GPT
    // tokenization of CJK script (closer to 1 token per character). Real
    // provider-reported usage must win outright — this is the exact case
    // the chars/4-only implementation was gameable through.
    const promptText = "这是一个关于退款政策的问题，请详细说明退款流程和时间。".repeat(2);
    const completionText = "退款将在三十天内处理完毕，原路退回至您的支付账户。";
    const usage = { promptTokens: 58, completionTokens: 34, totalTokens: 92 };

    const result = resolveChatTokenUsage(usage, promptText, completionText);

    expect(result).toEqual({ ...usage, source: "provider" });
    // The chars/4 estimate for this same text would be far lower — CJK
    // script tokenizes closer to 1 token/character than 1 token per 4
    // characters — proof that real provider usage, not a recomputation
    // from text length, is what's actually returned.
    const naiveCharsPer4Estimate = Math.ceil(promptText.length / 4) + Math.ceil(completionText.length / 4);
    expect(result.totalTokens).toBeGreaterThan(naiveCharsPer4Estimate);
  });

  it("falls back to a real-tokenizer estimate and marks the result as estimated when usage metadata is missing", () => {
    const promptText = "a".repeat(400);
    const completionText = "b".repeat(200);

    const result = resolveChatTokenUsage(null, promptText, completionText);

    // Real BPE counts, not a chars/4 guess — verified against gpt-tokenizer
    // directly rather than hand-computed, since the whole point of this
    // fallback is to match what an actual tokenizer produces.
    expect(result).toEqual({
      promptTokens: countTokens(promptText),
      completionTokens: countTokens(completionText),
      totalTokens: countTokens(promptText) + countTokens(completionText),
      source: "estimated",
    });
  });

  it("never estimates zero tokens for non-empty fallback text, closing a reservation-bypass edge case a chars/4 rounding-down bug could otherwise create", () => {
    const result = resolveChatTokenUsage(null, "a", "b");

    expect(result.promptTokens).toBeGreaterThanOrEqual(1);
    expect(result.completionTokens).toBeGreaterThanOrEqual(1);
  });

  it("estimates unicode-heavy fallback content far higher than a naive chars/4 heuristic would — the same gaming gap the provider-trusted path above closes, but for the path used when the provider itself reports no usage", () => {
    const promptText = "这是一个关于退款政策的问题，请详细说明退款流程和时间。".repeat(2);
    const completionText = "退款将在三十天内处理完毕，原路退回至您的支付账户。";

    const result = resolveChatTokenUsage(null, promptText, completionText);

    expect(result.source).toBe("estimated");
    const naiveCharsPer4Estimate = Math.ceil(promptText.length / 4) + Math.ceil(completionText.length / 4);
    expect(result.totalTokens).toBeGreaterThan(naiveCharsPer4Estimate);
  });

  it("treats a zero-value real usage object as present, not falling back, since zero is a legitimate reported count", () => {
    const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    const result = resolveChatTokenUsage(usage, "irrelevant", "irrelevant");

    expect(result).toEqual({ ...usage, source: "provider" });
  });
});

describe("estimateChatReservation", () => {
  const maxCompletionTokens = 1024;

  it("reserves promptTokens (real tokenizer count) plus the completion ceiling, for ordinary English input", () => {
    const promptText = "What is the refund policy for annual subscriptions?";

    const result = estimateChatReservation(promptText, maxCompletionTokens);

    expect(result).toBe(countTokens(promptText) + maxCompletionTokens);
  });

  it("reserves substantially more for a max-length unicode-heavy prompt than a chars/4 heuristic would have — the adversarial case this hardening closes: an attacker filling the 4000-char cap with dense-tokenizing script to make the pre-flight reservation under-claim its real cost and slip past a budget it can't actually afford", () => {
    const base = "这是一个关于退款政策和详细流程说明的问题，请解释清楚每一个步骤和时间安排。";
    const promptText = base.repeat(Math.ceil(MAX_MESSAGE_LENGTH / base.length)).slice(0, MAX_MESSAGE_LENGTH);
    expect(promptText.length).toBe(MAX_MESSAGE_LENGTH);

    const reservation = estimateChatReservation(promptText, maxCompletionTokens);
    const naiveCharsPer4Reservation = Math.ceil(promptText.length / 4) + maxCompletionTokens;

    // Real tokenizer count for this exact string, not a re-derivation of
    // the estimator's own formula — proves the reservation tracks an
    // actual BPE count rather than coincidentally matching by construction.
    expect(reservation).toBe(countTokens(promptText) + maxCompletionTokens);
    expect(reservation).toBeGreaterThan(naiveCharsPer4Reservation);
  });

  it("still produces a finite, positive reservation at the maximum message length for plain ASCII, with no overflow/NaN at the boundary", () => {
    const promptText = "The quick brown fox jumps over the lazy dog. ".repeat(90).slice(0, MAX_MESSAGE_LENGTH);
    expect(promptText.length).toBe(MAX_MESSAGE_LENGTH);

    const reservation = estimateChatReservation(promptText, maxCompletionTokens);

    expect(Number.isFinite(reservation)).toBe(true);
    expect(reservation).toBeGreaterThan(maxCompletionTokens);
  });
});
