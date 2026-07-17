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

export const env = {
  API_PORT: Number(process.env.API_PORT ?? 4000),
  API_HOST: process.env.API_HOST ?? "0.0.0.0",
  REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
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
  FAKE_LLM_DELAY_MS: Number(process.env.FAKE_LLM_DELAY_MS ?? 0),
  // Required unless BOTH providers are set to "fake" — either provider
  // being "openai" means a real key is load-bearing.
  OPENAI_API_KEY:
    process.env.EMBEDDING_PROVIDER === "fake" && process.env.LLM_PROVIDER === "fake" ? (process.env.OPENAI_API_KEY ?? "") : requireEnv("OPENAI_API_KEY"),
  NODE_ENV: process.env.NODE_ENV ?? "development",
};
