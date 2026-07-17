import { describe, expect, it } from "vitest";

import { TimeoutError, withTimeout } from "./timeout.js";

describe("withTimeout", () => {
  it("resolves normally when fn finishes before the timeout", async () => {
    const result = await withTimeout(() => Promise.resolve("done"), 200);
    expect(result).toBe("done");
  });

  it("throws TimeoutError when fn doesn't resolve before the timeout", async () => {
    // A realistic fn (like fetch with { signal }) rejects once the signal
    // aborts — this is what "fn is responsible for wiring the signal
    // through" (the module's own doc comment) means in practice.
    const fn = (signal: AbortSignal) =>
      new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      });

    await expect(withTimeout(fn, 30)).rejects.toThrow(TimeoutError);
  });

  it("aborts the signal passed to fn once the timeout fires", async () => {
    let receivedSignal: AbortSignal | undefined;
    const fn = (signal: AbortSignal) => {
      receivedSignal = signal;
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    };

    await expect(withTimeout(fn, 30)).rejects.toThrow(TimeoutError);
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("propagates fn's own error unchanged when it fails for a reason other than the timeout", async () => {
    await expect(
      withTimeout(() => Promise.reject(new Error("real failure")), 200),
    ).rejects.toThrow("real failure");
  });
});
