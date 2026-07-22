import { describe, expect, it } from "vitest";

import { extractDocument } from "./extract-document.js";
import { buildTestDocx } from "./test-helpers/build-docx.js";
import { buildTestPdf } from "./test-helpers/build-pdf.js";

describe("extractDocument", () => {
  it("dispatches application/pdf to the PDF extractor, preserving real page numbers", async () => {
    const pdf = buildTestPdf(["Page one content here", "Page two content here"]);

    const result = await extractDocument("application/pdf", pdf);

    expect(result.pages).toEqual([
      { pageNumber: 1, text: "Page one content here" },
      { pageNumber: 2, text: "Page two content here" },
    ]);
  });

  it("dispatches text/plain to the plain-text extractor", async () => {
    const result = await extractDocument("text/plain", Buffer.from("plain text content"));
    expect(result.pages).toEqual([{ pageNumber: null, text: "plain text content" }]);
  });

  it("dispatches text/markdown and text/x-markdown to the plain-text extractor", async () => {
    const md = await extractDocument("text/markdown", Buffer.from("# Heading\n\nSome markdown content"));
    expect(md.pages[0]!.pageNumber).toBeNull();
    expect(md.pages[0]!.text).toContain("# Heading");

    const legacy = await extractDocument("text/x-markdown", Buffer.from("legacy markdown content"));
    expect(legacy.pages[0]!.pageNumber).toBeNull();
  });

  it("dispatches text/html to the HTML extractor", async () => {
    const result = await extractDocument("text/html", Buffer.from("<p>hello html content</p>"));
    expect(result.pages[0]!.pageNumber).toBeNull();
    expect(result.pages[0]!.text).toContain("hello html content");
  });

  it("dispatches the DOCX mimetype to the DOCX extractor", async () => {
    const docx = await buildTestDocx(["docx paragraph content"]);
    const result = await extractDocument(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      docx,
    );
    expect(result.pages[0]!.pageNumber).toBeNull();
    expect(result.pages[0]!.text).toContain("docx paragraph content");
  });

  it("throws for an unrecognized mimetype", async () => {
    await expect(extractDocument("application/zip", Buffer.from("irrelevant"))).rejects.toThrow(
      /unsupported mimeType/,
    );
  });
});
