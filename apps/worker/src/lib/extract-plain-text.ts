import type { ExtractedDocument } from "./extracted-document.js";
import { DocumentValidationError } from "./job-failure.js";

/**
 * Shared by text/plain and text/markdown — .md is ingested as raw text, not
 * parsed/stripped of its formatting (no markdown-specific handling was
 * asked for), so both formats are identical from here on.
 */
export async function extractPlainText(buffer: Buffer): Promise<ExtractedDocument> {
  const text = buffer.toString("utf-8").trim();
  if (text.length === 0) {
    throw new DocumentValidationError("document has no extractable text");
  }
  return { pages: [{ pageNumber: null, text }] };
}
