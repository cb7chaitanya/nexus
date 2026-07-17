import { z } from "zod";

import { PLATFORM_EMBEDDING_DIM } from "../constants.js";
import { cursorPaginationSchema } from "./pagination.js";

export const createKnowledgeBaseSchema = z.object({
  organizationId: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
  embeddingProvider: z.string().trim().min(1).max(100),
  embeddingModel: z.string().trim().min(1).max(200),
  // MVP: exactly one dimension is supported — see constants.ts.
  embeddingDim: z.literal(PLATFORM_EMBEDDING_DIM, {
    message: `embeddingDim must be ${PLATFORM_EMBEDDING_DIM} — no other dimension is supported yet`,
  }),
});
export type CreateKnowledgeBaseInput = z.infer<typeof createKnowledgeBaseSchema>;

export const listKnowledgeBasesQuerySchema = z
  .object({
    organizationId: z.string().uuid(),
  })
  .merge(cursorPaginationSchema);
export type ListKnowledgeBasesQuery = z.infer<typeof listKnowledgeBasesQuerySchema>;

// GET/DELETE /kb/:id — :id is the KB itself (URL param), organizationId
// still has to come from somewhere since these routes aren't nested under
// /organizations/:id; a query param, same convention GET /kb and GET
// /kb/:id/documents already use.
export const knowledgeBaseIdQuerySchema = z.object({
  organizationId: z.string().uuid(),
});
export type KnowledgeBaseIdQuery = z.infer<typeof knowledgeBaseIdQuerySchema>;

// PATCH /kb/:id — embeddingProvider/embeddingModel/embeddingDim are
// immutable after creation (architecture.md: "sets embedding model at
// creation, immutable" — changing them would orphan every existing
// vector), so only name/description are editable.
export const updateKnowledgeBaseSchema = z.object({
  organizationId: z.string().uuid(),
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
});
export type UpdateKnowledgeBaseInput = z.infer<typeof updateKnowledgeBaseSchema>;
