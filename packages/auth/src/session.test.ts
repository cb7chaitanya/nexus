import { describe, expect, it } from "vitest";

import { isSessionTokenExpired } from "./expiry.js";
import { signSessionToken, verifySessionToken } from "./session.js";

const SECRET = "test-secret-do-not-use-in-real-env";

describe("signSessionToken / verifySessionToken round trip", () => {
  it("verifies a token it just signed", async () => {
    const token = await signSessionToken(
      { sub: "user-1", sid: "session-1" },
      { secret: SECRET, ttlSeconds: 3600 },
    );

    const result = await verifySessionToken(token, { secret: SECRET });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.payload.sub).toBe("user-1");
      expect(result.payload.sid).toBe("session-1");
      expect(result.payload.expiresAt.getTime()).toBeGreaterThan(Date.now());
    }
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signSessionToken(
      { sub: "user-1", sid: "session-1" },
      { secret: "wrong-secret", ttlSeconds: 3600 },
    );

    const result = await verifySessionToken(token, { secret: SECRET });

    expect(result).toEqual({ valid: false, reason: "invalid" });
  });

  it("rejects a tampered token (payload modified after signing)", async () => {
    const token = await signSessionToken(
      { sub: "user-1", sid: "session-1" },
      { secret: SECRET, ttlSeconds: 3600 },
    );
    const [header, , signature] = token.split(".");
    const forgedPayload = Buffer.from(JSON.stringify({ sub: "user-2", sid: "session-1" })).toString(
      "base64url",
    );
    const forgedToken = `${header}.${forgedPayload}.${signature}`;

    const result = await verifySessionToken(forgedToken, { secret: SECRET });

    expect(result).toEqual({ valid: false, reason: "invalid" });
  });

  it("rejects an expired token with a distinguishable reason", async () => {
    const token = await signSessionToken(
      { sub: "user-1", sid: "session-1" },
      { secret: SECRET, ttlSeconds: -1 },
    );

    const result = await verifySessionToken(token, { secret: SECRET });

    expect(result).toEqual({ valid: false, reason: "expired" });
  });

  it("rejects garbage input without throwing", async () => {
    const result = await verifySessionToken("not-a-jwt-at-all", { secret: SECRET });

    expect(result).toEqual({ valid: false, reason: "invalid" });
  });
});

describe("isSessionTokenExpired", () => {
  it("is false for a claim with exp in the future", () => {
    const claims = { exp: Math.floor(Date.now() / 1000) + 3600 };
    expect(isSessionTokenExpired(claims)).toBe(false);
  });

  it("is true for a claim with exp in the past", () => {
    const claims = { exp: Math.floor(Date.now() / 1000) - 3600 };
    expect(isSessionTokenExpired(claims)).toBe(true);
  });

  it("is true exactly at the expiry boundary (<=, not <)", () => {
    const now = new Date();
    const claims = { exp: Math.floor(now.getTime() / 1000) };
    expect(isSessionTokenExpired(claims, now)).toBe(true);
  });

  it("accepts an explicit `now` for deterministic testing", () => {
    const claims = { exp: 1000 };
    expect(isSessionTokenExpired(claims, new Date(999_000))).toBe(false);
    expect(isSessionTokenExpired(claims, new Date(1_000_000))).toBe(true);
  });
});
