import type { SessionTokenClaims } from "./token.js";

/**
 * Pure expiry check against a decoded (unverified) token's `exp` claim.
 * Deliberately takes `now` as an explicit parameter (defaulting to the
 * real clock) so this is trivially testable without mocking global time.
 *
 * This is a UX-only signal on its own (e.g. "don't bother calling the API,
 * redirect to login immediately" from an unverified, client-decoded
 * token) — it is not, by itself, an authorization decision. A token that
 * passes this check might still fail signature verification; a real
 * access decision always goes through verifySessionToken.
 */
export function isSessionTokenExpired(claims: Pick<SessionTokenClaims, "exp">, now = new Date()): boolean {
  return claims.exp * 1000 <= now.getTime();
}
