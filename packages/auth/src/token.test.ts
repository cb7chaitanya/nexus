import { describe, expect, it } from "vitest";

import { decodeSessionToken, parseBearerToken } from "./token.js";
import { signSessionToken } from "./session.js";

describe("parseBearerToken", () => {
  it("extracts the token from a well-formed Authorization header", () => {
    expect(parseBearerToken("Bearer abc.def.ghi")).toBe("abc.def.ghi");
  });

  it("is case-insensitive on the Bearer scheme", () => {
    expect(parseBearerToken("bearer abc.def.ghi")).toBe("abc.def.ghi");
  });

  it("returns null for a missing header", () => {
    expect(parseBearerToken(undefined)).toBeNull();
  });

  it("returns null for a header without the Bearer scheme", () => {
    expect(parseBearerToken("abc.def.ghi")).toBeNull();
    expect(parseBearerToken("Basic abc123")).toBeNull();
  });

  it("takes the first value when given an array (duplicate headers)", () => {
    expect(parseBearerToken(["Bearer first", "Bearer second"])).toBe("first");
  });
});

describe("decodeSessionToken", () => {
  it("decodes a well-formed token's claims without verifying the signature", async () => {
    const token = await signSessionToken(
      { sub: "user-1", sid: "session-1" },
      { secret: "test-secret", ttlSeconds: 3600 },
    );

    const claims = decodeSessionToken(token);

    expect(claims?.sub).toBe("user-1");
    expect(claims?.sid).toBe("session-1");
    expect(typeof claims?.exp).toBe("number");
  });

  it("decodes correctly even when signed with a DIFFERENT secret — this is structural parsing, not verification", async () => {
    const token = await signSessionToken(
      { sub: "user-1", sid: "session-1" },
      { secret: "some-other-secret", ttlSeconds: 3600 },
    );

    expect(decodeSessionToken(token)?.sub).toBe("user-1");
  });

  it("returns null for garbage input rather than throwing", () => {
    expect(decodeSessionToken("not-a-jwt")).toBeNull();
    expect(decodeSessionToken("")).toBeNull();
    expect(decodeSessionToken("a.b.c")).toBeNull();
  });

  it("returns null for a well-formed JWT missing the claims this package expects", async () => {
    // A structurally valid JWT (base64url header.payload.signature) that
    // just doesn't carry sub/sid/iat/exp.
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ foo: "bar" })).toString("base64url");
    expect(decodeSessionToken(`${header}.${payload}.`)).toBeNull();
  });
});
