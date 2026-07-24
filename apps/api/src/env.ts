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

// Resolved once, with the same defaults their own env fields below use —
// referenced by both the provider fields themselves and by
// OPENAI_API_KEY/GROQ_API_KEY's requiredness checks further down, so
// "unset" and "explicitly set to the default value" are never treated
// differently (a plain `process.env.X === "openai"` check would miss the
// unset-defaults-to-openai case).
const resolvedEmbeddingProvider = (process.env.EMBEDDING_PROVIDER ?? "openai") as "openai" | "fake";
const resolvedLlmProvider = (process.env.LLM_PROVIDER ?? "openai") as "openai" | "groq" | "fake";

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
  // Optional — see lib/cookies.ts's setSessionCookie for the full
  // explanation. Only needed when apps/web and apps/api are deployed on
  // different (sibling/parent-child) subdomains; unset is correct and
  // sufficient for local dev and any single-host deployment.
  SESSION_COOKIE_DOMAIN: process.env.SESSION_COOKIE_DOMAIN,
  // Signup is gated on a 6-digit OTP emailed to the address given — see
  // lib/pending-signup.ts. How long a pending (unconfirmed) signup lives
  // in Redis before it must be restarted, and how many wrong-code guesses
  // are tolerated before the pending signup is locked out (still subject
  // to the TTL above; a fresh POST /auth/signup starts over regardless).
  SIGNUP_OTP_TTL_SECONDS: requirePositiveInt("SIGNUP_OTP_TTL_SECONDS", process.env.SIGNUP_OTP_TTL_SECONDS, 600),
  MAX_OTP_ATTEMPTS: requirePositiveInt("MAX_OTP_ATTEMPTS", process.env.MAX_OTP_ATTEMPTS, 5),
  // "Sign in with Google" — optional, unlike SESSION_JWT_SECRET/etc: the
  // app is fully usable via password+OTP signup with neither of these
  // set. GOOGLE_CLIENT_ID being unset is what routes.ts checks to decide
  // whether to register the /auth/google* routes at all (see
  // routes/auth.ts) — a half-configured deployment (id but no secret, or
  // vice versa) fails loudly instead, via requireGoogleOAuthConfig below.
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
  // Must exactly match an Authorized redirect URI configured on the
  // Google Cloud OAuth client — defaults to the local-dev API port,
  // production must override this to its real public API URL.
  GOOGLE_REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI ?? "http://localhost:4000/auth/google/callback",
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
  EMBEDDING_PROVIDER: resolvedEmbeddingProvider,
  OPENAI_EMBEDDING_BATCH_SIZE: Number(process.env.OPENAI_EMBEDDING_BATCH_SIZE ?? 100),
  FAKE_EMBEDDING_DELAY_MS: Number(process.env.FAKE_EMBEDDING_DELAY_MS ?? 0),
  // "groq" reuses @raas/providers's OpenAIChatProvider unchanged, pointed
  // at Groq's own OpenAI-compatible /chat/completions endpoint via
  // baseUrl (see lib/llm-provider.ts) — Groq has no embeddings API, so
  // this is a chat-completions-only alternative to "openai", never a
  // value for EMBEDDING_PROVIDER above.
  LLM_PROVIDER: resolvedLlmProvider,
  OPENAI_CHAT_MODEL: process.env.OPENAI_CHAT_MODEL ?? "gpt-4o-mini",
  GROQ_CHAT_MODEL: process.env.GROQ_CHAT_MODEL ?? "llama-3.3-70b-versatile",
  // Hard per-request ceiling on completion output tokens (see
  // @raas/providers's OpenAIChatProvider) — the daily chat token budget
  // below can only reject the NEXT request once a prior one has already
  // gone over; this bounds what any single request can cost regardless of
  // budget state. 1024 is generous for a citation-grounded chat answer
  // (architecture.md §4.7) while still being a real ceiling, not a
  // nominal one.
  MAX_COMPLETION_TOKENS: requirePositiveInt("MAX_COMPLETION_TOKENS", process.env.MAX_COMPLETION_TOKENS, 1024),
  FAKE_LLM_DELAY_MS: Number(process.env.FAKE_LLM_DELAY_MS ?? 0),
  // Load-bearing only when LLM_PROVIDER is actually "groq" — same
  // fail-fast-on-missing-secret discipline as OPENAI_API_KEY below.
  GROQ_API_KEY: resolvedLlmProvider === "groq" ? requireEnv("GROQ_API_KEY") : (process.env.GROQ_API_KEY ?? ""),
  // Required exactly when something actually uses "openai" — either
  // provider being "fake", or LLM_PROVIDER being "groq", never makes this
  // key load-bearing on its own.
  OPENAI_API_KEY:
    resolvedEmbeddingProvider === "openai" || resolvedLlmProvider === "openai" ? requireEnv("OPENAI_API_KEY") : (process.env.OPENAI_API_KEY ?? ""),
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
  // Paddle billing — optional like GOOGLE_CLIENT_ID/SECRET above, same
  // reasoning: the app is fully usable with none of this set (routes.ts
  // only registers billingRoutes when PADDLE_API_KEY is present, see
  // routes/billing.ts), so local dev/tests never need a real Paddle
  // account. See the all-or-nothing check below this object.
  PADDLE_API_KEY: process.env.PADDLE_API_KEY,
  PADDLE_WEBHOOK_SECRET: process.env.PADDLE_WEBHOOK_SECRET,
  // "sandbox" default is deliberate — accidentally pointing an unconfigured
  // deployment at real Paddle production would be a much worse failure
  // mode than accidentally staying in sandbox.
  PADDLE_ENVIRONMENT: (process.env.PADDLE_ENVIRONMENT ?? "sandbox") as "sandbox" | "production",
  // Each tier's Paddle Price IDs (pri_...) — created in the Paddle
  // dashboard, not something this app generates. Maps a checkout/
  // subscription back to a plan value in routes/billing.ts's resolvePlan.
  // PADDLE_PRO_PRICE_ID predates the other five (kept as-is, still "Pro
  // monthly") — the settings/billing page's existing upgrade button
  // depends on this exact name.
  PADDLE_STARTER_PRICE_ID_MONTHLY: process.env.PADDLE_STARTER_PRICE_ID_MONTHLY,
  PADDLE_STARTER_PRICE_ID_YEARLY: process.env.PADDLE_STARTER_PRICE_ID_YEARLY,
  PADDLE_PRO_PRICE_ID: process.env.PADDLE_PRO_PRICE_ID,
  PADDLE_PRO_PRICE_ID_YEARLY: process.env.PADDLE_PRO_PRICE_ID_YEARLY,
  PADDLE_ADVANCED_PRICE_ID_MONTHLY: process.env.PADDLE_ADVANCED_PRICE_ID_MONTHLY,
  PADDLE_ADVANCED_PRICE_ID_YEARLY: process.env.PADDLE_ADVANCED_PRICE_ID_YEARLY,
  // Bring-your-own-LLM (routes/llm-config.ts, lib/llm-provider.ts) — same
  // "optional, routes simply not registered when unset" shape as Paddle/
  // Google OAuth above. Base64-encoded 32-byte AES-256-GCM key
  // (@raas/crypto) that encrypts every customer-supplied provider API key
  // before it's stored. Generate with `openssl rand -base64 32`.
  LLM_KEY_ENCRYPTION_SECRET: process.env.LLM_KEY_ENCRYPTION_SECRET,
};

