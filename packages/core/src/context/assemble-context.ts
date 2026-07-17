import type { AssembledContext, AssembledContextChunk, RetrievedChunk } from "../types.js";

// Same chars-per-token approximation used by apps/worker's chunker —
// consistent rather than exact, good enough for a packing budget.
const CHARS_PER_TOKEN = 4;
// architecture.md §4.8: 3-4k tokens of context, leaving room for system
// prompt + question + generation.
const DEFAULT_TOKEN_BUDGET = 3000;
// Rough per-chunk overhead of the "[[chunk:cN]] (document: ..., page: ...)"
// label line, so the budget isn't purely content length.
const LABEL_OVERHEAD_CHARS = 60;

export interface AssembleContextOptions {
  tokenBudget?: number;
}

/**
 * Takes similarity-search candidates (already ordered best-first) and
 * turns them into a prompt-ready context block: dedupes exact-duplicate
 * content (overlapping chunk windows can retrieve the same text twice),
 * greedily packs into a token budget preserving relevance order, and tags
 * each included chunk with a short-lived reference id (`c1`, `c2`, ...)
 * the model is instructed to cite against for this one request
 * (architecture.md §4.8) — this tagging is the mechanism citation
 * validation depends on later, not just a formatting choice.
 *
 * Always includes at least one chunk if any candidates exist, even if it
 * alone exceeds the budget — an empty context because the single best
 * match was long is worse than a slightly over-budget prompt.
 */
export function assembleContext(candidates: RetrievedChunk[], options: AssembleContextOptions = {}): AssembledContext {
  const charBudget = (options.tokenBudget ?? DEFAULT_TOKEN_BUDGET) * CHARS_PER_TOKEN;

  const seenContent = new Set<string>();
  const chunks: AssembledContextChunk[] = [];
  let usedChars = 0;

  for (const candidate of candidates) {
    const normalized = candidate.content.trim();
    if (normalized.length === 0 || seenContent.has(normalized)) {
      continue;
    }

    const entryChars = normalized.length + LABEL_OVERHEAD_CHARS;
    if (chunks.length > 0 && usedChars + entryChars > charBudget) {
      break;
    }

    seenContent.add(normalized);
    chunks.push({
      refId: `c${chunks.length + 1}`,
      chunkId: candidate.chunkId,
      documentId: candidate.documentId,
      pageNumber: candidate.pageNumber,
      content: normalized,
    });
    usedChars += entryChars;
  }

  const contextText =
    chunks.length === 0
      ? "(No relevant reference material was found in the knowledge base.)"
      : chunks
          .map((c) => `[[chunk:${c.refId}]] (document: ${c.documentId}, page: ${c.pageNumber ?? "n/a"})\n${c.content}`)
          .join("\n\n");

  return { chunks, contextText };
}
