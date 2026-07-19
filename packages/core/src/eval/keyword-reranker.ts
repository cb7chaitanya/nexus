import type { RetrievedChunk } from "../types.js";
import type { RerankParams, Reranker } from "../reranking/types.js";
import { tokenize } from "./lexical-embedding.js";

/**
 * A second, non-identity `Reranker` implementation, used only by this
 * eval framework's own tests to prove requirement (3): swapping the
 * identity reranker out for a real one requires no change to the
 * retrieve -> rerank -> assemble -> generate pipeline, only a different
 * `Reranker` instance passed to `runRetrievalBenchmark` (or, in
 * production, to `apps/api/src/lib/reranker.ts`'s `getReranker()`).
 *
 * It is not a production reranker choice (no cross-encoder, no model,
 * just exact-token-overlap scoring against the query) and is not exported
 * from `@raas/core`'s package index — it exists purely as a deterministic,
 * offline "something other than identity" to reorder against. When a real
 * cross-encoder/API-backed reranker is adopted, it plugs into the exact
 * same `Reranker` interface this implements — see `EVALUATION.md`.
 */
export class KeywordOverlapReranker implements Reranker {
  async rerank({ query, chunks }: RerankParams): Promise<RetrievedChunk[]> {
    const queryTokens = new Set(tokenize(query));

    return chunks
      .map((chunk, originalIndex) => ({ chunk, originalIndex, overlap: this.overlapCount(queryTokens, chunk.content) }))
      .sort((a, b) => b.overlap - a.overlap || a.originalIndex - b.originalIndex)
      .map((entry) => entry.chunk);
  }

  private overlapCount(queryTokens: Set<string>, content: string): number {
    let count = 0;
    for (const token of new Set(tokenize(content))) {
      if (queryTokens.has(token)) count++;
    }
    return count;
  }
}
