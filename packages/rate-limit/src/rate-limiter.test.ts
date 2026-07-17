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
