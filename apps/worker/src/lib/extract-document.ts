import { extractDocxText } from "./extract-docx.js";
import { extractHtmlText } from "./extract-html.js";
import { extractPdfText } from "./extract-pdf.js";
import { extractPlainText } from "./extract-plain-text.js";
import type { ExtractedDocument } from "./extracted-document.js";

/**
 * Format dispatch behind one call site — the interface docs/architecture.md
 * §4.1 described ("architect the extraction step behind an interface... so
 * DOCX/HTML/TXT/Markdown are additive later") but that was never actually
 * built until now; extract-text.ts used to call extractPdfText directly.
 *
 * mimeType is validated against SUPPORTED_DOCUMENT_MIME_TYPES by the caller
 * before this is ever reached (presign-time, and again as a worker-side
 * backstop in extract-text.ts) — the default branch below is unreachable in
 * practice, kept only so this switch stays exhaustive if that invariant is
 * ever violated some other way.
 */
export async function extractDocument(mimeType: string, buffer: Buffer): Promise<ExtractedDocument> {
  switch (mimeType) {
    case "application/pdf":
      return extractPdfText(buffer);
    case "text/plain":
    case "text/markdown":
    case "text/x-markdown":
      return extractPlainText(buffer);
    case "text/html":
      return extractHtmlText(buffer);
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return extractDocxText(buffer);
    default:
      throw new Error(`extractDocument: unsupported mimeType "${mimeType}"`);
  }
}
