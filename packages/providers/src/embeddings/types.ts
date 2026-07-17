/**
 * Provider abstraction for turning text into vectors — see
 * docs/architecture.md §4.4. One embedding model per KnowledgeBase, fixed
 * at creation; swapping the default provider/model is a config change at
 * the call site, not a rewrite of pipeline code, because every stage only
 * ever depends on this interface.
 */
export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
}
