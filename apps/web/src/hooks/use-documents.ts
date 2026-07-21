import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  completeDocument,
  deleteDocument,
  listDocuments,
  retryDocument,
  uploadToPresignedUrl,
} from "@/lib/api/documents";
import { presignDocument } from "@/lib/api/knowledge-bases";
import type { Document } from "@/lib/types";

const ACTIVE_STATUSES = new Set<Document["status"]>(["QUEUED", "PROCESSING"]);

export function documentKeys(knowledgeBaseId: string) {
  return ["documents", knowledgeBaseId] as const;
}

export function useDocuments(knowledgeBaseId: string, organizationId: string) {
  return useQuery({
    queryKey: documentKeys(knowledgeBaseId),
    queryFn: () => listDocuments(knowledgeBaseId, organizationId),
    enabled: Boolean(knowledgeBaseId && organizationId),
    refetchInterval: (query) => {
      const documents = query.state.data?.data ?? [];
      return documents.some((doc) => ACTIVE_STATUSES.has(doc.status)) ? 3_000 : false;
    },
  });
}

export function useUploadDocument(knowledgeBaseId: string, organizationId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (file: File) => {
      const { document, uploadUrl } = await presignDocument(knowledgeBaseId, {
        organizationId,
        fileName: file.name,
        mimeType: file.type || "application/octet-stream",
        sizeBytes: file.size,
      });
      await uploadToPresignedUrl(uploadUrl, file);
      return completeDocument(document.id, organizationId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: documentKeys(knowledgeBaseId) });
    },
  });
}

export function useDeleteDocument(knowledgeBaseId: string, organizationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteDocument(id, organizationId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: documentKeys(knowledgeBaseId) });
    },
  });
}

export function useRetryDocument(knowledgeBaseId: string, organizationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => retryDocument(id, organizationId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: documentKeys(knowledgeBaseId) });
    },
  });
}
