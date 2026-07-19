import { describe, expect, it } from "vitest";

import { IdentityReranker } from "../reranking/identity.js";
import type { Reranker } from "../reranking/types.js";
import type { RetrievedChunk } from "../types.js";
import { KeywordOverlapReranker } from "./keyword-reranker.js";
import { LexicalEmbeddingProvider, rankByCosineSimilarity } from "./lexical-embedding.js";
import { precisionAtK, reciprocalRank } from "./metrics.js";
import { runRetrievalBenchmark } from "./run-benchmark.js";
import type { EvalDataset } from "./types.js";

/**
 * Requirement: replacing the identity reranker with a real reranker
 * provider must require no pipeline changes. Both tests below prove this
 * the same way production would adopt a real reranker
 * (`apps/api/src/lib/reranker.ts`'s `getReranker()` swapping which
 * `Reranker` it constructs) — by passing a different object that
 * implements the same `Reranker` interface into the exact same call site,
 * with no other code touched.
 *
 * `KeywordOverlapReranker` stands in for "a real reranker provider" here.
 * It's not a production choice (see its own doc comment) but it IS a
 * second, independent, non-identity implementation of the interface,
 * which is all a pipeline is allowed to assume about a reranker.
 */
describe("swapping IdentityReranker for a real Reranker implementation", () => {
  // A short, keyword-stuffed but low-information chunk ("decoy") next to
  // a long, substantive, correct one ("answer") — a realistic lexical
  // retrieval failure mode: bag-of-words similarity favors dense keyword
  // repetition over a correct answer diluted by its own genuinely
  // relevant supporting detail. Base retrieval (LexicalEmbeddingProvider)
  // ranks "decoy" first; this is empirically verified below, not assumed.
  const decoy: { id: string; documentId: string; content: string } = {
    id: "decoy",
    documentId: "doc-x",
    content: "vector search vector search",
  };
  const answer: { id: string; documentId: string; content: string } = {
    id: "answer",
    documentId: "doc-y",
    content:
      "PostgreSQL supports the pgvector extension, which adds a native vector column type to the database, enabling efficient nearest neighbor search using an HNSW index built on top of the standard B-tree and GIN infrastructure already present in the query planner.",
  };
  const query = "Which index does PostgreSQL use for nearest neighbor vector search?";

  async function retrieveBaseOrder(): Promise<RetrievedChunk[]> {
    const provider = new LexicalEmbeddingProvider();
    const chunks = [decoy, answer].map((c, i) => ({ id: c.id, documentId: c.documentId, chunkIndex: i, pageNumber: 1, content: c.content }));
    const embeddings = new Map(
      await Promise.all(chunks.map(async (c): Promise<[string, number[]]> => [c.id, (await provider.embed([c.content]))[0]!])),
    );
    const [queryVector] = await provider.embed([query]);
    return rankByCosineSimilarity(chunks, embeddings, queryVector!, 2);
  }

  it("confirms the fixture actually reproduces the failure: base retrieval ranks the decoy above the real answer", async () => {
    const retrieved = await retrieveBaseOrder();
    expect(retrieved.map((c) => c.chunkId)).toEqual(["decoy", "answer"]);
  });

  it("IdentityReranker leaves the wrong order in place — the answer stays ranked 2nd", async () => {
    const retrieved = await retrieveBaseOrder();
    const reranked = await new IdentityReranker().rerank({ query, chunks: retrieved });

    expect(reranked.map((c) => c.chunkId)).toEqual(["decoy", "answer"]);
    expect(reciprocalRank(reranked.map((c) => c.chunkId), ["answer"])).toBe(0.5);
  });

  it("a real reranker corrects the order — same input, same call shape, only the Reranker instance differs", async () => {
    const retrieved = await retrieveBaseOrder();

    // The only thing that changed from the previous test: which Reranker
    // is called. `retrieved`, `query`, and the call shape itself
    // (`reranker.rerank({ query, chunks })`) are identical.
    const reranked = await new KeywordOverlapReranker().rerank({ query, chunks: retrieved });

    expect(reranked.map((c) => c.chunkId)).toEqual(["answer", "decoy"]);
    expect(reciprocalRank(reranked.map((c) => c.chunkId), ["answer"])).toBe(1);
    expect(precisionAtK(reranked.map((c) => c.chunkId), ["answer"])).toBe(0.5);
  });

  it("runRetrievalBenchmark itself needs no code change — only the `reranker` option differs across the two runs", async () => {
    const dataset: EvalDataset = {
      name: "reranker-swap-fixture",
      chunks: [decoy, answer].map((c, i) => ({ id: c.id, documentId: c.documentId, chunkIndex: i, pageNumber: 1, content: c.content })),
      cases: [{ id: "case-1", question: query, expectedRelevantChunkIds: ["answer"], expectedCitationChunkIds: ["answer"] }],
    };

    async function runWith(reranker: Reranker) {
      const report = await runRetrievalBenchmark(dataset, { k: 2, reranker });
      return report.cases[0]!;
    }

    const withIdentity = await runWith(new IdentityReranker());
    const withKeyword = await runWith(new KeywordOverlapReranker());

    expect(withIdentity.reciprocalRank).toBe(0.5);
    expect(withKeyword.reciprocalRank).toBe(1);
    expect(withKeyword.reciprocalRank).toBeGreaterThan(withIdentity.reciprocalRank);
  });
});
