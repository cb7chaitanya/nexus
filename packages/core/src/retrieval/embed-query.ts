import type { EmbeddingProvider } from "@raas/providers";

/**
 * Embeds the user's chat message with the same model the knowledge base
 * was built with (architecture.md §4.6 — retrieval must never let the
 * caller pick a different embedding model than the one the KB's vectors
 * were generated with, since the vectors wouldn't be comparable).
 * Deliberately a one-line function: keeping "which provider embeds the
 * query" as an explicit pipeline stage in packages/core, rather than
 * inlined at the call site, is what makes it obvious in a code review that
 * retrieval never picks its own model.
 */
export async function embedQuery(provider: EmbeddingProvider, query: string): Promise<number[]> {
  const [embedding] = await provider.embed([query]);
  if (!embedding) {
    throw new Error("embedding provider returned no vector for the query");
  }
  return embedding;
}
