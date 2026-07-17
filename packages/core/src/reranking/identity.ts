import type { RetrievedChunk } from "../types.js";
import type { RerankParams, Reranker } from "./types.js";

/**
 * No-op pass-through — returns the retrieved chunks unchanged, in the
 * same order similarity search produced them. The shipped default
 * (architecture.md §4.7: "a rerank step... that is a no-op pass-through
 * by default"); real reranking is a genuine latency/cost cost on every
 * chat message, deliberately not turned on until there's a measured
 * quality reason to pay it.
 */
export class IdentityReranker implements Reranker {
  async rerank({ chunks }: RerankParams): Promise<RetrievedChunk[]> {
    return chunks;
  }
}
