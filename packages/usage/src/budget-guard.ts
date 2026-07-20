import type { RateLimiter } from "@raas/rate-limit";
import { ApiError } from "@raas/shared";

const WINDOW_SECONDS = 86_400;

function budgetIdentifier(organizationId: string, dimension: string): string {
  return `usage:org:${organizationId}:${dimension}:daily`;
}

export interface DailyBudgetResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Read-only: is `organizationId` already at/over its daily budget for
 * `dimension`, without consuming anything. For a cost that can't be known
 * until after the call it's guarding completes (e.g. chat completion
 * tokens — see recordDailyBudgetUsage for the write half of that pair).
 * The single shared primitive behind both apps/api's chat token budget
 * and this package's embedding-token guard — see
 * docs/decisions.md's cost-protection ticket: "reuse existing rate-limit
 * primitives... do not create route-specific duplicated logic".
 */
export async function checkDailyBudget(params: {
  rateLimiter: RateLimiter;
  organizationId: string;
  dimension: string;
  limit: number;
}): Promise<DailyBudgetResult> {
  const result = await params.rateLimiter.peekLimit({
    identifier: budgetIdentifier(params.organizationId, params.dimension),
    limit: params.limit,
    window: WINDOW_SECONDS,
  });
  return result;
}

/**
 * Consumes `amount` from `organizationId`'s daily budget for `dimension`.
 * Never throws on exceeding — by the time this runs the cost is already
 * incurred; it only affects whether the NEXT checkDailyBudget call is
 * blocked.
 */
export async function recordDailyBudgetUsage(params: {
  rateLimiter: RateLimiter;
  organizationId: string;
  dimension: string;
  amount: number;
}): Promise<void> {
  if (params.amount <= 0) return;
  await params.rateLimiter.checkLimit({
    identifier: budgetIdentifier(params.organizationId, params.dimension),
    limit: Number.MAX_SAFE_INTEGER,
    window: WINDOW_SECONDS,
    amount: params.amount,
  });
}

/**
 * Consumes `amount` from the budget immediately and throws if that
 * consumption itself pushes the org over `limit` — the "before OpenAI
 * calls: check budget; reject if exceeded" shape, for a cost that CAN be
 * estimated up front (see embedding-guard.ts). Consuming immediately
 * (rather than peek-then-record-after) matters here specifically because
 * concurrent calls must not all pass a stale peek at once.
 */
export async function checkAndConsumeDailyBudget(params: {
  rateLimiter: RateLimiter;
  organizationId: string;
  dimension: string;
  limit: number;
  amount: number;
  rejectionMessage: string;
}): Promise<DailyBudgetResult> {
  const result = await params.rateLimiter.checkLimit({
    identifier: budgetIdentifier(params.organizationId, params.dimension),
    limit: params.limit,
    window: WINDOW_SECONDS,
    amount: params.amount,
  });
  if (!result.allowed) {
    throw ApiError.rateLimited(params.rejectionMessage);
  }
  return result;
}

export interface ReserveDailyBudgetResult {
  allowed: boolean;
  reserved: number;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Reserve half of the reserve/settle pair (see settleDailyBudget for the
 * other half) — built for a cost that's estimated up front and then
 * corrected once the real amount is known after the fact (apps/api's
 * chat token budget: an LLM completion's real cost isn't known until
 * generation finishes, but letting every concurrent request past a
 * stale check in the meantime is exactly the race checkAndConsumeDailyBudget
 * above doesn't have for a cost that's already exact at call time, like a
 * document or an embedding batch — see that function's own comment).
 *
 * Deliberately NOT built on checkAndConsumeDailyBudget/checkLimit: that
 * primitive always increments the counter, even on the call that gets
 * rejected — harmless for a one-shot consumption (the next call for that
 * dimension is correctly rejected regardless of the exact stored value),
 * but wrong here, where a reservation happens on every single chat
 * request. A client retrying near the limit would otherwise inflate the
 * counter on every rejected attempt with nothing to ever undo it.
 * @raas/rate-limit's reserve is a single atomic EVAL that leaves the
 * counter completely untouched when the reservation doesn't fit.
 *
 * Throws ApiError.rateLimited (429) when the reservation itself would
 * push the org over `limit` — same shape as checkAndConsumeDailyBudget,
 * so callers handle it identically.
 */
export async function reserveDailyBudget(params: {
  rateLimiter: RateLimiter;
  organizationId: string;
  dimension: string;
  amount: number;
  limit: number;
  rejectionMessage: string;
}): Promise<ReserveDailyBudgetResult> {
  const result = await params.rateLimiter.reserve({
    identifier: budgetIdentifier(params.organizationId, params.dimension),
    amount: params.amount,
    limit: params.limit,
    window: WINDOW_SECONDS,
  });
  if (!result.allowed) {
    throw ApiError.rateLimited(params.rejectionMessage);
  }
  return result;
}

/**
 * Settle half of the reserve/settle pair — adjusts a dimension's daily
 * counter by (actual - reserved) once the real cost of a previously
 * reserved request is known: positive tops up a reservation actual usage
 * exceeded, negative refunds the unused portion, zero (the reservation
 * happened to be exact) is a no-op. Every reserveDailyBudget call must be
 * settled exactly once, on every exit path (success, a mid-generation
 * failure, a timeout) — an un-settled reservation permanently overstates
 * the org's usage for the rest of that day's window; settling twice for
 * the same request double-counts the adjustment in the other direction.
 * Never throws — by the time this runs the real cost is already
 * incurred (or the reservation's cost is being given back), and a
 * transient Redis failure here shouldn't fail a request whose response
 * the caller has often already sent.
 */
export async function settleDailyBudget(params: {
  rateLimiter: RateLimiter;
  organizationId: string;
  dimension: string;
  delta: number;
}): Promise<void> {
  await params.rateLimiter.settle({
    identifier: budgetIdentifier(params.organizationId, params.dimension),
    delta: params.delta,
    window: WINDOW_SECONDS,
  });
}
