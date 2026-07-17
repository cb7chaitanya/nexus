import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Real Redis, not a mock — a fixed-window counter's correctness is
    // about actual INCR/EXPIRE/TTL semantics, which a mock would just
    // reimplement (and could reimplement wrong). Requires docker-compose
    // Redis up.
    include: ["src/**/*.test.ts"],
    testTimeout: 15_000,
  },
});
