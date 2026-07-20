import { describe, expect, it } from "vitest";

import { FakeLLMProvider } from "./fake.js";

async function collect(iterable: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const delta of iterable) out += delta;
  return out;
}

describe("FakeLLMProvider", () => {
  it("cites every [[chunk:refId]] marker found in the prompt's context", async () => {
    const provider = new FakeLLMProvider();
    const messages = [
      { role: "system" as const, content: "You are a helpful assistant." },
      {
        role: "user" as const,
        content: "<context>\n[[chunk:c1]] (document: doc-1, page: 1)\nfoo\n\n[[chunk:c2]] (document: doc-2, page: 2)\nbar\n</context>\n<question>what?</question>",
      },
    ];

    const text = await collect(provider.streamCompletion(messages));

    expect(text).toContain("[[chunk:c1]]");
    expect(text).toContain("[[chunk:c2]]");
  });

  it("cites no markers when the context has none", async () => {
    const provider = new FakeLLMProvider();
    const messages = [{ role: "user" as const, content: "<context>(No relevant reference material was found in the knowledge base.)</context>" }];

    const text = await collect(provider.streamCompletion(messages));

    expect(text).not.toContain("[[chunk:");
  });

  it("is deterministic for the same input", async () => {
    const messages = [{ role: "user" as const, content: "[[chunk:c1]] hello" }];

    const first = await collect(new FakeLLMProvider().streamCompletion(messages));
    const second = await collect(new FakeLLMProvider().streamCompletion(messages));

    expect(first).toBe(second);
  });

  it("respects delayMs between yielded words", async () => {
    const provider = new FakeLLMProvider({ delayMs: 20 });
    const messages = [{ role: "user" as const, content: "[[chunk:c1]] hi" }];

    const start = Date.now();
    await collect(provider.streamCompletion(messages));
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(20);
  });

  describe("usage", () => {
    it("defaults to a deterministic chars/4-derived estimate of the actual prompt and response text", async () => {
      const provider = new FakeLLMProvider();
      const messages = [{ role: "user" as const, content: "[[chunk:c1]] hello" }];

      const stream = provider.streamCompletion(messages);
      const text = await collect(stream);
      const usage = await stream.usage;

      expect(usage).not.toBeNull();
      expect(usage!.promptTokens).toBe(Math.ceil(messages[0]!.content.length / 4));
      expect(usage!.completionTokens).toBe(Math.ceil(text.length / 4));
      expect(usage!.totalTokens).toBe(usage!.promptTokens + usage!.completionTokens);
    });

    it("resolves usage to exactly the configured value when one is passed explicitly", async () => {
      const explicitUsage = { promptTokens: 999, completionTokens: 111, totalTokens: 1110 };
      const provider = new FakeLLMProvider({ usage: explicitUsage });

      const stream = provider.streamCompletion([{ role: "user" as const, content: "[[chunk:c1]] hi" }]);
      await collect(stream);

      await expect(stream.usage).resolves.toEqual(explicitUsage);
    });

    it("resolves usage to null when configured to simulate a missing-usage-metadata response", async () => {
      const provider = new FakeLLMProvider({ usage: null });

      const stream = provider.streamCompletion([{ role: "user" as const, content: "[[chunk:c1]] hi" }]);
      const text = await collect(stream);

      expect(text.length).toBeGreaterThan(0);
      await expect(stream.usage).resolves.toBeNull();
    });
  });
});
