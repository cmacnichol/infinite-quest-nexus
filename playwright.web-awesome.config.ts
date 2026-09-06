import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "line",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  testMatch: [
    "web-awesome-core.e2e.test.ts",
    "quiet-leaf-story.e2e.test.ts",
    "quiet-leaf-navigation.e2e.test.ts",
    "quiet-leaf-preferences.e2e.test.ts"
  ],
  use: {
    baseURL: "http://127.0.0.1:43175",
    headless: true,
    trace: "retain-on-failure"
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } }
  ],
  webServer: {
    command: "node node_modules/tsx/dist/cli.mjs scripts/serve-ui-test-build.ts",
    url: "http://127.0.0.1:43175/health",
    reuseExistingServer: false,
    timeout: 30_000
  }
});
