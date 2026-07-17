import { createRateLimiter } from "@raas/rate-limit";
import { ApiError } from "@raas/shared";
import type { FastifyReply, FastifyRequest } from "fastify";

import { env } from "../env.js";
import { redis } from "./redis.js";

const rateLimiter = createRateLimiter(redis);

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

/**
 * Pre-flight check: is this organization already over its daily token
 * budget from prior usage? Read-only (peekLimit, not checkLimit) — the
 * actual token cost of THIS request is only known after generation
 * completes (see recordChatTokenUsage below), so it can't be charged in
 * advance. This only blocks NEW requests once a prior request has already
 * pushed the org over budget; the request that crosses the line is itself
 * unavoidably let through, since nobody knew its cost yet. An honest
 * limitation of metering something you can't measure until after the
 * fact, not a bug.
 */
export async function checkChatTokenBudget(organizationId: string, reply: FastifyReply): Promise<void> {
  const result = await rateLimiter.peekLimit({
    identifier: `chat:org:${organizationId}:tokens:daily`,
    limit: env.RATE_LIMIT_CHAT_TOKEN_BUDGET_DAILY,
    window: 86_400,
  });
  applyHeaders(reply, result);
  if (!result.allowed) {
    throw ApiError.rateLimited("This organization has exceeded its daily token budget");
  }
}

/**
 * Records actual token usage against the daily budget counter, after
 * generation completes. Never throws on the budget being exceeded — the
 * tokens are already spent by the time this runs; it only affects
 * whether the NEXT request's checkChatTokenBudget call is blocked.
 */
export async function recordChatTokenUsage(organizationId: string, totalTokens: number): Promise<void> {
  if (totalTokens <= 0) return;
  await rateLimiter.checkLimit({
    identifier: `chat:org:${organizationId}:tokens:daily`,
    limit: env.RATE_LIMIT_CHAT_TOKEN_BUDGET_DAILY,
    window: 86_400,
    amount: totalTokens,
  });
}
