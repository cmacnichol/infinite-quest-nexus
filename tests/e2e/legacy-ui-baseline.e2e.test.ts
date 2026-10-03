import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { installLegacyUiFixture, legacyUiFixture } from "./helpers/legacy-ui-fixtures.js";

const origin = `http://127.0.0.1:${process.env.PLAYWRIGHT_LEGACY_PORT ?? "43173"}`;
const historyTurnCounts = [0, 1, 50, 317, 2000] as const;

async function installStoryDocument(page: Page, campaignId: string): Promise<void> {
  const html = (await readFile("apps/web/public/story.html", "utf8"))
    .replace("/nexus/legacy-client.js", "/nexus/src/legacy-client-entry.ts");
  await page.route(`**/story/${campaignId}`, route => route.fulfill({ contentType: "text/html", body: html }));
}

async function captureDesktopAndMobile(page: Page, testInfo: TestInfo, stem: string): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.screenshot({ path: testInfo.outputPath(`${stem}-1280x800.png`), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath(`${stem}-390x844.png`), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 800 });
}

test("deterministic fixtures cover the agreed cardinalities without private canaries", () => {
  for (const turnCount of historyTurnCounts) {
    const fixture = legacyUiFixture({ turnCount, worldCount: 2, campaignCount: 3 });
    expect(fixture.turns).toHaveLength(turnCount);
    expect(fixture.worlds).toHaveLength(2);
    expect(fixture.campaigns).toHaveLength(3);
    const serialized = JSON.stringify(fixture);
    expect(serialized).not.toMatch(/PRIVATE-CANARY-|HIDDEN-MECHANIC-CANARY-|SCRATCHPAD-CANARY-/u);
    expect(serialized).toContain("synthetic");
  }
});

test("legacy dashboard and Story baseline records requests, zero writes, history timing and rendered counts", async ({ page }, testInfo) => {
  const fixture = legacyUiFixture({ turnCount: 317, worldCount: 3, campaignCount: 2 });
  const instrumentation = await installLegacyUiFixture(page, fixture);
  await page.setViewportSize({ width: 1280, height: 800 });
  const externalRequests: string[] = [];
  const longTasks: number[] = [];
  page.on("request", request => {
    if (new URL(request.url()).origin !== origin && request.url().startsWith("http")) externalRequests.push(request.url());
  });
  await page.addInitScript(() => {
    const target = window as typeof window & { __legacyUiLongTasks?: number[] };
    target.__legacyUiLongTasks = [];
    if ("PerformanceObserver" in window) {
      try {
        new PerformanceObserver(list => {
          for (const entry of list.getEntries()) target.__legacyUiLongTasks?.push(entry.duration);
        }).observe({ type: "longtask", buffered: true });
      } catch { /* Long task timing is optional in unsupported browser builds. */ }
    }
  });

  await page.goto(`${origin}/nexus/index.html`);
  await expect(page.locator("#dashboardWorlds")).toContainText("Fixture World 1");
  await expect(page.locator("#dashboardCampaigns")).toContainText("Fixture Campaign 1");
  const dashboardDomNodes = await page.locator("body *").count();
  await captureDesktopAndMobile(page, testInfo, "dashboard");

  await page.goto(`${origin}/nexus/index.html#world-library`);
  await page.getByRole("button", { name: "New world", exact: true }).click();
  await expect(page.locator("#worldAuthorDialog")).toBeVisible();
  await captureDesktopAndMobile(page, testInfo, "world-author");
  await page.locator('[data-tab-target="world-author-mechanics"]').click();
  await page.getByRole("button", { name: "+ Add character", exact: true }).click();
  await expect(page.locator("#characterDialog")).toBeVisible();
  await captureDesktopAndMobile(page, testInfo, "character-editor");
  await page.locator("#cancelCharacter").click();
  await page.locator("#cancelWorldAuthor").click();

  await page.locator("#worldManagementCarousel").getByText("Fixture World 1", { exact: true }).click();
  await page.locator("#createCampaignModalBtn").click();
  await expect(page.locator("#createCampaignDialog")).toBeVisible();
  await captureDesktopAndMobile(page, testInfo, "campaign-creation");
  await page.locator("#cancelCreateCampaign").click();

  await installStoryDocument(page, fixture.campaignId);
  await page.goto(`${origin}/story/${fixture.campaignId}`);
  await expect(page.locator("#storyTitle")).toHaveText("Fixture Campaign 1");
  const storyDomNodes = await page.locator("body *").count();
  await captureDesktopAndMobile(page, testInfo, "story-reader");

  const historyOpenStarted = performance.now();
  await page.locator("#turnPill").click();
  await expect(page.locator("#turnHistoryDialog")).toBeVisible();
  await expect(page.locator("#turnHistoryModalList .history-card")).toHaveCount(317);
  const historyOpenMs = performance.now() - historyOpenStarted;
  const navigationStarted = performance.now();
  await page.locator("#turnHistoryModalList .history-card").first().click();
  await page.locator("#btnTurnHistoryJump").click();
  await expect(page.locator("#viewPill")).toContainText("1");
  const historyNavigationMs = performance.now() - navigationStarted;
  const historyDomNodes = await page.locator("body *").count();
  await captureDesktopAndMobile(page, testInfo, "story-history");
  longTasks.push(...await page.evaluate(() => (window as typeof window & { __legacyUiLongTasks?: number[] }).__legacyUiLongTasks ?? []));

  expect(instrumentation.writes).toEqual([]);
  expect(instrumentation.requests.length).toBeGreaterThan(0);
  expect(instrumentation.requests.every(request => request.finishedAt !== undefined)).toBe(true);
  expect(externalRequests).toEqual([]);
  const baseline = {
    commit: process.env.GIT_COMMIT ?? "recorded in baseline report",
    dirty: process.env.GIT_DIRTY ?? "recorded in baseline report",
    buildMode: "Vite development server; deterministic API routes",
    fixture: { turnCount: 317, worldCount: 3, campaignCount: 2 },
    requests: instrumentation.requests,
    writes: instrumentation.writes.length,
    domCounts: { dashboard: dashboardDomNodes, story: storyDomNodes, history: historyDomNodes },
    historyOpenMs,
    historyNavigationMs,
    longTasks,
    coldAssetBytes: instrumentation.requests.filter(request => request.path.startsWith("/api/v1/")).reduce((sum, request) => sum + request.responseBytes, 0),
    warmAssetBytes: null
  };
  await testInfo.attach("legacy-ui-baseline.json", { body: JSON.stringify(baseline, null, 2), contentType: "application/json" });
  expect(dashboardDomNodes).toBeGreaterThan(0);
  expect(storyDomNodes).toBeGreaterThan(0);
  expect(historyDomNodes).toBeGreaterThan(0);
  expect(Number.isFinite(historyOpenMs)).toBe(true);
});
