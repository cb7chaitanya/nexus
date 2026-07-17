import { z } from "zod";

// Shared cursor-pagination shape: cursor is the id of the last item seen
// on the previous page (opaque to the client beyond that), limit is
// capped well below "unbounded" — this is the fix for the pagination gap
// flagged against GET /kb and GET /organizations/:id/members, applied to
// the two new list endpoints from the start rather than retrofitted.
const cursorPaginationSchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

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
