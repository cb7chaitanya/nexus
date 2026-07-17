import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Pipeline/chaos tests are real integration tests: real Postgres (RLS)
    // + real Redis (BullMQ) + real MinIO, no mocking of any of them.
    // Requires docker-compose up and migrations applied.
    include: ["src/**/*.test.ts"],
    testTimeout: 30_000,
    // pipeline.test.ts and chaos.test.ts both run real BullMQ Worker
    // consumers on the same fixed queue names (@raas/shared QUEUE_NAMES)
    // against the same real Redis — there's no per-file queue namespace.
    // Running files in parallel lets one file's workers steal another
    // file's jobs (observed: pipeline.test.ts's zero-delay workers
    // grabbing chaos.test.ts's job before its own spawned worker saw it
    // go active), so integration files must run sequentially.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
