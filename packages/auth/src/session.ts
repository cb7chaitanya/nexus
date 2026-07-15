import { errors, jwtVerify, SignJWT } from "jose";

export interface SessionTokenPayload {
  /** userId */
  sub: string;
  /** session id — apps/api's Redis key for this session. Opaque to this package. */
  sid: string;
}

export interface VerifiedSessionToken extends SessionTokenPayload {
  issuedAt: Date;
  expiresAt: Date;
}

export type VerifySessionTokenResult =
  | { valid: true; payload: VerifiedSessionToken }
  | { valid: false; reason: "expired" | "invalid" };

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

/**
 * Signs a session token. Pure function of (payload, secret, ttl) — no I/O,
 * no database, no Redis. Stateful session bookkeeping (creating the
 * revocable Redis record this token's `sid` points at) is apps/api's job,
 * not this package's — see apps/api/src/lib/session.ts.
 */
export async function signSessionToken(
  payload: SessionTokenPayload,
  options: { secret: string; ttlSeconds: number },
): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000);

  return new SignJWT({ sid: payload.sid })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.sub)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + options.ttlSeconds)
    .sign(secretKey(options.secret));
}

/**
 * Verifies a session token's signature and expiry — the real, security-
 * relevant check (unlike decodeSessionToken in token.ts, which trusts
 * nothing it's given). Still stateless: this only proves the token was
 * signed by us and hasn't expired. It says nothing about whether the
 * session has since been revoked (logout) — that's a Redis lookup keyed
 * by the returned `sid`, which is apps/api's responsibility, deliberately
 * kept out of this package.
 */
export async function verifySessionToken(
  token: string,
  options: { secret: string },
): Promise<VerifySessionTokenResult> {
  try {
    const { payload } = await jwtVerify(token, secretKey(options.secret), {
      algorithms: ["HS256"],
    });

    if (typeof payload.sub !== "string" || typeof payload.sid !== "string") {
      return { valid: false, reason: "invalid" };
    }

    return {
      valid: true,
      payload: {
        sub: payload.sub,
        sid: payload.sid,
        issuedAt: new Date((payload.iat ?? 0) * 1000),
        expiresAt: new Date((payload.exp ?? 0) * 1000),
      },
    };
  } catch (err) {
    if (err instanceof errors.JWTExpired) {
      return { valid: false, reason: "expired" };
    }
    return { valid: false, reason: "invalid" };
  }
}
