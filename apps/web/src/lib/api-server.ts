import { cookies } from "next/headers";

import { API_URL, SESSION_COOKIE_NAME } from "@/lib/config";
import { ApiError } from "@/lib/api-error";
import type { ApiErrorBody, OrganizationWithRole, PublicUser } from "@/lib/types";

export interface ApiServerRequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
}

function buildUrl(path: string, query?: ApiServerRequestOptions["query"]) {
  const url = new URL(path, API_URL);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/**
 * Server Component / Route Handler API client. httpOnly cookies aren't
 * ambient outside the browser, so the incoming request's session cookie
 * has to be read via next/headers and forwarded explicitly on every
 * outbound call to apps/api.
 */
export async function apiFetchServer<T = undefined>(
  path: string,
  options: ApiServerRequestOptions = {},
): Promise<T> {
  const cookieStore = await cookies();
  const session = cookieStore.get(SESSION_COOKIE_NAME);

  const headers: Record<string, string> = {};
  if (session) headers["Cookie"] = `${SESSION_COOKIE_NAME}=${session.value}`;

  let body: string | undefined;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }

  const res = await fetch(buildUrl(path, options.query), {
    method: options.method ?? "GET",
    headers,
    body,
    cache: "no-store",
  });

  if (res.status === 204) {
    return undefined as T;
  }

  const contentType = res.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json") ? await res.json() : undefined;

  if (!res.ok) {
    const errorBody = (payload as ApiErrorBody | undefined)?.error;
    throw new ApiError(res.status, errorBody ?? { message: res.statusText });
  }

  return payload as T;
}

/** Returns null instead of throwing when there is no valid session — the common case for layout-level auth checks. */
export async function getServerSession() {
  try {
    return await apiFetchServer<{ user: PublicUser; organizations: OrganizationWithRole[] }>(
      "/auth/me",
    );
  } catch {
    return null;
  }
}
