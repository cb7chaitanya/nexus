import { apiFetch } from "@/lib/api-client";
import type { KnowledgeBase, KnowledgeBaseDetail, Paginated, PresignResponse } from "@/lib/types";

export function listKnowledgeBases(organizationId: string, cursor?: string) {
  return apiFetch<Paginated<KnowledgeBase>>("/kb", { query: { organizationId, cursor } });
}

export function getKnowledgeBase(id: string, organizationId: string) {
  return apiFetch<KnowledgeBaseDetail>(`/kb/${id}`, { query: { organizationId } });
}

export function createKnowledgeBase(input: {
  organizationId: string;
  name: string;
  embeddingProvider: string;
  embeddingModel: string;
  embeddingDim: 1536;
}) {
  return apiFetch<KnowledgeBase>("/kb", { method: "POST", body: input });
}

export function updateKnowledgeBase(
  id: string,
  input: { organizationId: string; name?: string; description?: string | null },
) {
  return apiFetch<KnowledgeBase>(`/kb/${id}`, { method: "PATCH", body: input });
}

export function deleteKnowledgeBase(id: string, organizationId: string) {
  return apiFetch<{ id: string; status: "DELETING" } | undefined>(`/kb/${id}`, {
    method: "DELETE",
    query: { organizationId },
  });
}

export function presignDocument(
  knowledgeBaseId: string,
  input: { organizationId: string; fileName: string; mimeType: string; sizeBytes: number },
) {
  return apiFetch<PresignResponse>(`/kb/${knowledgeBaseId}/documents/presign`, {
    method: "POST",
    body: input,
  });
}
