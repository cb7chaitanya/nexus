const MAX_LINE_CHARS = 90;
const LINES_PER_PAGE = 45; // (792 - 2*72) usable height / 14pt leading

/**
 * Wraps text into lines short enough to stay within the page's MediaBox at
 * the font size used below. Necessary because pdfjs's text-layout pass
 * (which pdf-parse's getText() relies on) reconstructs lines using the
 * page's width — a single unwrapped Tj run wider than the page silently
 * gets cut off rather than fully extracted (found by direct testing, not
 * assumed). Real PDF-authoring tools always wrap for exactly this reason;
 * this test helper has to do the same to produce realistic bytes.
 */
function wrapLines(text: string): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > MAX_LINE_CHARS && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Hand-rolled minimal PDF writer for tests — real PDF bytes (a Type1
 * Helvetica font, one content stream per page with line-wrapped Tj
 * text-show operators), not a mock of pdf-parse. Deliberately tiny: just
 * enough valid PDF structure (catalog, pages tree, xref, trailer) for
 * pdf-parse to successfully extract per-page text, which is all
 * extract-pdf.test.ts needs. Pass an empty string for a page to simulate a
 * page with no extractable text (e.g. a scanned/image-only page). Text
 * beyond LINES_PER_PAGE is truncated — callers needing more content should
 * pass more pages, not longer per-page text.
 */
export function buildTestPdf(pageTexts: string[]): Buffer {
  const objects: Record<number, string | { stream: string }> = {};
  const pageObjIds: number[] = [];
  const fontObjId = 3 + pageTexts.length * 2;

  pageTexts.forEach((text, i) => {
    const pageObjId = 3 + i * 2;
    const contentObjId = pageObjId + 1;
    pageObjIds.push(pageObjId);

    const escaped = text.replace(/([()\\])/g, "\\$1");
    const lines = wrapLines(escaped).slice(0, LINES_PER_PAGE);
    const stream = lines.length
      ? `BT /F1 12 Tf 72 720 Td\n${lines.map((line) => `(${line}) Tj\n0 -14 Td`).join("\n")}\nET`
      : "";
    objects[pageObjId] =
      `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 ${fontObjId} 0 R >> >> /MediaBox [0 0 612 792] /Contents ${contentObjId} 0 R >>`;
    objects[contentObjId] = { stream };
  });

  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageObjIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageTexts.length} >>`;
  objects[fontObjId] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

  const maxId = fontObjId;
  let body = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (let id = 1; id <= maxId; id++) {
    offsets[id] = body.length;
    const obj = objects[id];
    if (obj === undefined) continue;
    body += typeof obj === "string" ? `${id} 0 obj\n${obj}\nendobj\n` : `${id} 0 obj\n<< /Length ${obj.stream.length} >>\nstream\n${obj.stream}\nendstream\nendobj\n`;
  }
  const xrefStart = body.length;
  body += `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= maxId; id++) {
    body += `${String(offsets[id] ?? 0).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  return Buffer.from(body, "latin1");
}
