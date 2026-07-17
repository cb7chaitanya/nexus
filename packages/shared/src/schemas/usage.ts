import { z } from "zod";

// GET /organizations/:id/usage — from/to bound an inclusive-exclusive
// [from, to) window (default: the trailing 30 days ending now, computed
// route-side since "now" isn't a static schema default); cursor/limit
// paginate the day×eventType breakdown rows the same way every other
// list endpoint in this API does (see cursorPaginationSchema), while
// `totals` in the response always covers the FULL requested range
// regardless of which breakdown page was requested.
export const getUsageQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type GetUsageQuery = z.infer<typeof getUsageQuerySchema>;
