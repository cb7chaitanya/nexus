import { apiFetch } from "@/lib/api-client";

export function createPortalSession(organizationId: string) {
  return apiFetch<{ url: string }>("/billing/portal-session", {
    method: "POST",
    body: { organizationId },
  });
}
