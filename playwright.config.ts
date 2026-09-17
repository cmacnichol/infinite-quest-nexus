import { defineConfig, devices } from "@playwright/test";

const legacyPort = Number(process.env.PLAYWRIGHT_LEGACY_PORT ?? "43173");
const webNextPort = Number(process.env.PLAYWRIGHT_WEB_NEXT_PORT ?? "43174");
const reuseExistingServer = process.env.PLAYWRIGHT_REUSE_EXISTING_SERVER === "true";

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
      command: `corepack pnpm --filter @infinite-quest/web-legacy exec vite --host 127.0.0.1 --port ${legacyPort} --strictPort`,
      url: `http://127.0.0.1:${legacyPort}/nexus/index.html`,
      reuseExistingServer,
      timeout: 30_000
    },
    {
      command: `corepack pnpm --filter @infinite-quest/web-next exec vite --host 127.0.0.1 --port ${webNextPort} --strictPort`,
      url: `http://127.0.0.1:${webNextPort}/app/data-transfer`,
      reuseExistingServer,
      timeout: 30_000
    }
  ]
});
