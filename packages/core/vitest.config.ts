import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Most of this package is pure logic (marker filtering, context
    // assembly, citation validation) and needs no I/O. similarity-search
    // is the exception — pgvector's ORDER BY/LIMIT behavior and RLS-backed
    // org isolation can't be meaningfully verified without a real Postgres
    // connection. Requires docker-compose Postgres up and migrations
    // applied.
    include: ["src/**/*.test.ts"],
    testTimeout: 15_000,
    // similarity-search.test.ts builds up chunks in a shared KB across
    // several `it` blocks within the file — matches packages/db's
    // vitest.config.ts convention for the same reason.
    fileParallelism: true,
    sequence: { concurrent: false },
  },
});
