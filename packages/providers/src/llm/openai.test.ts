import { describe, expect, it, vi } from "vitest";

import { CircuitBreaker, CircuitBreakerOpenError } from "../resilience/circuit-breaker.js";
import { OpenAIChatError, OpenAIChatProvider } from "./openai.js";

/** Builds a real streaming Response whose body emits `rawChunks` as
 * separate reads, so tests can exercise SSE lines split across chunk
 * boundaries — the same reason openai.test.ts (embeddings) builds real
 * Response objects instead of a hand-rolled fetch mock. */
function sseResponse(rawChunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of rawChunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(status === 200 ? stream : null, { status });
}

async function collect(iterable: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const delta of iterable) out.push(delta);
  return out;
}

describe("OpenAIChatProvider", () => {
  it("yields delta.content from each data: line and stops at [DONE]", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      sseResponse([
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    );

    const provider = new OpenAIChatProvider({ apiKey: "sk-test", model: "gpt-4o-mini", fetchImpl });
    const deltas = await collect(provider.streamCompletion([{ role: "user", content: "hi" }]));

    expect(deltas).toEqual(["Hello", " world"]);
  });

  it("reassembles an SSE line split across two chunk-boundary reads", async () => {
    const line = 'data: {"choices":[{"delta":{"content":"split-safe"}}]}\n\n';
    const splitPoint = 20;
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse([line.slice(0, splitPoint), line.slice(splitPoint), "data: [DONE]\n\n"]));

    const provider = new OpenAIChatProvider({ apiKey: "sk-test", model: "gpt-4o-mini", fetchImpl });
    const deltas = await collect(provider.streamCompletion([{ role: "user", content: "hi" }]));

    expect(deltas).toEqual(["split-safe"]);
  });

  it("skips chunks with no delta.content (e.g. the final finish_reason chunk)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      sseResponse([
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    );

    const provider = new OpenAIChatProvider({ apiKey: "sk-test", model: "gpt-4o-mini", fetchImpl });
    const deltas = await collect(provider.streamCompletion([{ role: "user", content: "hi" }]));

    expect(deltas).toEqual(["ok"]);
  });

  it("throws OpenAIChatError on a non-ok response instead of yielding", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("bad request", { status: 400 }));

    const provider = new OpenAIChatProvider({ apiKey: "sk-test", model: "gpt-4o-mini", fetchImpl });

    await expect(collect(provider.streamCompletion([{ role: "user", content: "hi" }]))).rejects.toThrow(OpenAIChatError);
  });

  it("does not retry a non-retryable 400 — fails on the first attempt", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("bad request", { status: 400 }));
    const provider = new OpenAIChatProvider({ apiKey: "sk-test", model: "gpt-4o-mini", fetchImpl, sleepImpl: async () => {} });

    await expect(collect(provider.streamCompletion([{ role: "user", content: "hi" }]))).rejects.toThrow(OpenAIChatError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries establishing the response on a 503, then succeeds and streams normally", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("service unavailable", { status: 503 }))
      .mockResolvedValueOnce(sseResponse(['data: {"choices":[{"delta":{"content":"recovered"}}]}\n\n', "data: [DONE]\n\n"]));
    const sleepImpl = vi.fn().mockResolvedValue(undefined);

    const provider = new OpenAIChatProvider({ apiKey: "sk-test", model: "gpt-4o-mini", fetchImpl, sleepImpl, maxRetries: 2 });
    const deltas = await collect(provider.streamCompletion([{ role: "user", content: "hi" }]));

    expect(deltas).toEqual(["recovered"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleepImpl).toHaveBeenCalledTimes(1);
  });

  it("exhausts the retry budget on persistent 5xx failures and throws", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("server error", { status: 500 }));
    const sleepImpl = vi.fn().mockResolvedValue(undefined);

    const provider = new OpenAIChatProvider({ apiKey: "sk-test", model: "gpt-4o-mini", fetchImpl, sleepImpl, maxRetries: 2 });

    await expect(collect(provider.streamCompletion([{ role: "user", content: "hi" }]))).rejects.toThrow(OpenAIChatError);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("aborts and retries a hung connection once connectTimeoutMs elapses", async () => {
    const hungFetch = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(hungFetch)
      .mockResolvedValueOnce(sseResponse(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', "data: [DONE]\n\n"]));
    const sleepImpl = vi.fn().mockResolvedValue(undefined);

    const provider = new OpenAIChatProvider({
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      fetchImpl,
      sleepImpl,
      maxRetries: 1,
      connectTimeoutMs: 20,
    });
    const deltas = await collect(provider.streamCompletion([{ role: "user", content: "hi" }]));

    expect(deltas).toEqual(["ok"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("opens the circuit after repeated failures and fails fast without calling fetch again", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("server error", { status: 500 }));
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const circuitBreaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 10_000 });

    const makeProvider = () =>
      new OpenAIChatProvider({ apiKey: "sk-test", model: "gpt-4o-mini", fetchImpl, sleepImpl, maxRetries: 0, circuitBreaker });

    // Two independent streamCompletion calls, each exhausting its own
    // (maxRetries: 0) attempt — two failures total, reaching the
    // breaker's threshold of 2.
    await expect(collect(makeProvider().streamCompletion([{ role: "user", content: "hi" }]))).rejects.toThrow(OpenAIChatError);
    await expect(collect(makeProvider().streamCompletion([{ role: "user", content: "hi" }]))).rejects.toThrow(OpenAIChatError);
    expect(circuitBreaker.getState()).toBe("open");

    fetchImpl.mockClear();
    await expect(collect(makeProvider().streamCompletion([{ role: "user", content: "hi" }]))).rejects.toThrow(CircuitBreakerOpenError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
