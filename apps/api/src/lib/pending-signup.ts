import { randomUUID } from "node:crypto";

import { env } from "../env.js";
import { generateOtp, hashOtp } from "./otp.js";
import { redis } from "./redis.js";

const PENDING_SIGNUP_KEY_PREFIX = "signup:pending:";

export interface PendingSignupData {
  email: string;
  passwordHash: string;
  name?: string;
  organizationName: string;
  organizationSlug?: string;
}

export interface PendingSignupRecord extends PendingSignupData {
  hashedOtp: string;
  attempts: number;
}

function key(pendingSignupId: string): string {
  return `${PENDING_SIGNUP_KEY_PREFIX}${pendingSignupId}`;
}

/**
 * Pending (unconfirmed) signups live entirely in Redis, not Postgres —
 * unlike OrganizationInvite, the User row this eventually creates
 * doesn't exist yet, so there's nothing a Postgres table could FK
 * against. This also means an abandoned/mistyped signup just expires
 * (TTL) and vanishes instead of permanently occupying the unique `email`
 * constraint the way a pre-created-but-unverified User row would.
 */
export async function createPendingSignup(data: PendingSignupData): Promise<{ pendingSignupId: string; otp: string }> {
  const pendingSignupId = randomUUID();
  const otp = generateOtp();
  const record: PendingSignupRecord = { ...data, hashedOtp: hashOtp(otp), attempts: 0 };
  await redis.set(key(pendingSignupId), JSON.stringify(record), "EX", env.SIGNUP_OTP_TTL_SECONDS);
  return { pendingSignupId, otp };
}

export async function getPendingSignup(pendingSignupId: string): Promise<PendingSignupRecord | null> {
  const raw = await redis.get(key(pendingSignupId));
  return raw ? (JSON.parse(raw) as PendingSignupRecord) : null;
}

/** Records a wrong-code guess without resetting the pending signup's remaining TTL. */
export async function recordFailedAttempt(pendingSignupId: string, record: PendingSignupRecord): Promise<void> {
  const remainingTtl = await redis.ttl(key(pendingSignupId));
  if (remainingTtl <= 0) return; // expired between the read and this write — nothing to update
  const updated: PendingSignupRecord = { ...record, attempts: record.attempts + 1 };
  await redis.set(key(pendingSignupId), JSON.stringify(updated), "EX", remainingTtl);
}

/** New code, reset attempts, fresh full TTL — used by resend. */
export async function refreshOtp(pendingSignupId: string, record: PendingSignupRecord): Promise<{ otp: string }> {
  const otp = generateOtp();
  const updated: PendingSignupRecord = { ...record, hashedOtp: hashOtp(otp), attempts: 0 };
  await redis.set(key(pendingSignupId), JSON.stringify(updated), "EX", env.SIGNUP_OTP_TTL_SECONDS);
  return { otp };
}

export async function consumePendingSignup(pendingSignupId: string): Promise<void> {
  await redis.del(key(pendingSignupId));
}
