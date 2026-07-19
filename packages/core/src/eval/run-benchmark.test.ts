import { describe, expect, it } from "vitest";

import { sampleRetrievalDataset } from "./fixtures/sample-dataset.js";
import { runRetrievalBenchmark } from "./run-benchmark.js";

/**
 * End-to-end, still entirely in-memory: no Postgres connection, no
 * network call, nothing non-deterministic. Exact expected numbers below
 * were captured from a real run against `sampleRetrievalDataset` and are
 * pinned here as a regression guard — if a future change to
 * `assembleContext`, `validateCitations`, `rankByCosineSimilarity`, or the
 * fixture itself shifts these, that's exactly what this test exists to
 * catch.
 */
describe("runRetrievalBenchmark against the sample dataset (default IdentityReranker)", () => {
  it("retrieves the expected chunks and scores every metric correctly, per case", async () => {
    const report = await runRetrievalBenchmark(sampleRetrievalDataset, { k: 3 });

    expect(report.datasetName).toBe("sample-retrieval-benchmark");
    expect(report.k).toBe(3);
    expect(report.cases).toHaveLength(4);

    const byCaseId = new Map(report.cases.map((c) => [c.caseId, c]));

    // Single-expected-chunk questions: the right chunk is always ranked
    // first (recall=1, MRR contribution=1), but K=3 pulls in one
    // unrelated chunk from another topic alongside the two same-document
    // siblings, so precision is 1/3.
    const bio1 = byCaseId.get("bio-1")!;
    expect(bio1.retrievedChunkIds).toEqual(["bio-1", "bio-2", "astro-2"]);
    expect(bio1.recallAtK).toBe(1);
    expect(bio1.precisionAtK).toBeCloseTo(1 / 3);
    expect(bio1.reciprocalRank).toBe(1);

    const history1 = byCaseId.get("history-1")!;
    expect(history1.retrievedChunkIds).toEqual(["history-1", "bio-1", "history-2"]);
    expect(history1.recallAtK).toBe(1);
    expect(history1.precisionAtK).toBeCloseTo(1 / 3);
    expect(history1.reciprocalRank).toBe(1);

    // Two-expected-chunk questions: both same-document chunks are the top
    // 2 results, so recall/MRR are still perfect and precision is higher
    // (2 of 3 retrieved were actually relevant).
    const db1 = byCaseId.get("db-1")!;
    expect(db1.retrievedChunkIds).toEqual(["db-1", "db-2", "bio-2"]);
    expect(db1.recallAtK).toBe(1);
    expect(db1.precisionAtK).toBeCloseTo(2 / 3);
    expect(db1.reciprocalRank).toBe(1);

    const astro1 = byCaseId.get("astro-1")!;
    expect(astro1.retrievedChunkIds).toEqual(["astro-1", "astro-2", "history-2"]);
    expect(astro1.recallAtK).toBe(1);
    expect(astro1.precisionAtK).toBeCloseTo(2 / 3);
    expect(astro1.reciprocalRank).toBe(1);
  });

  it("FakeLLMProvider cites every retrieved chunk (see its own doc comment), so citation coverage is always full but only citing the single expected chunk of three leaves a high unsupported rate", async () => {
    const report = await runRetrievalBenchmark(sampleRetrievalDataset, { k: 3 });

    for (const c of report.cases) {
      // Every expected citation was, trivially, among what got cited —
      // FakeLLMProvider cites the whole context, never fewer.
      expect(c.citationCoverage).toBe(1);
      // Every dataset case has exactly ONE expectedCitationChunkIds entry
      // (see sample-dataset.ts) but three chunks end up in context at
      // K=3, and FakeLLMProvider cites all three — so 2 of the 3
      // citations are always "unsupported" by this fixture's stricter
      // definition of "the one chunk a precise answer should cite",
      // even though every citation is structurally valid. This is the
      // deliberately visible cost of pairing FakeLLMProvider's
      // cite-everything behavior with a K wider than the narrow citation
      // target.
      expect(c.unsupportedCitationRate).toBeCloseTo(2 / 3);
    }
  });

  it("aggregates per-case scores into dataset-level means", async () => {
    const report = await runRetrievalBenchmark(sampleRetrievalDataset, { k: 3 });

    expect(report.aggregate.meanRecallAtK).toBe(1);
    expect(report.aggregate.mrr).toBe(1);
    expect(report.aggregate.meanPrecisionAtK).toBeCloseTo((1 / 3 + 2 / 3 + 1 / 3 + 2 / 3) / 4);
    expect(report.aggregate.meanCitationCoverage).toBe(1);
    expect(report.aggregate.meanUnsupportedCitationRate).toBeCloseTo(2 / 3);
  });

  it("is fully deterministic — two runs against the same dataset produce identical reports", async () => {
    const first = await runRetrievalBenchmark(sampleRetrievalDataset, { k: 3 });
    const second = await runRetrievalBenchmark(sampleRetrievalDataset, { k: 3 });
    expect(first).toEqual(second);
  });
});
