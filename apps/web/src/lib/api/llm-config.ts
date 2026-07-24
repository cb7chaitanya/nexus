import { apiFetch } from "@/lib/api-client";
import type { PublicLlmConfig } from "@/lib/types";

export function getLlmConfig(organizationId: string) {
  return apiFetch<{ config: PublicLlmConfig | null }>(`/organizations/${organizationId}/llm-config`);
}

export function setLlmConfig(organizationId: string, input: { provider: string; model: string; apiKey: string }) {
  return apiFetch<{ config: PublicLlmConfig }>(`/organizations/${organizationId}/llm-config`, {
    method: "PATCH",
    body: input,
  });
}

export function deleteLlmConfig(organizationId: string) {
  return apiFetch<undefined>(`/organizations/${organizationId}/llm-config`, { method: "DELETE" });
}

export function testLlmConfig(organizationId: string, input: { provider: string; model: string; apiKey?: string }) {
  return apiFetch<{ ok: boolean; message?: string }>(`/organizations/${organizationId}/llm-config/test`, {
    method: "POST",
    body: input,
  });
}
