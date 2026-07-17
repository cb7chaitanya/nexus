/**
 * Verifies the HNSW index (migration
 * 20260717122000_add_document_chunk_hnsw_index) is a real index that
 * exists with the right definition, and that the exact query
 * searchSimilarChunks issues correctly routes through indexed access
 * paths (never a sequential scan) once one is disallowed.
 *
 * What this deliberately does NOT try to assert: that the HNSW index
 * specifically (as opposed to some other index) is what the planner
 * picks at whatever row count a fast test fixture can seed. Investigated
 * this directly rather than assuming it: with `SET LOCAL enable_seqscan
 * = off`, RLS's own policy predicate (`"organizationId" =
 * current_setting(...)`) is itself an equality filter, and Postgres has
 * an existing plain-btree index on organizationId — at small-to-medium
 * row counts that "index-scan on organizationId, then sort the few
 * matching rows in memory" plan is genuinely CHEAPER than an HNSW index
 * scan, and the planner correctly picks it. Empirically, seeding this
 * exact org/KB with successively more rows, the crossover to the planner
 * choosing document_chunk_embedding_idx specifically happened somewhere
 * between 3,000 and 5,000 rows — not something a fast correctness test
 * should be seeding on every run. scripts/benchmark-vector-search.ts (at
 * a realistic 10k-row scale) is what actually proves the HNSW index gets
 * chosen and measurably helps — see docs/vector-index-benchmark.md for
 * that result. This test only proves the index is real and that nothing
 * here can silently regress into an unindexed sequential scan.
 */
import { randomUUID } from "node:crypto";

import { prisma, withTenantTransaction } from "@raas/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DIM = 1536;

function unitVector(hotIndex: number): number[] {
  const vector = new Array(DIM).fill(0) as number[];
  vector[hotIndex] = 1;
  return vector;
}

describe("DocumentChunk embedding HNSW index", () => {
  const suffix = randomUUID().slice(0, 8);
  let organizationId: string;
  let knowledgeBaseId: string;

  beforeAll(async () => {
    const org = await prisma.organization.create({ data: { name: `Index Org ${suffix}`, slug: `index-org-${suffix}` } });
    organizationId = org.id;
    const kb = await withTenantTransaction(organizationId, (tx) =>
      tx.knowledgeBase.create({
        data: { organizationId, name: "Index KB", embeddingProvider: "openai", embeddingModel: "text-embedding-3-small", embeddingDim: DIM },
      }),
    );
    knowledgeBaseId = kb.id;

    const doc = await withTenantTransaction(organizationId, (tx) =>
      tx.document.create({
        data: { organizationId, knowledgeBaseId, fileName: "x.pdf", mimeType: "application/pdf", sizeBytes: 1, storageKey: `${organizationId}/${randomUUID()}` },
      }),
    );
    const chunk = await withTenantTransaction(organizationId, (tx) =>
      tx.documentChunk.create({
        data: { organizationId, knowledgeBaseId, documentId: doc.id, chunkIndex: 0, content: "x", tokenCount: 1, charStart: 0, charEnd: 1 },
      }),
    );
    const vectorLiteral = `[${unitVector(0).join(",")}]`;
    await withTenantTransaction(organizationId, (tx) => tx.$executeRaw`UPDATE "DocumentChunk" SET embedding = ${vectorLiteral}::vector WHERE id = ${chunk.id}`);
  });

  afterAll(async () => {
    await prisma.organization.delete({ where: { id: organizationId } }).catch(() => undefined);
  });

  it("is a real HNSW (cosine ops) index on DocumentChunk.embedding", async () => {
    const rows = await prisma.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
      SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'DocumentChunk' AND indexname = 'document_chunk_embedding_idx'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.indexdef).toContain("USING hnsw");
    expect(rows[0]!.indexdef).toContain("vector_cosine_ops");
  });

  it("routes the exact searchSimilarChunks query through an indexed access path, never a sequential scan", async () => {
    const vectorLiteral = `[${unitVector(0).join(",")}]`;

    const plan = await withTenantTransaction(organizationId, async (tx) => {
      await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
      return tx.$queryRaw<Array<{ "QUERY PLAN": string }>>`
        EXPLAIN
        SELECT id, "documentId", "chunkIndex", content, "pageNumber", 1 - (embedding <=> ${vectorLiteral}::vector) AS score
        FROM "DocumentChunk"
        WHERE "organizationId" = ${organizationId}
          AND "knowledgeBaseId" = ${knowledgeBaseId}
          AND embedding IS NOT NULL
        ORDER BY embedding <=> ${vectorLiteral}::vector
        LIMIT 8
      `;
    });

    const planText = plan.map((row) => row["QUERY PLAN"]).join("\n");
    expect(planText).toContain("Index Scan");
    expect(planText).not.toContain("Seq Scan");
  });
});
