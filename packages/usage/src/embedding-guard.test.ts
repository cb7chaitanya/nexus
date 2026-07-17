/**
 * Real Redis integration test (the budget check itself), with a fake
 * EmbeddingProvider standing in for OpenAI — no network call, same
 * "fake provider is a real, documented choice" convention used across
 * this codebase's test suites. Prerequisites: docker compose up -d.
 */
import { randomUUID } from "node:crypto";

import { FakeEmbeddingProvider } from "@raas/providers";
import { createRateLimiter } from "@raas/rate-limit";
import { ApiError } from "@raas/shared";
import { Redis } from "ioredis";
import { afterAll, describe, expect, it } from "vitest";

import { withEmbeddingBudgetGuard } from "./embedding-guard.js";

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
const rateLimiter = createRateLimiter(redis);

afterAll(async () => {
  await redis.quit();
});

describe("withEmbeddingBudgetGuard", () => {
  it("delegates to the real provider when comfortably within budget", async () => {
    const real = new FakeEmbeddingProvider();
    const guarded = withEmbeddingBudgetGuard({
      provider: real,
      rateLimiter,
      organizationId: randomUUID(),
      dailyTokenLimit: 1_000_000,
    });

    const vectors = await guarded.embed(["hello world"]);
    expect(vectors).toHaveLength(1);
    expect(vectors[0]!.length).toBeGreaterThan(0);
  });

  it("rejects with an ApiError before ever calling the underlying provider once the estimate exceeds budget", async () => {
    let callCount = 0;
    const spyProvider = {
      embed: async (texts: string[]) => {
        callCount++;
        return texts.map(() => [0.1, 0.2, 0.3]);
      },
    };
    const organizationId = randomUUID();
    const guarded = withEmbeddingBudgetGuard({
      provider: spyProvider,
      rateLimiter,
      organizationId,
      // ~4 chars/token estimate — a long text pushes the estimate over a
      // tiny limit on the very first call.
      dailyTokenLimit: 1,
    });

    await expect(guarded.embed(["a".repeat(400)])).rejects.toBeInstanceOf(ApiError);
    expect(callCount).toBe(0);
  });

  it("accumulates estimated usage across calls for the same organization", async () => {
    const organizationId = randomUUID();
    const guarded = withEmbeddingBudgetGuard({
      provider: new FakeEmbeddingProvider(),
      rateLimiter,
      organizationId,
      dailyTokenLimit: 20, // ~80 chars worth at 4 chars/token
    });

    await guarded.embed(["a".repeat(40)]); // ~10 tokens, within budget
    await expect(guarded.embed(["a".repeat(80)])).rejects.toBeInstanceOf(ApiError); // pushes cumulative over 20
  });

  it("keeps two organizations' budgets fully isolated", async () => {
    const orgA = randomUUID();
    const orgB = randomUUID();
    const guardedA = withEmbeddingBudgetGuard({ provider: new FakeEmbeddingProvider(), rateLimiter, organizationId: orgA, dailyTokenLimit: 5 });
    const guardedB = withEmbeddingBudgetGuard({ provider: new FakeEmbeddingProvider(), rateLimiter, organizationId: orgB, dailyTokenLimit: 5 });

    await expect(guardedA.embed(["a".repeat(100)])).rejects.toBeInstanceOf(ApiError);
    // org B's budget was never touched by org A's rejected call.
    const result = await guardedB.embed(["short"]);
    expect(result).toHaveLength(1);
  });
});
