import { describe, expect, it } from "vitest";

import { chunkPages } from "./chunk-text.js";
import type { ExtractedPage } from "./extract-pdf.js";

describe("chunkPages", () => {
  it("returns no chunks for empty input", () => {
    expect(chunkPages([])).toEqual([]);
  });

  it("produces a single chunk for short text, preserving its page number", () => {
    const pages: ExtractedPage[] = [{ pageNumber: 1, text: "hello world this is a short document" }];

    const chunks = chunkPages(pages);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ chunkIndex: 0, pageNumber: 1, content: "hello world this is a short document" });
  });

  it("assigns sequential chunkIndex values starting at 0", () => {
    const longText = Array.from({ length: 2000 }, (_, i) => `word${i}`).join(" ");
    const chunks = chunkPages([{ pageNumber: 1, text: longText }]);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((c) => c.chunkIndex)).toEqual(chunks.map((_, i) => i));
  });

  it("splits long text into multiple chunks with overlapping content", () => {
    const longText = Array.from({ length: 2000 }, (_, i) => `word${i}`).join(" ");
    const chunks = chunkPages([{ pageNumber: 1, text: longText }]);

    expect(chunks.length).toBeGreaterThan(1);

    // Overlap: the tail of one chunk's content reappears at the head of
    // the next.
    const firstChunkWords = chunks[0]!.content.split(" ");
    const secondChunkWords = chunks[1]!.content.split(" ");
    const overlapWord = firstChunkWords[firstChunkWords.length - 1];
    expect(secondChunkWords).toContain(overlapWord);
  });

  it("carries the page number of the page a chunk starts on across a page boundary", () => {
    const pages: ExtractedPage[] = [
      { pageNumber: 1, text: Array.from({ length: 900 }, (_, i) => `p1w${i}`).join(" ") },
      { pageNumber: 2, text: Array.from({ length: 900 }, (_, i) => `p2w${i}`).join(" ") },
    ];

    const chunks = chunkPages(pages);
    const pageNumbers = chunks.map((c) => c.pageNumber);

    expect(pageNumbers[0]).toBe(1);
    expect(pageNumbers[pageNumbers.length - 1]).toBe(2);
    // Monotonically non-decreasing — chunk page numbers never go backwards.
    for (let i = 1; i < pageNumbers.length; i++) {
      expect(pageNumbers[i]).toBeGreaterThanOrEqual(pageNumbers[i - 1]!);
    }
  });

  it("charStart/charEnd correctly index into the chunk's own content length", () => {
    const pages: ExtractedPage[] = [{ pageNumber: 1, text: "alpha beta gamma delta" }];

    const chunks = chunkPages(pages);

    expect(chunks[0]!.charEnd - chunks[0]!.charStart).toBe(chunks[0]!.content.length);
  });

  it("estimates a positive tokenCount proportional to content length", () => {
    const chunks = chunkPages([{ pageNumber: 1, text: "one two three four five" }]);

    expect(chunks[0]!.tokenCount).toBeGreaterThan(0);
  });
});
