"use client";

import { API_URL } from "@/lib/config";
import { ApiError } from "@/lib/api-error";
import type { ApiErrorBody } from "@/lib/types";

export interface ApiRequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
}

function buildUrl(path: string, query?: ApiRequestOptions["query"]) {
  const url = new URL(path, API_URL);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/**
 * Browser-side API client. Always sends the session cookie
 * (`credentials: "include"`) and never attaches an Authorization header —
 * the dashboard authenticates purely via the httpOnly session cookie.
 */
export async function apiFetch<T = undefined>(
  path: string,
  options: ApiRequestOptions = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  let body: string | undefined;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }

  const res = await fetch(buildUrl(path, options.query), {
    method: options.method ?? "GET",
    credentials: "include",
    headers,
    body,
    signal: options.signal,
  });

  if (res.status === 204) {
    return undefined as T;
  }

  const contentType = res.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json") ? await res.json() : undefined;

  if (!res.ok) {
    if (res.status === 401 && typeof window !== "undefined") {
      const onAuthPage =
        window.location.pathname.startsWith("/login") ||
        window.location.pathname.startsWith("/signup");
      if (!onAuthPage) {
        window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
      }
    }
    const errorBody = (payload as ApiErrorBody | undefined)?.error;
    throw new ApiError(res.status, errorBody ?? { message: res.statusText });
  }

  return payload as T;
}
