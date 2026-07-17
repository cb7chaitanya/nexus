import { describe, expect, it } from "vitest";

import { FakeEmbeddingProvider } from "./fake.js";

describe("FakeEmbeddingProvider", () => {
  it("is deterministic — the same text always produces the same vector", async () => {
    const provider = new FakeEmbeddingProvider();

    const [first] = await provider.embed(["hello world"]);
    const [second] = await provider.embed(["hello world"]);

    expect(first).toEqual(second);
  });

  it("produces different vectors for different text", async () => {
    const provider = new FakeEmbeddingProvider();

    const [a, b] = await provider.embed(["hello", "goodbye"]);

    expect(a).not.toEqual(b);
  });

  it("defaults to the platform's fixed embedding dimension", async () => {
    const provider = new FakeEmbeddingProvider();

    const [vector] = await provider.embed(["hello"]);

    expect(vector).toHaveLength(1536);
  });

  it("respects a custom dimension", async () => {
    const provider = new FakeEmbeddingProvider({ dim: 8 });

    const [vector] = await provider.embed(["hello"]);

    expect(vector).toHaveLength(8);
  });
});
