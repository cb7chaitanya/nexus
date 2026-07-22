import { z } from "zod";

// POST /billing/portal-session — organizationId in the body, same
// convention as retryDocumentSchema/completeDocumentSchema for a mutating
// POST with no useful URL param to scope it by.
export const createPortalSessionSchema = z.object({
  organizationId: z.string().uuid(),
});
export type CreatePortalSessionInput = z.infer<typeof createPortalSessionSchema>;