// Half-configured Google OAuth (one of the two set, not both) is almost
// certainly a mistake — fail loudly at startup rather than silently
// registering routes that would only fail once someone actually clicks
// "Continue with Google".
if (Boolean(env.GOOGLE_CLIENT_ID) !== Boolean(env.GOOGLE_CLIENT_SECRET)) {
  throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must both be set, or both left unset. Refusing to start.");
}

// Same all-or-nothing discipline as Google OAuth above, extended to all
// eight Paddle fields — any subset set without the rest is almost
// certainly a partially-completed setup, not an intentional configuration.
const paddleFieldsSet = [
  env.PADDLE_API_KEY,
  env.PADDLE_WEBHOOK_SECRET,
  env.PADDLE_STARTER_PRICE_ID_MONTHLY,
  env.PADDLE_STARTER_PRICE_ID_YEARLY,
  env.PADDLE_PRO_PRICE_ID,
  env.PADDLE_PRO_PRICE_ID_YEARLY,
  env.PADDLE_ADVANCED_PRICE_ID_MONTHLY,
  env.PADDLE_ADVANCED_PRICE_ID_YEARLY,
].map(Boolean);
if (new Set(paddleFieldsSet).size > 1) {
  throw new Error(
    "PADDLE_API_KEY, PADDLE_WEBHOOK_SECRET, and all 6 tier price ids (PADDLE_{STARTER,PRO,ADVANCED}_PRICE_ID{,_YEARLY}) must all be set, or all left unset. Refusing to start.",
  );
}
