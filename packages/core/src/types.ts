/** One chunk returned by similarity search, ordered by relevance (best
 * match first) — the raw candidate set before context assembly dedupes
 * and truncates it. */
export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  chunkIndex: number;
  content: string;
  pageNumber: number | null;
  /** Cosine similarity (1 - cosine distance), higher is more relevant. */
  score: number;
}

/** A chunk that made it into the assembled context, tagged with the
 * short-lived reference id (`c1`, `c2`, ...) the model is instructed to
 * cite against for this one request. */
export interface AssembledContextChunk {
  refId: string;
  chunkId: string;
  documentId: string;
  pageNumber: number | null;
  content: string;
}

export interface AssembledContext {
  chunks: AssembledContextChunk[];
  /** Ready to inject into the prompt's context block. */
  contextText: string;
}

/** A citation resolved against the context that was actually sent for a
 * request. See validateCitations's doc comment for exactly what this
 * does and does not verify. */
export interface Citation {
  refId: string;
  chunkId: string;
  documentId: string;
  pageNumber: number | null;
  quote: string;
}
