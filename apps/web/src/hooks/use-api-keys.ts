import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { createApiKey, listApiKeys, revokeApiKey } from "@/lib/api/api-keys";

export function apiKeyKeys(organizationId: string) {
  return ["api-keys", organizationId] as const;
}

export function useApiKeys(organizationId: string) {
  return useQuery({
    queryKey: apiKeyKeys(organizationId),
    queryFn: () => listApiKeys(organizationId),
    enabled: Boolean(organizationId),
  });
}

export function useCreateApiKey(organizationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; expiresAt?: string }) => createApiKey(organizationId, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: apiKeyKeys(organizationId) });
    },
  });
}

export function useRevokeApiKey(organizationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (keyId: string) => revokeApiKey(organizationId, keyId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: apiKeyKeys(organizationId) });
    },
  });
}
