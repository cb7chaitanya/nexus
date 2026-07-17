import { Writable } from "node:stream";

import pino from "pino";
import { describe, expect, it } from "vitest";

import { createLogger, REDACT_PATHS } from "./index.js";

/** Captures every line pino writes as parsed JSON — pino's own
 * synchronous-write-to-a-stream mode, not stdout/transport (which is
 * fixed at process construction and not redirectable after the fact). */
function captureLogs(): { stream: Writable; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return {
    stream,
    lines: () => chunks.filter((c) => c.trim().length > 0).map((c) => JSON.parse(c) as Record<string, unknown>),
  };
}

describe("createLogger", () => {
  it("binds the given fields onto every log line", () => {
    const { stream, lines } = captureLogs();
    const logger = pino({}, stream).child({ service: "api", requestId: "req-1" });

    logger.info("hello");

    expect(lines()[0]).toMatchObject({ service: "api", requestId: "req-1", msg: "hello" });
  });

  it("accumulates bindings across successive .child() calls, matching the request-scoped logger pattern", () => {
    const { stream, lines } = captureLogs();
    const base = pino({}, stream).child({ service: "api", requestId: "req-1" });
    const withUser = base.child({ userId: "user-1" });
    const withOrg = withUser.child({ organizationId: "org-1" });

    withOrg.info("fully bound");

    expect(lines()[0]).toMatchObject({
      service: "api",
      requestId: "req-1",
      userId: "user-1",
      organizationId: "org-1",
      msg: "fully bound",
    });
  });

  it("exposes the currently-bound fields via .bindings(), the same way tests introspect request.log", () => {
    const logger = createLogger({ service: "worker", jobId: "job-1" }).child({ organizationId: "org-1" });
    expect(logger.bindings()).toMatchObject({ service: "worker", jobId: "job-1", organizationId: "org-1" });
  });
});

describe("redaction", () => {
  // Constructed with the SAME REDACT_PATHS the real baseLogger uses
  // (exported specifically for this) but a captured stream instead of
  // baseLogger's worker-thread pino-pretty transport, which can't be
  // redirected after construction.
  function redactedLogger() {
    const { stream, lines } = captureLogs();
    const logger = pino({ redact: { paths: REDACT_PATHS, censor: "[REDACTED]" } }, stream);
    return { logger, lines };
  }

  it("redacts a top-level password field", () => {
    const { logger, lines } = redactedLogger();
    logger.info({ password: "hunter2" }, "signup attempt");
    expect(lines()[0]!.password).toBe("[REDACTED]");
  });

  it("redacts a nested token field one level deep", () => {
    const { logger, lines } = redactedLogger();
    logger.info({ session: { token: "eyJ.raw.jwt" } }, "session resolved");
    expect((lines()[0]!.session as Record<string, unknown>).token).toBe("[REDACTED]");
  });

  it("redacts a nested apiKey field one level deep", () => {
    const { logger, lines } = redactedLogger();
    logger.info({ credentials: { apiKey: "sk-live-abc123" } }, "provider call");
    expect((lines()[0]!.credentials as Record<string, unknown>).apiKey).toBe("[REDACTED]");
  });

  it("redacts the Authorization and Cookie request headers if they were ever logged", () => {
    const { logger, lines } = redactedLogger();
    logger.info({ req: { headers: { authorization: "Bearer secret", cookie: "raas_session=abc" } } }, "request");
    const headers = (lines()[0]!.req as { headers: Record<string, unknown> }).headers;
    expect(headers.authorization).toBe("[REDACTED]");
    expect(headers.cookie).toBe("[REDACTED]");
  });

  it("leaves ordinary, non-sensitive fields untouched", () => {
    const { logger, lines } = redactedLogger();
    logger.info({ organizationId: "org-1", documentId: "doc-1" }, "document processed");
    expect(lines()[0]).toMatchObject({ organizationId: "org-1", documentId: "doc-1" });
  });
});
