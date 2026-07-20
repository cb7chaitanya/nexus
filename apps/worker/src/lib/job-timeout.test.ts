import type { Job } from "bullmq";
import { describe, expect, it } from "vitest";

import { JobTimeoutError, withJobTimeout } from "./job-timeout.js";

// These tests exercise withJobTimeout's timing/error-propagation behavior
// only; the job payload's shape is irrelevant to every case here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fakeJob = {} as Job<any, any, any>;

function delay<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

describe("withJobTimeout", () => {
  it("returns the processor's result when it settles well within the budget", async () => {
    const wrapped = withJobTimeout(async () => "done", 200);
    await expect(wrapped(fakeJob)).resolves.toBe("done");
  });

  it("rejects with JobTimeoutError when the processor exceeds the budget", async () => {
    const wrapped = withJobTimeout(() => delay(200, "too slow"), 20);
    await expect(wrapped(fakeJob)).rejects.toThrow(JobTimeoutError);
  });

  it("propagates the processor's own rejection unchanged when it fails before timing out", async () => {
    const wrapped = withJobTimeout(async (): Promise<string> => {
      throw new Error("processor-specific failure");
    }, 200);
    await expect(wrapped(fakeJob)).rejects.toThrow("processor-specific failure");
  });

  it("passes job/token/signal through to the wrapped processor unchanged", async () => {
    let received: unknown[] = [];
    const wrapped = withJobTimeout(async (job, token, signal) => {
      received = [job, token, signal];
      return "ok";
    }, 200);

    const controller = new AbortController();
    await wrapped(fakeJob, "token-123", controller.signal);

    expect(received).toEqual([fakeJob, "token-123", controller.signal]);
  });

  it("does not leave a dangling timer that fires after a fast success", async () => {
    // Regression guard for a leaked setTimeout: if clearTimeout weren't
    // called on the success path, this would eventually reject far later
    // than the test's own lifetime — vitest's fake timers aren't used
    // here specifically so a real leaked timer would show up as an
    // unhandled rejection during the suite's teardown, not silently pass.
    const wrapped = withJobTimeout(async () => "fast", 30);
    await expect(wrapped(fakeJob)).resolves.toBe("fast");
    await delay(50, undefined); // outlive the timeout window that must NOT fire
  });
});
