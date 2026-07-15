import { decodeJwt } from "jose";

export interface SessionTokenClaims {
  /** userId */
  sub: string;
  /** session id — the Redis key apps/api uses for stateful revocation. This package never touches Redis itself. */
  sid: string;
  /** issued-at, unix seconds */
  iat: number;
  /** expiry, unix seconds */
  exp: number;
}

/**
 * Extracts the raw token string from an `Authorization: Bearer <token>`
 * header. Pure string parsing, no verification — this is "is there
 * something here that looks like a token", not "is it valid".
 */
export function parseBearerToken(headerValue: string | string[] | undefined): string | null {
  const value = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (!value) return null;

  const match = /^Bearer\s+(\S+)$/i.exec(value.trim());
  return match?.[1] ?? null;
}

/**
 * Decodes a session token's claims WITHOUT verifying its signature. This
 * is structural parsing only — never use this result for an authorization
 * decision, it tells you what a token *claims*, not whether that claim is
 * genuine. Use verifySessionToken (session.ts) for anything that gates
 * access. This exists for cheap, non-security-critical reads: is this
 * even shaped like one of our tokens, what does it claim its expiry is.
 *
 * Returns null if the token isn't well-formed JWT with the claims this
 * package expects (malformed input should never throw here — decoding
 * garbage is an expected, ordinary case, not an exceptional one).
 */
export function decodeSessionToken(token: string): SessionTokenClaims | null {
  let claims: Record<string, unknown>;
  try {
    claims = decodeJwt(token);
  } catch {
    return null;
  }

  if (
    typeof claims.sub !== "string" ||
    typeof claims.sid !== "string" ||
    typeof claims.iat !== "number" ||
    typeof claims.exp !== "number"
  ) {
    return null;
  }

  return { sub: claims.sub, sid: claims.sid, iat: claims.iat, exp: claims.exp };
}
