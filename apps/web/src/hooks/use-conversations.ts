import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  deleteConversation,
  getConversation,
  listConversations,
  listMessages,
} from "@/lib/api/conversations";

export function conversationKeys(organizationId: string) {
  return {
    list: (knowledgeBaseId?: string) =>
      ["conversations", organizationId, knowledgeBaseId ?? "all"] as const,
    detail: (id: string) => ["conversations", organizationId, "detail", id] as const,
    messages: (id: string) => ["conversations", organizationId, "messages", id] as const,
  };
}

export function useConversations(organizationId: string, knowledgeBaseId?: string) {
  return useQuery({
    queryKey: conversationKeys(organizationId).list(knowledgeBaseId),
    queryFn: () => listConversations(organizationId, knowledgeBaseId),
    enabled: Boolean(organizationId),
  });
}

export function useConversation(id: string, organizationId: string) {
  return useQuery({
    queryKey: conversationKeys(organizationId).detail(id),
    queryFn: () => getConversation(id, organizationId),
    enabled: Boolean(id && organizationId),
  });
}

export function useMessages(conversationId: string, organizationId: string) {
  return useQuery({
    queryKey: conversationKeys(organizationId).messages(conversationId),
    queryFn: () => listMessages(conversationId, organizationId),
    enabled: Boolean(conversationId && organizationId),
  });
}

export function useDeleteConversation(organizationId: string, knowledgeBaseId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteConversation(id, organizationId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: conversationKeys(organizationId).list(knowledgeBaseId) });
    },
  });
}
