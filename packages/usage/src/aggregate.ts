import { withTenantTransaction } from "@raas/db";
import type { UsageEventType } from "@raas/db";

// Estimated, illustrative $/1M-token rates — not billing-grade, no
// invoice reconciliation behind these numbers. UsageEvent.metadata is
// already the source of truth for real token counts (see
// docs/architecture.md's UsageEvent notes); this just turns those counts
// into an approximate dollar figure so a cost spike is visible through
// the API before an actual OpenAI invoice arrives. Update alongside real
// provider pricing changes — not tied to any specific model version.
const COST_PER_MILLION_TOKENS: Partial<Record<UsageEventType, number>> = {
  EMBEDDING_TOKENS: 0.02,
  CHAT_PROMPT_TOKENS: 0.15,
  CHAT_COMPLETION_TOKENS: 0.6,
};

function estimateCost(eventType: UsageEventType, tokens: number): number {
  const rate = COST_PER_MILLION_TOKENS[eventType];
  return rate ? (tokens / 1_000_000) * rate : 0;
}

export interface UsageBreakdownRow {
  /** `${date}|${eventType}` — opaque cursor key for this row, stripped
   * before the row is sent over the wire (see apps/api's usage route). */
  id: string;
  date: string;
  eventType: UsageEventType;
  requestCount: number;
  tokens: number;
  cost: number;
}

interface RawBreakdownRow {
  date: Date;
  eventType: UsageEventType;
  requestCount: number;
  tokens: number;
}

/**
 * Returns every (day, eventType) breakdown row for `organizationId` in
 * [from, to), grouped and pre-aggregated in Postgres. Bounded by the
 * caller's own time-range cap (see apps/api's usage route) rather than by
 * this function, which fetches the whole range in one query and lets the
 * caller paginate the (already small — at most days-in-range × 5 event
 * types) result in memory, rather than pushing cursor logic into a
 * GROUP BY query.
 *
 * organizationId, from, and to are bound parameters through Prisma's
 * tagged-template $queryRaw — never string-concatenated — same
 * discipline as packages/core's searchSimilarChunks. Run inside
 * withTenantTransaction so RLS backs up the explicit WHERE clause, same
 * defense-in-depth pattern used everywhere else in this codebase.
 */
export async function aggregateUsage(params: { organizationId: string; from: Date; to: Date }): Promise<UsageBreakdownRow[]> {
  const { organizationId, from, to } = params;

  const rows = await withTenantTransaction(organizationId, (tx) =>
    tx.$queryRaw<RawBreakdownRow[]>`
      SELECT
        DATE_TRUNC('day', "createdAt") AS date,
        type AS "eventType",
        COUNT(*)::int AS "requestCount",
        COALESCE(SUM(("metadata"->>'tokenCount')::int), 0)::float8 AS tokens
      FROM "UsageEvent"
      WHERE "organizationId" = ${organizationId}
        AND "createdAt" >= ${from}
        AND "createdAt" < ${to}
      GROUP BY DATE_TRUNC('day', "createdAt"), type
      ORDER BY DATE_TRUNC('day', "createdAt") ASC, type ASC
    `,
  );

  return rows.map((row) => {
    const date = row.date.toISOString().slice(0, 10);
    return {
      id: `${date}|${row.eventType}`,
      date,
      eventType: row.eventType,
      requestCount: Number(row.requestCount),
      tokens: Number(row.tokens),
      cost: estimateCost(row.eventType, Number(row.tokens)),
    };
  });
}

export interface UsageTotals {
  embeddingTokens: number;
  completionTokens: number;
  requestCount: number;
  estimatedCost: number;
}

/**
 * Sums totals over the FULL set of breakdown rows passed in — always the
 * whole requested period, not just whichever page of `breakdown` the
 * response happens to include (see apps/api's usage route: totals and
 * pagination are independent).
 */
export function computeUsageTotals(rows: UsageBreakdownRow[]): UsageTotals {
  return rows.reduce<UsageTotals>(
    (acc, row) => {
      acc.estimatedCost += row.cost;
      if (row.eventType === "EMBEDDING_TOKENS") acc.embeddingTokens += row.tokens;
      if (row.eventType === "CHAT_COMPLETION_TOKENS") acc.completionTokens += row.tokens;
      // "Request counts" means logical requests (one CHAT_REQUEST event
      // per chat turn) — not the total number of UsageEvent rows across
      // all 5 internal event types, which would double- and triple-count
      // a single chat turn's prompt/completion token events alongside it.
      if (row.eventType === "CHAT_REQUEST") acc.requestCount += row.requestCount;
      return acc;
    },
    { embeddingTokens: 0, completionTokens: 0, requestCount: 0, estimatedCost: 0 },
  );
}
