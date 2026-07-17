import { z } from "zod";

// Shared cursor-pagination shape, reused by every paginated list endpoint
// (GET /kb, GET /organizations/:id/members, GET /kb/:id/documents,
// GET /conversations, GET /conversations/:id/messages): cursor is the id
// of the last item seen on the previous page (opaque to the client
// beyond that), limit is capped well below "unbounded".
export const cursorPaginationSchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type CursorPaginationQuery = z.infer<typeof cursorPaginationSchema>;
