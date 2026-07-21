import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { codeChallengeFor, generateCodeVerifier, generateState } from "./google-oauth.js";

describe("google-oauth PKCE/state helpers", () => {
  it("generates high-entropy, unique state values", () => {
    const a = generateState();
    const b = generateState();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
  });

  it("generates a code_verifier within the PKCE spec's length range (43-128 chars)", () => {
    const verifier = generateCodeVerifier();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
  });

  it("derives the S256 code_challenge deterministically from a verifier", () => {
    const verifier = "test-verifier-value";
    const expected = createHash("sha256").update(verifier).digest("base64url");

    expect(codeChallengeFor(verifier)).toBe(expected);
    expect(codeChallengeFor(verifier)).toBe(codeChallengeFor(verifier));
  });
});
