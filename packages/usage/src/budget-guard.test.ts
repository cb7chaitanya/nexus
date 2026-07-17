/**
 * Real Redis integration test — same reasoning as
 * packages/rate-limit/src/rate-limiter.test.ts: fixed-window counter
 * correctness is about actual Redis behavior, which a mock would just
 * reimplement (possibly wrong). Prerequisites: docker compose up -d.
 */
import { randomUUID } from "node:crypto";

import { createRateLimiter } from "@raas/rate-limit";
import { ApiError } from "@raas/shared";
import { Redis } from "ioredis";
import { afterAll, describe, expect, it } from "vitest";

import { checkAndConsumeDailyBudget, checkDailyBudget, recordDailyBudgetUsage } from "./budget-guard.js";

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
const rateLimiter = createRateLimiter(redis);

afterAll(async () => {
  await redis.quit();
});

function uniqueOrgId(): string {
  return randomUUID();
}

describe("checkDailyBudget / recordDailyBudgetUsage", () => {
  it("reports allowed with full budget before anything is recorded", async () => {
    const result = await checkDailyBudget({ rateLimiter, organizationId: uniqueOrgId(), dimension: "chat-tokens", limit: 1000 });
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(1000);
  });

  it("blocks once recorded usage crosses the limit", async () => {
    const organizationId = uniqueOrgId();
    await recordDailyBudgetUsage({ rateLimiter, organizationId, dimension: "chat-tokens", amount: 900 });

    const underLimit = await checkDailyBudget({ rateLimiter, organizationId, dimension: "chat-tokens", limit: 1000 });
    expect(underLimit.allowed).toBe(true);

    await recordDailyBudgetUsage({ rateLimiter, organizationId, dimension: "chat-tokens", amount: 200 });
    const overLimit = await checkDailyBudget({ rateLimiter, organizationId, dimension: "chat-tokens", limit: 1000 });
    expect(overLimit.allowed).toBe(false);
  });

  it("keeps different organizations completely isolated", async () => {
    const orgA = uniqueOrgId();
    const orgB = uniqueOrgId();

    await recordDailyBudgetUsage({ rateLimiter, organizationId: orgA, dimension: "chat-tokens", amount: 5000 });

    const orgAResult = await checkDailyBudget({ rateLimiter, organizationId: orgA, dimension: "chat-tokens", limit: 1000 });
    const orgBResult = await checkDailyBudget({ rateLimiter, organizationId: orgB, dimension: "chat-tokens", limit: 1000 });

    expect(orgAResult.allowed).toBe(false);
    expect(orgBResult.allowed).toBe(true);
    expect(orgBResult.remaining).toBe(1000);
  });

  it("keeps different dimensions for the same org completely isolated", async () => {
    const organizationId = uniqueOrgId();
    await recordDailyBudgetUsage({ rateLimiter, organizationId, dimension: "embedding-tokens", amount: 5000 });

    const embeddingResult = await checkDailyBudget({ rateLimiter, organizationId, dimension: "embedding-tokens", limit: 1000 });
    const chatResult = await checkDailyBudget({ rateLimiter, organizationId, dimension: "chat-tokens", limit: 1000 });

    expect(embeddingResult.allowed).toBe(false);
    expect(chatResult.allowed).toBe(true);
  });
});

describe("checkAndConsumeDailyBudget", () => {
  it("consumes immediately and allows calls within budget", async () => {
    const organizationId = uniqueOrgId();
    const result = await checkAndConsumeDailyBudget({
      rateLimiter,
      organizationId,
      dimension: "embedding-tokens",
      limit: 1000,
      amount: 400,
      rejectionMessage: "over budget",
    });
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(600);
  });

  it("throws an ApiError (RATE_LIMIT_EXCEEDED) once consumption crosses the limit", async () => {
    const organizationId = uniqueOrgId();
    await checkAndConsumeDailyBudget({
      rateLimiter,
      organizationId,
      dimension: "embedding-tokens",
      limit: 1000,
      amount: 700,
      rejectionMessage: "over budget",
    });

    await expect(
      checkAndConsumeDailyBudget({
        rateLimiter,
        organizationId,
        dimension: "embedding-tokens",
        limit: 1000,
        amount: 500,
        rejectionMessage: "custom rejection message",
      }),
    ).rejects.toMatchObject({ code: "RATE_LIMIT_EXCEEDED", message: "custom rejection message" });
  });

  it("throws a real ApiError instance with a 429 status code", async () => {
    const organizationId = uniqueOrgId();
    await checkAndConsumeDailyBudget({
      rateLimiter,
      organizationId,
      dimension: "embedding-tokens",
      limit: 100,
      amount: 100,
      rejectionMessage: "over budget",
    });

    try {
      await checkAndConsumeDailyBudget({
        rateLimiter,
        organizationId,
        dimension: "embedding-tokens",
        limit: 100,
        amount: 1,
        rejectionMessage: "over budget",
      });
      expect.unreachable("expected checkAndConsumeDailyBudget to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).statusCode).toBe(429);
    }
  });
});
