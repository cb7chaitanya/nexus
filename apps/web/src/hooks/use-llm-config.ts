import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { deleteLlmConfig, getLlmConfig, setLlmConfig, testLlmConfig } from "@/lib/api/llm-config";

export function llmConfigKeys(organizationId: string) {
  return ["llm-config", organizationId] as const;
}

export function useLlmConfig(organizationId: string) {
  return useQuery({
    queryKey: llmConfigKeys(organizationId),
    queryFn: () => getLlmConfig(organizationId),
    enabled: Boolean(organizationId),
  });
}

export function useSetLlmConfig(organizationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { provider: string; model: string; apiKey: string }) => setLlmConfig(organizationId, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: llmConfigKeys(organizationId) });
    },
  });
}

export function useDeleteLlmConfig(organizationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => deleteLlmConfig(organizationId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: llmConfigKeys(organizationId) });
    },
  });
}

// Deliberately not tied to query invalidation the way the mutations above
// are — testing a candidate provider/model/key before it's ever saved is
// a valid call (nothing in the cache to invalidate yet), and re-testing
// an already-saved config updates health status server-side but the
// settings page re-fetches that explicitly rather than relying on this
// mutation's own cache effects.
export function useTestLlmConfig(organizationId: string) {
  return useMutation({
    mutationFn: (input: { provider: string; model: string; apiKey?: string }) => testLlmConfig(organizationId, input),
  });
}
