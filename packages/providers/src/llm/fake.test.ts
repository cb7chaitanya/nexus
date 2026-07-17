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
});
