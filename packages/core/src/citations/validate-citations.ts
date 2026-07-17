import type { AssembledContextChunk, Citation } from "../types.js";

export const CITATION_MARKER_REGEX = /\[\[chunk:([^[\]]+)]]/g;

const QUOTE_MAX_CHARS = 200;

/**
 * Parses `[[chunk:refId]]` markers out of the model's full raw output and
 * resolves each one against the context chunks that were actually sent
 * for *this* request (docs/architecture.md §4.9, §6 R6). A marker whose
 * refId doesn't resolve — the model citing something that was never in
 * its context — is silently dropped, never fabricated into a citation;
 * that's the server-side check that makes citations trustworthy rather
 * than the model's unverified self-report. Duplicate mentions of the same
 * refId collapse to one citation, ordered by first appearance.
 *
 * Important scope boundary, stated explicitly because it's easy to
 * oversell: this validates that a citation *exists* — that it points to a
 * chunk which was genuinely part of the retrieved context. It does
 * **not** verify that the model's claim is actually supported by that
 * chunk's content. True groundedness scoring (does the text next to this
 * marker actually follow from the cited chunk) is a real, harder problem,
 * explicitly deferred to a later evaluation-framework phase — see
 * docs/implementation-plan.md §2 item 5. Do not describe this function's
 * output as "verified" or "grounded" anywhere it's surfaced.
 */
export function validateCitations(rawText: string, contextChunks: AssembledContextChunk[]): Citation[] {
  const byRefId = new Map(contextChunks.map((chunk) => [chunk.refId, chunk]));
  const seen = new Set<string>();
  const citations: Citation[] = [];

  for (const match of rawText.matchAll(CITATION_MARKER_REGEX)) {
    const refId = match[1]!;
    if (seen.has(refId)) {
      continue;
    }
    seen.add(refId);

    const chunk = byRefId.get(refId);
    if (!chunk) {
      continue;
    }

    citations.push({
      chunkId: chunk.chunkId,
      documentId: chunk.documentId,
      pageNumber: chunk.pageNumber,
      quote: chunk.content.slice(0, QUOTE_MAX_CHARS),
    });
  }

  return citations;
}
