import { CircuitBreaker } from "../resilience/circuit-breaker.js";
import { withTimeout } from "../resilience/timeout.js";
import type { LLMMessage, LLMProvider } from "./types.js";

export interface OpenAIChatProviderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  /** Hard ceiling on a single completion's output tokens — every request
   * sends this, unconditionally. Defaults to DEFAULT_MAX_COMPLETION_TOKENS.
   * See the class doc comment for why this exists. */
  maxCompletionTokens?: number;
  /** Injectable for tests — never hits the real OpenAI API in the test
   * suite (see this package's openai.test.ts). */
  fetchImpl?: typeof fetch;
  /** Injectable for tests, so exponential backoff doesn't make the suite
   * slow. */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Retries apply only to establishing the response (the connection and
   * response headers) — never to anything once a single token has been
   * yielded to the caller. See the class doc comment for why. */
  maxRetries?: number;
  baseDelayMs?: number;
  /** Max time to wait for the response to begin (headers/status), not
   * the total streaming duration — a slow-but-still-flowing generation
   * must never be killed by this. Applies per attempt, so a retry gets
   * its own fresh budget. */
  connectTimeoutMs?: number;
  /** Injectable so tests don't have to wait out real cooldowns. Defaults
   * to a fresh breaker per provider instance (5 consecutive failures,
   * 30s cooldown). */
  circuitBreaker?: CircuitBreaker;
}

interface OpenAIStreamChunk {
  choices: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
}

export class OpenAIChatError extends Error {
  readonly status: number;
  readonly retryAfterSeconds: number | null;

  constructor(message: string, status: number, retryAfterHeader: string | null = null) {
    super(message);
    this.name = "OpenAIChatError";
    this.status = status;
    const parsed = retryAfterHeader ? Number(retryAfterHeader) : NaN;
    this.retryAfterSeconds = Number.isFinite(parsed) ? parsed : null;
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

// Safe default when a caller doesn't pass maxCompletionTokens explicitly
// (every production call site does — see apps/api/src/lib/llm-provider.ts —
// this only matters for a construction site that forgets to). Bounds the
// worst case per-request cost of an uncapped completion; see
// docs/decisions.md's cost-protection ticket for the incident this closes.
export const DEFAULT_MAX_COMPLETION_TOKENS = 1024;

// o1/o3-family "reasoning" models reject `max_tokens` outright and require
// `max_completion_tokens` instead; every other Chat Completions model
// (gpt-4o, gpt-4o-mini, gpt-3.5-turbo, ...) accepts `max_tokens`, which is
// the field OpenAI's API has documented for years and still honors. This is
// why the request body field name is resolved per-model rather than fixed.
function maxTokensParamName(model: string): "max_tokens" | "max_completion_tokens" {
  return /^o\d/.test(model) ? "max_completion_tokens" : "max_tokens";
}

/**
 * OpenAI implementation of LLMProvider, using the Chat Completions
 * streaming API (`stream: true`), which sends a series of
 * `data: {...}\n\n` Server-Sent Events terminated by a literal
 * `data: [DONE]` line. This parses that wire format directly rather than
 * depending on OpenAI's SDK, matching the fetch-based, dependency-free
 * style of OpenAIEmbeddingProvider in this same package.
 *
 * Every request sends a hard `max_tokens`/`max_completion_tokens` ceiling
 * (maxCompletionTokens) — streaming still yields deltas exactly as before,
 * this only bounds how many the model is allowed to produce before OpenAI
 * itself truncates the response. Without this, a single request's cost is
 * bounded only by the model's own native output ceiling (tens of thousands
 * of tokens on some models), which the org-level daily token budget
 * (@raas/usage) can only catch *after* the cost is already incurred — this
 * is the per-request backstop that budget can't be.
 *
 * Resilience is split by phase, which is the actual distinction that
 * makes retrying safe or not: establishing the response — the fetch
 * call, up through checking response.ok — gets a timeout, exponential
 * backoff retry (mirroring OpenAIEmbeddingProvider's shape), and a
 * circuit breaker, all wrapping connectWithRetry() below. Once that
 * response exists and streaming begins, NONE of that applies anymore —
 * a chat request is already mid-stream to a client by the time a
 * failure there would be detected, so retrying would mean either
 * silently re-showing already-displayed content or requiring a
 * resumption protocol this system doesn't have. A mid-stream failure
 * instead propagates directly to the caller (apps/api's chat route ends
 * the SSE stream with an error event) — the user sees a partial answer
 * and has to re-ask. This is a real, documented limitation, not an
 * oversight.
 */
export class OpenAIChatProvider implements LLMProvider {
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

  constructor(options: OpenAIChatProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = options.baseUrl ?? "https://api.openai.com/v1";
    this.maxCompletionTokens = options.maxCompletionTokens ?? DEFAULT_MAX_COMPLETION_TOKENS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleepImpl = options.sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxRetries = options.maxRetries ?? 2;
    this.baseDelayMs = options.baseDelayMs ?? 1000;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 30_000;
    this.circuitBreaker = options.circuitBreaker ?? new CircuitBreaker({ failureThreshold: 5, cooldownMs: 30_000 });
  }

  async *streamCompletion(messages: LLMMessage[]): AsyncIterable<string> {
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

  private async connectWithRetry(messages: LLMMessage[]): Promise<Response> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        await this.sleepImpl(this.retryDelayMs(attempt, lastError));
      }

      try {
        const response = await withTimeout(
          (signal) =>
            this.fetchImpl(`${this.baseUrl}/chat/completions`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${this.apiKey}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                model: this.model,
                messages,
                stream: true,
                [maxTokensParamName(this.model)]: this.maxCompletionTokens,
              }),
              signal,
            }),
          this.connectTimeoutMs,
        );

        if (!response.ok || !response.body) {
          const body = await response.text().catch(() => "");
          const error = new OpenAIChatError(
            `OpenAI chat completions request failed with status ${response.status}: ${body}`,
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
        if (err instanceof OpenAIChatError) {
          throw err;
        }
        // Network-level failure or connectTimeoutMs's TimeoutError —
        // always retryable up to the budget.
        if (attempt === this.maxRetries) {
          throw err;
        }
        lastError = err;
      }
    }

    // Unreachable: the loop above always either returns or throws.
    throw lastError;
  }

  private retryDelayMs(attempt: number, lastError: unknown): number {
    if (lastError instanceof OpenAIChatError && lastError.retryAfterSeconds !== null) {
      return lastError.retryAfterSeconds * 1000;
    }
    return this.baseDelayMs * 2 ** (attempt - 1);
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
