import { PDFParse } from "pdf-parse";

import type { ExtractedDocument } from "./extracted-document.js";

// Re-exported so every existing `from "./extract-pdf.js"` import elsewhere
// keeps working — the types themselves now live in extracted-document.ts,
// the neutral home shared by every extractor, not just this PDF-specific one.
export type { ExtractedPage, ExtractedDocument } from "./extracted-document.js";

/**
 * Thrown when a PDF has no meaningfully-extractable text — most commonly a
 * scanned/image-only document. This is a terminal, non-retryable failure
 * (see docs/architecture.md §4.1): OCR isn't MVP scope, so the correct
 * behavior is failing the document clearly, never silently producing empty
 * chunks. The worker's extract-text processor catches this specifically
 * and sets Document.failureReason to this exact message.
 */
export class ScannedDocumentError extends Error {
  constructor() {
    super("scanned document, OCR not supported");
    this.name = "ScannedDocumentError";
  }
}

// Below this many characters, a page is treated as having no real
// extractable text (an empty/whitespace-only page, or one that's just a
// rendered image). Below this FRACTION of a document's pages having real
// text, the whole document is treated as scanned — a handful of genuinely
// blank pages in an otherwise-text PDF shouldn't fail the whole document.
const MIN_CHARS_PER_PAGE = 20;
const MAX_SPARSE_PAGE_RATIO = 0.5;

export async function extractPdfText(buffer: Buffer): Promise<ExtractedDocument> {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    const pages = result.pages.map((page) => ({
      pageNumber: page.num,
      text: page.text.trim(),
    }));

    const sparsePages = pages.filter((page) => page.text.length < MIN_CHARS_PER_PAGE).length;
    if (pages.length === 0 || sparsePages / pages.length > MAX_SPARSE_PAGE_RATIO) {
      throw new ScannedDocumentError();
    }

    return { pages };
  } finally {
    await parser.destroy();
  }
}
