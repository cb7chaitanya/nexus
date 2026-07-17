import type { EmbeddingProvider } from "./types.js";

export interface OpenAIEmbeddingProviderOptions {
  apiKey: string;
  model: string;
  /** OpenAI accepts many inputs per request, but batching keeps individual
   * requests small and bounds how much work one failed request has to
   * retry. ~100 matches architecture.md §4.4's guidance. */
  batchSize?: number;
  /** Transient-failure retries per batch, not per embed() call — each
   * batch gets its own retry budget so one bad batch doesn't waste
   * retries that other batches in the same embed() call didn't need. */
  maxRetries?: number;
  baseDelayMs?: number;
  baseUrl?: string;
  /** Injectable for tests — never hits the real OpenAI API in the test
   * suite (see this package's openai.test.ts). */
  fetchImpl?: typeof fetch;
  /** Injectable for tests, so exponential backoff doesn't make the suite
   * slow. */
  sleepImpl?: (ms: number) => Promise<void>;
}

interface OpenAIEmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

/**
 * OpenAI implementation of EmbeddingProvider. Batches requests, retries
 * transient failures (429/5xx/network errors) with exponential backoff
 * (honoring a Retry-After header when the API sends one), and fails fast
 * on non-retryable errors (bad API key, malformed input) rather than
 * burning through the retry budget on something retrying can't fix.
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly batchSize: number;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(options: OpenAIEmbeddingProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.batchSize = options.batchSize ?? 100;
    this.maxRetries = options.maxRetries ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 1000;
    this.baseUrl = options.baseUrl ?? "https://api.openai.com/v1";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleepImpl = options.sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const batches = chunk(texts, this.batchSize);
    const results: number[][][] = [];
    for (const batch of batches) {
      results.push(await this.embedBatch(batch));
    }
    return results.flat();
  }

  private async embedBatch(batch: string[]): Promise<number[][]> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        await this.sleepImpl(this.retryDelayMs(attempt, lastError));
      }

      try {
        const response = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ model: this.model, input: batch }),
        });

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          const error = new OpenAIEmbeddingError(
            `OpenAI embeddings request failed with status ${response.status}: ${body}`,
            response.status,
            response.headers.get("retry-after"),
          );

          if (!isRetryableStatus(response.status) || attempt === this.maxRetries) {
            throw error;
          }
          lastError = error;
          continue;
        }

        const payload = (await response.json()) as OpenAIEmbeddingResponse;
        return payload.data.sort((a, b) => a.index - b.index).map((item) => item.embedding);
      } catch (err) {
        if (err instanceof OpenAIEmbeddingError) {
          throw err;
        }
        // Network-level failure (fetch rejected) — always retryable.
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
    if (lastError instanceof OpenAIEmbeddingError && lastError.retryAfterSeconds !== null) {
      return lastError.retryAfterSeconds * 1000;
    }
    return this.baseDelayMs * 2 ** (attempt - 1);
  }
}

export class OpenAIEmbeddingError extends Error {
  readonly status: number;
  readonly retryAfterSeconds: number | null;

  constructor(message: string, status: number, retryAfterHeader: string | null) {
    super(message);
    this.name = "OpenAIEmbeddingError";
    this.status = status;
    const parsed = retryAfterHeader ? Number(retryAfterHeader) : NaN;
    this.retryAfterSeconds = Number.isFinite(parsed) ? parsed : null;
  }
}
