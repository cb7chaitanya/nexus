import type { Job } from "bullmq";

import { getEmailProvider } from "../lib/email-provider.js";
import { createJobLogger } from "../lib/job-logger.js";

export interface SendEmailJobData {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/**
 * Generic transactional email delivery — apps/api builds the actual
 * message content (see apps/api/src/lib/email-templates.ts) and enqueues
 * it here; this processor only knows how to hand a fully-built message to
 * whichever EmailProvider is configured. Kept generic (not
 * signup-OTP-specific) so a future transactional email reuses this same
 * job/processor instead of adding a new one.
 */
export async function sendEmailProcessor(job: Job<SendEmailJobData>): Promise<void> {
  const log = createJobLogger({ jobId: job.id });
  await getEmailProvider().send(job.data);
  log.info({ to: job.data.to }, "email delivered");
}
