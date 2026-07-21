import { apiFetch } from "@/lib/api-client";
import type { UsageResponse } from "@/lib/types";

export function getUsage(
  organizationId: string,
  params: { from?: string; to?: string; cursor?: string; limit?: number } = {},
) {
  return apiFetch<UsageResponse>(`/organizations/${organizationId}/usage`, { query: params });
}
