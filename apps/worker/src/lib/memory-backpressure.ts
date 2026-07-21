import type { Logger } from "@raas/logger";
import { RateLimitError } from "bullmq";

import { env } from "../env.js";

/**
 * Anything that can set BullMQ's queue-level rate limiter — `Queue` and
 * (deprecated but functionally identical) `Worker` both implement this;
 * kept minimal so this module doesn't need to import either concrete
 * class or take on a circular import with index.ts, which constructs
 * both.
 */
export interface RateLimitable {
  rateLimit(expireTimeMs: number): Promise<void>;
}

/** process.memoryUsage().rss, isolated behind a function so tests can
 * stub it without touching the real process. */
export function currentRssBytes(): number {
  return process.memoryUsage().rss;
}

export function isMemoryBackpressured(): boolean {
  return currentRssBytes() >= env.WORKER_MEMORY_RSS_LIMIT_BYTES;
}

/**
 * The runtime half of extract-text's memory safety budget — see
 * env.ts's WORKER_MAX_DOCUMENT_BYTES comment for the static half
 * (concurrency x per-document size ceiling). That budget assumes
 * pdf-parse/pdfjs's actual working-set size during a parse is close to
 * the input buffer's size; in practice a parser can transiently use
 * several times that (decompression, an in-memory DOM-like structure of
 * the whole document) — this is the backstop for when that assumption
 * doesn't hold, or several concurrent parses simply land in their peak
 * memory window at once. Deliberately NOT a hard failure: an RSS spike
 * is a transient condition, not a fact about the document, so it must
 * never count against a document's retry budget or its correctness (see
 * failDocument/isLastAttempt in job-failure.ts, untouched by this path).
 *
 * Uses BullMQ's own rate-limiting primitive rather than a bespoke
 * delay/backoff: `queue.rateLimit(ms)` sets a Redis-backed limiter this
 * queue's own Worker instances already know how to honor, then throwing
 * RateLimitError puts the current job straight back on the wait list
 * (moveToWait) and pauses this worker from pulling its NEXT job until the
 * limiter expires — the concurrency slot the in-flight job held is freed
 * immediately, giving the JS heap/GC room to bring RSS back down before
 * more extraction work starts. No processor code (extract-text.ts) is
 * touched — this wraps its call site in index.ts.
 */
export async function backOffIfMemoryConstrained(rateLimiter: RateLimitable, log: Logger): Promise<void> {
  if (!isMemoryBackpressured()) return;

  const rssBytes = currentRssBytes();
  log.warn(
    { rssBytes, limitBytes: env.WORKER_MEMORY_RSS_LIMIT_BYTES, delayMs: env.WORKER_MEMORY_BACKPRESSURE_DELAY_MS },
    "extraction worker memory backpressure triggered — pausing new extraction pulls to let RSS recover",
  );
  await rateLimiter.rateLimit(env.WORKER_MEMORY_BACKPRESSURE_DELAY_MS);
  throw new RateLimitError();
}
