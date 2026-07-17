import { describe, expect, it } from "vitest";

import { extractPdfText, ScannedDocumentError } from "./extract-pdf.js";
import { buildTestPdf } from "./test-helpers/build-pdf.js";

describe("extractPdfText", () => {
  it("extracts text per page, preserving page numbers", async () => {
    const pdf = buildTestPdf(["Page one hello world content", "Page two more text content here"]);

    const result = await extractPdfText(pdf);

    expect(result.pages).toEqual([
      { pageNumber: 1, text: "Page one hello world content" },
      { pageNumber: 2, text: "Page two more text content here" },
    ]);
  });

  it("throws ScannedDocumentError when every page has no extractable text", async () => {
    const pdf = buildTestPdf(["", ""]);

    await expect(extractPdfText(pdf)).rejects.toThrow(ScannedDocumentError);
    await expect(extractPdfText(pdf)).rejects.toThrow("scanned document, OCR not supported");
  });

  it("does not flag a document as scanned just because a minority of pages are blank", async () => {
    const pdf = buildTestPdf([
      "This page has plenty of real extractable text content on it",
      "",
      "This page also has plenty of real extractable text content on it",
    ]);

    const result = await extractPdfText(pdf);

    expect(result.pages).toHaveLength(3);
  });

  it("flags a document as scanned when most pages are sparse even if not fully empty", async () => {
    const pdf = buildTestPdf(["hi", "no", "This page has plenty of real extractable text content on it"]);

    await expect(extractPdfText(pdf)).rejects.toThrow(ScannedDocumentError);
  });
});
