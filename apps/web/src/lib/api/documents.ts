import { apiFetch } from "@/lib/api-client";
import type { Document, Paginated } from "@/lib/types";

export function listDocuments(knowledgeBaseId: string, organizationId: string, cursor?: string) {
  return apiFetch<Paginated<Document>>(`/kb/${knowledgeBaseId}/documents`, {
    query: { organizationId, cursor },
  });
}

export function getDocument(id: string, organizationId: string) {
  return apiFetch<Document>(`/documents/${id}`, { query: { organizationId } });
}

export function completeDocument(id: string, organizationId: string) {
  return apiFetch<Document>(`/documents/${id}/complete`, {
    method: "POST",
    body: { organizationId },
  });
}

export function deleteDocument(id: string, organizationId: string) {
  return apiFetch<undefined>(`/documents/${id}`, { method: "DELETE", query: { organizationId } });
}

export function retryDocument(id: string, organizationId: string) {
  return apiFetch<Document>(`/documents/${id}/retry`, { method: "POST", body: { organizationId } });
}

/** Uploads the raw file to R2/S3 via the presigned PUT URL — not through apps/api. */
export async function uploadToPresignedUrl(uploadUrl: string, file: File) {
  const res = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file,
  });
  if (!res.ok) {
    throw new Error(`Upload failed (${res.status})`);
  }
}
