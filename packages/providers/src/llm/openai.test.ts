import { describe, expect, it, vi } from "vitest";

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
});
