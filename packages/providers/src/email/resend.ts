import type { EmailProvider, SendEmailParams } from "./types.js";

export interface ResendEmailProviderOptions {
  apiKey: string;
  /** e.g. `"Nexus <noreply@yourdomain.com>"` — Resend requires a verified sending domain. */
  from: string;
  maxRetries?: number;
  baseDelayMs?: number;
  baseUrl?: string;
  /** Injectable for tests — never hits the real Resend API in the test suite. */
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Resend implementation of EmailProvider. Raw fetch against Resend's REST
 * API rather than their SDK — matches this package's zero-runtime-deps
 * convention (see embeddings/openai.ts). Same retry/backoff shape as
 * OpenAIEmbeddingProvider: transient failures (429/5xx/network) retry
 * with exponential backoff honoring Retry-After, everything else fails
 * fast.
 */
export class ResendEmailProvider implements EmailProvider {
  private readonly apiKey: string;
  private readonly from: string;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(options: ResendEmailProviderOptions) {
    this.apiKey = options.apiKey;
    this.from = options.from;
    this.maxRetries = options.maxRetries ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 1000;
    this.baseUrl = options.baseUrl ?? "https://api.resend.com";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleepImpl = options.sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async send(params: SendEmailParams): Promise<void> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        await this.sleepImpl(this.retryDelayMs(attempt, lastError));
      }

      try {
        const response = await this.fetchImpl(`${this.baseUrl}/emails`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: this.from,
            to: [params.to],
            subject: params.subject,
            html: params.html,
            text: params.text,
          }),
        });

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          const error = new ResendEmailError(
            `Resend request failed with status ${response.status}: ${body}`,
            response.status,
            response.headers.get("retry-after"),
          );

          if (!isRetryableStatus(response.status) || attempt === this.maxRetries) {
            throw error;
          }
          lastError = error;
          continue;
        }

        return;
      } catch (err) {
        if (err instanceof ResendEmailError) {
          throw err;
        }
        if (attempt === this.maxRetries) {
          throw err;
        }
        lastError = err;
      }
    }
  }

  private retryDelayMs(attempt: number, lastError: unknown): number {
    if (lastError instanceof ResendEmailError && lastError.retryAfterSeconds !== null) {
      return lastError.retryAfterSeconds * 1000;
    }
    return this.baseDelayMs * 2 ** (attempt - 1);
  }
}

export class ResendEmailError extends Error {
  readonly status: number;
  readonly retryAfterSeconds: number | null;

  constructor(message: string, status: number, retryAfterHeader: string | null) {
    super(message);
    this.name = "ResendEmailError";
    this.status = status;
    const parsed = retryAfterHeader ? Number(retryAfterHeader) : NaN;
    this.retryAfterSeconds = Number.isFinite(parsed) ? parsed : null;
  }
}
