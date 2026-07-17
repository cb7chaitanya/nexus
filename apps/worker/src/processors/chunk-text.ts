import { JOB_NAMES } from "@raas/shared";
import { withTenantTransaction } from "@raas/db";
import { UnrecoverableError, type Job } from "bullmq";

import { chunkPages } from "../lib/chunk-text.js";
import type { ExtractedDocument } from "../lib/extract-pdf.js";
import { failDocument, isLastAttempt } from "../lib/job-failure.js";
import { DEFAULT_JOB_OPTS, documentEmbeddingQueue } from "../queue/queues.js";
import type { DocumentJobData, EmbedChunksJobData } from "./types.js";

// ~100 chunks per embed-chunks job, matching docs/architecture.md §4.4/§6.1.
const EMBED_BATCH_SIZE = 100;

function batch<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

/**
 * Depends on extract-text (its only static child in the flow). Upserts all
 * chunk rows (content/position, embedding left null — see
 * DocumentChunk.embedding in schema.prisma), then dynamically fans out
 * embed-chunks jobs as ADDITIONAL children of process-document (this
 * job's own parent), one per batch of ~100 chunks. This has to be dynamic
 * rather than a statically-declared flow because the number of batches
 * isn't known until chunking has actually run — see
 * docs/implementation-plan.md §1.1(c) for why a static "same transaction"
 * design doesn't work here.
 *
 * Idempotent under retry two ways: the chunk upsert is keyed on
 * (documentId, chunkIndex), and each embed-chunks job gets a deterministic
 * jobId (`embed-chunks-<documentId>-<batchIndex>`) — BullMQ treats
 * re-adding a job with an existing id as a no-op rather than creating a
 * duplicate (verified against bullmq's addStandardJob/handleDuplicatedJob
 * scripts), so a chunk-text retry that re-adds the same batches doesn't
 * double up embedding work or process-document's pending-children count.
 */
export async function chunkTextProcessor(job: Job<DocumentJobData>): Promise<{ chunkCount: number }> {
  const { organizationId, documentId, knowledgeBaseId } = job.data;

  try {
    if (!job.parent) {
      throw new UnrecoverableError(`chunk-text job ${job.id} has no parent — it must run as part of the process-document flow`);
    }

    const children = await job.getChildrenValues<ExtractedDocument>();
    const extracted = Object.values(children ?? {})[0];
    if (!extracted) {
      throw new UnrecoverableError(`chunk-text job ${job.id} could not read extract-text's output`);
    }

    const chunks = chunkPages(extracted.pages);
    if (chunks.length === 0) {
      throw new UnrecoverableError("document produced no extractable text chunks");
    }

    const chunkIds = await withTenantTransaction(organizationId, async (tx) => {
      const ids: string[] = [];
      for (const chunk of chunks) {
        const row = await tx.documentChunk.upsert({
          where: { documentId_chunkIndex: { documentId, chunkIndex: chunk.chunkIndex } },
          create: {
            organizationId,
            knowledgeBaseId,
            documentId,
            chunkIndex: chunk.chunkIndex,
            content: chunk.content,
            tokenCount: chunk.tokenCount,
            pageNumber: chunk.pageNumber,
            charStart: chunk.charStart,
            charEnd: chunk.charEnd,
          },
          update: {
            content: chunk.content,
            tokenCount: chunk.tokenCount,
            pageNumber: chunk.pageNumber,
            charStart: chunk.charStart,
            charEnd: chunk.charEnd,
          },
        });
        ids.push(row.id);
      }
      return ids;
    });

    const batches = batch(chunkIds, EMBED_BATCH_SIZE);
    for (const [batchIndex, batchChunkIds] of batches.entries()) {
      const data: EmbedChunksJobData = { organizationId, documentId, knowledgeBaseId, chunkIds: batchChunkIds };
      await documentEmbeddingQueue.add(JOB_NAMES.embedChunks, data, {
        ...DEFAULT_JOB_OPTS,
        // Hyphens, not colons — BullMQ rejects a custom jobId containing
        // `:` outside a specific 3-part repeatable-job format.
        jobId: `${JOB_NAMES.embedChunks}-${documentId}-${batchIndex}`,
        parent: { id: job.parent.id!, queue: job.parent.queueKey },
      });
    }

    return { chunkCount: chunks.length };
  } catch (err) {
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
