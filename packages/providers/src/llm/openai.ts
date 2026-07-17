import type { LLMMessage, LLMProvider } from "./types.js";

export interface OpenAIChatProviderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  /** Injectable for tests — never hits the real OpenAI API in the test
   * suite (see this package's openai.test.ts). */
  fetchImpl?: typeof fetch;
}

interface OpenAIStreamChunk {
  choices: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
}

export class OpenAIChatError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "OpenAIChatError";
    this.status = status;
  }
}

/**
 * OpenAI implementation of LLMProvider, using the Chat Completions
 * streaming API (`stream: true`), which sends a series of
 * `data: {...}\n\n` Server-Sent Events terminated by a literal
 * `data: [DONE]` line. This parses that wire format directly rather than
 * depending on OpenAI's SDK, matching the fetch-based, dependency-free
 * style of OpenAIEmbeddingProvider in this same package.
 *
 * No retry/backoff here (unlike OpenAIEmbeddingProvider) — a chat request
 * is already mid-stream to a client by the time most failures would be
 * detected, so a retry would mean silently restarting a partially-shown
 * answer rather than a clean retry of an atomic call. Surfacing the
 * failure and letting the caller decide (apps/api's chat route ends the
 * SSE stream) is the right behavior for this interface; batch-style retry
 * belongs to a future non-streaming use of this provider if one exists.
 */
export class OpenAIChatProvider implements LLMProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAIChatProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = options.baseUrl ?? "https://api.openai.com/v1";
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async *streamCompletion(messages: LLMMessage[]): AsyncIterable<string> {
    const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: this.model, messages, stream: true }),
    });

    if (!response.ok || !response.body) {
      const body = await response.text().catch(() => "");
      throw new OpenAIChatError(`OpenAI chat completions request failed with status ${response.status}: ${body}`, response.status);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        // The last element may be a partial line — keep it in the buffer
        // until more bytes arrive.
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const delta = parseSseDataLine(line);
          if (delta !== null) yield delta;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

function parseSseDataLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;

  const payload = trimmed.slice("data:".length).trim();
  if (payload === "[DONE]") return null;

  const parsed = JSON.parse(payload) as OpenAIStreamChunk;
  return parsed.choices[0]?.delta?.content ?? null;
}
