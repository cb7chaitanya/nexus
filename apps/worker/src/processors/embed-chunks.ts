import { Prisma, withTenantTransaction } from "@raas/db";
import type { EmbeddingProvider } from "@raas/providers";
import { ApiError } from "@raas/shared";
import { recordUsage } from "@raas/usage";
import { UnrecoverableError, type Job } from "bullmq";

import { getBudgetGuardedEmbeddingProvider, getEmbeddingModelName } from "../lib/embedding-provider.js";
import { failDocument, isLastAttempt } from "../lib/job-failure.js";
import { createJobLogger } from "../lib/job-logger.js";
import type { EmbedChunksJobData } from "./types.js";

// Same chars-per-token approximation used by chunk-text.ts's own budget
// packing — neither EmbeddingProvider's interface nor the real OpenAI
// embeddings response is currently plumbed through with a token count, so
// this is an estimate, not billing-grade accounting. Documented as such
// rather than presented as exact.
const CHARS_PER_TOKEN = 4;

export interface EmbedChunksDeps {
  getProvider(organizationId: string): Promise<EmbeddingProvider>;
  /**
   * Runs the persistence step (embedding writes + usage record, one
   * transaction — see the module doc comment). Defaults to the real
   * withTenantTransaction; overridden in tests to deterministically
   * simulate "the provider succeeded but persistence then failed"
   * (e.g. a dropped connection) without needing to fake Postgres itself.
   * This is the "separating provider execution from persistence" seam.
   */
  runPersistTransaction<T>(organizationId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;
}

const defaultDeps: EmbedChunksDeps = {
  getProvider: getBudgetGuardedEmbeddingProvider,
  runPersistTransaction: withTenantTransaction,
};

/**
 * Embeds and writes exactly one batch of chunks, in one transaction —
 * "commits only its batch" (see docs/implementation-plan.md §1.1(c)): this
 * is the real, achievable transaction boundary the fan-out design allows,
 * as opposed to one transaction spanning the whole document's embedding
 * work across N independent jobs. That transaction boundary (writes +
 * usage, atomically together) is unchanged by the idempotency design
 * below — it's what makes "embedding IS NOT NULL" a reliable signal that
 * a chunk's usage was ALSO already recorded, never one without the other.
 *
 * Idempotency (fixes a real production bug: a batch that got billed by
 * OpenAI but then failed to persist — e.g. a dropped connection during
 * the write transaction — used to get re-billed on every BullMQ retry,
 * since the provider was unconditionally re-called from scratch). Three
 * layers, cheapest/most-common check first:
 *
 * 1. A chunk with a non-null `embedding` in Postgres already has its
 *    vector written AND its usage recorded (same transaction, see above)
 *    — it's fully done. Skipped entirely, no provider call, no write, no
 *    usage record, no matter how many times this job retries.
 *
 * 2. A chunk whose vector was already computed by a PREVIOUS attempt of
 *    THIS SAME job — one where the provider call itself succeeded but the
 *    persistence transaction below then failed — is cached on the job's
 *    own data in Redis (`job.data.embeddingCache`, written via
 *    `job.updateData()` immediately after the provider call, BEFORE the
 *    transaction is attempted). This is the actual fix for the reported
 *    bug: the checkpoint lives in Redis, a system independent of whatever
 *    made the Postgres transaction fail, so a transaction failure can
 *    never take the checkpoint down with it. A checkpoint written to
 *    Postgres instead wouldn't structurally fix this — it would just move
 *    the same class of failure to a different (smaller) transaction.
 *    BullMQ keeps a job's data around for its whole retry lifecycle (it's
 *    the same job, same Redis hash, across attempts), so this survives
 *    exactly as long as it needs to and no longer.
 *
 * 3. Only chunks matching neither (1) nor (2) genuinely need a new
 *    provider call — the actual embedding provider is only ever invoked
 *    for chunks nothing has already paid for.
 *
 * The write itself uses `WHERE embedding IS NULL` as a conditional,
 * atomic per-row guard, and only bills usage for rows THIS statement
 * actually flipped from null (`$executeRaw`'s affected-row count) — not
 * every row it attempted. That closes the concurrent-worker race BullMQ's
 * stalled-job reclaim can (rarely) create, where two workers briefly both
 * believe they hold the same job: if both reach the write, only one of
 * them actually updates a given row, and only that one bills for it. The
 * loser's conditional UPDATE affects zero rows and bills nothing.
 */
export async function processEmbedChunksJob(job: Job<EmbedChunksJobData>, deps: EmbedChunksDeps = defaultDeps): Promise<{ embedded: number }> {
  const { organizationId, documentId, chunkIds, requestId } = job.data;
  const log = createJobLogger({ jobId: job.id, organizationId, documentId, requestId });

  try {
    const { chunks, embeddedIds } = await withTenantTransaction(organizationId, async (tx) => {
      const found = await tx.documentChunk.findMany({ where: { id: { in: chunkIds }, documentId } });
      // `embedding` is Prisma's Unsupported("vector(n)") type — excluded
      // from the generated client's TS types entirely, so its presence
      // has to be checked via raw SQL rather than read off `found`
      // directly (same pattern used by this repo's own tests).
      const embedded = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "DocumentChunk" WHERE id IN (${Prisma.join(chunkIds)}) AND embedding IS NOT NULL`;
      return { chunks: found, embeddedIds: embedded };
    });
    const byId = new Map(chunks.map((c) => [c.id, c]));
    const orderedChunks = chunkIds.map((id) => {
      const chunk = byId.get(id);
      if (!chunk) {
        throw new UnrecoverableError(`DocumentChunk ${id} not found for document ${documentId}`);
      }
      return chunk;
    });
    const alreadyEmbedded = new Set(embeddedIds.map((row) => row.id));

    // Layer 1: already fully committed (vector + usage, same transaction)
    // in a previous attempt — nothing left to do for this chunk at all.
    const pending = orderedChunks.filter((c) => !alreadyEmbedded.has(c.id));

    if (pending.length === 0) {
      log.info({ embedded: orderedChunks.length }, "batch already fully embedded (idempotent retry)");
      return { embedded: orderedChunks.length };
    }

    // Layer 2: already paid for by a previous attempt of this same job,
    // just not yet persisted — reuse the cached vector, no new provider
    // call for it.
    const cache: Record<string, number[]> = { ...(job.data.embeddingCache ?? {}) };
    const needsProvider = pending.filter((c) => !(c.id in cache));

    if (needsProvider.length > 0) {
      const provider = await deps.getProvider(organizationId);
      const freshVectors = await provider.embed(needsProvider.map((c) => c.content));

      needsProvider.forEach((c, i) => {
        cache[c.id] = freshVectors[i]!;
      });
      // CHECKPOINT — persisted to Redis, as part of the job's own data,
      // BEFORE the Postgres transaction below is attempted. See the
      // module doc comment: this ordering is the entire fix.
      await job.updateData({ ...job.data, embeddingCache: cache });
    }

    const actuallyWritten: typeof pending = [];
    await deps.runPersistTransaction(organizationId, async (tx) => {
      for (const chunk of pending) {
        const vector = cache[chunk.id];
        if (!vector) {
          // Unreachable: every `pending` chunk was just proven to have a
          // cache entry above, either pre-existing or freshly written.
          throw new Error(`embedding vector missing for chunk ${chunk.id} after checkpoint`);
        }
        const vectorLiteral = `[${vector.join(",")}]`;
        const affected = await tx.$executeRaw`UPDATE "DocumentChunk" SET embedding = ${vectorLiteral}::vector WHERE id = ${chunk.id} AND embedding IS NULL`;
        if (affected > 0) {
          actuallyWritten.push(chunk);
        }
      }

      // Same transaction as the embedding writes, and scoped to only the
      // rows THIS statement actually wrote — see the module doc comment's
      // note on concurrent-worker safety. Nothing to bill if every row in
      // this batch was already claimed by a concurrent writer.
      if (actuallyWritten.length > 0) {
        const approxTokenCount = Math.ceil(actuallyWritten.reduce((sum, chunk) => sum + chunk.content.length, 0) / CHARS_PER_TOKEN);
        await recordUsage(
          {
            organizationId,
            type: "EMBEDDING_TOKENS",
            metadata: { model: getEmbeddingModelName(), documentId, tokenCount: approxTokenCount, chunkCount: actuallyWritten.length },
          },
          tx,
        );
      }
    });

    // Embedded chunk count only — never chunk content or the vectors
    // themselves.
    log.info({ embedded: orderedChunks.length }, "batch embedded");
    return { embedded: orderedChunks.length };
  } catch (err) {
    // A daily embedding-token budget won't reset within the retry
    // backoff window (5s/10s/20s — see queue/queues.ts's exponential
    // backoff), so retrying immediately is pointless: fail the document
    // now, the same way an UnrecoverableError does, instead of burning
    // the full retry budget on something retrying can't fix.
    if (err instanceof ApiError && err.code === "RATE_LIMIT_EXCEEDED") {
      await failDocument(organizationId, documentId, err.message);
      log.warn({ err }, "embed-chunks failed: daily budget exceeded");
      throw new UnrecoverableError(err.message);
    }
    if (err instanceof UnrecoverableError) {
      await failDocument(organizationId, documentId, err.message);
      log.warn({ err }, "embed-chunks failed: unrecoverable");
      throw err;
    }
    if (isLastAttempt(job)) {
      await failDocument(organizationId, documentId, err instanceof Error ? err.message : String(err));
    }
    log.error({ err }, "embed-chunks failed");
    throw err;
  }
}

// Thin production entry point — kept to this exact shape (job) => Promise
// because BullMQ's Processor type is `(job, token?, signal?) => Promise`,
// and a positional second parameter here would collide with the token
// BullMQ actually passes. processEmbedChunksJob's injectable `deps` is
// what tests use instead (see embed-chunks.test.ts).
export async function embedChunksProcessor(job: Job<EmbedChunksJobData>): Promise<{ embedded: number }> {
  return processEmbedChunksJob(job);
}
