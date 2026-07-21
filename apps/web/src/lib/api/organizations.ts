import { apiFetch } from "@/lib/api-client";
import type {
  Organization,
  OrganizationInvite,
  OrganizationMember,
  OrganizationWithRole,
  OrgRole,
  Paginated,
} from "@/lib/types";

export function listOrganizations() {
  return apiFetch<{ organizations: OrganizationWithRole[] }>("/organizations");
}

export function getOrganization(id: string) {
  return apiFetch<OrganizationWithRole>(`/organizations/${id}`);
}

export function createOrganization(input: { name: string; slug?: string }) {
  return apiFetch<OrganizationWithRole>("/organizations", { method: "POST", body: input });
}

export function updateOrganization(id: string, input: { name?: string }) {
  return apiFetch<OrganizationWithRole>(`/organizations/${id}`, { method: "PATCH", body: input });
}

export function listMembers(organizationId: string, cursor?: string) {
  return apiFetch<Paginated<OrganizationMember>>(`/organizations/${organizationId}/members`, {
    query: { cursor },
  });
}

export function inviteMember(organizationId: string, input: { email: string; role: "ADMIN" | "MEMBER" }) {
  return apiFetch<{ invite: OrganizationInvite; token: string }>(
    `/organizations/${organizationId}/invites`,
    { method: "POST", body: input },
  );
}

export function acceptInvite(token: string) {
  return apiFetch(`/invites/${token}/accept`, { method: "POST" });
}

export function changeMemberRole(organizationId: string, userId: string, role: OrgRole) {
  return apiFetch<OrganizationMember>(`/organizations/${organizationId}/members/${userId}`, {
    method: "PATCH",
    body: { role },
  });
}

export function removeMember(organizationId: string, userId: string) {
  return apiFetch<undefined>(`/organizations/${organizationId}/members/${userId}`, {
    method: "DELETE",
  });
}

export type { Organization };
