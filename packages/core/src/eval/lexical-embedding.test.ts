import { describe, expect, it } from "vitest";

import { cosineSimilarity, LexicalEmbeddingProvider, rankByCosineSimilarity, tokenize } from "./lexical-embedding.js";
import type { EvalChunk } from "./types.js";

describe("tokenize", () => {
  it("lowercases and splits on non-alphanumeric characters", () => {
    expect(tokenize("Photosynthesis: converts SUNLIGHT!")).toEqual(["photosynthesis", "converts", "sunlight"]);
  });

  it("returns an empty array for text with no word characters", () => {
    expect(tokenize("...")).toEqual([]);
  });
});

describe("LexicalEmbeddingProvider", () => {
  it("is deterministic — the same text always produces the same vector", async () => {
    const provider = new LexicalEmbeddingProvider();
    const [first] = await provider.embed(["the quick brown fox"]);
    const [second] = await provider.embed(["the quick brown fox"]);
    expect(first).toEqual(second);
  });

  it("gives texts that share vocabulary a higher cosine similarity than texts that share none", async () => {
    const provider = new LexicalEmbeddingProvider();
    const [query, related, unrelated] = await provider.embed([
      "how does photosynthesis convert sunlight into energy",
      "photosynthesis converts sunlight into chemical energy inside the leaf",
      "PostgreSQL is a relational database with support for indexes",
    ]);

    const relatedScore = cosineSimilarity(query!, related!);
    const unrelatedScore = cosineSimilarity(query!, unrelated!);

    expect(relatedScore).toBeGreaterThan(unrelatedScore);
    expect(unrelatedScore).toBeCloseTo(0, 5);
  });

  it("produces a vector of the configured dimension, unaffected by text length", async () => {
    const provider = new LexicalEmbeddingProvider({ dim: 64 });
    const [short, long] = await provider.embed(["a", "a very long sentence with many different unique words in it"]);
    expect(short).toHaveLength(64);
    expect(long).toHaveLength(64);
  });
});

describe("rankByCosineSimilarity", () => {
  const chunks: EvalChunk[] = [
    { id: "a", documentId: "doc-1", chunkIndex: 0, pageNumber: 1, content: "photosynthesis converts sunlight into energy" },
    { id: "b", documentId: "doc-2", chunkIndex: 0, pageNumber: 1, content: "PostgreSQL supports B-tree and GIN indexes" },
    { id: "c", documentId: "doc-3", chunkIndex: 0, pageNumber: 1, content: "the French Revolution began in 1789" },
  ];

  it("ranks the chunk sharing the most vocabulary with the query first", async () => {
    const provider = new LexicalEmbeddingProvider();
    const embeddings = new Map(await Promise.all(chunks.map(async (c) => [c.id, (await provider.embed([c.content]))[0]!] as const)));
    const [queryVector] = await provider.embed(["how do plants use sunlight for energy via photosynthesis"]);

    const ranked = rankByCosineSimilarity(chunks, embeddings, queryVector!, 3);

    expect(ranked[0]!.chunkId).toBe("a");
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
  });

  it("respects the limit", async () => {
    const provider = new LexicalEmbeddingProvider();
    const embeddings = new Map(await Promise.all(chunks.map(async (c) => [c.id, (await provider.embed([c.content]))[0]!] as const)));
    const [queryVector] = await provider.embed(["indexes"]);

    const ranked = rankByCosineSimilarity(chunks, embeddings, queryVector!, 1);

    expect(ranked).toHaveLength(1);
  });

  it("throws a clear error if a chunk has no precomputed embedding, rather than silently scoring it 0", async () => {
    const provider = new LexicalEmbeddingProvider();
    const [queryVector] = await provider.embed(["anything"]);
    expect(() => rankByCosineSimilarity(chunks, new Map(), queryVector!, 3)).toThrow(/no embedding/i);
  });
});
