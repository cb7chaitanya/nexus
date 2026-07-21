import type { FastifyReply } from "fastify";

import { SESSION_COOKIE_NAME } from "../plugins/auth-guard.js";
import { env } from "../env.js";

export function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: env.SESSION_TTL_SECONDS,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
}

export const GOOGLE_OAUTH_STATE_COOKIE = "google_oauth_state";
export const GOOGLE_OAUTH_VERIFIER_COOKIE = "google_oauth_verifier";
export const GOOGLE_OAUTH_NEXT_COOKIE = "google_oauth_next";
// Just long enough for a human to complete Google's consent screen —
// unlike the session cookie, these carry no identity, only CSRF/PKCE
// material (and where to send the browser back to) for the one redirect
// round trip.
const GOOGLE_OAUTH_COOKIE_MAX_AGE_SECONDS = 600;

export function setGoogleOAuthCookies(reply: FastifyReply, params: { state: string; codeVerifier: string; next?: string }): void {
  const attrs = {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: GOOGLE_OAUTH_COOKIE_MAX_AGE_SECONDS,
  };
  reply.setCookie(GOOGLE_OAUTH_STATE_COOKIE, params.state, attrs);
  reply.setCookie(GOOGLE_OAUTH_VERIFIER_COOKIE, params.codeVerifier, attrs);
  if (params.next) {
    reply.setCookie(GOOGLE_OAUTH_NEXT_COOKIE, params.next, attrs);
  }
}

export function clearGoogleOAuthCookies(reply: FastifyReply): void {
  reply.clearCookie(GOOGLE_OAUTH_STATE_COOKIE, { path: "/" });
  reply.clearCookie(GOOGLE_OAUTH_VERIFIER_COOKIE, { path: "/" });
  reply.clearCookie(GOOGLE_OAUTH_NEXT_COOKIE, { path: "/" });
}
