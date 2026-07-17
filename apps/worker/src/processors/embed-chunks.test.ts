/**
 * Failure-simulation tests for embed-chunks.ts's idempotency design (see
 * that file's module doc comment for the full design rationale). These
 * exist to reproduce, and prove fixed, a real production bug: a batch
 * that got billed by the embedding provider but then failed to persist
 * used to get re-billed on every BullMQ retry, since the provider was
 * unconditionally re-called from scratch on every attempt.
 *
 * Runs a real BullMQ Worker against real Postgres (RLS) + real Redis —
 * same "real infra, controllable seams" convention as the rest of this
 * suite (chaos.test.ts, pipeline.test.ts): nothing about Postgres, Redis,
 * or BullMQ itself is mocked. What IS controlled, via
 * processEmbedChunksJob's injectable EmbedChunksDeps (not the production
 * embedChunksProcessor entry point, which has no seam by design — see
 * that file), is exactly two things: which embedding provider answers a
 * call, and how the persistence transaction behaves. The "persistence
 * transaction fails" scenario below still goes through a real
 * withTenantTransaction/$transaction call and produces a real Postgres
 * ROLLBACK — the failure is injected by throwing from inside the
 * transaction callback, not by faking Prisma's transaction machinery.
 *
 * Uses its own dedicated queue name (not QUEUE_NAMES.embedding) so this
 * file's Worker can never end up processing a job that pipeline.test.ts
 * or chaos.test.ts enqueued (or vice versa) — those use the real
 * production processor with real deps, which would silently defeat this
 * file's injected failures if the two ever shared a queue name.
 *
 * Prerequisites: docker compose up -d, migrations applied.
 */
import { randomUUID } from "node:crypto";

import { Prisma, prisma, withTenantTransaction } from "@raas/db";
import type { EmbeddingProvider } from "@raas/providers";
import { Queue, Worker, type Job } from "bullmq";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { redisConnection } from "../lib/redis.js";
import { type EmbedChunksDeps, processEmbedChunksJob } from "./embed-chunks.js";
import type { EmbedChunksJobData } from "./types.js";

const TEST_QUEUE_NAME = "test-embed-chunks-idempotency";

const TEST_JOB_OPTS = {
  attempts: 3,
  backoff: { type: "fixed" as const, delay: 150 },
  // NOT removeOnComplete/removeOnFail — waitForJobSettled below polls
  // queue.getJob(jobId) after the job finishes to inspect its final
  // state; an immediate auto-remove would race that poll and make every
  // job look like it "never settled". The queue is obliterated in
  // afterAll instead.
};

/** Deterministic, in-memory EmbeddingProvider that counts calls and can
 * be told to fail its first N calls before succeeding — the seam this
 * file uses to prove "provider called exactly once per genuinely failed
 * attempt" and "provider never called again once it has already
 * succeeded". */
class CountingProvider implements EmbeddingProvider {
  calls = 0;

  constructor(private readonly failFirstNCalls: number = 0) {}

  async embed(texts: string[]): Promise<number[][]> {
    this.calls++;
    if (this.calls <= this.failFirstNCalls) {
      throw new Error(`simulated provider failure (call ${this.calls})`);
    }
    // Must match DocumentChunk.embedding's real column type, vector(1536)
    // — a wrong-dimension literal is rejected by Postgres, not silently
    // truncated/padded, so this can't be a shorter stand-in vector.
    return texts.map((text) => Array.from({ length: 1536 }, (_, i) => ((text.length + i) % 97) / 100));
  }
}

async function waitForJobSettled(queue: Queue, jobId: string, timeoutMs = 15_000): Promise<Job> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = await queue.getJob(jobId);
    if (job) {
      const state = await job.getState();
      if (state === "completed" || state === "failed") return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`job ${jobId} did not settle within ${timeoutMs}ms`);
}

