import { createRateLimiter } from "@raas/rate-limit";
import { ApiError } from "@raas/shared";
import { checkAndConsumeDailyBudget, getOrganizationDailyLimit, reserveDailyBudget, settleDailyBudget } from "@raas/usage";
import type { FastifyReply, FastifyRequest } from "fastify";

import { env } from "../env.js";
import { redis } from "./redis.js";

export const rateLimiter = createRateLimiter(redis);

// Writes directly to the underlying Node response (reply.raw) rather
// than through Fastify's reply.header() — chat.ts's SSE path later calls
// reply.raw.writeHead() manually (after reply.hijack()), which bypasses
// Fastify's own send lifecycle entirely, so headers queued via
// reply.header() would never actually get flushed onto the response.
// Node's response.writeHead(status, headers) documents that it MERGES
// with anything already set via response.setHeader() — so setting these
// here and letting chat.ts's later writeHead() call add its own
// Content-Type/etc. on top works correctly for both the hijacked SSE
// path and the normal (auth endpoints') Fastify-managed response.
function applyHeaders(reply: FastifyReply, result: { limit: number; remaining: number; retryAfterSeconds: number }): void {
  reply.raw.setHeader("X-RateLimit-Limit", String(result.limit));
  reply.raw.setHeader("X-RateLimit-Remaining", String(result.remaining));
  if (result.retryAfterSeconds > 0) {
    reply.raw.setHeader("Retry-After", String(result.retryAfterSeconds));
  }
}

/**
 * IP-based limit for POST /auth/login and POST /auth/signup — the
 * anti-credential-stuffing mitigation named in docs/decisions.md's risk
 * list. Relies on app.ts's trustProxy setting for request.ip to reflect
 * the real client IP behind a reverse proxy in production; falls back to
 * the raw socket address otherwise (fine for local dev).
 */
export async function authRateLimit(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const result = await rateLimiter.checkLimit({
    identifier: `auth:${request.ip}`,
    limit: env.RATE_LIMIT_AUTH_MAX,
    window: env.RATE_LIMIT_AUTH_WINDOW_SECONDS,
  });
  applyHeaders(reply, result);
  if (!result.allowed) {
    throw ApiError.rateLimited("Too many authentication attempts — try again later");
  }
}

export interface ChatRateLimitCheck {
  organizationId: string;
  userId: string;
}

/**
 * Per-organization and per-user requests/minute for POST /kb/:id/chat.
 * No per-API-key dimension: this codebase has no API-key auth path yet
 * (see docs/decisions.md's non-goals list), so there's nothing to key
 * that dimension off of. Adding it once API keys exist is additive to
 * this function, not a redesign of it.
 */
export async function checkChatRateLimit(check: ChatRateLimitCheck, reply: FastifyReply): Promise<void> {
  const orgResult = await rateLimiter.checkLimit({
    identifier: `chat:org:${check.organizationId}:rpm`,
    limit: env.RATE_LIMIT_CHAT_ORG_RPM,
    window: 60,
  });
  const userResult = await rateLimiter.checkLimit({
    identifier: `chat:user:${check.userId}:rpm`,
    limit: env.RATE_LIMIT_CHAT_USER_RPM,
    window: 60,
  });

  // Headers describe whichever limit is closer to being exhausted — the
  // one a client would actually need to back off against.
  const tightest = orgResult.remaining <= userResult.remaining ? orgResult : userResult;
  applyHeaders(reply, tightest);

  if (!orgResult.allowed) {
    throw ApiError.rateLimited("This organization has exceeded its chat request rate limit");
  }
  if (!userResult.allowed) {
    throw ApiError.rateLimited("You have exceeded your chat request rate limit");
  }
}

export interface ChatTokenReservation {
  /** Exactly the amount that was reserved — 0 is never returned here,
   * since a rejected reservation throws instead (see below). Threaded
   * back into settleChatTokenUsage once real usage is known. */
  reserved: number;
}

