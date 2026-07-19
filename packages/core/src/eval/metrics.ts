/**
 * Pure, deterministic scoring functions — no I/O, no randomness. Every
 * function here takes plain arrays of ids and returns a number in [0, 1],
 * so they're testable with inline literals and reusable outside the
 * benchmark runner (e.g. scoring a single production retrieval result if
 * that's ever wanted).
 *
 * Edge case convention, applied consistently below: an empty `expected`
 * set means "nothing to find" and is scored as a vacuous pass (1.0) for
 * recall/precision/coverage, and 0 for MRR (there is no rank of a
 * nonexistent target). Real fixtures should never actually hit this —
 * every `EvalCase` should have at least one expected relevant chunk — but
 * the functions stay total rather than throwing on a malformed fixture.
 */

function intersectionSize(a: string[], b: string[]): number {
  const bSet = new Set(b);
  return a.filter((id) => bSet.has(id)).length;
}

/** Recall@K: of everything that SHOULD have been retrieved, what fraction
 * actually was, within the top K results. */
export function recallAtK(retrievedIds: string[], expectedRelevantIds: string[]): number {
  if (expectedRelevantIds.length === 0) return 1;
  return intersectionSize(retrievedIds, expectedRelevantIds) / expectedRelevantIds.length;
}

/** Precision@K: of what WAS retrieved, what fraction was actually
 * relevant. Divides by the number of results actually returned, not a
 * fixed K, so a knowledge base with fewer than K chunks total isn't
 * unfairly penalized. */
export function precisionAtK(retrievedIds: string[], expectedRelevantIds: string[]): number {
  if (retrievedIds.length === 0) return expectedRelevantIds.length === 0 ? 1 : 0;
  return intersectionSize(retrievedIds, expectedRelevantIds) / retrievedIds.length;
}

/** Reciprocal rank of the first relevant result: 1/rank of the earliest
 * retrieved id that's in `expectedRelevantIds`, or 0 if none of the
 * retrieved results are relevant. Mean across cases gives MRR. */
export function reciprocalRank(retrievedIds: string[], expectedRelevantIds: string[]): number {
  if (expectedRelevantIds.length === 0) return 0;
  const expected = new Set(expectedRelevantIds);
  const rank = retrievedIds.findIndex((id) => expected.has(id));
  return rank === -1 ? 0 : 1 / (rank + 1);
}

/** Citation coverage: of everything a correct answer should have cited,
 * what fraction actually got cited. Low coverage means the model is
 * under-citing — leaving out sources it should have drawn on. */
export function citationCoverage(citedChunkIds: string[], expectedCitationChunkIds: string[]): number {
  if (expectedCitationChunkIds.length === 0) return 1;
  return intersectionSize(citedChunkIds, expectedCitationChunkIds) / expectedCitationChunkIds.length;
}

/**
 * Unsupported citation rate: of everything that WAS cited, what fraction
 * wasn't actually one of the expected sources for this question.
 *
 * This is deliberately distinct from `validateCitations`'s own notion of
 * validity. `validateCitations` only checks that a citation marker
 * resolves to a chunk that was genuinely in the context sent for this
 * request (structural validity — see its doc comment) — every citation
 * this framework scores has already passed that check by construction. A
 * citation counted "unsupported" here is structurally valid (it points at
 * real, in-context material) but is the WRONG source for this specific
 * question per the fixture's ground truth: the model cited something
 * real but irrelevant, rather than fabricating a source. Structural
 * hallucination and topical wrongness are different failure modes and
 * warrant different fixes (prompt/parsing vs. retrieval/rerank quality).
 */
export function unsupportedCitationRate(citedChunkIds: string[], expectedCitationChunkIds: string[]): number {
  if (citedChunkIds.length === 0) return 0;
  const supported = intersectionSize(citedChunkIds, expectedCitationChunkIds);
  return (citedChunkIds.length - supported) / citedChunkIds.length;
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}
