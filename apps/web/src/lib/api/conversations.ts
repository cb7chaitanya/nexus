import { apiFetch } from "@/lib/api-client";
import type { Conversation, Message, Paginated } from "@/lib/types";

export function listConversations(
  organizationId: string,
  knowledgeBaseId?: string,
  cursor?: string,
) {
  return apiFetch<Paginated<Conversation>>("/conversations", {
    query: { organizationId, knowledgeBaseId, cursor },
  });
}

export function getConversation(id: string, organizationId: string) {
  return apiFetch<Conversation>(`/conversations/${id}`, { query: { organizationId } });
}

export function listMessages(conversationId: string, organizationId: string, cursor?: string) {
  return apiFetch<Paginated<Message>>(`/conversations/${conversationId}/messages`, {
    query: { organizationId, cursor },
  });
}

export function deleteConversation(id: string, organizationId: string) {
  return apiFetch<undefined>(`/conversations/${id}`, {
    method: "DELETE",
    query: { organizationId },
  });
}
