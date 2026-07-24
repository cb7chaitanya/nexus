import type { FastifyReply } from "fastify";

import { SESSION_COOKIE_NAME } from "../plugins/auth-guard.js";
import { env } from "../env.js";

export function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    // Unset (default) means host-only — correct when apps/web and
    // apps/api share the exact same hostname (local dev: both on
    // "localhost", just different ports — cookies aren't port-scoped, so
    // this already works with no Domain attribute at all). Deployments
    // that split web/api across sibling/parent-child subdomains (e.g.
    // web on app.example.com, api on api.app.example.com) MUST set this
    // to the shared parent (here, app.example.com) — otherwise apps/web's
    // own server-side session check (getServerSession, which reads
    // cookies sent to ITS OWN host) never sees a cookie that was scoped
    // only to the API's host, even though direct browser->API calls work
    // fine. A cookie's Domain can only be set to the response host itself
    // or one of its parent domains, never a sibling or child — so this
    // only works when the API host is (or is under) the web host, not the
    // other way around or unrelated domains entirely.
    domain: env.SESSION_COOKIE_DOMAIN,
    maxAge: env.SESSION_TTL_SECONDS,
  });
  clearStaleHostOnlyCookie(reply);
}

export function clearSessionCookie(reply: FastifyReply): void {
  // Must match the original Set-Cookie's Domain exactly, or the browser
  // treats this as clearing a different (host-only) cookie and leaves the
  // real, domain-scoped session cookie behind.
  reply.clearCookie(SESSION_COOKIE_NAME, { path: "/", domain: env.SESSION_COOKIE_DOMAIN });
  clearStaleHostOnlyCookie(reply);
}

// Before SESSION_COOKIE_DOMAIN existed, this cookie was always host-only.
// Anyone who logged in before that shipped and has since authenticated
// again (without a full manual browser cookie clear) can be carrying BOTH
// the old host-only cookie and the new domain-scoped one at once — sent
// together on every request, with whichever one the server happens to
// read determined by cookie ordering, not anything meaningful. That's
// what makes auth state flip unpredictably between requests for exactly
// these "old" sessions. Hooked into both set and clear so any affected
// user gets cleaned up the moment they next log in, sign up, or log out —
// no separate migration needed. Only relevant when SESSION_COOKIE_DOMAIN
// is actually set — clearing a host-only cookie when it's unset would
// delete the very cookie setSessionCookie just set above, since an unset
// SESSION_COOKIE_DOMAIN means host-only IS the current, correct shape.
function clearStaleHostOnlyCookie(reply: FastifyReply): void {
  if (!env.SESSION_COOKIE_DOMAIN) return;
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
