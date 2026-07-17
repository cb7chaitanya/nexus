import { describe, expect, it, vi } from "vitest";

import { OpenAIEmbeddingError, OpenAIEmbeddingProvider } from "./openai.js";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function embeddingPayload(texts: string[]): { data: Array<{ embedding: number[]; index: number }> } {
  // Returned out of order on purpose — the provider must sort by index,
  // not trust response ordering.
  return {
    data: texts
      .map((text, index) => ({ embedding: [text.length, index], index }))
      .sort(() => Math.random() - 0.5),
  };
}

describe("OpenAIEmbeddingProvider", () => {
  it("returns an empty array without making a request for empty input", async () => {
    const fetchImpl = vi.fn();
    const provider = new OpenAIEmbeddingProvider({ apiKey: "sk-test", model: "text-embedding-3-small", fetchImpl });

    const result = await provider.embed([]);

    expect(result).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("preserves input order regardless of response ordering", async () => {
    const texts = ["a", "bb", "ccc"];
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, embeddingPayload(texts)));
    const provider = new OpenAIEmbeddingProvider({ apiKey: "sk-test", model: "text-embedding-3-small", fetchImpl });

    const result = await provider.embed(texts);

    expect(result).toEqual([
      [1, 0],
      [2, 1],
      [3, 2],
    ]);
  });

  it("splits input into multiple batched requests", async () => {
    const texts = Array.from({ length: 5 }, (_, i) => `text-${i}`);
    const fetchImpl = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { input: string[] };
      return jsonResponse(200, embeddingPayload(body.input));
    });
    const provider = new OpenAIEmbeddingProvider({
      apiKey: "sk-test",
      model: "text-embedding-3-small",
      batchSize: 2,
      fetchImpl,
    });

    const result = await provider.embed(texts);

    expect(fetchImpl).toHaveBeenCalledTimes(3); // batches of 2, 2, 1
    expect(result).toHaveLength(5);
  });

  it("retries on a 429 and eventually succeeds, honoring Retry-After", async () => {
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { error: "rate limited" }, { "retry-after": "2" }))
      .mockResolvedValueOnce(jsonResponse(200, embeddingPayload(["a"])));
    const provider = new OpenAIEmbeddingProvider({
      apiKey: "sk-test",
      model: "text-embedding-3-small",
      fetchImpl,
      sleepImpl,
    });

    const result = await provider.embed(["a"]);

    expect(result).toEqual([[1, 0]]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleepImpl).toHaveBeenCalledWith(2000); // Retry-After: 2 seconds, not the exponential default
  });

  it("retries on a 500 with exponential backoff when no Retry-After header is present", async () => {
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(500, { error: "server error" }))
      .mockResolvedValueOnce(jsonResponse(500, { error: "server error" }))
      .mockResolvedValueOnce(jsonResponse(200, embeddingPayload(["a"])));
    const provider = new OpenAIEmbeddingProvider({
      apiKey: "sk-test",
      model: "text-embedding-3-small",
      fetchImpl,
      sleepImpl,
      baseDelayMs: 1000,
    });

    const result = await provider.embed(["a"]);

    expect(result).toEqual([[1, 0]]);
    expect(sleepImpl.mock.calls.map((call) => call[0])).toEqual([1000, 2000]); // 1000 * 2^0, 1000 * 2^1
  });

  it("does not retry a non-retryable 400 and fails immediately", async () => {
    const sleepImpl = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(400, { error: "invalid request" }));
    const provider = new OpenAIEmbeddingProvider({
      apiKey: "sk-test",
      model: "text-embedding-3-small",
      fetchImpl,
      sleepImpl,
    });

    await expect(provider.embed(["a"])).rejects.toThrow(OpenAIEmbeddingError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleepImpl).not.toHaveBeenCalled();
  });

  it("gives up after exhausting the retry budget on persistent 5xx errors", async () => {
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(503, { error: "unavailable" }));
    const provider = new OpenAIEmbeddingProvider({
      apiKey: "sk-test",
      model: "text-embedding-3-small",
      fetchImpl,
      sleepImpl,
      maxRetries: 2,
    });

    await expect(provider.embed(["a"])).rejects.toThrow(OpenAIEmbeddingError);
    expect(fetchImpl).toHaveBeenCalledTimes(3); // initial attempt + 2 retries
  });

  it("retries a network-level failure (fetch rejection)", async () => {
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(jsonResponse(200, embeddingPayload(["a"])));
    const provider = new OpenAIEmbeddingProvider({
      apiKey: "sk-test",
      model: "text-embedding-3-small",
      fetchImpl,
      sleepImpl,
    });

    const result = await provider.embed(["a"]);

    expect(result).toEqual([[1, 0]]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
