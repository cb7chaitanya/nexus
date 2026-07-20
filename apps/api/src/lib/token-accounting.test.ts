import { describe, expect, it } from "vitest";

import { resolveChatTokenUsage } from "./token-accounting.js";

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

  it("falls back to a chars/4 estimate and marks the result as estimated when usage metadata is missing", () => {
    const promptText = "a".repeat(400);
    const completionText = "b".repeat(200);

    const result = resolveChatTokenUsage(null, promptText, completionText);

    expect(result).toEqual({
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      source: "estimated",
    });
  });

  it("rounds the fallback estimate up rather than truncating, for both prompt and completion", () => {
    const result = resolveChatTokenUsage(null, "abc", "de");

    // 3 chars / 4 -> ceil(0.75) = 1; 2 chars / 4 -> ceil(0.5) = 1.
    expect(result).toEqual({ promptTokens: 1, completionTokens: 1, totalTokens: 2, source: "estimated" });
  });

  it("treats a zero-value real usage object as present, not falling back, since zero is a legitimate reported count", () => {
    const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    const result = resolveChatTokenUsage(usage, "irrelevant", "irrelevant");

    expect(result).toEqual({ ...usage, source: "provider" });
  });
});
