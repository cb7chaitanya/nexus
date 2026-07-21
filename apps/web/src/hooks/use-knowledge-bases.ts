import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  createKnowledgeBase,
  deleteKnowledgeBase,
  getKnowledgeBase,
  listKnowledgeBases,
  updateKnowledgeBase,
} from "@/lib/api/knowledge-bases";

export function knowledgeBaseKeys(organizationId: string) {
  return {
    all: ["knowledge-bases", organizationId] as const,
    detail: (id: string) => ["knowledge-bases", organizationId, id] as const,
  };
}

export function useKnowledgeBases(organizationId: string) {
  return useQuery({
    queryKey: knowledgeBaseKeys(organizationId).all,
    queryFn: () => listKnowledgeBases(organizationId),
  });
}

export function useKnowledgeBase(id: string, organizationId: string) {
  return useQuery({
    queryKey: knowledgeBaseKeys(organizationId).detail(id),
    queryFn: () => getKnowledgeBase(id, organizationId),
    enabled: Boolean(id && organizationId),
  });
}

export function useCreateKnowledgeBase(organizationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createKnowledgeBase,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: knowledgeBaseKeys(organizationId).all });
    },
  });
}

export function useUpdateKnowledgeBase(organizationId: string, id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { name?: string; description?: string | null }) =>
      updateKnowledgeBase(id, { organizationId, ...input }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: knowledgeBaseKeys(organizationId).all });
      queryClient.invalidateQueries({ queryKey: knowledgeBaseKeys(organizationId).detail(id) });
    },
  });
}

export function useDeleteKnowledgeBase(organizationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteKnowledgeBase(id, organizationId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: knowledgeBaseKeys(organizationId).all });
    },
  });
}
