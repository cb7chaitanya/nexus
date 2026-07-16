import { z } from "zod";

import { PLATFORM_EMBEDDING_DIM } from "../constants.js";

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

export const listKnowledgeBasesQuerySchema = z.object({
  organizationId: z.string().uuid(),
});
export type ListKnowledgeBasesQuery = z.infer<typeof listKnowledgeBasesQuerySchema>;
