import { convert } from "html-to-text";

import type { ExtractedDocument } from "./extracted-document.js";
import { DocumentValidationError } from "./job-failure.js";

export async function extractHtmlText(buffer: Buffer): Promise<ExtractedDocument> {
  const text = convert(buffer.toString("utf-8"), { wordwrap: false }).trim();
  if (text.length === 0) {
    throw new DocumentValidationError("document has no extractable text");
  }
  return { pages: [{ pageNumber: null, text }] };
}
