// Same fail-fast-on-missing-secret discipline as apps/api/src/env.ts.

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. Refusing to start.`);
  }
  return value;
}

/** Same discipline as apps/api/src/env.ts's own requirePositiveInt — a
 * resource-configuration value that IS set but nonsensical (zero,
 * negative, non-numeric) is refused at startup rather than silently
 * producing a concurrency of 0 or a timeout of NaN ms. */
function requirePositiveInt(name: string, rawValue: string | undefined, defaultValue: number): number {
  const value = rawValue === undefined ? defaultValue : Number(rawValue);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got: ${JSON.stringify(rawValue)}. Refusing to start.`);
  }
  return value;
}

export const env = {
  REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
  S3_ENDPOINT: requireEnv("S3_ENDPOINT"),
  S3_REGION: process.env.S3_REGION ?? "us-east-1",
  S3_BUCKET: requireEnv("S3_BUCKET"),
  S3_ACCESS_KEY_ID: requireEnv("S3_ACCESS_KEY_ID"),
  S3_SECRET_ACCESS_KEY: requireEnv("S3_SECRET_ACCESS_KEY"),
  S3_FORCE_PATH_STYLE: process.env.S3_FORCE_PATH_STYLE !== "false",
  // A second, worker-operational memory guardrail — deliberately separate
  // from (and independent of) @raas/shared's MAX_UPLOAD_SIZE_BYTES (1 GiB),
  // which stays exactly as it is: that's the platform's accepted-upload
  // ceiling, enforced at presign/complete time. This is what extract-text
  // checks before ever downloading an object into memory (see
  // processors/extract-text.ts) — a lower, per-deployment tunable an
  // operator can set based on THIS worker fleet's actual container memory,
  // without touching what the platform accepts from customers at all. A
  // document over this limit still uploaded successfully; it just fails
  // processing with a clear, safe reason (DocumentValidationError) instead
  // of ever being downloaded. Default (200 MiB) is comfortably below the
  // platform ceiling and sized so that
  // WORKER_EXTRACTION_CONCURRENCY * WORKER_MAX_DOCUMENT_BYTES (worst-case
  // concurrent in-memory bytes across this worker's extraction slots — see
  // that var's own comment) stays well under a typical small-to-medium
  // worker container's memory budget.
  WORKER_MAX_DOCUMENT_BYTES: requirePositiveInt("WORKER_MAX_DOCUMENT_BYTES", process.env.WORKER_MAX_DOCUMENT_BYTES, 200 * 1024 * 1024),
  // "fake" is a real, documented provider choice (see
  // @raas/providers/FakeEmbeddingProvider) for local dev without an OpenAI
  // key and for tests — deterministic, offline, no cost. Defaults to
  // "openai" so a misconfigured production env fails loudly (missing
  // OPENAI_API_KEY) rather than silently writing fake vectors.
  EMBEDDING_PROVIDER: (process.env.EMBEDDING_PROVIDER ?? "openai") as "openai" | "fake",
  OPENAI_API_KEY: process.env.EMBEDDING_PROVIDER === "fake" ? (process.env.OPENAI_API_KEY ?? "") : requireEnv("OPENAI_API_KEY"),
  OPENAI_EMBEDDING_BATCH_SIZE: Number(process.env.OPENAI_EMBEDDING_BATCH_SIZE ?? 100),
  // Platform-wide default for OrganizationUsageLimit.maxEmbeddingTokensPerDay,
  // used whenever an org has no override row (see @raas/usage's
  // getOrganizationDailyLimit). Same env var name as apps/api's own copy
  // of this default — set once per deployment, read by both processes.
  RATE_LIMIT_EMBEDDING_TOKEN_BUDGET_DAILY_DEFAULT: Number(process.env.RATE_LIMIT_EMBEDDING_TOKEN_BUDGET_DAILY_DEFAULT ?? 2_000_000),
  // Only meaningful with EMBEDDING_PROVIDER=fake — lets the chaos test
  // (and manual testing) control embedding latency deterministically
  // instead of racing a real network call.
  FAKE_EMBEDDING_DELAY_MS: Number(process.env.FAKE_EMBEDDING_DELAY_MS ?? 0),
  // Same reasoning as FAKE_EMBEDDING_DELAY_MS, for the two earlier
  // pipeline stages: a real PDF parse (extract-text) and a real batch of
  // Postgres upserts (chunk-text) are both too fast against a local test
  // PDF/DB to reliably land a process kill inside them without an
  // artificial delay. Zero (no-op) in every real deployment — these only
  // do anything when a chaos test sets them.
  FAKE_EXTRACTION_DELAY_MS: Number(process.env.FAKE_EXTRACTION_DELAY_MS ?? 0),
  FAKE_CHUNK_UPSERT_DELAY_MS: Number(process.env.FAKE_CHUNK_UPSERT_DELAY_MS ?? 0),
  // BullMQ defaults (30s/30s) are right for production — a worker crash
  // shouldn't have its jobs reclaimed by a healthy sibling too eagerly.
  // The chaos test shrinks both so "kill worker, restart, watch it
  // recover" doesn't take 30+ real seconds per run.
  WORKER_LOCK_DURATION_MS: Number(process.env.WORKER_LOCK_DURATION_MS ?? 30_000),
  WORKER_STALLED_INTERVAL_MS: Number(process.env.WORKER_STALLED_INTERVAL_MS ?? 30_000),
  // Per-queue concurrency (see index.ts's sharedWorkerOptions usage) —
  // previously hardcoded, now tunable per deployment without a redeploy.
  // Defaults match the values this codebase already shipped with:
  // processing just orchestrates (cheap, high concurrency is fine),
  // extraction buffers a whole PDF into memory per job (see
  // WORKER_MAX_DOCUMENT_BYTES above — concurrency is the OTHER half of
  // that memory-safety budget), embedding/kb-cleanup are I/O-bound against
  // an external provider/S3 rather than CPU/memory-bound, and sweep is
  // deliberately serialized (one pass at a time).
  WORKER_PROCESSING_CONCURRENCY: requirePositiveInt("WORKER_PROCESSING_CONCURRENCY", process.env.WORKER_PROCESSING_CONCURRENCY, 10),
  WORKER_EXTRACTION_CONCURRENCY: requirePositiveInt("WORKER_EXTRACTION_CONCURRENCY", process.env.WORKER_EXTRACTION_CONCURRENCY, 4),
  WORKER_EMBEDDING_CONCURRENCY: requirePositiveInt("WORKER_EMBEDDING_CONCURRENCY", process.env.WORKER_EMBEDDING_CONCURRENCY, 2),
  WORKER_SWEEP_CONCURRENCY: requirePositiveInt("WORKER_SWEEP_CONCURRENCY", process.env.WORKER_SWEEP_CONCURRENCY, 1),
  WORKER_KB_CLEANUP_CONCURRENCY: requirePositiveInt("WORKER_KB_CLEANUP_CONCURRENCY", process.env.WORKER_KB_CLEANUP_CONCURRENCY, 2),
  // Its own queue, separate from kb-cleanup — a single-document S3 delete
  // is much lighter and more frequent than a whole-KB cascade, closer in
  // cost to processing's own "cheap, high concurrency is fine" tier.
  WORKER_DOCUMENT_CLEANUP_CONCURRENCY: requirePositiveInt("WORKER_DOCUMENT_CLEANUP_CONCURRENCY", process.env.WORKER_DOCUMENT_CLEANUP_CONCURRENCY, 10),
  // Generic per-job-attempt wall-clock ceiling (see lib/job-timeout.ts),
  // applied uniformly to every processor at the Worker construction site
  // in index.ts — not a change to any processor itself. A backstop against
  // a job that's somehow still running well past any reasonable duration
  // for its stage (a genuinely hung dependency with no timeout of its own,
  // a bug) holding a concurrency slot — and the memory of whatever it
  // downloaded — forever. Every real external call in this codebase
  // already has its own, tighter timeout (OpenAI's connectTimeoutMs, the
  // health server's CHECK_TIMEOUT_MS); this is the outermost, coarsest
  // layer, not a replacement for those.
  WORKER_MAX_JOB_DURATION_MS: requirePositiveInt("WORKER_MAX_JOB_DURATION_MS", process.env.WORKER_MAX_JOB_DURATION_MS, 10 * 60 * 1000),
  // How long SIGTERM/SIGINT waits for active jobs to finish before giving
  // up and exiting anyway (see lib/shutdown.ts) — bounded so this process
  // always terminates on its own within a known window rather than
  // relying on the orchestrator's own SIGKILL grace period (commonly
  // ~30s) to end it uncleanly. Keep this comfortably below whatever that
  // external grace period actually is in production.
  WORKER_SHUTDOWN_TIMEOUT_MS: requirePositiveInt("WORKER_SHUTDOWN_TIMEOUT_MS", process.env.WORKER_SHUTDOWN_TIMEOUT_MS, 25_000),
  // Bounds the initial `redisConnection.ping()` at startup (index.ts) —
  // ioredis's default retry behavior queues commands and retries
  // connecting indefinitely with backoff, which means a genuinely
  // misconfigured REDIS_URL would otherwise hang main() forever instead of
  // failing loudly, unlike every other required dependency in this file
  // (S3, OPENAI_API_KEY) which fails fast via requireEnv above.
  WORKER_REDIS_CONNECT_TIMEOUT_MS: requirePositiveInt("WORKER_REDIS_CONNECT_TIMEOUT_MS", process.env.WORKER_REDIS_CONNECT_TIMEOUT_MS, 10_000),
  // Stuck-document sweep (docs/architecture.md §6.2, decisions.md R8): a
  // scheduled job finds Documents sitting in QUEUED/PROCESSING longer
  // than STUCK_DOCUMENT_THRESHOLD_MS and fails them visibly. The sweep
  // itself runs every STUCK_DOCUMENT_SWEEP_INTERVAL_MS, which must stay
  // well below the threshold or a stuck document could sit unnoticed for
  // up to threshold + interval.
  STUCK_DOCUMENT_THRESHOLD_MS: Number(process.env.STUCK_DOCUMENT_THRESHOLD_MS ?? 30 * 60 * 1000),
  STUCK_DOCUMENT_SWEEP_INTERVAL_MS: Number(process.env.STUCK_DOCUMENT_SWEEP_INTERVAL_MS ?? 5 * 60 * 1000),
  // Off by default: auto-retrying a stuck document has real failure
  // modes of its own (see sweep-stuck-documents.ts's doc comment) and
  // should be an explicit operational choice, not a silent default.
  STUCK_DOCUMENT_AUTO_RETRY: process.env.STUCK_DOCUMENT_AUTO_RETRY === "true",
  // Ceiling on Document.retryCount (the same field POST /documents/:id/retry
  // increments) before a stuck document is left permanently FAILED instead
  // of being auto-retried again — closes the "genuinely malformed document
  // gets re-enqueued forever" gap STUCK_DOCUMENT_AUTO_RETRY's own doc
  // comment names. Only consulted when STUCK_DOCUMENT_AUTO_RETRY is on.
  STUCK_DOCUMENT_MAX_AUTO_RETRIES: Number(process.env.STUCK_DOCUMENT_MAX_AUTO_RETRIES ?? 3),
  // GET /health (see health-server.ts) — an orchestrator readiness probe,
  // not internet-facing traffic; not published to the host by default in
  // docker-compose.prod.yml, only reachable inside the compose network /
  // by Docker's own HEALTHCHECK. Distinct from apps/api's API_PORT so
  // both processes can run on the same host without colliding.
  WORKER_HEALTH_PORT: Number(process.env.WORKER_HEALTH_PORT ?? 3001),
  WORKER_HEALTH_HOST: process.env.WORKER_HEALTH_HOST ?? "0.0.0.0",
  // Failure alerting (see lib/notifications/) — optional on purpose:
  // alerting is an operational nice-to-have, not load-bearing for the
  // pipeline to function, so an unset URL selects a no-op notifier (see
  // lib/notifications/index.ts's createNotifier) rather than failing to
  // start. Only ever read by that one factory function — nothing else in
  // this codebase should reach for this var directly, so a future
  // Slack/PagerDuty/Sentry notifier stays a config change there, not a
  // call-site change everywhere a failure can happen.
  ALERT_WEBHOOK_URL: process.env.ALERT_WEBHOOK_URL,
  ALERT_WEBHOOK_TIMEOUT_MS: Number(process.env.ALERT_WEBHOOK_TIMEOUT_MS ?? 5000),
  NODE_ENV: process.env.NODE_ENV ?? "development",
  // Optional (see lib/sentry.ts's initSentry) — same reasoning as
  // apps/api's own copy of this var: unset leaves captureException calls
  // going to NoopErrorTracker, never load-bearing for startup.
  SENTRY_DSN: process.env.SENTRY_DSN,
};
