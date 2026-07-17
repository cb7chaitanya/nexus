import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Real Postgres — RLS scoping on UsageEvent is a database-level
    // behavior, same reasoning as every other RLS-adjacent test suite in
    // this repo. Requires docker-compose Postgres up and migrations
    // applied.
    include: ["src/**/*.test.ts"],
    testTimeout: 15_000,
  },
});
