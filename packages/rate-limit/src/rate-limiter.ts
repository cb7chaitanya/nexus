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

export interface ReserveParams {
  identifier: string;
  /** How much to attempt to reserve — e.g. a worst-case token estimate
   * for a chat completion that hasn't run yet. */
  amount: number;
  limit: number;
  /** Window size in seconds — same fixed-window semantics as checkLimit:
   * only set on the very first write within a window, never renewed. */
  window: number;
}

export interface ReserveResult {
  allowed: boolean;
  /** Exactly `amount` when allowed, 0 when rejected — a reservation is
   * never partially granted. */
  reserved: number;
  limit: number;
  /** Never negative — clamped to 0 once exceeded. */
  remaining: number;
  resetAt: Date;
  retryAfterSeconds: number;
}

export interface SettleParams {
  identifier: string;
  /** actual - reserved. Positive tops up the reservation (real usage
   * exceeded what was reserved); negative refunds the unused portion.
   * Zero is a documented no-op. */
  delta: number;
  /** Fallback TTL, used only if this key somehow has none set (e.g. the
   * reservation's window already expired between reserve and settle) —
   * see the settle script's own comment for why this can't just be
   * skipped in that case. */
  window: number;
}

const KEY_PREFIX = "ratelimit:";

/**
 * Atomically reserves `amount` against `key` only if doing so would not
 * push the running total past `limit` — a single EVAL, not
 * check-then-increment across two round trips, so there is no window in
 * which two concurrent reservations can both read a total that's still
 * under budget and both proceed (the exact race checkLimit's own
 * INCRBY-then-check shape doesn't have either, but which peekLimit +
 * a later checkLimit call — the OLD chat-token-budget design — very much
 * did: see @raas/usage's reserveDailyBudget). A rejected reservation
 * leaves the counter completely untouched, unlike checkLimit's
 * always-increment-then-maybe-reject shape — reservations happen on
 * every request attempt, so a rejected one leaving a permanent trace
 * would let repeated near-limit attempts inflate the counter for no
 * reason.
 */
const RESERVE_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local amount = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local window = tonumber(ARGV[3])

if current + amount > limit then
  return {0, current}
end

local newValue = redis.call('INCRBY', KEYS[1], amount)
if newValue == amount then
  redis.call('EXPIRE', KEYS[1], window)
end
return {1, newValue}
`;

/**
 * Atomically adjusts `key` by `delta` — the settlement half of a
 * reserve/settle pair (see reserve above). Clamps at 0 rather than ever
 * letting the counter go negative: a delta this large and negative should
 * be structurally impossible (a settlement's refund can only undo what
 * that same request's own reservation added), but this is a budget
 * counter, not a value worth trusting a single call site's arithmetic
 * for — see reserveDailyBudget/settleDailyBudget's own doc comments for
 * the invariant that's supposed to make this unreachable in practice.
 * Re-applies the window's TTL only if the key somehow has none (its
 * window already expired) — INCRBY on an absent key silently (re)creates
 * it with no expiry, which would otherwise leak a key that never resets.
 */
const SETTLE_SCRIPT = `
local delta = tonumber(ARGV[1])
local window = tonumber(ARGV[2])

local newValue = redis.call('INCRBY', KEYS[1], delta)
if newValue < 0 then
  redis.call('SET', KEYS[1], 0, 'KEEPTTL')
  newValue = 0
end
if redis.call('TTL', KEYS[1]) == -1 then
  redis.call('EXPIRE', KEYS[1], window)
end
return newValue
`;

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

  /**
   * See RESERVE_SCRIPT's own comment for why this is one atomic EVAL
   * rather than checkLimit's increment-then-maybe-reject shape.
   */
  async function reserve(params: ReserveParams): Promise<ReserveResult> {
    const { identifier, amount, limit, window } = params;
    const key = `${KEY_PREFIX}${identifier}`;

    const [allowedFlag, count] = (await redis.eval(RESERVE_SCRIPT, 1, key, amount, limit, window)) as [number, number];
    const allowed = allowedFlag === 1;
    const ttlSeconds = await redis.ttl(key);
    const effectiveTtl = Math.max(ttlSeconds, 0);

    return {
      allowed,
      reserved: allowed ? amount : 0,
      limit,
      remaining: Math.max(limit - count, 0),
      resetAt: new Date(Date.now() + effectiveTtl * 1000),
      retryAfterSeconds: allowed ? 0 : Math.max(effectiveTtl, 1),
    };
  }

  /** See SETTLE_SCRIPT's own comment. A zero delta is a documented no-op
   * — skipped without a round trip, since it's the common case whenever a
   * reservation's estimate happens to land exactly on the real count. */
  async function settle(params: SettleParams): Promise<void> {
    const { identifier, delta, window } = params;
    if (delta === 0) return;
    const key = `${KEY_PREFIX}${identifier}`;
    await redis.eval(SETTLE_SCRIPT, 1, key, delta, window);
  }

  return { checkLimit, peekLimit, reserve, settle };
}

export type RateLimiter = ReturnType<typeof createRateLimiter>;
