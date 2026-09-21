import { defineConfig } from "vitest/config";

if (process.platform !== "linux") throw new Error("This verification configuration requires Linux.");
if (!process.env.TEST_DATABASE_URL) throw new Error("Provision a dedicated test database before starting Linux verification.");

export default defineConfig({ test: {
  include: [
    "tests/integration/image-pipeline.integration.test.ts",
    "tests/integration/import-memory.integration.test.ts",
    "tests/integration/campaign-archive.integration.test.ts",
    "tests/integration/system-archive.integration.test.ts",
    "tests/integration/system-archive-resumable.integration.test.ts",
    "tests/integration/system-archive-e2e.integration.test.ts",
    "tests/integration/source-world-system-archive-portability.integration.test.ts",
    "tests/integration/source-campaign-portability.integration.test.ts",
    "tests/integration/story-only-portability.integration.test.ts",
    "tests/integration/story-memory-compatibility.integration.test.ts",
    "tests/integration/gameplay.integration.test.ts",
    "tests/integration/task-14e2c-adapter-matrix.integration.test.ts",
    "tests/integration/world-campaign-route-application.integration.test.ts"
  ],
  setupFiles: ["tests/integration/setup-isolated-database.ts"],
  testTimeout: 360000,
  hookTimeout: 360000,
  fileParallelism: false,
  sequence: { hooks: "stack" }
} });