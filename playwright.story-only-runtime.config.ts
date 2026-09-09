import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.IQ_UI_RUNTIME_BASE_URL?.trim();
const campaignId = process.env.IQ_UI_TEST_CAMPAIGN_ID?.trim();
if (!baseURL || !campaignId) {
  throw new Error("Story-only runtime verification requires IQ_UI_RUNTIME_BASE_URL and IQ_UI_TEST_CAMPAIGN_ID from the disposable harness.");
}

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "story-only-campaigns.e2e.test.ts",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "line",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: { baseURL, headless: true, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 5"] } }
  ]
});
