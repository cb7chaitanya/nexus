/**
 * Retrieval benchmark dataset format. A dataset is a small, self-contained
 * knowledge base fixture: the chunks that would otherwise live in
 * `DocumentChunk` rows, plus a set of questions with hand-labeled ground
 * truth. Everything here is plain data (no embeddings, no DB rows) so a
 * dataset can be committed as a literal TS/JSON file and reviewed like any
 * other test fixture.
 */

/** Stand-in for a `DocumentChunk` row — same shape as the fields
 * `searchSimilarChunks` returns, minus `embedding`/`score` (which are
 * computed at run time, not authored). `id` is a fixture-local stable
 * identifier (not a real UUID) — it's what `expectedRelevantChunkIds` and
 * `expectedCitationChunkIds` below reference. */
export interface EvalChunk {
  id: string;
  documentId: string;
  chunkIndex: number;
  content: string;
  pageNumber: number | null;
}

/** One benchmark question with its ground truth. */
export interface EvalCase {
  id: string;
  question: string;
  /** Every `EvalChunk.id` that would be an acceptable retrieval result for
   * this question — the ground truth Recall@K/Precision@K/MRR are scored
   * against. Order does not matter: this is a set, not a ranking. */
  expectedRelevantChunkIds: string[];
  /** Every `EvalChunk.id` a correct, well-cited answer should cite. Usually
   * a subset of `expectedRelevantChunkIds` (a chunk can be relevant enough
   * to retrieve without being the specific chunk the answer draws from). */
  expectedCitationChunkIds: string[];
}

export interface EvalDataset {
  name: string;
  chunks: EvalChunk[];
  cases: EvalCase[];
}

/** Per-question scoring, plus what was actually retrieved/cited — kept
 * alongside the scores so a benchmark run's output is inspectable, not
 * just a number. */
export interface EvalCaseResult {
  caseId: string;
  question: string;
  retrievedChunkIds: string[];
  citedChunkIds: string[];
  recallAtK: number;
  precisionAtK: number;
  reciprocalRank: number;
  citationCoverage: number;
  unsupportedCitationRate: number;
}

export interface EvalReport {
  datasetName: string;
  k: number;
  cases: EvalCaseResult[];
  aggregate: {
    meanRecallAtK: number;
    meanPrecisionAtK: number;
    mrr: number;
    meanCitationCoverage: number;
    meanUnsupportedCitationRate: number;
  };
}
