import { expect, test } from "@playwright/test";
import { installLegacyUiFixture, legacyUiFixture } from "./helpers/legacy-ui-fixtures.js";

const origin = `http://127.0.0.1:${process.env.PLAYWRIGHT_LEGACY_PORT ?? "43173"}`;

function delayedTurnsPath(campaignId: string): string {
  return `/api/v1/campaigns/${campaignId}/turns`;
}

test("manual-delay benchmark request stays held past 60 ms until explicit release", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 3, worldCount: 1, campaignCount: 1 });
  const path = delayedTurnsPath(fixture.campaignId);
  const instrumentation = await installLegacyUiFixture(page, fixture, {
    delays: { [path]: 20 },
    manualDelayReleaseTimeoutMs: 10_000
  });
  const navigation = page.goto(`${origin}${path}`);

  try {
    await expect.poll(() => instrumentation.requests.find(request => request.path === path)).toBeDefined();
    await new Promise<void>(resolve => setTimeout(resolve, 60));

    const heldRequest = instrumentation.requests.find(request => request.path === path);
    expect(heldRequest).toBeDefined();
    expect(heldRequest?.configuredDelayMs).toBe(20);
    expect(heldRequest?.finishedAt).toBeUndefined();
    expect(heldRequest?.delayReleaseKind).toBeUndefined();

    instrumentation.releaseDelayedRoute();
    const response = await navigation;
    expect(response?.ok()).toBe(true);
    expect(heldRequest?.delayReleaseKind).toBe("explicit");
    expect(heldRequest?.finishedAt).toBeDefined();
  } finally {
    instrumentation.releaseDelayedRoute();
    await navigation.catch(() => null);
  }
});

test("fixture routes keep their configured automatic delay when manual fallback is omitted", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 3, worldCount: 1, campaignCount: 1 });
  const path = delayedTurnsPath(fixture.campaignId);
  const instrumentation = await installLegacyUiFixture(page, fixture, { delays: { [path]: 20 } });

  const response = await page.goto(`${origin}${path}`);
  expect(response?.ok()).toBe(true);

  const completedRequest = instrumentation.requests.find(request => request.path === path);
  expect(completedRequest).toBeDefined();
  expect(completedRequest?.configuredDelayMs).toBe(20);
  expect(completedRequest?.delayReleaseKind).toBe("timeout");
  expect(completedRequest?.finishedAt).toBeDefined();
});
