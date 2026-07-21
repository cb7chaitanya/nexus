import type { ApiErrorBody, ApiErrorCode } from "@/lib/types";

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly requestId: string | undefined;
  readonly details: { path: string; message: string }[] | undefined;

  constructor(status: number, body: Partial<ApiErrorBody["error"]>) {
    super(body.message ?? "Something went wrong. Please try again.");
    this.name = "ApiError";
    this.status = status;
    this.code = body.code ?? "INTERNAL_ERROR";
    this.requestId = body.requestId;
    this.details = body.details;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}
