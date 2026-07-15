import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ApiError } from "./errors.js";
import { parseOrThrow } from "./validate.js";

const schema = z.object({ email: z.string().email(), age: z.number().min(0) });

describe("parseOrThrow", () => {
  it("returns the parsed value on success", () => {
    const result = parseOrThrow(schema, { email: "a@example.com", age: 30 });
    expect(result).toEqual({ email: "a@example.com", age: 30 });
  });

  it("throws an ApiError with VALIDATION_ERROR on failure", () => {
    expect(() => parseOrThrow(schema, { email: "not-an-email", age: -1 })).toThrow(ApiError);
  });

  it("includes a detail entry per failing field", () => {
    try {
      parseOrThrow(schema, { email: "not-an-email", age: -1 });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.code).toBe("VALIDATION_ERROR");
      const paths = apiErr.details?.map((d) => d.path);
      expect(paths).toEqual(expect.arrayContaining(["email", "age"]));
    }
  });
});
