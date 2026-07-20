// Fail fast on a missing security-critical env var rather than limping
// along and discovering it mid-request — same principle as
// packages/db/src/client.ts's refusal to silently fall back to the
// superuser role.

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. Refusing to start.`);
  }
  return value;
}

/** Fail fast on a misconfigured numeric env var rather than silently
 * shipping a NaN/zero/negative limit into a cost-control path — the same
 * "refuse to start" discipline requireEnv already applies to missing
 * secrets, extended to a value that IS set but nonsensical. */
function requirePositiveInt(name: string, rawValue: string | undefined, defaultValue: number): number {
  const value = rawValue === undefined ? defaultValue : Number(rawValue);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got: ${JSON.stringify(rawValue)}. Refusing to start.`);
  }
  return value;
}

export const env = {
  API_PORT: Number(process.env.API_PORT ?? 4000),
  API_HOST: process.env.API_HOST ?? "0.0.0.0",
  REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
  // CORS: apps/web and apps/api are separate origins in general (see
  // docs/cors-csrf-policy.md for the full policy) — exactly one origin
  // is allowed, with credentials, never a wildcard. Defaults to Next.js's
  // standard local dev port; production must set this explicitly.
  WEB_ORIGIN: process.env.WEB_ORIGIN ?? "http://localhost:3000",
  SESSION_JWT_SECRET: requireEnv("SESSION_JWT_SECRET"),
  SESSION_TTL_SECONDS: Number(process.env.SESSION_TTL_SECONDS ?? 60 * 60 * 24 * 7),
  S3_ENDPOINT: requireEnv("S3_ENDPOINT"),
  S3_REGION: process.env.S3_REGION ?? "us-east-1",
  S3_BUCKET: requireEnv("S3_BUCKET"),
  S3_ACCESS_KEY_ID: requireEnv("S3_ACCESS_KEY_ID"),
  S3_SECRET_ACCESS_KEY: requireEnv("S3_SECRET_ACCESS_KEY"),
  // MinIO/R2 need path-style addressing; real AWS S3 doesn't. Defaults to
  // path-style since MinIO is the common local/test case — set explicitly
  // to "false" for real S3 in prod.
  S3_FORCE_PATH_STYLE: process.env.S3_FORCE_PATH_STYLE !== "false",
  // "fake" is a real, documented provider choice (@raas/providers), not
  // just a test mock — see apps/worker/src/env.ts, which this mirrors.
  // Defaults to "openai" so a misconfigured production env fails loudly
  // (missing OPENAI_API_KEY) rather than silently answering with fake
  // embeddings/text.
  EMBEDDING_PROVIDER: (process.env.EMBEDDING_PROVIDER ?? "openai") as "openai" | "fake",
  OPENAI_EMBEDDING_BATCH_SIZE: Number(process.env.OPENAI_EMBEDDING_BATCH_SIZE ?? 100),
  FAKE_EMBEDDING_DELAY_MS: Number(process.env.FAKE_EMBEDDING_DELAY_MS ?? 0),
  LLM_PROVIDER: (process.env.LLM_PROVIDER ?? "openai") as "openai" | "fake",
  OPENAI_CHAT_MODEL: process.env.OPENAI_CHAT_MODEL ?? "gpt-4o-mini",
  // Hard per-request ceiling on completion output tokens (see
  // @raas/providers's OpenAIChatProvider) — the daily chat token budget
  // below can only reject the NEXT request once a prior one has already
  // gone over; this bounds what any single request can cost regardless of
  // budget state. 1024 is generous for a citation-grounded chat answer
  // (architecture.md §4.7) while still being a real ceiling, not a
  // nominal one.
  MAX_COMPLETION_TOKENS: requirePositiveInt("MAX_COMPLETION_TOKENS", process.env.MAX_COMPLETION_TOKENS, 1024),
  FAKE_LLM_DELAY_MS: Number(process.env.FAKE_LLM_DELAY_MS ?? 0),
  // Required unless BOTH providers are set to "fake" — either provider
  // being "openai" means a real key is load-bearing.
  OPENAI_API_KEY:
    process.env.EMBEDDING_PROVIDER === "fake" && process.env.LLM_PROVIDER === "fake" ? (process.env.OPENAI_API_KEY ?? "") : requireEnv("OPENAI_API_KEY"),
  // Rate limiting (packages/rate-limit). The auth default here is
  // deliberately higher than the ticket's own "10/minute/IP" example —
  // every apps.inject() test request in this suite shares one apparent
  // IP (127.0.0.1), and app.ts's trustProxy setting means that's the
  // real key these limits are checked against. A real deployment behind
  // a reverse proxy sees real per-client IPs and should set this via env
  // to something much closer to the ticket's example.
  RATE_LIMIT_AUTH_MAX: Number(process.env.RATE_LIMIT_AUTH_MAX ?? 50),
  RATE_LIMIT_AUTH_WINDOW_SECONDS: Number(process.env.RATE_LIMIT_AUTH_WINDOW_SECONDS ?? 60),
  RATE_LIMIT_CHAT_ORG_RPM: Number(process.env.RATE_LIMIT_CHAT_ORG_RPM ?? 30),
  RATE_LIMIT_CHAT_USER_RPM: Number(process.env.RATE_LIMIT_CHAT_USER_RPM ?? 20),
  // Org-scoped, not per-user — matches how usage/billing is tracked
  // everywhere else in this schema (UsageEvent.organizationId is the
  // primary dimension; userId is auxiliary).
  RATE_LIMIT_CHAT_TOKEN_BUDGET_DAILY: Number(process.env.RATE_LIMIT_CHAT_TOKEN_BUDGET_DAILY ?? 200_000),
  // Ingestion path (POST /kb, POST /kb/:id/documents/presign, POST
  // /documents/:id/complete) — org-scoped RPM, same shape as chat's own
  // org limit, guarding against burst abuse independent of the daily
  // document/embedding-token ceilings below.
  RATE_LIMIT_INGESTION_ORG_RPM: Number(process.env.RATE_LIMIT_INGESTION_ORG_RPM ?? 20),
  // Platform-wide defaults for OrganizationUsageLimit's three ceilings,
  // used whenever an org has no override row (see @raas/usage's
  // getOrganizationDailyLimit) — most orgs run on these.
  RATE_LIMIT_DOCUMENT_QUOTA_DAILY_DEFAULT: Number(process.env.RATE_LIMIT_DOCUMENT_QUOTA_DAILY_DEFAULT ?? 200),
  RATE_LIMIT_EMBEDDING_TOKEN_BUDGET_DAILY_DEFAULT: Number(process.env.RATE_LIMIT_EMBEDDING_TOKEN_BUDGET_DAILY_DEFAULT ?? 2_000_000),
  // How many prior turns (user+assistant pairs) are loaded as
  // conversation history and replayed into the prompt.
  CHAT_HISTORY_MESSAGE_LIMIT: Number(process.env.CHAT_HISTORY_MESSAGE_LIMIT ?? 20),
  // DELETE /kb/:id: a KB with more chunks than this gets an async
  // cleanup job (see lib/kb-cleanup.ts) instead of an inline
  // cascade-delete — cascading tens of thousands of rows plus their S3
  // objects inside one HTTP request risks a request timeout and a long-
  // held transaction. Below the threshold, deletion happens synchronously
  // and returns 204 immediately.
  KB_DELETION_ASYNC_CHUNK_THRESHOLD: Number(process.env.KB_DELETION_ASYNC_CHUNK_THRESHOLD ?? 5000),
  // How long SIGTERM/SIGINT waits for Fastify's close() to finish on its
  // own — i.e. for every open connection, including a hijacked, actively
  // streaming SSE response from POST /kb/:id/chat, to end — before giving
  // up and exiting anyway (see lib/shutdown.ts). Bounded so this process
  // always terminates on its own within a known window rather than
  // relying on the orchestrator's SIGKILL grace period (Docker's default
  // is 10s, comfortably shorter than a real chat generation can take) to
  // end it uncleanly. Same default and reasoning as apps/worker's own
  // WORKER_SHUTDOWN_TIMEOUT_MS — keep this comfortably below whatever
  // stop_grace_period is actually configured in production.
  API_SHUTDOWN_TIMEOUT_MS: requirePositiveInt("API_SHUTDOWN_TIMEOUT_MS", process.env.API_SHUTDOWN_TIMEOUT_MS, 25_000),
  NODE_ENV: process.env.NODE_ENV ?? "development",
  // Optional (see lib/sentry.ts's initSentry) — unset leaves
  // @raas/observability's captureException calls going to
  // NoopErrorTracker, exactly as before Sentry was wired up. Never
  // required: error tracking is an operational nice-to-have, not
  // load-bearing for this process to start and serve traffic.
  SENTRY_DSN: process.env.SENTRY_DSN,
};
