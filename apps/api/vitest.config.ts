import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration tests: real Postgres (RLS) + real Redis (sessions) via
    // app.inject(), no mocking of either. Requires docker-compose up and
    // migrations applied.
    include: ["src/**/*.test.ts"],
    testTimeout: 15_000,
    fileParallelism: true,
    sequence: { concurrent: false },
  },
});
