import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.IQ_UI_RUNTIME_BASE_URL?.trim();
const campaignId = process.env.IQ_UI_TEST_CAMPAIGN_ID?.trim();

if (!baseURL || !campaignId) {
  throw new Error(
    "Quiet Leaf runtime verification requires IQ_UI_RUNTIME_BASE_URL and IQ_UI_TEST_CAMPAIGN_ID for a disposable runtime campaign."
  );
}

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "quiet-leaf-runtime.e2e.test.ts",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "line",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    headless: true,
    trace: "retain-on-failure"
  }
});
