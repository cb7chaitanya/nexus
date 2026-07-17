import { createHash } from "node:crypto";

import type { EmbeddingProvider } from "./types.js";

export interface FakeEmbeddingProviderOptions {
  /** Defaults to the platform's fixed embedding dimension (1536). Not
   * imported from @raas/shared to keep this package dependency-free —
   * callers that care about matching PLATFORM_EMBEDDING_DIM pass it
   * explicitly. */
  dim?: number;
  /** Artificial per-call latency — lets tests (notably the worker's chaos
   * test) reliably land a process kill mid-embed-chunks-job without
   * relying on timing against a real network call. */
  delayMs?: number;
}

/**
 * Deterministic, offline EmbeddingProvider: same text always produces the
 * same vector, no network call, no cost. Used by worker integration/chaos
 * tests and available as a real (documented) provider choice via
 * EMBEDDING_PROVIDER=fake for local dev without an OpenAI key — not just a
 * test mock bolted on the side. OpenAIEmbeddingProvider's own request/retry
 * logic is exercised separately in openai.test.ts against a fake fetch,
 * since hitting the real OpenAI API in the test suite would make tests
 * cost money, require a secret, and be network-flaky.
 */
export class FakeEmbeddingProvider implements EmbeddingProvider {
  private readonly dim: number;
  private readonly delayMs: number;

  constructor(options: FakeEmbeddingProviderOptions = {}) {
    this.dim = options.dim ?? 1536;
    this.delayMs = options.delayMs ?? 0;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const vectors: number[][] = [];
    for (const text of texts) {
      if (this.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      }
      vectors.push(this.vectorFor(text));
    }
    return vectors;
  }

  private vectorFor(text: string): number[] {
    // sha256 gives 32 bytes of deterministic pseudo-randomness; cycle
    // through them to fill out the full dimension.
    const digest = createHash("sha256").update(text).digest();
    return Array.from({ length: this.dim }, (_, i) => (digest[i % digest.length]! / 255) * 2 - 1);
  }
}
