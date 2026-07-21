import { RateLimitError } from "bullmq";
import { afterEach, describe, expect, it, vi } from "vitest";

import { env } from "../env.js";
import { backOffIfMemoryConstrained, isMemoryBackpressured } from "./memory-backpressure.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fakeLog = { warn: vi.fn() } as any;

function mockRss(rssBytes: number): void {
  vi.spyOn(process, "memoryUsage").mockReturnValue({
    rss: rssBytes,
    heapTotal: 0,
    heapUsed: 0,
    external: 0,
    arrayBuffers: 0,
  });
}

describe("isMemoryBackpressured", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is false when RSS is comfortably under the configured limit", () => {
    mockRss(env.WORKER_MEMORY_RSS_LIMIT_BYTES - 1024);
    expect(isMemoryBackpressured()).toBe(false);
  });

  it("is true once RSS reaches the configured limit", () => {
    mockRss(env.WORKER_MEMORY_RSS_LIMIT_BYTES);
    expect(isMemoryBackpressured()).toBe(true);
  });

  it("is true when RSS exceeds the configured limit", () => {
    mockRss(env.WORKER_MEMORY_RSS_LIMIT_BYTES + 1024);
    expect(isMemoryBackpressured()).toBe(true);
  });
});

describe("backOffIfMemoryConstrained", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does nothing — no rate limit set, no throw — when RSS is under the limit", async () => {
    mockRss(env.WORKER_MEMORY_RSS_LIMIT_BYTES - 1024);
    const rateLimit = vi.fn().mockResolvedValue(undefined);

    await expect(backOffIfMemoryConstrained({ rateLimit }, fakeLog)).resolves.toBeUndefined();
    expect(rateLimit).not.toHaveBeenCalled();
    expect(fakeLog.warn).not.toHaveBeenCalled();
  });

  it("sets the queue rate limit and throws RateLimitError when RSS is at or over the limit", async () => {
    mockRss(env.WORKER_MEMORY_RSS_LIMIT_BYTES + 1024);
    const rateLimit = vi.fn().mockResolvedValue(undefined);

    await expect(backOffIfMemoryConstrained({ rateLimit }, fakeLog)).rejects.toThrow(RateLimitError);
    expect(rateLimit).toHaveBeenCalledWith(env.WORKER_MEMORY_BACKPRESSURE_DELAY_MS);
    expect(fakeLog.warn).toHaveBeenCalledTimes(1);
  });

  it("throws even if rateLimit() itself rejects — a job must never silently proceed under memory pressure", async () => {
    mockRss(env.WORKER_MEMORY_RSS_LIMIT_BYTES + 1024);
    const rateLimit = vi.fn().mockRejectedValue(new Error("redis unavailable"));

    await expect(backOffIfMemoryConstrained({ rateLimit }, fakeLog)).rejects.toThrow("redis unavailable");
  });
});
