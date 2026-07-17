import { withTenantTransaction } from "@raas/db";
import { ApiError } from "@raas/shared";
import { recordUsage } from "@raas/usage";
import { UnrecoverableError, type Job } from "bullmq";

import { getBudgetGuardedEmbeddingProvider, getEmbeddingModelName } from "../lib/embedding-provider.js";
import { failDocument, isLastAttempt } from "../lib/job-failure.js";
import type { EmbedChunksJobData } from "./types.js";

// Same chars-per-token approximation used by chunk-text.ts's own budget
// packing — neither EmbeddingProvider's interface nor the real OpenAI
// embeddings response is currently plumbed through with a token count, so
// this is an estimate, not billing-grade accounting. Documented as such
// rather than presented as exact.
const CHARS_PER_TOKEN = 4;

/**
 * Embeds and writes exactly one batch of chunks, in one transaction —
 * "commits only its batch" (see docs/implementation-plan.md §1.1(c)): this
 * is the real, achievable transaction boundary the fan-out design allows,
 * as opposed to one transaction spanning the whole document's embedding
 * work across N independent jobs.
 *
 * Because the whole batch is written in a single transaction, a crash
 * mid-batch (worker killed while awaiting the provider call, or mid-write)
 * always leaves every chunk in that batch with a null embedding — never a
 * partially-embedded batch. A retry (whether a normal BullMQ retry or
 * stalled-job recovery after a worker crash) re-embeds and
 * UPDATEs the same rows by id, which is what makes this safe to re-run:
 * no new rows are ever created here, only existing ones overwritten with
 * the same or freshly-recomputed vectors.
 */
export async function embedChunksProcessor(job: Job<EmbedChunksJobData>): Promise<{ embedded: number }> {
  const { organizationId, documentId, chunkIds } = job.data;

  try {
    const chunks = await withTenantTransaction(organizationId, (tx) =>
      tx.documentChunk.findMany({ where: { id: { in: chunkIds }, documentId } }),
    );
    const byId = new Map(chunks.map((c) => [c.id, c]));
    const orderedChunks = chunkIds.map((id) => {
      const chunk = byId.get(id);
      if (!chunk) {
        throw new UnrecoverableError(`DocumentChunk ${id} not found for document ${documentId}`);
      }
      return chunk;
    });

    const provider = await getBudgetGuardedEmbeddingProvider(organizationId);
    const vectors = await provider.embed(orderedChunks.map((c) => c.content));

    await withTenantTransaction(organizationId, async (tx) => {
      for (let i = 0; i < orderedChunks.length; i++) {
        const vectorLiteral = `[${vectors[i]!.join(",")}]`;
        await tx.$executeRaw`UPDATE "DocumentChunk" SET embedding = ${vectorLiteral}::vector WHERE id = ${orderedChunks[i]!.id}`;
      }

      // Same transaction as the embedding writes — one batch's usage
      // record commits or rolls back atomically with the batch it
      // describes, never orphaned from it.
      const approxTokenCount = Math.ceil(orderedChunks.reduce((sum, chunk) => sum + chunk.content.length, 0) / CHARS_PER_TOKEN);
      await recordUsage(
        {
          organizationId,
          type: "EMBEDDING_TOKENS",
          metadata: { model: getEmbeddingModelName(), documentId, tokenCount: approxTokenCount, chunkCount: orderedChunks.length },
        },
        tx,
      );
    });

    return { embedded: orderedChunks.length };
  } catch (err) {
    // A daily embedding-token budget won't reset within the retry
    // backoff window (5s/10s/20s — see queue/queues.ts's exponential
    // backoff), so retrying immediately is pointless: fail the document
    // now, the same way an UnrecoverableError does, instead of burning
    // the full retry budget on something retrying can't fix.
    if (err instanceof ApiError && err.code === "RATE_LIMIT_EXCEEDED") {
      await failDocument(organizationId, documentId, err.message);
      throw new UnrecoverableError(err.message);
    }
    if (err instanceof UnrecoverableError) {
      await failDocument(organizationId, documentId, err.message);
      throw err;
    }
    if (isLastAttempt(job)) {
      await failDocument(organizationId, documentId, err instanceof Error ? err.message : String(err));
    }
    throw err;
  }
}
