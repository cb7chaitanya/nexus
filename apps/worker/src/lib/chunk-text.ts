import type { ExtractedPage } from "./extract-pdf.js";

export interface TextChunk {
  chunkIndex: number;
  content: string;
  tokenCount: number;
  pageNumber: number;
  charStart: number;
  charEnd: number;
}

// Target ~500-800 tokens per chunk with ~15% overlap (see
// docs/architecture.md §4.3). Layout-aware chunking (headings, tables,
// multi-column PDFs) is explicitly deferred — see decisions.md — so this
// is a straightforward greedy word-packing algorithm, not the full
// recursive structural-boundary splitter architecture.md describes as the
// eventual target.
const TARGET_CHUNK_TOKENS = 700;
const OVERLAP_RATIO = 0.15;
// Rough approximation for English text — good enough for chunk sizing;
// exact token counts aren't load-bearing here the way they are for
// provider billing.
const CHARS_PER_TOKEN = 4;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

interface Word {
  text: string;
  pageNumber: number;
}

/**
 * Splits extracted page text into overlapping, token-budgeted chunks.
 * Pure and synchronous so it's directly unit-testable without a PDF or a
 * database — the worker's chunk-text processor is a thin wrapper that
 * calls this and upserts the result.
 */
export function chunkPages(pages: ExtractedPage[]): TextChunk[] {
  const words: Word[] = [];
  for (const page of pages) {
    for (const text of page.text.split(/\s+/).filter(Boolean)) {
      words.push({ text, pageNumber: page.pageNumber });
    }
  }

  if (words.length === 0) {
    return [];
  }

  // Precompute each word's offset in the synthetic full text (words joined
  // by single spaces) up front, so chunk boundaries below can look up
  // offsets directly instead of re-deriving them through an overlapping
  // sliding window.
  const wordOffsets: number[] = new Array(words.length);
  let runningOffset = 0;
  for (let i = 0; i < words.length; i++) {
    wordOffsets[i] = runningOffset;
    runningOffset += words[i]!.text.length + 1; // +1 for the joining space
  }

  const targetChars = TARGET_CHUNK_TOKENS * CHARS_PER_TOKEN;
  const chunks: TextChunk[] = [];
  let chunkIndex = 0;
  let i = 0;

  while (i < words.length) {
    let j = i;
    let length = 0;
    while (j < words.length) {
      const addition = words[j]!.text.length + (j > i ? 1 : 0);
      if (length > 0 && length + addition > targetChars) {
        break;
      }
      length += addition;
      j++;
    }
    if (j === i) {
      // A single word alone exceeds the target — include it anyway rather
      // than producing an empty chunk.
      j = i + 1;
    }

    const content = words
      .slice(i, j)
      .map((w) => w.text)
      .join(" ");
    const charStart = wordOffsets[i]!;

    chunks.push({
      chunkIndex: chunkIndex++,
      content,
      tokenCount: estimateTokens(content),
      pageNumber: words[i]!.pageNumber,
      charStart,
      charEnd: charStart + content.length,
    });

    if (j >= words.length) {
      break;
    }

    const consumed = j - i;
    const overlapWords = Math.max(1, Math.floor(consumed * OVERLAP_RATIO));
    i = Math.max(i + 1, j - overlapWords);
  }

  return chunks;
}
