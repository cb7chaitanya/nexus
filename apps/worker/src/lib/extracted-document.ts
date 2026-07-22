// Neutral, format-agnostic shape every extractor (extract-pdf.ts,
// extract-plain-text.ts, extract-docx.ts, extract-html.ts) produces and
// chunk-text.ts consumes. pageNumber is nullable because only PDF has real
// pages — every other supported format is wrapped as a single page with
// pageNumber: null rather than fabricating a false-precision page number.
export interface ExtractedPage {
  pageNumber: number | null;
  text: string;
}

export interface ExtractedDocument {
  pages: ExtractedPage[];
}
