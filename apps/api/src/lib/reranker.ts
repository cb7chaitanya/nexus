import { IdentityReranker, type Reranker } from "@raas/core";

// Module-level singleton, same convention as getEmbeddingProvider/
// getLLMProvider. IdentityReranker is the only implementation that
// exists — this indirection is what makes swapping in a real
// cross-encoder reranker later a one-line change here, not a pipeline
// edit in chat.ts (architecture.md §4.7).
let reranker: Reranker | undefined;

export function getReranker(): Reranker {
  if (!reranker) {
    reranker = new IdentityReranker();
  }
  return reranker;
}
