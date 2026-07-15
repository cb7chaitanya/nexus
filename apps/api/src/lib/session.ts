import { randomUUID } from "node:crypto";

import { signSessionToken, verifySessionToken } from "@raas/auth";

import { env } from "../env.js";
import { redis } from "./redis.js";

const SESSION_KEY_PREFIX = "session:";

export interface CreatedSession {
  token: string;
  sessionId: string;
}

export interface AuthenticatedSession {
  userId: string;
  sessionId: string;
}

/**
 * Creates a session: a signed JWT (stateless, packages/auth) whose
 * validity ALSO depends on a Redis record (stateful, this module) —
 * that's what makes logout meaningful. A stolen/replayed JWT stops
 * working the moment the Redis record is deleted, even though its
 * signature and expiry would otherwise still check out.
 */
export async function createSession(userId: string): Promise<CreatedSession> {
  const sessionId = randomUUID();

  await redis.set(`${SESSION_KEY_PREFIX}${sessionId}`, userId, "EX", env.SESSION_TTL_SECONDS);

  const token = await signSessionToken(
    { sub: userId, sid: sessionId },
    { secret: env.SESSION_JWT_SECRET, ttlSeconds: env.SESSION_TTL_SECONDS },
  );

  return { token, sessionId };
}

/** Idempotent — deleting a key that's already gone is not an error. */
export async function destroySession(sessionId: string): Promise<void> {
  await redis.del(`${SESSION_KEY_PREFIX}${sessionId}`);
}

/**
 * The real authorization check: stateless signature+expiry verification
 * (packages/auth) AND a live Redis record for that session id. Both must
 * hold. Returns null rather than throwing for every "not authenticated"
 * outcome — the caller (the auth-guard preHandler) decides what that
 * means for the request, this function just answers the yes/no question.
 */
export async function resolveSession(token: string): Promise<AuthenticatedSession | null> {
  const result = await verifySessionToken(token, { secret: env.SESSION_JWT_SECRET });
  if (!result.valid) return null;

  const storedUserId = await redis.get(`${SESSION_KEY_PREFIX}${result.payload.sid}`);
  if (!storedUserId || storedUserId !== result.payload.sub) return null;

  return { userId: result.payload.sub, sessionId: result.payload.sid };
}
