import { withTenantTransaction } from "@raas/db";
import type { Prisma, UsageEventType } from "@raas/db";

export interface RecordUsageInput {
  organizationId: string;
  userId?: string | null;
  type: UsageEventType;
  /** Operation-specific facts — token counts, model name, document/
   * conversation id. Shape varies by `type`; see docs/architecture.md's
   * UsageEvent notes and each call site's own comment for what it puts
   * here. */
  metadata: Record<string, unknown>;
}

/**
 * Writes one UsageEvent row. Deliberately a plain, throwing function —
 * "never silently fail" (the ticket's own words) means THIS function
 * must not catch and swallow its own DB error; it is the caller's job to
 * decide what a failure means in context (apps/worker lets it propagate
 * into the existing job retry/dead-letter path; apps/api's chat route
 * folds it into the same transaction as message persistence, so its
 * failure is handled by that transaction's own catch block — see
 * apps/api/src/routes/chat.ts).
 *
 * Accepts an optional existing transaction client so a caller that
 * already has one open (e.g. chat.ts writing the user message + assistant
 * message + citations + usage together) can pass it through and get one
 * atomic commit — "usage writes should happen transactionally where
 * possible," per the ticket. Without one, this opens its own
 * withTenantTransaction, for standalone callers (e.g. the embedding
 * pipeline) that don't have a natural larger transaction to join.
 */
export async function recordUsage(event: RecordUsageInput, tx?: Prisma.TransactionClient): Promise<void> {
  const write = (client: Prisma.TransactionClient) =>
    client.usageEvent.create({
      data: {
        organizationId: event.organizationId,
        userId: event.userId ?? null,
        type: event.type,
        metadata: event.metadata as Prisma.InputJsonValue,
      },
    });

  if (tx) {
    await write(tx);
    return;
  }

  await withTenantTransaction(event.organizationId, (freshTx) => write(freshTx));
}
