import type { EmailProvider, SendEmailParams } from "./types.js";

export interface FakeEmailProviderOptions {
  delayMs?: number;
}

/**
 * Offline EmailProvider — logs the message to stdout instead of sending
 * it. Same status as FakeEmbeddingProvider: a real, documented
 * EMAIL_PROVIDER=fake runtime choice for local dev and tests (no Resend
 * account needed to exercise the signup-OTP flow end to end), not just a
 * test mock. Kept dependency-free (plain console.log, no @raas/logger)
 * to match this package's zero-runtime-deps convention.
 */
export class FakeEmailProvider implements EmailProvider {
  private readonly delayMs: number;

  constructor(options: FakeEmailProviderOptions = {}) {
    this.delayMs = options.delayMs ?? 0;
  }

  async send(params: SendEmailParams): Promise<void> {
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    console.log(`[FakeEmailProvider] to=${params.to} subject=${JSON.stringify(params.subject)}\n${params.text}`);
  }
}