describe("embed-chunks idempotency (no duplicate provider calls, no duplicate billing)", () => {
  const suffix = randomUUID().slice(0, 8);
  let organizationId: string;
  let knowledgeBaseId: string;
  let queue: Queue;
  let worker: Worker | undefined;

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: `Embed Idempotency Org ${suffix}`, slug: `embed-idem-${suffix}` },
    });
    organizationId = org.id;
    const kb = await withTenantTransaction(organizationId, (tx) =>
      tx.knowledgeBase.create({
        data: {
          organizationId,
          name: "Idempotency KB",
          embeddingProvider: "openai",
          embeddingModel: "text-embedding-3-small",
          embeddingDim: 1536,
        },
      }),
    );
    knowledgeBaseId = kb.id;

    queue = new Queue(TEST_QUEUE_NAME, { connection: redisConnection });
  });

  afterEach(async () => {
    if (worker) {
      await worker.close();
      worker = undefined;
    }
  });

  afterAll(async () => {
    // Jobs are kept around (no removeOnComplete/removeOnFail — see
    // TEST_JOB_OPTS) so tests can inspect final state; clean them all up
    // here instead of per-test.
    await queue.obliterate({ force: true });
    await queue.close();
    await prisma.organization.delete({ where: { id: organizationId } }).catch(() => undefined);
  });

  async function createDocumentWithChunks(chunkCount: number, fileNamePrefix: string): Promise<{ documentId: string; chunkIds: string[] }> {
    const document = await withTenantTransaction(organizationId, (tx) =>
      tx.document.create({
        data: {
          organizationId,
          knowledgeBaseId,
          fileName: `${fileNamePrefix}.pdf`,
          mimeType: "application/pdf",
          sizeBytes: 1024,
          storageKey: `${organizationId}/${knowledgeBaseId}/${randomUUID()}-${fileNamePrefix}.pdf`,
          status: "PROCESSING",
        },
      }),
    );

    const chunkIds = await withTenantTransaction(organizationId, async (tx) => {
      const ids: string[] = [];
      for (let i = 0; i < chunkCount; i++) {
        const chunk = await tx.documentChunk.create({
          data: {
            organizationId,
            knowledgeBaseId,
            documentId: document.id,
            chunkIndex: i,
            content: `chunk content number ${i} for ${fileNamePrefix}`,
            tokenCount: 10,
            pageNumber: 1,
            charStart: i * 100,
            charEnd: i * 100 + 50,
          },
        });
        ids.push(chunk.id);
      }
      return ids;
    });

    return { documentId: document.id, chunkIds };
  }

  async function embeddingStates(chunkIds: string[]): Promise<boolean[]> {
    const rows = await withTenantTransaction(organizationId, (tx) =>
      tx.$queryRaw<Array<{ id: string; has_embedding: boolean }>>`
        SELECT id, embedding IS NOT NULL as has_embedding FROM "DocumentChunk" WHERE id IN (${Prisma.join(chunkIds)})
      `,
    );
    const byId = new Map(rows.map((r) => [r.id, r.has_embedding]));
    return chunkIds.map((id) => byId.get(id) ?? false);
  }

  it("scenario 1: provider succeeds, persistence transaction fails, retry does NOT call the provider again", async () => {
    const { documentId, chunkIds } = await createDocumentWithChunks(3, "scenario-1");
    const provider = new CountingProvider(0); // never fails on its own

    let persistCalls = 0;
    const deps: EmbedChunksDeps = {
      getProvider: async () => provider,
      runPersistTransaction: async (orgId, fn) => {
        persistCalls++;
        if (persistCalls === 1) {
          // Simulates "OpenAI succeeded, then the DB transaction failed"
          // (e.g. a dropped connection) — a real Postgres ROLLBACK, since
          // this throws from inside a real withTenantTransaction
          // callback, not a faked Prisma error.
          return withTenantTransaction(orgId, async () => {
            throw new Error("simulated transaction failure (e.g. dropped connection)");
          });
        }
        return withTenantTransaction(orgId, fn);
      },
    };

    worker = new Worker(TEST_QUEUE_NAME, (job) => processEmbedChunksJob(job, deps), { connection: redisConnection });
    await worker.waitUntilReady();

    const jobId = `test-embed-scenario-1-${documentId}`;
    const data: EmbedChunksJobData = { organizationId, documentId, knowledgeBaseId, chunkIds };
    await queue.add("embed-chunks", data, { ...TEST_JOB_OPTS, jobId });

    const job = await waitForJobSettled(queue, jobId);
    expect(await job.getState()).toBe("completed");

    // The persistence transaction was attempted twice (fails once, then
    // succeeds on retry) — but the embedding provider was called only
    // ONCE across both attempts. That is the actual requirement: never
    // call the provider twice for the same chunk unless the PROVIDER
    // call itself definitively failed — it didn't here, only persistence
    // did, and that must not cost a second call.
    expect(persistCalls).toBe(2);
    expect(provider.calls).toBe(1);

    const states = await embeddingStates(chunkIds);
    expect(states.every(Boolean)).toBe(true);

    const usageEvents = await withTenantTransaction(organizationId, (tx) => tx.usageEvent.findMany({ where: { type: "EMBEDDING_TOKENS" } }));
    const forThisDocument = usageEvents.filter((e) => (e.metadata as Record<string, unknown>).documentId === documentId);
    // Exactly one usage record for this batch — not duplicated by the
    // retry (that would be the "duplicate billing" bug this ticket
    // fixes), and not skipped either.
    expect(forThisDocument).toHaveLength(1);
  }, 20_000);

  it("scenario 2: provider fails, retries, provider is called exactly once per attempt", async () => {
    const { documentId, chunkIds } = await createDocumentWithChunks(2, "scenario-2");
    // Fails the first two calls, succeeds on the third — matching this
    // job's attempts:3, so the final attempt succeeds.
    const provider = new CountingProvider(2);

    const deps: EmbedChunksDeps = {
      getProvider: async () => provider,
      runPersistTransaction: withTenantTransaction,
    };

    worker = new Worker(TEST_QUEUE_NAME, (job) => processEmbedChunksJob(job, deps), { connection: redisConnection });
    await worker.waitUntilReady();

    const jobId = `test-embed-scenario-2-${documentId}`;
    const data: EmbedChunksJobData = { organizationId, documentId, knowledgeBaseId, chunkIds };
    await queue.add("embed-chunks", data, { ...TEST_JOB_OPTS, jobId });

    const job = await waitForJobSettled(queue, jobId);
    expect(await job.getState()).toBe("completed");

    // Exactly one provider call per attempt — 2 genuinely failed attempts
    // + 1 successful attempt = 3 calls. Unlike scenario 1, every one of
    // these calls was necessary: a provider call that itself throws
    // leaves nothing cached, so the next attempt has no choice but to
    // call it again.
    expect(provider.calls).toBe(3);

    const states = await embeddingStates(chunkIds);
    expect(states.every(Boolean)).toBe(true);
  }, 20_000);

  it("never calls the provider again once a batch is already fully embedded", async () => {
    const { documentId, chunkIds } = await createDocumentWithChunks(2, "already-embedded");
    const provider = new CountingProvider(0);
    const deps: EmbedChunksDeps = { getProvider: async () => provider, runPersistTransaction: withTenantTransaction };

    worker = new Worker(TEST_QUEUE_NAME, (job) => processEmbedChunksJob(job, deps), { connection: redisConnection });
    await worker.waitUntilReady();

    const jobId = `test-embed-already-embedded-${documentId}`;
    const data: EmbedChunksJobData = { organizationId, documentId, knowledgeBaseId, chunkIds };
    const enqueuedJob = await queue.add("embed-chunks", data, { ...TEST_JOB_OPTS, jobId });
    await waitForJobSettled(queue, jobId);
    expect(provider.calls).toBe(1);

    // Directly re-run the same (now fully embedded) job data, simulating
    // a duplicate delivery or a manual re-trigger after the job already
    // fully completed — e.g. BullMQ's stalled-job reclaim finding a job
    // whose original worker actually finished just before being marked
    // stalled.
    const result = await processEmbedChunksJob(enqueuedJob, deps);
    expect(provider.calls).toBe(1);
    expect(result.embedded).toBe(chunkIds.length);
  }, 20_000);
});
