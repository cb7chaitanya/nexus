import type { z } from "zod";

import { ApiError } from "./errors.js";

/**
 * Parses `input` against `schema`, throwing a structured ApiError
 * (VALIDATION_ERROR, 422) with per-field details on failure. Centralizes
 * "proper validation + structured errors" in one place rather than every
 * route handler hand-rolling its own safeParse/format dance.
 */
export function parseOrThrow<S extends z.ZodTypeAny>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const details = result.error.issues.map((issue) => ({
      path: issue.path.join(".") || "(root)",
      message: issue.message,
    }));
    throw ApiError.validation("Request validation failed", details);
  }
  return result.data;
}
