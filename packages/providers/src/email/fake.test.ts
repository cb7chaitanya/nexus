import { describe, expect, it, vi } from "vitest";

import { FakeEmailProvider } from "./fake.js";

describe("FakeEmailProvider", () => {
  it("logs the message instead of sending it", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const provider = new FakeEmailProvider();

    await provider.send({ to: "a@example.com", subject: "Your code", html: "<p>123456</p>", text: "123456" });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("a@example.com"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("123456"));
    logSpy.mockRestore();
  });
});
