import type { Redis } from "ioredis";

export interface CheckLimitParams {
  identifier: string;
  limit: number;
  /** Window size in seconds. */
  window: number;
  /** How much this call consumes from the limit — defaults to 1 (one
   * request). A token-budget check passes the actual token count instead
   * of a flat 1 (see @raas/rate-limit's README-equivalent doc comment on
   * createRateLimiter). */
  amount?: number;
}

export interface CheckLimitResult {
  allowed: boolean;
  limit: number;
  /** Never negative — clamped to 0 once exceeded. */
  remaining: number;
  resetAt: Date;
  /** Only meaningful when !allowed; 0 otherwise. */
  retryAfterSeconds: number;
}

export interface PeekLimitParams {
  identifier: string;
  limit: number;
  window: number;
}

const KEY_PREFIX = "ratelimit:";

/**
 * Fixed-window counter backed by Redis INCRBY + EXPIRE NX. The window's
 * TTL is only ever set on its first write (the NX flag), so a request
 * partway through a window never pushes its own reset time back out —
 * that's the property that makes this a real fixed window rather than a
 * sliding one that never resets under sustained load. Simpler than a
 * sliding-window/token-bucket implementation, and sufficient for every
 * caller in this codebase ("N requests per minute per IP/org/user" — see
 * apps/api/src/lib/rate-limit.ts), which is a deliberate scope choice,
 * not an oversight: a sliding window matters when burst-at-the-boundary
 * precision matters, which none of this codebase's limits currently need.
 *
 * Takes a Redis client rather than constructing its own connection —
 * same dependency-injection convention as @raas/core's searchSimilarChunks
 * taking a `tx` — callers own connection lifecycle, this package is pure
 * logic on top of it.
 */
export function createRateLimiter(redis: Redis) {
  async function checkLimit(params: CheckLimitParams): Promise<CheckLimitResult> {
    const { identifier, limit, window, amount = 1 } = params;
    const key = `${KEY_PREFIX}${identifier}`;

    const pipeline = redis.multi();
    pipeline.incrby(key, amount);
    pipeline.expire(key, window, "NX");
    const results = await pipeline.exec();
    if (!results) {
      throw new Error(`rate-limit: Redis pipeline for "${identifier}" returned no results (connection issue?)`);
    }
    const [incrResult] = results;
    if (incrResult![0]) {
      throw incrResult![0];
    }
    const count = incrResult![1] as number;

    const ttlSeconds = await redis.ttl(key);
    const effectiveTtl = Math.max(ttlSeconds, 0);
    const allowed = count <= limit;

    return {
      allowed,
      limit,
      remaining: Math.max(limit - count, 0),
      resetAt: new Date(Date.now() + effectiveTtl * 1000),
      retryAfterSeconds: allowed ? 0 : Math.max(effectiveTtl, 1),
    };
  }

  /**
   * Read-only equivalent of checkLimit: reports whether `identifier` is
   * already at/over `limit` WITHOUT consuming from it. Exists for
   * pre-flight checks against a value only known after the fact — a
   * daily token budget can't be decremented before an LLM call because
   * nobody knows the token count yet, but a request can still be rejected
   * up front if the org is already over budget from prior calls (see
   * apps/api/src/routes/chat.ts).
   */
  async function peekLimit(params: PeekLimitParams): Promise<CheckLimitResult> {
    const { identifier, limit, window } = params;
    const key = `${KEY_PREFIX}${identifier}`;

    const [rawCount, ttlSeconds] = await Promise.all([redis.get(key), redis.ttl(key)]);
    const count = rawCount ? Number(rawCount) : 0;
    // No key yet (ttl -2) or a key with no expiry somehow (ttl -1, should
    // never happen given checkLimit always sets one on first write) —
    // either way, report a full fresh window rather than a negative/stale
    // reset time.
    const effectiveTtl = ttlSeconds > 0 ? ttlSeconds : window;
    const allowed = count < limit;

    return {
      allowed,
      limit,
      remaining: Math.max(limit - count, 0),
      resetAt: new Date(Date.now() + effectiveTtl * 1000),
      retryAfterSeconds: allowed ? 0 : Math.max(effectiveTtl, 1),
    };
  }

  return { checkLimit, peekLimit };
}

export type RateLimiter = ReturnType<typeof createRateLimiter>;
