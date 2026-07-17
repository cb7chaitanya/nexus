import { z } from "zod";

export const chatSchema = z.object({
  organizationId: z.string().uuid(),
  message: z.string().trim().min(1).max(4000),
  // Omitted -> a new conversation is created. Provided -> continues an
  // existing one (must belong to the same organizationId and knowledge
  // base; see apps/api/src/lib/conversation.ts).
  conversationId: z.string().uuid().optional(),
});
export type ChatInput = z.infer<typeof chatSchema>;
