import type { LLMMessage, LLMProvider } from "./types.js";

export interface FakeLLMProviderOptions {
  /** Artificial per-word latency, mirroring FakeEmbeddingProvider's
   * delayMs — lets tests control streaming timing deterministically. */
  delayMs?: number;
}

const CONTEXT_REF_RE = /\[\[chunk:([^[\]]+)]]/g;

/**
 * Deterministic, offline LLMProvider: builds a canned response that cites
 * every context reference id it finds in the prompt (the
 * `[[chunk:refId]]` labels assembleContext writes into the context
 * block), with no network call and no cost — the LLM-provider analogue of
 * FakeEmbeddingProvider in this same package, and available the same way
 * (a real, documented provider choice via LLM_PROVIDER=fake for local
 * dev/test, not a mock bolted onto a test file). Exists so apps/api's
 * chat endpoint's full retrieve -> generate -> stream -> validate
 * pipeline is testable without an OpenAI key, including the
 * marker-stripping and citation-validation paths, which need a response
 * that actually contains `[[chunk:refId]]` markers to exercise.
 */
export class FakeLLMProvider implements LLMProvider {
  private readonly delayMs: number;

  constructor(options: FakeLLMProviderOptions = {}) {
    this.delayMs = options.delayMs ?? 0;
  }

  async *streamCompletion(messages: LLMMessage[]): AsyncIterable<string> {
    const refIds = this.extractRefIds(messages);
    const text =
      refIds.length === 0
        ? "I don't have enough information in the provided context to answer that."
        : `Based on the available sources, here is relevant information ${refIds.map((refId) => `[[chunk:${refId}]]`).join(" and ")}.`;

    for (const word of text.split(" ")) {
      if (this.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      }
      yield `${word} `;
    }
  }

  private extractRefIds(messages: LLMMessage[]): string[] {
    const combined = messages.map((m) => m.content).join("\n");
    const refIds: string[] = [];
    const seen = new Set<string>();
    for (const match of combined.matchAll(CONTEXT_REF_RE)) {
      const refId = match[1]!;
      if (!seen.has(refId)) {
        seen.add(refId);
        refIds.push(refId);
      }
    }
    return refIds;
  }
}
