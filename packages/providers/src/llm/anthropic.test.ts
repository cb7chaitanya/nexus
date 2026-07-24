import { describe, expect, it, vi } from "vitest";

import { CircuitBreaker, CircuitBreakerOpenError } from "../resilience/circuit-breaker.js";
import { AnthropicChatError, AnthropicChatProvider } from "./anthropic.js";

function requestBody(fetchImpl: ReturnType<typeof vi.fn>, callIndex = 0): Record<string, unknown> {
  const init = fetchImpl.mock.calls[callIndex]![1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

function requestHeaders(fetchImpl: ReturnType<typeof vi.fn>, callIndex = 0): Record<string, string> {
  const init = fetchImpl.mock.calls[callIndex]![1] as RequestInit;
  return init.headers as Record<string, string>;
}

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

const textDelta = (text: string) => `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}\n\n`;
const messageStart = (inputTokens: number) =>
  `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: inputTokens } } })}\n\n`;
const messageDelta = (outputTokens: number) =>
  `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: outputTokens } })}\n\n`;
const messageStop = 'data: {"type":"message_stop"}\n\n';

describe("AnthropicChatProvider", () => {
  it("yields text from content_block_delta events", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse([textDelta("Hello"), textDelta(" world"), messageStop]));

    const provider = new AnthropicChatProvider({ apiKey: "sk-ant-test", model: "claude-3-5-sonnet-latest", fetchImpl });
    const deltas = await collect(provider.streamCompletion([{ role: "user", content: "hi" }]));

    expect(deltas).toEqual(["Hello", " world"]);
  });

  it("reassembles an SSE line split across two chunk-boundary reads", async () => {
    const line = textDelta("split-safe");
    const splitPoint = 25;
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse([line.slice(0, splitPoint), line.slice(splitPoint), messageStop]));

    const provider = new AnthropicChatProvider({ apiKey: "sk-ant-test", model: "claude-3-5-sonnet-latest", fetchImpl });
    const deltas = await collect(provider.streamCompletion([{ role: "user", content: "hi" }]));

    expect(deltas).toEqual(["split-safe"]);
  });

  it("authenticates with x-api-key and anthropic-version, never an Authorization header", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse([messageStop]));
    const provider = new AnthropicChatProvider({ apiKey: "sk-ant-test", model: "claude-3-5-sonnet-latest", fetchImpl });

    await collect(provider.streamCompletion([{ role: "user", content: "hi" }]));

    const headers = requestHeaders(fetchImpl);
    expect(headers["x-api-key"]).toBe("sk-ant-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("hoists a role:\"system\" message to the top-level `system` field, not the messages array", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse([messageStop]));
    const provider = new AnthropicChatProvider({ apiKey: "sk-ant-test", model: "claude-3-5-sonnet-latest", fetchImpl });

    await collect(
      provider.streamCompletion([
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "hi" },
      ]),
    );

    const body = requestBody(fetchImpl);
    expect(body.system).toBe("You are a helpful assistant.");
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("throws AnthropicChatError on a non-ok response instead of yielding", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("bad request", { status: 400 }));
    const provider = new AnthropicChatProvider({ apiKey: "sk-ant-test", model: "claude-3-5-sonnet-latest", fetchImpl });

    await expect(collect(provider.streamCompletion([{ role: "user", content: "hi" }]))).rejects.toThrow(AnthropicChatError);
  });

  it("does not retry a non-retryable 400 — fails on the first attempt", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("bad request", { status: 400 }));
    const provider = new AnthropicChatProvider({ apiKey: "sk-ant-test", model: "claude-3-5-sonnet-latest", fetchImpl, sleepImpl: async () => {} });

    await expect(collect(provider.streamCompletion([{ role: "user", content: "hi" }]))).rejects.toThrow(AnthropicChatError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries establishing the response on a 529 (overloaded), then succeeds and streams normally", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("overloaded", { status: 529 }))
      .mockResolvedValueOnce(sseResponse([textDelta("recovered"), messageStop]));
    const sleepImpl = vi.fn().mockResolvedValue(undefined);

    const provider = new AnthropicChatProvider({ apiKey: "sk-ant-test", model: "claude-3-5-sonnet-latest", fetchImpl, sleepImpl, maxRetries: 2 });
    const deltas = await collect(provider.streamCompletion([{ role: "user", content: "hi" }]));

    expect(deltas).toEqual(["recovered"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleepImpl).toHaveBeenCalledTimes(1);
  });

  it("exhausts the retry budget on persistent 5xx failures and throws", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("server error", { status: 500 }));
    const sleepImpl = vi.fn().mockResolvedValue(undefined);

    const provider = new AnthropicChatProvider({ apiKey: "sk-ant-test", model: "claude-3-5-sonnet-latest", fetchImpl, sleepImpl, maxRetries: 2 });

    await expect(collect(provider.streamCompletion([{ role: "user", content: "hi" }]))).rejects.toThrow(AnthropicChatError);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("opens the circuit after repeated failures and fails fast without calling fetch again", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("server error", { status: 500 }));
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const circuitBreaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 10_000 });

    const makeProvider = () =>
      new AnthropicChatProvider({ apiKey: "sk-ant-test", model: "claude-3-5-sonnet-latest", fetchImpl, sleepImpl, maxRetries: 0, circuitBreaker });

    await expect(collect(makeProvider().streamCompletion([{ role: "user", content: "hi" }]))).rejects.toThrow(AnthropicChatError);
    await expect(collect(makeProvider().streamCompletion([{ role: "user", content: "hi" }]))).rejects.toThrow(AnthropicChatError);
    expect(circuitBreaker.getState()).toBe("open");

    fetchImpl.mockClear();
    await expect(collect(makeProvider().streamCompletion([{ role: "user", content: "hi" }]))).rejects.toThrow(CircuitBreakerOpenError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends max_tokens on every request", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse([messageStop]));
    const provider = new AnthropicChatProvider({ apiKey: "sk-ant-test", model: "claude-3-5-sonnet-latest", fetchImpl, maxCompletionTokens: 256 });

    await collect(provider.streamCompletion([{ role: "user", content: "hi" }]));

    expect(requestBody(fetchImpl).max_tokens).toBe(256);
  });

  describe("usage accounting", () => {
    it("captures input tokens from message_start and output tokens from the last message_delta", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(
        sseResponse([messageStart(12), textDelta("Hello"), textDelta(" world"), messageDelta(4), messageStop]),
      );

      const provider = new AnthropicChatProvider({ apiKey: "sk-ant-test", model: "claude-3-5-sonnet-latest", fetchImpl });
      const stream = provider.streamCompletion([{ role: "user", content: "hi" }]);
      const deltas = await collect(stream);
      const usage = await stream.usage;

      expect(deltas).toEqual(["Hello", " world"]);
      expect(usage).toEqual({ promptTokens: 12, completionTokens: 4, totalTokens: 16 });
    });

    it("keeps the LAST message_delta's output_tokens when there are several (running count)", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(
        sseResponse([messageStart(10), textDelta("a"), messageDelta(1), textDelta("b"), messageDelta(2), messageStop]),
      );

      const provider = new AnthropicChatProvider({ apiKey: "sk-ant-test", model: "claude-3-5-sonnet-latest", fetchImpl });
      const stream = provider.streamCompletion([{ role: "user", content: "hi" }]);
      await collect(stream);
      const usage = await stream.usage;

      expect(usage).toEqual({ promptTokens: 10, completionTokens: 2, totalTokens: 12 });
    });

    it("resolves usage to null when the response never sends usage events", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(sseResponse([textDelta("ok"), messageStop]));

      const provider = new AnthropicChatProvider({ apiKey: "sk-ant-test", model: "claude-3-5-sonnet-latest", fetchImpl });
      const stream = provider.streamCompletion([{ role: "user", content: "hi" }]);
      const deltas = await collect(stream);
      const usage = await stream.usage;

      expect(deltas).toEqual(["ok"]);
      expect(usage).toBeNull();
    });

    it("still resolves usage (to whatever was captured before the failure) when the stream throws mid-read", async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(messageStart(10)));
          controller.enqueue(encoder.encode(textDelta("partial")));
          controller.error(new Error("connection dropped"));
        },
      });
      const fetchImpl = vi.fn().mockResolvedValue(new Response(stream, { status: 200 }));

      const provider = new AnthropicChatProvider({ apiKey: "sk-ant-test", model: "claude-3-5-sonnet-latest", fetchImpl });
      const completionStream = provider.streamCompletion([{ role: "user", content: "hi" }]);

      await expect(collect(completionStream)).rejects.toThrow("connection dropped");
      // message_start arrived (input tokens captured) but no message_delta
      // did — still null overall, since usage is only ever reported as a
      // complete { promptTokens, completionTokens } pair, never partial.
      await expect(completionStream.usage).resolves.toBeNull();
    });
  });

  it("throws AnthropicChatError when an error event arrives mid-stream", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      sseResponse([textDelta("partial"), `data: ${JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })}\n\n`]),
    );

    const provider = new AnthropicChatProvider({ apiKey: "sk-ant-test", model: "claude-3-5-sonnet-latest", fetchImpl });

    await expect(collect(provider.streamCompletion([{ role: "user", content: "hi" }]))).rejects.toThrow("Overloaded");
  });
});
