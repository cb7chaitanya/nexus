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

import { checkAndConsumeDailyBudget, checkDailyBudget, recordDailyBudgetUsage, reserveDailyBudget, settleDailyBudget } from "./budget-guard.js";
import type { ReserveDailyBudgetResult } from "./budget-guard.js";

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

describe("reserveDailyBudget / settleDailyBudget", () => {
  it("reserves within budget and reports the reduced remaining amount", async () => {
    const organizationId = uniqueOrgId();
    const result = await reserveDailyBudget({
      rateLimiter,
      organizationId,
      dimension: "chat-tokens",
      amount: 1200,
      limit: 5000,
      rejectionMessage: "over budget",
    });

    expect(result).toMatchObject({ allowed: true, reserved: 1200, remaining: 3800 });
  });

  it("throws a 429 ApiError when the reservation itself would exceed the limit, without altering the stored counter", async () => {
    const organizationId = uniqueOrgId();
    await reserveDailyBudget({ rateLimiter, organizationId, dimension: "chat-tokens", amount: 4500, limit: 5000, rejectionMessage: "over budget" });

    await expect(
      reserveDailyBudget({
        rateLimiter,
        organizationId,
        dimension: "chat-tokens",
        amount: 1000,
        limit: 5000,
        rejectionMessage: "custom rejection message",
      }),
    ).rejects.toMatchObject({ code: "RATE_LIMIT_EXCEEDED", message: "custom rejection message" });

    // The rejected 1000 must not have leaked in — exactly 500 (5000 -
    // 4500) still fits.
    const stillFits = await reserveDailyBudget({ rateLimiter, organizationId, dimension: "chat-tokens", amount: 500, limit: 5000, rejectionMessage: "over budget" });
    expect(stillFits.allowed).toBe(true);
    expect(stillFits.remaining).toBe(0);
  });

  it("settleDailyBudget tops up when actual usage exceeds the reservation", async () => {
    const organizationId = uniqueOrgId();
    const reservation = await reserveDailyBudget({ rateLimiter, organizationId, dimension: "chat-tokens", amount: 800, limit: 5000, rejectionMessage: "over budget" });

    await settleDailyBudget({ rateLimiter, organizationId, dimension: "chat-tokens", delta: 950 - reservation.reserved });

    const after = await checkDailyBudget({ rateLimiter, organizationId, dimension: "chat-tokens", limit: 5000 });
    expect(after.remaining).toBe(5000 - 950);
  });

  it("settleDailyBudget refunds the unused portion when actual usage is below the reservation", async () => {
    const organizationId = uniqueOrgId();
    const reservation = await reserveDailyBudget({ rateLimiter, organizationId, dimension: "chat-tokens", amount: 2000, limit: 5000, rejectionMessage: "over budget" });

    await settleDailyBudget({ rateLimiter, organizationId, dimension: "chat-tokens", delta: 300 - reservation.reserved });

    const after = await checkDailyBudget({ rateLimiter, organizationId, dimension: "chat-tokens", limit: 5000 });
    expect(after.remaining).toBe(5000 - 300);
  });

  it("keeps different organizations and dimensions fully isolated for reserve/settle, same as the other budget primitives", async () => {
    const orgA = uniqueOrgId();
    const orgB = uniqueOrgId();
    await reserveDailyBudget({ rateLimiter, organizationId: orgA, dimension: "chat-tokens", amount: 4900, limit: 5000, rejectionMessage: "over budget" });

    const orgAResult = await checkDailyBudget({ rateLimiter, organizationId: orgA, dimension: "chat-tokens", limit: 5000 });
    const orgBResult = await checkDailyBudget({ rateLimiter, organizationId: orgB, dimension: "chat-tokens", limit: 5000 });
    const orgAEmbeddingResult = await checkDailyBudget({ rateLimiter, organizationId: orgA, dimension: "embedding-tokens", limit: 5000 });

    expect(orgAResult.remaining).toBe(100);
    expect(orgBResult.remaining).toBe(5000);
    expect(orgAEmbeddingResult.remaining).toBe(5000);
  });

  it("10 simultaneous reservations near the limit: total granted usage never exceeds the configured budget, and settling afterward never drives the counter negative", async () => {
    const organizationId = uniqueOrgId();
    const limit = 1000;
    const amount = 200;

    const outcomes = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        reserveDailyBudget({ rateLimiter, organizationId, dimension: "chat-tokens", amount, limit, rejectionMessage: "over budget" }),
      ),
    );

    const granted = outcomes.filter((o): o is PromiseFulfilledResult<ReserveDailyBudgetResult> => o.status === "fulfilled");
    const denied = outcomes.filter((o) => o.status === "rejected");

    // 1000 / 200 = exactly 5 — never more, regardless of settlement order.
    expect(granted).toHaveLength(5);
    expect(denied).toHaveLength(5);

    const totalReserved = granted.reduce((sum, o) => sum + o.value.reserved, 0);
    expect(totalReserved).toBe(1000);
    expect(totalReserved).toBeLessThanOrEqual(limit);

    // Settle every granted reservation down to a smaller real usage —
    // must never push the counter negative (see settle's own clamping).
    await Promise.all(granted.map((o) => settleDailyBudget({ rateLimiter, organizationId, dimension: "chat-tokens", delta: 50 - o.value.reserved })));

    const after = await checkDailyBudget({ rateLimiter, organizationId, dimension: "chat-tokens", limit });
    expect(after.remaining).toBe(limit - 5 * 50);
  });
});
