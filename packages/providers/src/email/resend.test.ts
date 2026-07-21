import { describe, expect, it, vi } from "vitest";

import { ResendEmailError, ResendEmailProvider } from "./resend.js";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

const PARAMS = { to: "a@example.com", subject: "Your code", html: "<p>123456</p>", text: "123456" };

describe("ResendEmailProvider", () => {
  it("sends successfully on a 200", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { id: "email_123" }));
    const provider = new ResendEmailProvider({ apiKey: "re_test", from: "Nexus <noreply@example.com>", fetchImpl });

    await provider.send(PARAMS);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(JSON.parse(init.body as string)).toMatchObject({ to: ["a@example.com"], subject: "Your code" });
  });

  it("retries on a 429 and eventually succeeds, honoring Retry-After", async () => {
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { error: "rate limited" }, { "retry-after": "2" }))
      .mockResolvedValueOnce(jsonResponse(200, { id: "email_123" }));
    const provider = new ResendEmailProvider({ apiKey: "re_test", from: "Nexus <noreply@example.com>", fetchImpl, sleepImpl });

    await provider.send(PARAMS);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleepImpl).toHaveBeenCalledWith(2000);
  });

  it("does not retry a non-retryable 400 and fails immediately", async () => {
    const sleepImpl = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(400, { error: "invalid request" }));
    const provider = new ResendEmailProvider({ apiKey: "re_test", from: "Nexus <noreply@example.com>", fetchImpl, sleepImpl });

    await expect(provider.send(PARAMS)).rejects.toThrow(ResendEmailError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleepImpl).not.toHaveBeenCalled();
  });

  it("gives up after exhausting the retry budget on persistent 5xx errors", async () => {
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(503, { error: "unavailable" }));
    const provider = new ResendEmailProvider({
      apiKey: "re_test",
      from: "Nexus <noreply@example.com>",
      fetchImpl,
      sleepImpl,
      maxRetries: 2,
    });

    await expect(provider.send(PARAMS)).rejects.toThrow(ResendEmailError);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
