import { z } from "zod";

export const chatSchema = z.object({
  organizationId: z.string().uuid(),
  message: z.string().trim().min(1).max(4000),
});
export type ChatInput = z.infer<typeof chatSchema>;
