/**
 * The standard API error shape every apps/api route returns on failure:
 *
 *   { error: { code, message, requestId } }
 *
 * `details` is an addition beyond that literal shape — optional, and only
 * present on validation errors, carrying which field(s) failed and why.
 * Without it a VALIDATION_ERROR response is nearly useless to a client;
 * it's additive to the required shape, never a replacement for it.
 */
export const API_ERROR_CODES = {
  BAD_REQUEST: "BAD_REQUEST",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ApiErrorCode = keyof typeof API_ERROR_CODES;

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  BAD_REQUEST: 400,
  VALIDATION_ERROR: 422,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INTERNAL_ERROR: 500,
};

export interface ApiErrorDetail {
  path: string;
  message: string;
}

export interface ApiErrorResponseBody {
  error: {
    code: ApiErrorCode;
    message: string;
    requestId: string;
    details?: ApiErrorDetail[];
  };
}

/**
 * Thrown by apps/api route handlers for any expected failure (bad input,
 * missing auth, not found, etc). apps/api's central error handler is the
 * only place that translates this into the wire envelope — route handlers
 * never format error responses themselves.
 */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly statusCode: number;
  readonly details?: ApiErrorDetail[];

  constructor(code: ApiErrorCode, message: string, details?: ApiErrorDetail[]) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.statusCode = STATUS_BY_CODE[code];
    this.details = details;
  }

  static badRequest(message: string, details?: ApiErrorDetail[]): ApiError {
    return new ApiError("BAD_REQUEST", message, details);
  }

  static validation(message: string, details?: ApiErrorDetail[]): ApiError {
    return new ApiError("VALIDATION_ERROR", message, details);
  }

  static unauthorized(message = "Authentication required"): ApiError {
    return new ApiError("UNAUTHORIZED", message);
  }

  static forbidden(message = "You do not have permission to perform this action"): ApiError {
    return new ApiError("FORBIDDEN", message);
  }

  static notFound(message = "Not found"): ApiError {
    return new ApiError("NOT_FOUND", message);
  }

  static conflict(message: string, details?: ApiErrorDetail[]): ApiError {
    return new ApiError("CONFLICT", message, details);
  }

  static internal(message = "Internal server error"): ApiError {
    return new ApiError("INTERNAL_ERROR", message);
  }

  toResponseBody(requestId: string): ApiErrorResponseBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        requestId,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}
