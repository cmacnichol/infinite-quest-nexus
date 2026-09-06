import { defineConfig } from "vitest/config";

// This release gate receives its PostgreSQL authority from the Linux runner.
// Do not use the host-oriented integration global setup here: it provisions
// Docker itself and is intentionally unavailable inside the test container.
export default defineConfig({
  test: {
    include: ["tests/integration/system-archive-e2e.integration.test.ts"],
    testTimeout: 360_000,
    hookTimeout: 360_000,
    fileParallelism: false,
    sequence: {
      hooks: "stack",
    },
  },
});
