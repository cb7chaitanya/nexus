import type { CompletionStream, LLMMessage, LLMProvider, TokenUsage } from "./types.js";

const CHARS_PER_TOKEN = 4;

export interface FakeLLMProviderOptions {
  /** Artificial per-word latency, mirroring FakeEmbeddingProvider's
   * delayMs — lets tests control streaming timing deterministically. */
  delayMs?: number;
  /**
   * Controls what this provider's CompletionStream.usage resolves to:
   *  - omitted (default): a deterministic chars/4-derived estimate of the
   *    actual prompt/response text — good enough to exercise the "real
   *    usage present" path in tests/local dev without needing a real
   *    tokenizer.
   *  - an explicit TokenUsage: always resolves to exactly that value,
   *    regardless of the prompt/response — for a test asserting a
   *    specific number.
   *  - `null`: simulates a provider/response that never reports usage —
   *    apps/api/src/lib/token-accounting.ts's fallback path exists
   *    specifically for this, and this is how a test exercises it without
   *    needing a real OpenAI-shaped fixture.
   */
  usage?: TokenUsage | null;
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
  private readonly usageOption: TokenUsage | null | undefined;

  constructor(options: FakeLLMProviderOptions = {}) {
    this.delayMs = options.delayMs ?? 0;
    this.usageOption = options.usage;
  }

  streamCompletion(messages: LLMMessage[]): CompletionStream {
    // Same deferred-promise shape as OpenAIChatProvider — see that class's
    // streamCompletion for why usage has to be a promise resolved from the
    // generator's own `finally`, not computed up front.
    let resolveUsage!: (usage: TokenUsage | null) => void;
    const usage = new Promise<TokenUsage | null>((resolve) => {
      resolveUsage = resolve;
    });

    const iterator = this.generate(messages, resolveUsage);

    return {
      [Symbol.asyncIterator]: () => iterator,
      usage,
    };
  }

  private async *generate(messages: LLMMessage[], resolveUsage: (usage: TokenUsage | null) => void): AsyncGenerator<string> {
    const refIds = this.extractRefIds(messages);
    const text =
      refIds.length === 0
        ? "I don't have enough information in the provided context to answer that."
        : `Based on the available sources, here is relevant information ${refIds.map((refId) => `[[chunk:${refId}]]`).join(" and ")}.`;

    let emitted = "";
    try {
      for (const word of text.split(" ")) {
        if (this.delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.delayMs));
        }
        const chunk = `${word} `;
        emitted += chunk;
        yield chunk;
      }
    } finally {
      if (this.usageOption === null) {
        resolveUsage(null);
      } else if (this.usageOption) {
        resolveUsage(this.usageOption);
      } else {
        const promptTokens = Math.ceil(messages.map((m) => m.content).join("\n").length / CHARS_PER_TOKEN);
        const completionTokens = Math.ceil(emitted.length / CHARS_PER_TOKEN);
        resolveUsage({ promptTokens, completionTokens, totalTokens: promptTokens + completionTokens });
      }
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
