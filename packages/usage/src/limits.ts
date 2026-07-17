import { withTenantTransaction } from "@raas/db";

export type UsageLimitDimension = "maxDocumentsPerDay" | "maxEmbeddingTokensPerDay" | "maxChatTokensPerDay";

/**
 * Resolves one daily ceiling for `organizationId` from its
 * OrganizationUsageLimit row, falling back to `defaultValue` (the
 * platform-wide default, sourced from the caller's own env — apps/api and
 * apps/worker each own their own defaults) when no row exists. Most
 * organizations never get a row here; this table only exists to let a
 * specific org's ceiling be overridden above/below the platform default.
 *
 * One dimension per call rather than fetching the whole row and letting
 * the caller pick a field: every call site already knows exactly which
 * ceiling it's enforcing (a document-quota check has no use for
 * maxChatTokensPerDay), so this keeps each call site's intent explicit
 * and avoids a caller silently reading the wrong field.
 */
export async function getOrganizationDailyLimit(
  organizationId: string,
  dimension: UsageLimitDimension,
  defaultValue: number,
): Promise<number> {
  const row = await withTenantTransaction(organizationId, (tx) =>
    tx.organizationUsageLimit.findUnique({ where: { organizationId } }),
  );
  return row ? row[dimension] : defaultValue;
}
