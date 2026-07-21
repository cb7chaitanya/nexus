import { apiFetch } from "@/lib/api-client";
import type { OrganizationWithRole, PublicUser } from "@/lib/types";

export interface SessionResponse {
  user: PublicUser;
  organizations: OrganizationWithRole[];
}

export interface PendingSignupResponse {
  pendingSignupId: string;
  email: string;
  expiresInSeconds: number;
}

/** Stages the signup and emails a 6-digit code — does not create a session. See verifySignupOtp. */
export function signup(input: {
  email: string;
  password: string;
  name?: string;
  organizationName: string;
  organizationSlug?: string;
}) {
  return apiFetch<PendingSignupResponse>("/auth/signup", { method: "POST", body: input });
}

export function verifySignupOtp(input: { pendingSignupId: string; code: string }) {
  return apiFetch<SessionResponse>("/auth/signup/verify", { method: "POST", body: input });
}

export function resendSignupOtp(input: { pendingSignupId: string }) {
  return apiFetch<{ expiresInSeconds: number }>("/auth/signup/resend-otp", { method: "POST", body: input });
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
