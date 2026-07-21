import { createRemoteJWKSet, jwtVerify } from "jose";

const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUER = "https://accounts.google.com";

// Cached per process — createRemoteJWKSet itself already caches the
// fetched key set internally (and handles rotation), so this is just
// avoiding re-constructing the fetcher on every verification call.
let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
function getGoogleJwks(): ReturnType<typeof createRemoteJWKSet> {
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
  }
  return jwks;
}

export interface GoogleIdTokenClaims {
  /** Google's stable per-user identifier — never the email (which can change). */
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
}

/**
 * Verifies a Google-issued ID token's signature (against Google's own
 * published JWKS), issuer, and audience — the real proof that this token
 * came from Google and was minted for this app's client id, not a
 * caller-supplied claim to trust blindly. apps/api's Google OAuth
 * callback is the only caller.
 */
export async function verifyGoogleIdToken(idToken: string, options: { clientId: string }): Promise<GoogleIdTokenClaims> {
  const { payload } = await jwtVerify(idToken, getGoogleJwks(), {
    issuer: GOOGLE_ISSUER,
    audience: options.clientId,
  });

  if (typeof payload.sub !== "string" || typeof payload.email !== "string") {
    throw new Error("Google ID token is missing required claims (sub/email)");
  }

  return {
    sub: payload.sub,
    email: payload.email,
    emailVerified: payload.email_verified === true,
    name: typeof payload.name === "string" ? payload.name : null,
  };
}