/**
 * Atomically reserves `estimatedAmount` against the organization's daily
 * chat-token budget BEFORE generation starts, and rejects (429) if that
 * reservation alone would push the org over budget — replaces the old
 * peek-then-record design (a read-only peekLimit check before
 * generation, an unconditional record after), which let any number of
 * concurrent requests all pass the same stale peek before a single one
 * of them had recorded real usage: an org could run arbitrarily far past
 * its nominal daily ceiling for as long as requests kept starting faster
 * than earlier ones finished and recorded (see @raas/usage's
 * reserveDailyBudget for why this needed a genuinely atomic primitive,
 * not just moving the same check earlier).
 *
 * The org's ceiling comes from its OrganizationUsageLimit row when one
 * exists, falling back to RATE_LIMIT_CHAT_TOKEN_BUDGET_DAILY otherwise —
 * unchanged from the old design. Must be settled exactly once via
 * settleChatTokenUsage below, on every exit path — see chat.ts.
 */
export async function reserveChatTokenBudget(organizationId: string, estimatedAmount: number, reply: FastifyReply): Promise<ChatTokenReservation> {
  const limit = await getOrganizationDailyLimit(organizationId, "maxChatTokensPerDay", env.RATE_LIMIT_CHAT_TOKEN_BUDGET_DAILY);
  const result = await reserveDailyBudget({
    rateLimiter,
    organizationId,
    dimension: "chat-tokens",
    amount: estimatedAmount,
    limit,
    rejectionMessage: "This organization has exceeded its daily token budget",
  });
  applyHeaders(reply, result);
  return { reserved: result.reserved };
}

/**
 * Settles a prior reserveChatTokenBudget reservation against the real
 * token count once generation has finished — successfully, or by
 * failing partway through; either way the caller (chat.ts) always has
 * *some* real-or-estimated total by the time this runs. Tops the
 * reservation up if actual usage exceeded it, refunds the unused portion
 * otherwise, and is a no-op if the reservation happened to be exact.
 * Never throws — the request's response has typically already been sent
 * by the time this runs, so a transient Redis failure here must not fail
 * the request; the caller logs instead (see chat.ts).
 */
export async function settleChatTokenUsage(organizationId: string, reservedAmount: number, actualAmount: number): Promise<void> {
  await settleDailyBudget({ rateLimiter, organizationId, dimension: "chat-tokens", delta: actualAmount - reservedAmount });
}

/**
 * Org-scoped RPM for the ingestion path (POST /kb, POST
 * /kb/:id/documents/presign, POST /documents/:id/complete) — the same
 * shape as checkChatRateLimit's org dimension, just without a per-user
 * dimension (the ticket that added this only asked for org-scoped
 * limits on these routes). No per-API-key dimension for the same reason
 * checkChatRateLimit has none: there is no API-key auth path yet.
 */
export async function checkIngestionRateLimit(organizationId: string, reply: FastifyReply): Promise<void> {
  const result = await rateLimiter.checkLimit({
    identifier: `ingestion:org:${organizationId}:rpm`,
    limit: env.RATE_LIMIT_INGESTION_ORG_RPM,
    window: 60,
  });
  applyHeaders(reply, result);
  if (!result.allowed) {
    throw ApiError.rateLimited("This organization has exceeded its ingestion request rate limit");
  }
}

/**
 * Daily ceiling on documents actually queued for processing — checked at
 * POST /documents/:id/complete (the point where the pipeline, and its
 * real OpenAI embedding cost, is actually triggered), not at presign
 * (which only creates a PENDING_UPLOAD row and costs nothing). Unlike the
 * chat token budget, a document's cost to this counter is always exactly
 * 1 and known up front, so this consumes immediately via
 * checkAndConsumeDailyBudget rather than peeking then recording later.
 */
export async function checkDocumentQuota(organizationId: string, reply: FastifyReply): Promise<void> {
  const limit = await getOrganizationDailyLimit(organizationId, "maxDocumentsPerDay", env.RATE_LIMIT_DOCUMENT_QUOTA_DAILY_DEFAULT);
  const result = await checkAndConsumeDailyBudget({
    rateLimiter,
    organizationId,
    dimension: "documents",
    limit,
    amount: 1,
    rejectionMessage: "This organization has exceeded its daily document processing quota",
  });
  applyHeaders(reply, result);
}
