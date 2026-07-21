import { createHash, randomBytes } from "node:crypto";

import { env } from "../env.js";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/** CSRF token for the redirect round trip — compared against the callback's `state` query param. */
export function generateState(): string {
  return randomBytes(32).toString("base64url");
}

/** PKCE code_verifier — 32 random bytes base64url-encoded (43 chars, within the spec's 43-128 range). */
export function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

/** PKCE code_challenge (S256 method): base64url(sha256(verifier)). */
export function codeChallengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function buildGoogleAuthUrl(params: { state: string; codeChallenge: string }): string {
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", env.GOOGLE_CLIENT_ID!);
  url.searchParams.set("redirect_uri", env.GOOGLE_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("access_type", "online");
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

interface GoogleTokenResponse {
  id_token: string;
}

/** Exchanges an authorization code for tokens, returning the ID token (the only one this app needs — no offline/refresh access requested). */
export async function exchangeGoogleCode(params: { code: string; codeVerifier: string }): Promise<string> {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: params.code,
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: env.GOOGLE_REDIRECT_URI,
      grant_type: "authorization_code",
      code_verifier: params.codeVerifier,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Google token exchange failed with status ${response.status}: ${body}`);
  }

  const payload = (await response.json()) as GoogleTokenResponse;
  return payload.id_token;
}
