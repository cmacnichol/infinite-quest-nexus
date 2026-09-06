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
    headless: true,
    trace: "retain-on-failure"
  },
  webServer: [
    {
      command: "pnpm --filter @infinite-quest/web-legacy exec vite --host 127.0.0.1 --port 43173 --strictPort",
      url: "http://127.0.0.1:43173/nexus/index.html",
      reuseExistingServer: false,
      timeout: 30_000
    },
    {
      command: "pnpm --filter @infinite-quest/web-next exec vite --host 127.0.0.1 --port 43174 --strictPort",
      url: "http://127.0.0.1:43174/app/data-transfer",
      reuseExistingServer: false,
      timeout: 30_000
    }
  ]
});
