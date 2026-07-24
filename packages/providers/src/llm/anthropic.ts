import { CircuitBreaker } from "../resilience/circuit-breaker.js";
import { withTimeout } from "../resilience/timeout.js";
import type { CompletionStream, LLMMessage, LLMProvider, TokenUsage } from "./types.js";

export interface AnthropicChatProviderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  /** Hard ceiling on a single completion's output tokens — same
   * per-request cost backstop as OpenAIChatProvider's maxCompletionTokens,
   * required by Anthropic's API on every request regardless (there is no
   * "unbounded" option to omit it and fall back to). */
  maxCompletionTokens?: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  maxRetries?: number;
  baseDelayMs?: number;
  connectTimeoutMs?: number;
  circuitBreaker?: CircuitBreaker;
}

// Anthropic's Messages API streams named SSE events (`event: content_block_delta`
// etc.), but every event's `data:` payload also carries its own `type` field
// identical to the event name — so, same as OpenAIChatProvider's parser,
// this only needs to read `data:` lines and switch on that field, never the
// `event:` line itself.
interface AnthropicStreamEvent {
  type: string;
  message?: { usage?: { input_tokens: number } };
  delta?: { type?: string; text?: string; stop_reason?: string | null };
  usage?: { output_tokens: number };
  error?: { type: string; message: string };
}

export class AnthropicChatError extends Error {
  readonly status: number;
  readonly retryAfterSeconds: number | null;

  constructor(message: string, status: number, retryAfterHeader: string | null = null) {
    super(message);
    this.name = "AnthropicChatError";
    this.status = status;
    const parsed = retryAfterHeader ? Number(retryAfterHeader) : NaN;
    this.retryAfterSeconds = Number.isFinite(parsed) ? parsed : null;
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

const DEFAULT_MAX_COMPLETION_TOKENS = 1024;

/**
 * Anthropic implementation of LLMProvider, using the Messages API's
 * streaming mode — hand-rolled fetch + SSE parsing, matching
 * OpenAIChatProvider's dependency-free style (not the @anthropic-ai/sdk
 * package). Two real wire-format differences from OpenAI that make this
 * more than a find-and-replace of the OpenAI provider:
 *
 * 1. System prompt is a top-level `system` string field, not a
 *    role:"system" entry in `messages` — messages() below splits it out.
 * 2. Usage is reported in two pieces across the stream, not one trailing
 *    chunk: `message_start`'s `message.usage.input_tokens` plus the LAST
 *    `message_delta`'s `usage.output_tokens` (the running output count
 *    updates as the stream progresses; the final one before `message_stop`
 *    is what's kept).
 *
 * Resilience is split by phase exactly like OpenAIChatProvider: retried
 * with backoff + a circuit breaker up through establishing the response,
 * never retried once a token has started streaming to the caller — see
 * that class's doc comment for the full reasoning, unchanged here.
 */
export class AnthropicChatProvider implements LLMProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly maxCompletionTokens: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly connectTimeoutMs: number;
  private readonly circuitBreaker: CircuitBreaker;

  constructor(options: AnthropicChatProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = options.baseUrl ?? "https://api.anthropic.com/v1";
    this.maxCompletionTokens = options.maxCompletionTokens ?? DEFAULT_MAX_COMPLETION_TOKENS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleepImpl = options.sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxRetries = options.maxRetries ?? 2;
    this.baseDelayMs = options.baseDelayMs ?? 1000;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 30_000;
    this.circuitBreaker = options.circuitBreaker ?? new CircuitBreaker({ failureThreshold: 5, cooldownMs: 30_000 });
  }

  streamCompletion(messages: LLMMessage[]): CompletionStream {
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
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;

    try {
      const response = await this.circuitBreaker.execute(() => this.connectWithRetry(messages));

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const event = parseSseEvent(line);
            if (event === null) continue;

            if (event.type === "error") {
              throw new AnthropicChatError(event.error?.message ?? "Anthropic returned an error mid-stream", 0);
            }
            if (event.type === "message_start") {
              inputTokens = event.message?.usage?.input_tokens ?? null;
            }
            if (event.type === "message_delta" && event.usage) {
              outputTokens = event.usage.output_tokens;
            }
            if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
              yield event.delta.text;
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    } finally {
      resolveUsage(
        inputTokens !== null && outputTokens !== null
          ? { promptTokens: inputTokens, completionTokens: outputTokens, totalTokens: inputTokens + outputTokens }
          : null,
      );
    }
  }

  private async connectWithRetry(messages: LLMMessage[]): Promise<Response> {
    const system = messages.find((m) => m.role === "system")?.content;
    const conversation = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content }));

    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        await this.sleepImpl(this.retryDelayMs(attempt, lastError));
      }

      try {
        const response = await withTimeout(
          (signal) =>
            this.fetchImpl(`${this.baseUrl}/messages`, {
              method: "POST",
              headers: {
                "x-api-key": this.apiKey,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
              },
              body: JSON.stringify({
                model: this.model,
                ...(system ? { system } : {}),
                messages: conversation,
                max_tokens: this.maxCompletionTokens,
                stream: true,
              }),
              signal,
            }),
          this.connectTimeoutMs,
        );

        if (!response.ok || !response.body) {
          const body = await response.text().catch(() => "");
          const error = new AnthropicChatError(
            `Anthropic messages request failed with status ${response.status}: ${body}`,
            response.status,
            response.headers.get("retry-after"),
          );

          if (!isRetryableStatus(response.status) || attempt === this.maxRetries) {
            throw error;
          }
          lastError = error;
          continue;
        }

        return response;
      } catch (err) {
        if (err instanceof AnthropicChatError) {
          throw err;
        }
        if (attempt === this.maxRetries) {
          throw err;
        }
        lastError = err;
      }
    }

    throw lastError;
  }

  private retryDelayMs(attempt: number, lastError: unknown): number {
    if (lastError instanceof AnthropicChatError && lastError.retryAfterSeconds !== null) {
      return lastError.retryAfterSeconds * 1000;
    }
    return this.baseDelayMs * 2 ** (attempt - 1);
  }
}

function parseSseEvent(line: string): AnthropicStreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;

  const payload = trimmed.slice("data:".length).trim();
  if (!payload) return null;

  return JSON.parse(payload) as AnthropicStreamEvent;
}
