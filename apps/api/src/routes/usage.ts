import { ApiError, getUsageQuerySchema, parseOrThrow } from "@raas/shared";
import { aggregateUsage, computeUsageTotals } from "@raas/usage";
import type { FastifyInstance } from "fastify";

import { requireAuth, requireOrgMembership } from "../plugins/auth-guard.js";

const DEFAULT_RANGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1000;

export async function usageRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/organizations/:id/usage",
    { preHandler: [requireAuth, requireOrgMembership] },
    async (request, reply) => {
      const { id: organizationId } = request.params as { id: string };
      const input = parseOrThrow(getUsageQuerySchema, request.query);

      const to = input.to ?? new Date();
      const from = input.from ?? new Date(to.getTime() - DEFAULT_RANGE_MS);

      if (from >= to) {
        throw ApiError.badRequest("`from` must be before `to`");
      }
      if (to.getTime() - from.getTime() > MAX_RANGE_MS) {
        throw ApiError.badRequest("The requested range cannot exceed 366 days");
      }

      // Totals always cover the FULL requested range; only `breakdown`
      // below is paginated — a client paging through breakdown rows must
      // not see totals shrink to match whatever page it's currently on.
      const allRows = await aggregateUsage({ organizationId, from, to });
      const totals = computeUsageTotals(allRows);

      const startIndex = input.cursor ? allRows.findIndex((row) => row.id === input.cursor) + 1 : 0;
      const page = allRows.slice(startIndex, startIndex + input.limit);
      const nextCursor = startIndex + input.limit < allRows.length ? (page[page.length - 1]?.id ?? null) : null;

      reply.send({
        period: { from: from.toISOString(), to: to.toISOString() },
        totals,
        breakdown: page.map(({ date, eventType, requestCount, tokens, cost }) => ({ date, eventType, requestCount, tokens, cost })),
        nextCursor,
      });
    },
  );
}
