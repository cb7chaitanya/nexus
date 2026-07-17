import { z } from "zod";

import { cursorPaginationSchema } from "./pagination.js";

export const listConversationsQuerySchema = z
  .object({
    organizationId: z.string().uuid(),
    knowledgeBaseId: z.string().uuid().optional(),
  })
  .merge(cursorPaginationSchema);
export type ListConversationsQuery = z.infer<typeof listConversationsQuerySchema>;

export const getConversationQuerySchema = z.object({
  organizationId: z.string().uuid(),
});
export type GetConversationQuery = z.infer<typeof getConversationQuerySchema>;

export const listMessagesQuerySchema = z
  .object({
    organizationId: z.string().uuid(),
  })
  .merge(cursorPaginationSchema);
export type ListMessagesQuery = z.infer<typeof listMessagesQuerySchema>;
