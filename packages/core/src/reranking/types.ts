import type { RetrievedChunk } from "../types.js";

export interface RerankParams {
  query: string;
  chunks: RetrievedChunk[];
}

/**
 * A named pipeline stage between retrieval and context assembly
 * (architecture.md §4.7): retrieve -> rerank -> assemble context -> LLM.
 * Its presence as a real interface — not just a comment — is what makes
 * turning on a real cross-encoder reranker later a config change (swap
 * which Reranker apps/api's getReranker() constructs) rather than a
 * pipeline redesign.
 */
export interface Reranker {
  rerank(params: RerankParams): Promise<RetrievedChunk[]>;
}
