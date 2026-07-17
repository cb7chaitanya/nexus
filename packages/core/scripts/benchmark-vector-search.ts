/**
 * Standalone benchmark, not part of the test suite: seeds 10k
 * DocumentChunk rows with random embeddings, times searchSimilarChunks'
 * exact query with the HNSW index in place, drops the index, times it
 * again, then restores the index and cleans up the seeded data.
 *
 * Run with: pnpm --filter @raas/core run benchmark
 *
 * Uses a SEPARATE PrismaClient connected to DATABASE_URL (the raas
 * migration/superuser role) only for the DROP INDEX / CREATE INDEX
 * statements — @raas/db's own `prisma` export deliberately connects as
 * the restricted raas_app role, which has no DDL privileges (see
 * packages/db/src/client.ts) and structurally cannot run them. This is
 * the same narrowly-scoped-admin-connection pattern
 * docs/decisions.md's ADR-9 says any future admin/seed script should use
 * rather than reusing the app's own role. All actual data seeding and
 * querying goes through the normal @raas/db prisma/withTenantTransaction
 * (raas_app, RLS-enforced), same as production code paths.
 */
import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { prisma, withTenantTransaction } from "@raas/db";

const DIM = 1536;
const CHUNK_COUNT = 10_000;
const SEED_BATCH_SIZE = 200;
const QUERY_RUNS = 5;
const INDEX_NAME = "document_chunk_embedding_idx";

function randomVector(): number[] {
  return Array.from({ length: DIM }, () => Math.random() * 2 - 1);
}

function vectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

async function seedChunks(organizationId: string, knowledgeBaseId: string, documentId: string): Promise<void> {
  process.stdout.write(`Seeding ${CHUNK_COUNT} chunks with random embeddings...\n`);
  const start = Date.now();

  for (let batchStart = 0; batchStart < CHUNK_COUNT; batchStart += SEED_BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + SEED_BATCH_SIZE, CHUNK_COUNT);
    await withTenantTransaction(organizationId, async (tx) => {
      for (let i = batchStart; i < batchEnd; i++) {
        const chunk = await tx.documentChunk.create({
          data: { organizationId, knowledgeBaseId, documentId, chunkIndex: i, content: `benchmark chunk ${i}`, tokenCount: 3, charStart: 0, charEnd: 20 },
        });
        await tx.$executeRaw`UPDATE "DocumentChunk" SET embedding = ${vectorLiteral(randomVector())}::vector WHERE id = ${chunk.id}`;
      }
    });
    process.stdout.write(`\r  ${batchEnd}/${CHUNK_COUNT}`);
  }
  process.stdout.write(`\nSeeded in ${((Date.now() - start) / 1000).toFixed(1)}s\n\n`);
}

async function explainQuery(organizationId: string, knowledgeBaseId: string, queryVector: string): Promise<string> {
  const plan = await withTenantTransaction(organizationId, (tx) =>
    tx.$queryRaw<Array<{ "QUERY PLAN": string }>>`
      EXPLAIN (ANALYZE, BUFFERS)
      SELECT id, 1 - (embedding <=> ${queryVector}::vector) AS score
      FROM "DocumentChunk"
      WHERE "organizationId" = ${organizationId} AND "knowledgeBaseId" = ${knowledgeBaseId} AND embedding IS NOT NULL
      ORDER BY embedding <=> ${queryVector}::vector
      LIMIT 8
    `,
  );
  return plan.map((row) => row["QUERY PLAN"]).join("\n");
}

async function timeQuery(organizationId: string, knowledgeBaseId: string, queryVector: string): Promise<number[]> {
  const runs: number[] = [];
  for (let i = 0; i < QUERY_RUNS; i++) {
    const start = Date.now();
    await withTenantTransaction(organizationId, (tx) =>
      tx.$queryRaw`
        SELECT id, 1 - (embedding <=> ${queryVector}::vector) AS score
        FROM "DocumentChunk"
        WHERE "organizationId" = ${organizationId} AND "knowledgeBaseId" = ${knowledgeBaseId} AND embedding IS NOT NULL
        ORDER BY embedding <=> ${queryVector}::vector
        LIMIT 8
      `,
    );
    runs.push(Date.now() - start);
  }
  return runs;
}

function summarize(label: string, runs: number[]): void {
  const avg = runs.reduce((a, b) => a + b, 0) / runs.length;
  console.log(`${label}: runs=[${runs.join(", ")}]ms avg=${avg.toFixed(2)}ms`);
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set — needed for the DROP/CREATE INDEX statements this benchmark runs.");
  }
  const adminClient = new PrismaClient({ datasourceUrl: databaseUrl });

  const suffix = randomUUID().slice(0, 8);
  const org = await prisma.organization.create({ data: { name: `Benchmark Org ${suffix}`, slug: `benchmark-org-${suffix}` } });
  const kb = await withTenantTransaction(org.id, (tx) =>
    tx.knowledgeBase.create({
      data: { organizationId: org.id, name: "Benchmark KB", embeddingProvider: "openai", embeddingModel: "text-embedding-3-small", embeddingDim: DIM },
    }),
  );
  const doc = await withTenantTransaction(org.id, (tx) =>
    tx.document.create({
      data: { organizationId: org.id, knowledgeBaseId: kb.id, fileName: "benchmark.pdf", mimeType: "application/pdf", sizeBytes: 1, storageKey: `${org.id}/benchmark` },
    }),
  );

  try {
    await seedChunks(org.id, kb.id, doc.id);

    const queryVector = vectorLiteral(randomVector());

    console.log("=== WITH HNSW index ===");
    console.log(await explainQuery(org.id, kb.id, queryVector));
    const withIndexRuns = await timeQuery(org.id, kb.id, queryVector);
    summarize("with-index", withIndexRuns);

    console.log("\nDropping index for comparison...");
    await adminClient.$executeRawUnsafe(`DROP INDEX "${INDEX_NAME}"`);

    console.log("\n=== WITHOUT index (sequential scan) ===");
    console.log(await explainQuery(org.id, kb.id, queryVector));
    const withoutIndexRuns = await timeQuery(org.id, kb.id, queryVector);
    summarize("without-index", withoutIndexRuns);

    console.log("\nRecreating index...");
    await adminClient.$executeRawUnsafe(`CREATE INDEX "${INDEX_NAME}" ON "DocumentChunk" USING hnsw (embedding vector_cosine_ops)`);

    const withAvg = withIndexRuns.reduce((a, b) => a + b, 0) / withIndexRuns.length;
    const withoutAvg = withoutIndexRuns.reduce((a, b) => a + b, 0) / withoutIndexRuns.length;
    console.log(`\n=== Summary (${CHUNK_COUNT} chunks) ===`);
    console.log(`With index:    avg ${withAvg.toFixed(2)}ms`);
    console.log(`Without index: avg ${withoutAvg.toFixed(2)}ms`);
    console.log(`Speedup: ${(withoutAvg / withAvg).toFixed(2)}x`);
  } finally {
    console.log("\nCleaning up benchmark data...");
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => undefined);
    await adminClient.$disconnect();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
