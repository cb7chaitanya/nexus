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
  NODE_ENV: process.env.NODE_ENV ?? "development",
};
