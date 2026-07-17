/**
 * Real Postgres integration test — pgvector's ORDER BY/LIMIT behavior and,
 * most importantly, the org-isolation WHERE clause can't be meaningfully
 * verified without a live database (see similarity-search.ts's own header
 * comment: this query is "the single most important line of SQL in the
 * whole system from a security standpoint"). Prerequisites: docker
 * compose up -d, migrations applied.
 */
import { randomUUID } from "node:crypto";

import { prisma, withTenantTransaction } from "@raas/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { searchSimilarChunks } from "./similarity-search.js";

const DIM = 1536;

function unitVector(hotIndex: number): number[] {
  const vector = new Array(DIM).fill(0) as number[];
  vector[hotIndex] = 1;
  return vector;
}

function vectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

describe("searchSimilarChunks", () => {
  const suffix = randomUUID().slice(0, 8);
  let orgA: { id: string };
  let orgB: { id: string };
  let kbA: { id: string };
  let kbB: { id: string };

  beforeAll(async () => {
    orgA = await prisma.organization.create({ data: { name: `Search Org A ${suffix}`, slug: `search-org-a-${suffix}` } });
    orgB = await prisma.organization.create({ data: { name: `Search Org B ${suffix}`, slug: `search-org-b-${suffix}` } });

    kbA = await withTenantTransaction(orgA.id, (tx) =>
      tx.knowledgeBase.create({
        data: { organizationId: orgA.id, name: "KB A", embeddingProvider: "openai", embeddingModel: "text-embedding-3-small", embeddingDim: DIM },
      }),
    );
    kbB = await withTenantTransaction(orgB.id, (tx) =>
      tx.knowledgeBase.create({
        data: { organizationId: orgB.id, name: "KB B", embeddingProvider: "openai", embeddingModel: "text-embedding-3-small", embeddingDim: DIM },
      }),
    );
  });

  afterAll(async () => {
    await prisma.organization.delete({ where: { id: orgA.id } }).catch(() => undefined);
    await prisma.organization.delete({ where: { id: orgB.id } }).catch(() => undefined);
  });

  async function createChunk(orgId: string, kbId: string, content: string, hotIndex: number | null): Promise<string> {
    const doc = await withTenantTransaction(orgId, (tx) =>
      tx.document.create({
        data: {
          organizationId: orgId,
          knowledgeBaseId: kbId,
          fileName: `${randomUUID()}.pdf`,
          mimeType: "application/pdf",
          sizeBytes: 10,
          storageKey: `${orgId}/${randomUUID()}`,
        },
      }),
    );
    const chunk = await withTenantTransaction(orgId, (tx) =>
      tx.documentChunk.create({
        data: { organizationId: orgId, knowledgeBaseId: kbId, documentId: doc.id, chunkIndex: 0, content, tokenCount: 1, charStart: 0, charEnd: content.length },
      }),
    );
    if (hotIndex !== null) {
      await withTenantTransaction(orgId, (tx) =>
        tx.$executeRaw`UPDATE "DocumentChunk" SET embedding = ${vectorLiteral(unitVector(hotIndex))}::vector WHERE id = ${chunk.id}`,
      );
    }
    return chunk.id;
  }

  it("never returns another organization's chunks, even when they'd score as the closest possible match", async () => {
    // Both orgs get a chunk with the SAME vector as the query — this is
    // what actually proves the isolation filter is doing real work, not
    // just coincidentally never matching a less-relevant org B chunk.
    const chunkIdA = await createChunk(orgA.id, kbA.id, "org a exact match", 0);
    await createChunk(orgB.id, kbB.id, "org b exact match", 0);

    const results = await withTenantTransaction(orgA.id, (tx) =>
      searchSimilarChunks(tx, { organizationId: orgA.id, knowledgeBaseId: kbA.id, queryEmbedding: unitVector(0) }),
    );

    expect(results.some((r) => r.chunkId === chunkIdA)).toBe(true);
    expect(results.some((r) => r.content === "org b exact match")).toBe(false);
  });

  it("also enforces knowledgeBaseId, not just organizationId", async () => {
    const kbA2 = await withTenantTransaction(orgA.id, (tx) =>
      tx.knowledgeBase.create({
        data: { organizationId: orgA.id, name: "KB A2", embeddingProvider: "openai", embeddingModel: "text-embedding-3-small", embeddingDim: DIM },
      }),
    );
    await createChunk(orgA.id, kbA2.id, "wrong kb exact match", 7);

    const results = await withTenantTransaction(orgA.id, (tx) =>
      searchSimilarChunks(tx, { organizationId: orgA.id, knowledgeBaseId: kbA.id, queryEmbedding: unitVector(7) }),
    );

    expect(results.some((r) => r.content === "wrong kb exact match")).toBe(false);
  });

  it("orders results by descending relevance", async () => {
    const closeId = await createChunk(orgA.id, kbA.id, "closest", 1);
    const farId = await createChunk(orgA.id, kbA.id, "farthest", 2);

    const results = await withTenantTransaction(orgA.id, (tx) =>
      searchSimilarChunks(tx, { organizationId: orgA.id, knowledgeBaseId: kbA.id, queryEmbedding: unitVector(1), limit: 20 }),
    );

    const closeIndex = results.findIndex((r) => r.chunkId === closeId);
    const farIndex = results.findIndex((r) => r.chunkId === farId);
    expect(closeIndex).toBeGreaterThanOrEqual(0);
    expect(farIndex).toBeGreaterThan(closeIndex);
  });

  it("respects the limit parameter", async () => {
    for (let i = 0; i < 5; i++) {
      await createChunk(orgA.id, kbA.id, `limit test ${i} ${randomUUID()}`, 3);
    }

    const results = await withTenantTransaction(orgA.id, (tx) =>
      searchSimilarChunks(tx, { organizationId: orgA.id, knowledgeBaseId: kbA.id, queryEmbedding: unitVector(3), limit: 2 }),
    );

    expect(results).toHaveLength(2);
  });

  it("excludes chunks that have not been embedded yet", async () => {
    const content = `unembedded ${randomUUID()}`;
    await createChunk(orgA.id, kbA.id, content, null);

    const results = await withTenantTransaction(orgA.id, (tx) =>
      searchSimilarChunks(tx, { organizationId: orgA.id, knowledgeBaseId: kbA.id, queryEmbedding: unitVector(0), limit: 50 }),
    );

    expect(results.some((r) => r.content === content)).toBe(false);
  });
});
