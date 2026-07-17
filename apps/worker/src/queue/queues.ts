import { QUEUE_NAMES } from "@raas/shared";
import { Queue } from "bullmq";

import { redisConnection } from "../lib/redis.js";

// One Queue instance per BullMQ queue, shared by whichever code needs to
// add jobs to it (chunk-text's processor dynamically fans out into
// document-embedding — see processors/chunk-text.ts) and by index.ts,
// which creates the matching Worker for each.
export const documentEmbeddingQueue = new Queue(QUEUE_NAMES.embedding, { connection: redisConnection });

// Standard BullMQ exponential backoff (see docs/architecture.md §6.2):
// 3 attempts, base 5s. failParentOnFailure means a permanently-failed
// stage automatically fails process-document too, without running its
// processor — that's the signal each stage processor's own catch block
// uses to know whether to mark Document FAILED (see lib/job-failure.ts).
export const DEFAULT_JOB_OPTS = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 5000 },
  failParentOnFailure: true,
  // Bound Redis job-history growth — without this BullMQ keeps every
  // completed/failed job forever.
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 5000 },
};
