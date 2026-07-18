import { afterEach, describe, expect, it, vi } from "vitest";

import { captureException, NoopErrorTracker, resetErrorTrackerForTesting, SentryAdapter, setErrorTracker } from "./index.js";
import type { SentryLikeClient } from "./sentry-adapter.js";

describe("captureException / setErrorTracker", () => {
  afterEach(() => {
    resetErrorTrackerForTesting();
  });

  it("defaults to a no-op tracker — captureException never throws with nothing configured", () => {
    expect(() => captureException(new Error("boom"))).not.toThrow();
    expect(() => captureException(new Error("boom"), { requestId: "req-1" })).not.toThrow();
  });

  it("routes captureException calls to whatever tracker setErrorTracker configured", () => {
    const captured: Array<{ error: unknown; context?: Record<string, unknown> }> = [];
    setErrorTracker({
      captureException: (error, context) => {
        captured.push({ error, context });
      },
    });

    const err = new Error("something broke");
    captureException(err, { jobId: "job-1", organizationId: "org-1" });

    expect(captured).toHaveLength(1);
    expect(captured[0]!.error).toBe(err);
    expect(captured[0]!.context).toEqual({ jobId: "job-1", organizationId: "org-1" });
  });

  it("resetErrorTrackerForTesting restores the no-op default", () => {
    const spy = vi.fn();
    setErrorTracker({ captureException: spy });
    captureException(new Error("first"));
    expect(spy).toHaveBeenCalledTimes(1);

    resetErrorTrackerForTesting();
    captureException(new Error("second"));
    // Still only ever called once — the second capture went to the
    // restored no-op tracker, not the old spy.
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("NoopErrorTracker", () => {
  it("captureException is a genuine no-op — never throws, returns nothing", () => {
    const tracker = new NoopErrorTracker();
    expect(tracker.captureException(new Error("boom"), { foo: "bar" })).toBeUndefined();
  });
});

describe("SentryAdapter", () => {
  it("forwards the error and wraps context under `extra`, matching Sentry's captureContext shape", () => {
    const client: SentryLikeClient = { captureException: vi.fn().mockReturnValue("event-id-123") };
    const adapter = new SentryAdapter(client);

    const err = new Error("adapter test");
    adapter.captureException(err, { requestId: "req-42", route: "/kb" });

    expect(client.captureException).toHaveBeenCalledWith(err, { extra: { requestId: "req-42", route: "/kb" } });
  });

  it("passes undefined captureContext when no context is given, rather than an empty extra object", () => {
    const client: SentryLikeClient = { captureException: vi.fn() };
    const adapter = new SentryAdapter(client);

    adapter.captureException(new Error("no context"));

    expect(client.captureException).toHaveBeenCalledWith(expect.any(Error), undefined);
  });

  it("works when driven through captureException/setErrorTracker end-to-end", () => {
    const client: SentryLikeClient = { captureException: vi.fn() };
    setErrorTracker(new SentryAdapter(client));

    captureException(new Error("end to end"), { documentId: "doc-1" });

    expect(client.captureException).toHaveBeenCalledWith(expect.any(Error), { extra: { documentId: "doc-1" } });
    resetErrorTrackerForTesting();
  });
});
