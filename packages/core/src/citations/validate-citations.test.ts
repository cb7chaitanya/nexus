import { describe, expect, it } from "vitest";

import type { AssembledContextChunk } from "../types.js";
import { validateCitations } from "./validate-citations.js";

const contextChunks: AssembledContextChunk[] = [
  { refId: "c1", chunkId: "chunk-a", documentId: "doc-1", pageNumber: 1, content: "The sky is blue because of Rayleigh scattering." },
  { refId: "c2", chunkId: "chunk-b", documentId: "doc-2", pageNumber: 5, content: "Water boils at 100C at sea level." },
];

describe("validateCitations", () => {
  it("resolves a marker that references a real context chunk", () => {
    const citations = validateCitations("The sky is blue. [[chunk:c1]]", contextChunks);
    expect(citations).toEqual([{ refId: "c1", chunkId: "chunk-a", documentId: "doc-1", pageNumber: 1, quote: contextChunks[0]!.content }]);
  });

  it("drops a marker whose refId was never in the context sent for this request", () => {
    const citations = validateCitations("Citing something [[chunk:c99]] that was never retrieved.", contextChunks);
    expect(citations).toEqual([]);
  });

  it("dedupes repeated citations of the same refId, keeping first-appearance order", () => {
    const citations = validateCitations("[[chunk:c2]] ... later again [[chunk:c2]] and also [[chunk:c1]]", contextChunks);
    expect(citations.map((c) => c.chunkId)).toEqual(["chunk-b", "chunk-a"]);
  });

  it("returns an empty array when the text has no markers at all", () => {
    expect(validateCitations("No citations here.", contextChunks)).toEqual([]);
  });

  it("resolves multiple distinct valid citations in order of first appearance", () => {
    const citations = validateCitations("First [[chunk:c1]] then [[chunk:c2]].", contextChunks);
    expect(citations.map((c) => c.chunkId)).toEqual(["chunk-a", "chunk-b"]);
  });

  it("truncates the quote to a bounded length", () => {
    const longChunk: AssembledContextChunk = { refId: "c1", chunkId: "x", documentId: "doc-1", pageNumber: null, content: "a".repeat(500) };
    const citations = validateCitations("[[chunk:c1]]", [longChunk]);
    expect(citations[0]!.quote.length).toBeLessThanOrEqual(200);
  });
});
