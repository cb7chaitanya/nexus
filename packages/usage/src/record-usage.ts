import { withTenantTransaction } from "@raas/db";
import type { Prisma, UsageEventType } from "@raas/db";
import { embeddingTokensTotal, llmTokensTotal } from "@raas/metrics";

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
// EMBEDDING_TOKENS (apps/worker's embed-chunks.ts) and CHAT_PROMPT_TOKENS /
// CHAT_COMPLETION_TOKENS (apps/api's chat.ts) are the only UsageEventTypes
// that carry a token count worth exposing as a metric — CHAT_REQUEST and
// DOCUMENT_PROCESSED are pure counters with no token dimension. Recording
// here, at this single chokepoint, means every call site (both apps) gets
// metrics for free without any of them importing @raas/metrics themselves
// — the same "one place assembles it, every caller benefits" shape this
// file's own doc comment already describes for the transactional write.
function recordUsageMetric(event: RecordUsageInput): void {
  const metadata = event.metadata as { model?: unknown; tokenCount?: unknown };
  const model = typeof metadata.model === "string" ? metadata.model : "unknown";
  const tokenCount = typeof metadata.tokenCount === "number" ? metadata.tokenCount : 0;
  if (tokenCount <= 0) return;

  if (event.type === "EMBEDDING_TOKENS") {
    embeddingTokensTotal.inc({ model }, tokenCount);
  } else if (event.type === "CHAT_PROMPT_TOKENS") {
    llmTokensTotal.inc({ model, kind: "prompt" }, tokenCount);
  } else if (event.type === "CHAT_COMPLETION_TOKENS") {
    llmTokensTotal.inc({ model, kind: "completion" }, tokenCount);
  }
}

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
    // Recorded once the INSERT itself succeeds, which — when `tx` is a
    // transaction the caller opened and hasn't committed yet (e.g.
    // chat.ts's combined message+usage write) — is technically before
    // that outer transaction actually commits. A metric is best-effort
    // operational telemetry, not the billing ledger (that's the UsageEvent
    // row itself, queried via GET /organizations/:id/usage); the rare
    // case where the outer transaction later rolls back means this
    // process's in-memory counter is very slightly ahead of what's
    // durably persisted, which is an acceptable, deliberate tradeoff here
    // — not something worth a transactional-outbox pattern for.
    recordUsageMetric(event);
    return;
  }

  await withTenantTransaction(event.organizationId, (freshTx) => write(freshTx));
  recordUsageMetric(event);
}
