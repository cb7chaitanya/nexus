import { describe, expect, it } from "vitest";

import { extractDocxText } from "./extract-docx.js";
import { DocumentValidationError } from "./job-failure.js";
import { buildTestDocx } from "./test-helpers/build-docx.js";

describe("extractDocxText", () => {
  it("extracts paragraph text as a single page with no page number", async () => {
    const docx = await buildTestDocx(["First paragraph of real content.", "Second paragraph follows."]);

    const result = await extractDocxText(docx);

    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]!.pageNumber).toBeNull();
    expect(result.pages[0]!.text).toContain("First paragraph of real content.");
    expect(result.pages[0]!.text).toContain("Second paragraph follows.");
  });

  it("throws DocumentValidationError when the document body has no text", async () => {
    const docx = await buildTestDocx([]);

    await expect(extractDocxText(docx)).rejects.toThrow(DocumentValidationError);
    await expect(extractDocxText(docx)).rejects.toThrow("document has no extractable text");
  });
});
