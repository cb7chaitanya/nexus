import type { EmbeddingProvider } from "@raas/providers";

import type { RetrievedChunk } from "../types.js";
import type { EvalChunk } from "./types.js";

/**
 * A second, DIFFERENT kind of fake embedding provider from
 * `@raas/providers`'s `FakeEmbeddingProvider`, and not interchangeable
 * with it. `FakeEmbeddingProvider` hashes the whole input string with
 * sha256 — deterministic, but deliberately *non-semantic*: a one-character
 * difference in the input produces a completely unrelated vector, so
 * cosine similarity between two of its vectors carries no information
 * about whether the underlying texts are actually related. That's fine
 * for exercising the embedding *pipeline* (which is all it's used for
 * elsewhere), but it makes it useless for THIS package: an eval fixture's
 * `expectedRelevantChunkIds` is only checkable if a chunk about the same
 * topic as the question actually tends to rank higher than an unrelated
 * one.
 *
 * `LexicalEmbeddingProvider` fixes that: a classic hashing-trick
 * bag-of-words vector (lowercase, alphanumeric tokens, each hashed into
 * one of `dim` buckets and counted). Two texts that share vocabulary get
 * vectors with positive cosine similarity; texts that share nothing are
 * close to orthogonal. Still fully deterministic and offline — no network
 * call, no API key, same text always produces the same vector — but now
 * the similarity signal actually correlates with lexical overlap, which
 * is what makes it possible to author a fixture and know in advance,
 * without running anything, roughly which chunks should retrieve for
 * which questions.
 *
 * This is an eval-only tool, not a production embedding choice: it is not
 * exported from `@raas/core`'s package index, not registered in
 * `apps/api/src/lib/embedding-provider.ts`'s provider switch, and is
 * never used to embed anything that ends up in a real `DocumentChunk`
 * row. It implements `@raas/providers`'s `EmbeddingProvider` interface
 * only so a real provider (the real `FakeEmbeddingProvider`, or a real
 * `OpenAIEmbeddingProvider`) can be swapped in for a "live" benchmark run
 * via the exact same `runRetrievalBenchmark` option — see
 * `run-benchmark.ts`.
 */
export interface LexicalEmbeddingProviderOptions {
  /** Number of hash buckets (vector dimension). Larger reduces hash
   * collisions between unrelated tokens at the cost of a bigger vector;
   * 256 is plenty for the small fixture datasets this framework targets. */
  dim?: number;
}

const DEFAULT_DIM = 256;
const TOKEN_RE = /[a-z0-9]+/g;

export function tokenize(text: string): string[] {
  return text.toLowerCase().match(TOKEN_RE) ?? [];
}

/** Deterministic string -> non-negative int hash (FNV-1a variant) — no
 * crypto needed, this only has to be stable and reasonably well-spread
 * across buckets, not cryptographically secure. */
function hashToken(token: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export class LexicalEmbeddingProvider implements EmbeddingProvider {
  private readonly dim: number;

  constructor(options: LexicalEmbeddingProviderOptions = {}) {
    this.dim = options.dim ?? DEFAULT_DIM;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.vectorFor(text));
  }

  private vectorFor(text: string): number[] {
    const vector = new Array<number>(this.dim).fill(0);
    for (const token of tokenize(text)) {
      const bucket = hashToken(token) % this.dim;
      vector[bucket] = vector[bucket]! + 1;
    }
    return vector;
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Pure in-memory stand-in for `searchSimilarChunks`'s pgvector query:
 * same ranking semantics (`score = cosine similarity`, best match first,
 * capped at `limit`), computed over a plain array + a precomputed
 * embedding map instead of `SELECT ... ORDER BY embedding <=> $1 LIMIT
 * $2` against Postgres. Ranking by cosine similarity is a property of the
 * vectors, not of the database engine evaluating the `<=>` operator, so
 * this is a faithful stand-in for retrieval *quality* measurement — it
 * just skips the real I/O, which is what lets the whole benchmark run
 * without a live Postgres connection or an embedding API call.
 */
export function rankByCosineSimilarity(
  chunks: EvalChunk[],
  embeddings: Map<string, number[]>,
  queryVector: number[],
  limit: number,
): RetrievedChunk[] {
  return chunks
    .map((chunk) => {
      const vector = embeddings.get(chunk.id);
      if (!vector) {
        throw new Error(`No embedding computed for fixture chunk "${chunk.id}"`);
      }
      return {
        chunkId: chunk.id,
        documentId: chunk.documentId,
        chunkIndex: chunk.chunkIndex,
        content: chunk.content,
        pageNumber: chunk.pageNumber,
        score: cosineSimilarity(queryVector, vector),
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
