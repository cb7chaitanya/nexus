import mammoth from "mammoth";

import type { ExtractedDocument } from "./extracted-document.js";
import { DocumentValidationError } from "./job-failure.js";

// mammoth.extractRawText's `messages` (warnings about unsupported styles,
// dropped images, etc.) are intentionally discarded — extractPdfText
// doesn't surface pdf-parse's internal parser detail either, and none of
// it is actionable for the tenant beyond "the document was processed."
export async function extractDocxText(buffer: Buffer): Promise<ExtractedDocument> {
  const result = await mammoth.extractRawText({ buffer });
  const text = result.value.trim();
  if (text.length === 0) {
    throw new DocumentValidationError("document has no extractable text");
  }
  return { pages: [{ pageNumber: null, text }] };
}
