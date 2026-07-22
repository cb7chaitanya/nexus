import { describe, expect, it } from "vitest";

import { extractHtmlText } from "./extract-html.js";
import { DocumentValidationError } from "./job-failure.js";

describe("extractHtmlText", () => {
  it("strips markup and extracts a single page with no page number", async () => {
    // html-to-text uppercases heading text by default (a terminal-rendering
    // convention, not data loss) — asserting on the <p> content sidesteps
    // that transform rather than asserting exact heading casing.
    const html = "<html><body><h1>Title</h1><p>Hello world, this is content.</p></body></html>";

    const result = await extractHtmlText(Buffer.from(html));

    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]!.pageNumber).toBeNull();
    expect(result.pages[0]!.text.toLowerCase()).toContain("title");
    expect(result.pages[0]!.text).toContain("Hello world, this is content.");
    expect(result.pages[0]!.text).not.toContain("<p>");
  });

  it("throws DocumentValidationError when there's no text content", async () => {
    const html = "<html><body></body></html>";

    await expect(extractHtmlText(Buffer.from(html))).rejects.toThrow(DocumentValidationError);
    await expect(extractHtmlText(Buffer.from(html))).rejects.toThrow("document has no extractable text");
  });
});
