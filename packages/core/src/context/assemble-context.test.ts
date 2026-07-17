import { describe, expect, it } from "vitest";

import type { RetrievedChunk } from "../types.js";
import { assembleContext } from "./assemble-context.js";

function chunk(overrides: Partial<RetrievedChunk> & { chunkId: string; content: string }): RetrievedChunk {
  return {
    documentId: "doc-1",
    chunkIndex: 0,
    pageNumber: null,
    score: 0.9,
    ...overrides,
  };
}

describe("assembleContext", () => {
  it("returns a placeholder context when there are no candidates", () => {
    const result = assembleContext([]);
    expect(result.chunks).toEqual([]);
    expect(result.contextText).toContain("No relevant reference material");
  });

  it("assigns contiguous refIds in candidate order and includes the citation label in contextText", () => {
    const candidates = [
      chunk({ chunkId: "a", content: "First chunk content", pageNumber: 3 }),
      chunk({ chunkId: "b", content: "Second chunk content", pageNumber: 4 }),
    ];

    const result = assembleContext(candidates);

    expect(result.chunks.map((c) => c.refId)).toEqual(["c1", "c2"]);
    expect(result.chunks[0]!.chunkId).toBe("a");
    expect(result.contextText).toContain("[[chunk:c1]] (document: doc-1, page: 3)");
    expect(result.contextText).toContain("First chunk content");
    expect(result.contextText).toContain("[[chunk:c2]] (document: doc-1, page: 4)");
  });

  it("renders a missing page number as n/a", () => {
    const result = assembleContext([chunk({ chunkId: "a", content: "content", pageNumber: null })]);
    expect(result.contextText).toContain("page: n/a");
  });

  it("dedupes exact-duplicate content (overlapping chunk windows)", () => {
    const candidates = [
      chunk({ chunkId: "a", content: "Same text here" }),
      chunk({ chunkId: "b", content: "Same text here" }),
      chunk({ chunkId: "c", content: "Different text" }),
    ];

    const result = assembleContext(candidates);

    expect(result.chunks).toHaveLength(2);
    expect(result.chunks.map((c) => c.chunkId)).toEqual(["a", "c"]);
  });

  it("greedily truncates to the token budget, preserving relevance order", () => {
    const bigChunk = (id: string) => chunk({ chunkId: id, content: "word ".repeat(500) }); // ~2500 chars
    const candidates = [bigChunk("a"), bigChunk("b"), bigChunk("c")];

    // ~2500 chars per chunk; a tiny token budget should keep only the first.
    const result = assembleContext(candidates, { tokenBudget: 10 });

    expect(result.chunks.map((c) => c.chunkId)).toEqual(["a"]);
  });

  it("always includes at least one chunk even if it alone exceeds the budget", () => {
    const huge = chunk({ chunkId: "a", content: "word ".repeat(5000) });
    const result = assembleContext([huge], { tokenBudget: 1 });
    expect(result.chunks).toHaveLength(1);
  });
});
