// Same fail-fast-on-missing-secret discipline as apps/api/src/env.ts.

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. Refusing to start.`);
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
  // BullMQ defaults (30s/30s) are right for production — a worker crash
  // shouldn't have its jobs reclaimed by a healthy sibling too eagerly.
  // The chaos test shrinks both so "kill worker, restart, watch it
  // recover" doesn't take 30+ real seconds per run.
  WORKER_LOCK_DURATION_MS: Number(process.env.WORKER_LOCK_DURATION_MS ?? 30_000),
  WORKER_STALLED_INTERVAL_MS: Number(process.env.WORKER_STALLED_INTERVAL_MS ?? 30_000),
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
  NODE_ENV: process.env.NODE_ENV ?? "development",
};
