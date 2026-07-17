import { describe, expect, it, vi } from "vitest";

import { CircuitBreaker, CircuitBreakerOpenError } from "./circuit-breaker.js";

describe("CircuitBreaker", () => {
  it("starts closed and lets calls through", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000 });
    const result = await breaker.execute(() => Promise.resolve("ok"));
    expect(result).toBe("ok");
    expect(breaker.getState()).toBe("closed");
  });

  it("stays closed on failures below the threshold", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000 });
    for (let i = 0; i < 2; i++) {
      await expect(breaker.execute(() => Promise.reject(new Error("fail")))).rejects.toThrow("fail");
    }
    expect(breaker.getState()).toBe("closed");
  });

  it("opens after reaching the failure threshold and rejects immediately without calling fn", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 10_000 });
    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(() => Promise.reject(new Error("fail")))).rejects.toThrow("fail");
    }
    expect(breaker.getState()).toBe("open");

    const fn = vi.fn().mockResolvedValue("should not run");
    await expect(breaker.execute(fn)).rejects.toThrow(CircuitBreakerOpenError);
    expect(fn).not.toHaveBeenCalled();
  });

  it("a success resets the consecutive-failure count", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000 });
    await expect(breaker.execute(() => Promise.reject(new Error("fail")))).rejects.toThrow();
    await expect(breaker.execute(() => Promise.reject(new Error("fail")))).rejects.toThrow();
    await breaker.execute(() => Promise.resolve("ok"));
    // Two more failures (not three) after a reset — still below threshold.
    await expect(breaker.execute(() => Promise.reject(new Error("fail")))).rejects.toThrow();
    await expect(breaker.execute(() => Promise.reject(new Error("fail")))).rejects.toThrow();
    expect(breaker.getState()).toBe("closed");
  });

  it("allows one trial call after the cooldown elapses (half-open), and closes on success", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 20 });
    await expect(breaker.execute(() => Promise.reject(new Error("fail")))).rejects.toThrow();
    expect(breaker.getState()).toBe("open");

    await new Promise((resolve) => setTimeout(resolve, 30));

    const result = await breaker.execute(() => Promise.resolve("recovered"));
    expect(result).toBe("recovered");
    expect(breaker.getState()).toBe("closed");
  });

  it("a half-open trial that fails reopens the circuit with a fresh cooldown", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 20 });
    await expect(breaker.execute(() => Promise.reject(new Error("fail 1")))).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 30));

    await expect(breaker.execute(() => Promise.reject(new Error("fail 2")))).rejects.toThrow("fail 2");
    expect(breaker.getState()).toBe("open");

    const fn = vi.fn();
    await expect(breaker.execute(fn)).rejects.toThrow(CircuitBreakerOpenError);
    expect(fn).not.toHaveBeenCalled();
  });
});
