import { z } from "zod";

import { cursorPaginationSchema } from "./pagination.js";

// No `scopes` field — unlike architecture.md's original proposal, this
// ticket's ApiKey model doesn't have one (see packages/db's schema.prisma
// comment on the model); a key is all-or-nothing for its organization,
// matching how session-based access already works.
export const createApiKeySchema = z.object({
  name: z.string().trim().min(1).max(200),
  // Optional — a key with no expiresAt is valid until explicitly revoked.
  expiresAt: z.coerce.date().min(new Date(), "expiresAt must be in the future").optional(),
});
export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;

export const listApiKeysQuerySchema = cursorPaginationSchema;
export type ListApiKeysQuery = z.infer<typeof listApiKeysQuerySchema>;
