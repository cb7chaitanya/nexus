import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // These are integration tests: RLS is a database-level behavior that
    // can't be meaningfully verified without a real Postgres connection.
    // Requires the docker-compose Postgres up and this migration applied
    // (pnpm migrate:deploy) — see the test file's own header comment.
    include: ["src/**/*.test.ts"],
    testTimeout: 15_000,
    // Tenant-isolation tests share Organization rows across assertions
    // within a file; running test files in parallel workers is fine
    // (each file cleans up its own data), but tests within a file must
    // stay sequential since later tests build on earlier setup.
    fileParallelism: true,
    sequence: { concurrent: false },
  },
});
