import { JOB_NAMES, QUEUE_NAMES } from "@raas/shared";
import { Queue } from "bullmq";

import { redis } from "./redis.js";

// Mirrors kb-cleanup.ts's own reasoning for reusing apps/api's existing
// Redis connection rather than opening a second one.
const emailQueue = new Queue(QUEUE_NAMES.email, { connection: redis });

const JOB_OPTS = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 5000 },
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 5000 },
};

export interface EnqueueTransactionalEmailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/**
 * Hands email delivery off to apps/worker (see processors/send-email.ts)
 * rather than calling the provider inline — a flaky third-party email API
 * shouldn't be able to fail or slow down signup itself, and BullMQ's
 * retry already covers the transient-failure case.
 */
export async function enqueueTransactionalEmail(input: EnqueueTransactionalEmailInput): Promise<void> {
  await emailQueue.add(JOB_NAMES.sendTransactionalEmail, input, JOB_OPTS);
}
