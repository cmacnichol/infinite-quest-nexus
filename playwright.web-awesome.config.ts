import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "line",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:43175",
    headless: true,
    trace: "retain-on-failure"
  },
  webServer: {
    command: "pnpm exec tsx scripts/serve-ui-test-build.ts",
    url: "http://127.0.0.1:43175/health",
    reuseExistingServer: false,
    timeout: 30_000
  }
});
