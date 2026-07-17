import { z } from "zod";

import { MAX_UPLOAD_SIZE_BYTES } from "../constants.js";
import { cursorPaginationSchema } from "./pagination.js";

export const presignDocumentSchema = z.object({
  organizationId: z.string().uuid(),
  fileName: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(255),
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
