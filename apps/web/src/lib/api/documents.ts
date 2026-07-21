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

/**
 * Uploads the raw file to R2/S3 via the presigned PUT URL — not through
 * apps/api. Uses XMLHttpRequest rather than fetch specifically for its
 * `upload.onprogress` event — fetch has no equivalent for tracking
 * request-body upload progress.
 */
export function uploadToPresignedUrl(
  uploadUrl: string,
  file: File,
  onProgress?: (percent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadUrl);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new Error(`Upload failed (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error("Upload failed"));
    xhr.send(file);
  });
}
