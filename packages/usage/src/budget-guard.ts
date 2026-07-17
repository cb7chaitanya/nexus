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
