/**
 * Real Redis integration test — a fixed-window counter's correctness is
 * about actual INCR/EXPIRE/TTL behavior, which a mock would just
 * reimplement (possibly wrong). Prerequisites: docker compose up -d.
 */
import { randomUUID } from "node:crypto";

import { Redis } from "ioredis";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createRateLimiter } from "./rate-limiter.js";

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
const limiter = createRateLimiter(redis);

afterAll(async () => {
  await redis.quit();
});

function uniqueId(): string {
  return `test:${randomUUID()}`;
}

describe("checkLimit", () => {
  it("allows requests up to the limit and denies the next one", async () => {
    const identifier = uniqueId();
    const results = [];
    for (let i = 0; i < 4; i++) {
      results.push(await limiter.checkLimit({ identifier, limit: 3, window: 60 }));
    }

    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(results[2]!.remaining).toBe(0);
    expect(results[3]!.remaining).toBe(0);
    expect(results[3]!.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("reports decreasing remaining counts as the window is consumed", async () => {
    const identifier = uniqueId();
    const first = await limiter.checkLimit({ identifier, limit: 5, window: 60 });
    const second = await limiter.checkLimit({ identifier, limit: 5, window: 60 });

    expect(first.remaining).toBe(4);
    expect(second.remaining).toBe(3);
  });

  it("does not push the reset time back out on later requests within the same window (fixed, not sliding)", async () => {
    const identifier = uniqueId();
    const first = await limiter.checkLimit({ identifier, limit: 5, window: 60 });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const second = await limiter.checkLimit({ identifier, limit: 5, window: 60 });

    // The window's expiry was set on the FIRST write and never renewed —
    // the second call's resetAt must not be ~60s from now, it must still
    // be ~59s (60 minus the ~1.1s that elapsed).
    expect(second.resetAt.getTime()).toBeLessThan(first.resetAt.getTime() + 200);
  });

  it("keeps different identifiers completely independent", async () => {
    const idA = uniqueId();
    const idB = uniqueId();

    await limiter.checkLimit({ identifier: idA, limit: 1, window: 60 });
    const exceededA = await limiter.checkLimit({ identifier: idA, limit: 1, window: 60 });
    const firstB = await limiter.checkLimit({ identifier: idB, limit: 1, window: 60 });

    expect(exceededA.allowed).toBe(false);
    expect(firstB.allowed).toBe(true);
  });

  it("supports a non-default amount, for consuming a token budget rather than one request at a time", async () => {
    const identifier = uniqueId();
    const first = await limiter.checkLimit({ identifier, limit: 1000, window: 86_400, amount: 600 });
    const second = await limiter.checkLimit({ identifier, limit: 1000, window: 86_400, amount: 500 });

    expect(first.allowed).toBe(true);
    expect(first.remaining).toBe(400);
    // 600 + 500 = 1100 > 1000: the call that pushes the total over the
    // budget is itself reported as not allowed, even though on a token
    // budget the cost is already spent (see peekLimit's doc comment for
    // why this codebase's chat route checks budget with peekLimit BEFORE
    // generating, then records actual usage with checkLimit after).
    expect(second.allowed).toBe(false);
    expect(second.remaining).toBe(0);
  });
});

describe("peekLimit", () => {
  it("reports allowed with a full remaining budget when nothing has been consumed yet", async () => {
    const result = await limiter.peekLimit({ identifier: uniqueId(), limit: 10, window: 60 });
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(10);
  });

  it("never consumes from the budget, unlike checkLimit", async () => {
    const identifier = uniqueId();
    await limiter.peekLimit({ identifier, limit: 5, window: 60 });
    await limiter.peekLimit({ identifier, limit: 5, window: 60 });
    const result = await limiter.peekLimit({ identifier, limit: 5, window: 60 });

    expect(result.remaining).toBe(5);
  });

  it("reflects consumption made by checkLimit", async () => {
    const identifier = uniqueId();
    await limiter.checkLimit({ identifier, limit: 5, window: 60, amount: 3 });

    const result = await limiter.peekLimit({ identifier, limit: 5, window: 60 });
    expect(result.remaining).toBe(2);
    expect(result.allowed).toBe(true);
  });

  it("reports not allowed once checkLimit has pushed the count to/over the limit", async () => {
    const identifier = uniqueId();
    await limiter.checkLimit({ identifier, limit: 5, window: 60, amount: 5 });

    const result = await limiter.peekLimit({ identifier, limit: 5, window: 60 });
    expect(result.allowed).toBe(false);
  });
});

describe("reserve", () => {
  it("allows a reservation that fits and reports the reduced remaining budget", async () => {
    const identifier = uniqueId();
    const result = await limiter.reserve({ identifier, amount: 400, limit: 1000, window: 60 });

    expect(result).toMatchObject({ allowed: true, reserved: 400, remaining: 600 });
  });

  it("rejects a reservation that would push the total over the limit, reporting reserved: 0", async () => {
    const identifier = uniqueId();
    await limiter.reserve({ identifier, amount: 700, limit: 1000, window: 60 });

    const result = await limiter.reserve({ identifier, amount: 500, limit: 1000, window: 60 });

    expect(result.allowed).toBe(false);
    expect(result.reserved).toBe(0);
    expect(result.remaining).toBe(300);
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("leaves the counter completely untouched on rejection — unlike checkLimit, a rejected reservation must not leak into the stored total", async () => {
    const identifier = uniqueId();
    await limiter.reserve({ identifier, amount: 900, limit: 1000, window: 60 });

    // Would push 900 + 200 = 1100 > 1000 — rejected.
    await limiter.reserve({ identifier, amount: 200, limit: 1000, window: 60 });

    const raw = await redis.get(`ratelimit:${identifier}`);
    expect(raw).toBe("900");

    // Proves the rejection above added nothing: a reservation that fits
    // in the remaining 100 still succeeds afterward.
    const stillFits = await limiter.reserve({ identifier, amount: 100, limit: 1000, window: 60 });
    expect(stillFits.allowed).toBe(true);
    expect(stillFits.remaining).toBe(0);
  });

  it("allows a reservation landing exactly on the limit", async () => {
    const identifier = uniqueId();
    const result = await limiter.reserve({ identifier, amount: 1000, limit: 1000, window: 60 });

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(0);
  });

  it("sets the window's expiry only on the first reservation, fixed-window style", async () => {
    const identifier = uniqueId();
    const first = await limiter.reserve({ identifier, amount: 100, limit: 1000, window: 60 });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const second = await limiter.reserve({ identifier, amount: 100, limit: 1000, window: 60 });

    expect(second.resetAt.getTime()).toBeLessThan(first.resetAt.getTime() + 200);
  });

  it("10 simultaneous reservations near the budget limit: the total ever granted never exceeds the configured limit, regardless of arrival order", async () => {
    const identifier = uniqueId();
    // 10 concurrent callers each asking for 100 against a 500 budget —
    // if this raced like the old peek-then-record design, most or all 10
    // could see a stale "under budget" state and all be granted, letting
    // the total reserved run to 1000 (2x over). The atomic reserve script
    // must let exactly 5 of these 10 fit (500 / 100), no matter which 5.
    const results = await Promise.all(Array.from({ length: 10 }, () => limiter.reserve({ identifier, amount: 100, limit: 500, window: 60 })));

    const allowed = results.filter((r) => r.allowed);
    const rejected = results.filter((r) => !r.allowed);

    expect(allowed).toHaveLength(5);
    expect(rejected).toHaveLength(5);

    const totalReserved = allowed.reduce((sum, r) => sum + r.reserved, 0);
    expect(totalReserved).toBe(500);
    expect(totalReserved).toBeLessThanOrEqual(500);

    // The stored counter must match the sum of grants exactly — nothing
    // extra leaked in from any of the 5 rejected attempts.
    const raw = await redis.get(`ratelimit:${identifier}`);
    expect(Number(raw)).toBe(500);
  });

  it("20 simultaneous reservations at an amount that never divides the limit evenly: total granted still never exceeds it", async () => {
    const identifier = uniqueId();
    // 500 / 137 = 3.64... — at most 3 can ever fit (411), a 4th (548)
    // would exceed 500. Deliberately non-round numbers so this isn't
    // accidentally passing only because of a convenient exact multiple.
    const results = await Promise.all(Array.from({ length: 20 }, () => limiter.reserve({ identifier, amount: 137, limit: 500, window: 60 })));

    const allowed = results.filter((r) => r.allowed);
    const totalReserved = allowed.reduce((sum, r) => sum + r.reserved, 0);

    expect(allowed).toHaveLength(3);
    expect(totalReserved).toBe(411);
    expect(totalReserved).toBeLessThanOrEqual(500);
  });
});

describe("settle", () => {
  it("tops up the counter when the delta is positive (actual usage exceeded the reservation)", async () => {
    const identifier = uniqueId();
    await limiter.reserve({ identifier, amount: 200, limit: 1000, window: 60 });

    await limiter.settle({ identifier, delta: 50, window: 60 });

    const raw = await redis.get(`ratelimit:${identifier}`);
    expect(raw).toBe("250");
  });

  it("refunds the counter when the delta is negative (unused reservation)", async () => {
    const identifier = uniqueId();
    await limiter.reserve({ identifier, amount: 200, limit: 1000, window: 60 });

    await limiter.settle({ identifier, delta: -120, window: 60 });

    const raw = await redis.get(`ratelimit:${identifier}`);
    expect(raw).toBe("80");
  });

  it("is a no-op when the delta is zero", async () => {
    const identifier = uniqueId();
    await limiter.reserve({ identifier, amount: 200, limit: 1000, window: 60 });

    await limiter.settle({ identifier, delta: 0, window: 60 });

    const raw = await redis.get(`ratelimit:${identifier}`);
    expect(raw).toBe("200");
  });

  it("never lets the counter go negative — clamps at 0 even if a refund somehow exceeds what was reserved", async () => {
    const identifier = uniqueId();
    await limiter.reserve({ identifier, amount: 50, limit: 1000, window: 60 });

    // A refund larger than what's actually stored should never be
    // possible by construction (see settleDailyBudget's doc comment),
    // but the primitive itself must not produce a negative counter
    // regardless.
    await limiter.settle({ identifier, delta: -500, window: 60 });

    const raw = await redis.get(`ratelimit:${identifier}`);
    expect(raw).toBe("0");
  });

  it("re-establishes a TTL if the key had none (defensive: a settle arriving after the reservation's window already expired)", async () => {
    const identifier = uniqueId();
    await redis.set(`ratelimit:${identifier}`, "100");
    // No EXPIRE set — simulates a key that outlived its original window.

    await limiter.settle({ identifier, delta: 10, window: 120 });

    const ttl = await redis.ttl(`ratelimit:${identifier}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(120);
  });

  it("round-trips correctly: reserve a worst-case estimate, then settle down to a smaller real usage, leaving exactly the real amount", async () => {
    const identifier = uniqueId();
    const reservation = await limiter.reserve({ identifier, amount: 1024, limit: 10_000, window: 60 });
    expect(reservation.allowed).toBe(true);

    const actualUsage = 340;
    await limiter.settle({ identifier, delta: actualUsage - reservation.reserved, window: 60 });

    const raw = await redis.get(`ratelimit:${identifier}`);
    expect(raw).toBe("340");
  });
});

describe("isolation between test keys", () => {
  beforeEach(() => {
    // Every test above uses a fresh randomUUID()-based identifier, so
    // there's nothing to clean up between tests — documented here so a
    // reader doesn't wonder why there's no afterEach flush.
  });

  it("uses a namespaced key prefix, verified by direct Redis inspection", async () => {
    const identifier = uniqueId();
    await limiter.checkLimit({ identifier, limit: 5, window: 60 });

    const raw = await redis.get(`ratelimit:${identifier}`);
    expect(raw).toBe("1");
  });
});
