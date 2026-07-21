import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  changeMemberRole,
  inviteMember,
  listMembers,
  removeMember,
} from "@/lib/api/organizations";
import type { OrgRole } from "@/lib/types";

export function memberKeys(organizationId: string) {
  return ["organization-members", organizationId] as const;
}

export function useMembers(organizationId: string) {
  return useQuery({
    queryKey: memberKeys(organizationId),
    queryFn: () => listMembers(organizationId),
    enabled: Boolean(organizationId),
  });
}

export function useInviteMember(organizationId: string) {
  return useMutation({
    mutationFn: (input: { email: string; role: "ADMIN" | "MEMBER" }) =>
      inviteMember(organizationId, input),
  });
}

export function useChangeMemberRole(organizationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: OrgRole }) =>
      changeMemberRole(organizationId, userId, role),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: memberKeys(organizationId) });
    },
  });
}

export function useRemoveMember(organizationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => removeMember(organizationId, userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: memberKeys(organizationId) });
    },
  });
}
