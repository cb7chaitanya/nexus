import { apiFetch } from "@/lib/api-client";
import type { Paginated, PublicApiKey } from "@/lib/types";

export function listApiKeys(organizationId: string, cursor?: string) {
  return apiFetch<Paginated<PublicApiKey>>(`/organizations/${organizationId}/api-keys`, {
    query: { cursor },
  });
}

export function createApiKey(organizationId: string, input: { name: string; expiresAt?: string }) {
  return apiFetch<{ apiKey: PublicApiKey; key: string }>(
    `/organizations/${organizationId}/api-keys`,
    { method: "POST", body: input },
  );
}

export function revokeApiKey(organizationId: string, keyId: string) {
  return apiFetch<undefined>(`/organizations/${organizationId}/api-keys/${keyId}`, {
    method: "DELETE",
  });
}
