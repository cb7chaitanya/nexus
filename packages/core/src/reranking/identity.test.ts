import { describe, expect, it } from "vitest";

import type { RetrievedChunk } from "../types.js";
import { IdentityReranker } from "./identity.js";

function chunk(chunkId: string, score: number): RetrievedChunk {
  return { chunkId, documentId: "doc-1", chunkIndex: 0, content: `content ${chunkId}`, pageNumber: null, score };
}

describe("IdentityReranker", () => {
  it("returns the chunks unchanged, same order", async () => {
    const chunks = [chunk("a", 0.9), chunk("b", 0.5), chunk("c", 0.7)];
    const result = await new IdentityReranker().rerank({ query: "anything", chunks });

    expect(result).toEqual(chunks);
    expect(result.map((c) => c.chunkId)).toEqual(["a", "b", "c"]);
  });

  it("returns an empty array unchanged", async () => {
    const result = await new IdentityReranker().rerank({ query: "anything", chunks: [] });
    expect(result).toEqual([]);
  });
});
