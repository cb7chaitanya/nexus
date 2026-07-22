import { describe, expect, it } from "vitest";

import { extractPlainText } from "./extract-plain-text.js";
import { DocumentValidationError } from "./job-failure.js";

describe("extractPlainText", () => {
  it("wraps the whole buffer as a single page with no page number", async () => {
    const result = await extractPlainText(Buffer.from("hello world, this is plain text content"));

    expect(result.pages).toEqual([{ pageNumber: null, text: "hello world, this is plain text content" }]);
  });

  it("trims surrounding whitespace", async () => {
    const result = await extractPlainText(Buffer.from("\n\n  some content here  \n\n"));

    expect(result.pages[0]!.text).toBe("some content here");
  });

  it("throws DocumentValidationError for whitespace-only content", async () => {
    await expect(extractPlainText(Buffer.from("   \n\t  "))).rejects.toThrow(DocumentValidationError);
    await expect(extractPlainText(Buffer.from("   \n\t  "))).rejects.toThrow("document has no extractable text");
  });

  it("throws DocumentValidationError for an empty buffer", async () => {
    await expect(extractPlainText(Buffer.from(""))).rejects.toThrow(DocumentValidationError);
  });
});
