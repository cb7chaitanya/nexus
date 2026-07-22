import { z } from "zod";

import { MAX_UPLOAD_SIZE_BYTES, SUPPORTED_DOCUMENT_MIME_TYPES } from "../constants.js";
import { cursorPaginationSchema } from "./pagination.js";

export const presignDocumentSchema = z.object({
  organizationId: z.string().uuid(),
  fileName: z.string().trim().min(1).max(255),
  // Rejected here, at presign, rather than only discovered later inside
  // the worker's extraction stage — the previous behavior let an
  // unsupported file complete a real upload (progress bar, "Uploaded"
  // status, the works) before failing asynchronously minutes later.
  mimeType: z.enum(SUPPORTED_DOCUMENT_MIME_TYPES, {
    errorMap: () => ({ message: `Unsupported file type — only ${SUPPORTED_DOCUMENT_MIME_TYPES.join(", ")} is supported` }),
  }),
  sizeBytes: z.number().int().positive().max(MAX_UPLOAD_SIZE_BYTES),
});
export type PresignDocumentInput = z.infer<typeof presignDocumentSchema>;

export const completeDocumentSchema = z.object({
  organizationId: z.string().uuid(),
});
export type CompleteDocumentInput = z.infer<typeof completeDocumentSchema>;

export const listDocumentsQuerySchema = z
  .object({
    organizationId: z.string().uuid(),
  })
  .merge(cursorPaginationSchema);
export type ListDocumentsQuery = z.infer<typeof listDocumentsQuerySchema>;

// GET/DELETE /documents/:id — :id is the document itself (URL param),
// organizationId still has to come from somewhere since these routes
// aren't nested under /organizations/:id; a query param, same convention
// knowledgeBaseIdQuerySchema already uses for GET/DELETE /kb/:id.
export const documentIdQuerySchema = z.object({
  organizationId: z.string().uuid(),
});
export type DocumentIdQuery = z.infer<typeof documentIdQuerySchema>;

// POST /documents/:id/retry — a POST, so organizationId comes from the
// body instead (same convention completeDocumentSchema already uses for
// POST /documents/:id/complete), not the query.
export const retryDocumentSchema = z.object({
  organizationId: z.string().uuid(),
});
export type RetryDocumentInput = z.infer<typeof retryDocumentSchema>;
