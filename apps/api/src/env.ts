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
  NODE_ENV: process.env.NODE_ENV ?? "development",
};
