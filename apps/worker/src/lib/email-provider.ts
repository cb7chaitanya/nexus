import { FakeEmailProvider, ResendEmailProvider } from "@raas/providers";
import type { EmailProvider } from "@raas/providers";

import { env } from "../env.js";

let cached: EmailProvider | undefined;

export function getEmailProvider(): EmailProvider {
  if (!cached) {
    cached =
      env.EMAIL_PROVIDER === "fake"
        ? new FakeEmailProvider({ delayMs: env.FAKE_EMAIL_DELAY_MS })
        : new ResendEmailProvider({ apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM_ADDRESS });
  }
  return cached;
}
