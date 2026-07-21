import { apiFetch } from "@/lib/api-client";
import type { OrganizationWithRole, PublicUser } from "@/lib/types";

export interface SessionResponse {
  user: PublicUser;
  organizations: OrganizationWithRole[];
}

export function signup(input: {
  email: string;
  password: string;
  name?: string;
  organizationName: string;
  organizationSlug?: string;
}) {
  return apiFetch<SessionResponse>("/auth/signup", { method: "POST", body: input });
}

export function login(input: { email: string; password: string }) {
  return apiFetch<SessionResponse>("/auth/login", { method: "POST", body: input });
}

export function logout() {
  return apiFetch<{ success: true }>("/auth/logout", { method: "POST" });
}

export function getMe() {
  return apiFetch<SessionResponse>("/auth/me");
}
