import { describe, expect, it } from "vitest";

import { ApiError } from "./errors.js";

describe("ApiError", () => {
  it("maps each factory to the correct code and status", () => {
    expect(ApiError.badRequest("x")).toMatchObject({ code: "BAD_REQUEST", statusCode: 400 });
    expect(ApiError.validation("x")).toMatchObject({ code: "VALIDATION_ERROR", statusCode: 422 });
    expect(ApiError.unauthorized()).toMatchObject({ code: "UNAUTHORIZED", statusCode: 401 });
    expect(ApiError.forbidden()).toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
    expect(ApiError.notFound()).toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
    expect(ApiError.conflict("x")).toMatchObject({ code: "CONFLICT", statusCode: 409 });
    expect(ApiError.rateLimited()).toMatchObject({ code: "RATE_LIMIT_EXCEEDED", statusCode: 429 });
    expect(ApiError.internal()).toMatchObject({ code: "INTERNAL_ERROR", statusCode: 500 });
  });

  it("produces the standard { error: { code, message, requestId } } envelope", () => {
    const err = ApiError.notFound("Organization not found");
    const body = err.toResponseBody("req-123");

    expect(body).toEqual({
      error: { code: "NOT_FOUND", message: "Organization not found", requestId: "req-123" },
    });
  });

  it("includes details only when present, never as an empty/undefined artifact", () => {
    const withDetails = ApiError.validation("bad input", [{ path: "email", message: "invalid" }]);
    expect(withDetails.toResponseBody("r1").error.details).toEqual([
      { path: "email", message: "invalid" },
    ]);

    const withoutDetails = ApiError.notFound();
    expect(withoutDetails.toResponseBody("r1").error).not.toHaveProperty("details");
  });
});
