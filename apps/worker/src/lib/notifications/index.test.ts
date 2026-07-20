import type { Logger } from "@raas/logger";
import { describe, expect, it } from "vitest";

import { createNotifier, NoopNotifier, WebhookNotifier } from "./index.js";

/** Records .warn calls without needing a real pino instance — `pino`
 * isn't a direct dependency of apps/worker (only @raas/logger, which
 * wraps it), and createNotifier only ever calls `.warn` on whatever
 * logger it's given, so a minimal fake covering just that method is a
 * faithful, dependency-free stand-in for the `Logger` interface here. */
function fakeLogger(): { logger: Logger; warnCalls: unknown[][] } {
  const warnCalls: unknown[][] = [];
  const logger = {
    warn: (...args: unknown[]) => {
      warnCalls.push(args);
    },
  } as unknown as Logger;
  return { logger, warnCalls };
}

describe("createNotifier", () => {
  it("returns a WebhookNotifier, with no warning logged, when an alert webhook URL is configured", () => {
    const { logger, warnCalls } = fakeLogger();

    const notifier = createNotifier({ alertWebhookUrl: "https://alerts.example.com/hook", alertWebhookTimeoutMs: 5000 }, logger);

    expect(notifier).toBeInstanceOf(WebhookNotifier);
    expect(warnCalls).toHaveLength(0);
  });

  it("returns a NoopNotifier AND logs a warning when no alert webhook URL is configured", () => {
    const { logger, warnCalls } = fakeLogger();

    const notifier = createNotifier({ alertWebhookUrl: undefined }, logger);

    expect(notifier).toBeInstanceOf(NoopNotifier);
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]?.[0]).toContain("ALERT_WEBHOOK_URL is not set");
  });

  it("treats an empty-string URL the same as unconfigured", () => {
    const { logger, warnCalls } = fakeLogger();

    const notifier = createNotifier({ alertWebhookUrl: "" }, logger);

    expect(notifier).toBeInstanceOf(NoopNotifier);
    expect(warnCalls).toHaveLength(1);
  });

  it("never logs anything on the configured path — a webhook URL can carry an auth token as a query parameter", () => {
    const { logger, warnCalls } = fakeLogger();

    createNotifier({ alertWebhookUrl: "https://hooks.example.com/T00/B00/super-secret-token" }, logger);

    expect(warnCalls).toHaveLength(0);
  });
});
