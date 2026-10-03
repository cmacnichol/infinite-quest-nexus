import { mkdir, readFile } from "node:fs/promises";
import { expect, test, type Page, type Route } from "@playwright/test";

const origin = `http://127.0.0.1:${process.env.PLAYWRIGHT_LEGACY_PORT ?? "43173"}`;
const campaignId = "11111111-1111-4111-8111-111111111111";
const previousCampaignId = "22222222-2222-4222-8222-222222222222";
const worldId = "33333333-3333-4333-8333-333333333333";
const screenshots = ".superpowers/sdd/legacy-ui-2026-10-03/evidence/screenshots";

async function installStoryDocument(page: Page) {
  const html = (await readFile("apps/web/public/story.html", "utf8"))
    .replace("/nexus/legacy-client.js", "/nexus/src/legacy-client-entry.ts");
  await page.route(`**/story/${campaignId}`, (route) => route.fulfill({ contentType: "text/html", body: html }));
}

async function installApi(page: Page, statusCode: number) {
  let syncRequests = 0;
  await page.addInitScript(({ rememberedId }) => {
    localStorage.setItem("infiniteQuestLastCampaignId", rememberedId);
  }, { rememberedId: previousCampaignId });
  await page.route("**/api/v1/**", async (route: Route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/session") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ user: { id: previousCampaignId, displayName: "Fixture owner", settings: { autoSubmitTurnChoices: false, continuousReading: false } }, authentication: "deferred" })
      });
      return;
    }
    if (url.pathname === "/api/v1/providers") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ providers: [{ id: "44444444-4444-4444-8444-444444444444", name: "Fixture text", providerType: "openai_compatible", providerRole: "text", enabled: true, isDefault: true }] }) });
      return;
    }
    if (url.pathname.endsWith("/sync-status")) {
      syncRequests += 1;
      await route.fulfill({ status: statusCode, contentType: "application/json", body: JSON.stringify({}) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({}) });
  });
  return { syncRequests: () => syncRequests };
}

function dashboardCampaign(id: string, title: string, status: "active" | "archived", updatedAt: string) {
  return {
    id, title, status, updatedAt, createdAt: updatedAt, activeTurnNumber: 1,
    worldId, worldTitle: "Synthetic World", worldVersionId: "44444444-4444-4444-8444-444444444444",
    worldVersionNumber: 1, latestWorldVersionNumber: 1, worldUpdateAvailable: false,
    selectedCharacterId: null, selectedCharacterName: null, storyLengthProfile: "standard",
    storyContextBudgetTokens: 32000, turnControlStyle: "flexible_action", textProviderProfileId: null,
    imageProviderProfileId: null, costInformation: []
  };
}

async function installDashboardApi(page: Page, campaignList: ReturnType<typeof dashboardCampaign>[], options: { failOnce?: boolean; delayList?: boolean } = {}) {
  let campaignRequests = 0;
  let releaseList!: () => void;
  const listReleased = new Promise<void>((resolve) => { releaseList = resolve; });
  await page.addInitScript((rememberedId) => {
    localStorage.setItem("infiniteQuestLastCampaignId", rememberedId);
    localStorage.setItem("infiniteQuestStoryDraft:preserve", "draft-preserved");
    localStorage.setItem("infiniteQuestReaderPreference:preserve", "preference-preserved");
  }, "stale-remembered-id");
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/campaigns" && route.request().method() === "GET") {
      campaignRequests += 1;
      if (options.delayList && campaignRequests === 1) {
        await listReleased;
      }
      if (options.failOnce && campaignRequests === 1) {
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({}) });
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ campaigns: campaignList }) });
      return;
    }
    if (url.pathname === "/api/v1/worlds") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ worlds: [] }) });
      return;
    }
    if (url.pathname.endsWith("/state")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ activeTurnNumber: 1, revision: 1 }) });
      return;
    }
    if (url.pathname.startsWith("/api/v1/worlds/")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ versions: [{ id: "44444444-4444-4444-8444-444444444444", versionNumber: 1 }] }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({}) });
  });
  return { campaignRequests: () => campaignRequests, releaseList };
}

test("failed Story load preserves the prior resume ID and offers not-found recovery without campaign content", async ({ page }) => {
  const api = await installApi(page, 404);
  await installStoryDocument(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${origin}/story/${campaignId}`);

  await expect(page.locator("#storyLoadRecovery")).toBeVisible();
  await expect(page.locator("#storyLoadRecovery")).toContainText("Campaign not found");
  await expect(page.locator("#storyLoadRecovery a")).toHaveAttribute("href", "/nexus/#campaigns");
  await expect(page.locator("#storyLoadRetry")).toBeHidden();
  await expect(page.locator("#storyArea .turn")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("infiniteQuestLastCampaignId"))).toBe(previousCampaignId);
  expect(api.syncRequests()).toBe(1);

  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: `${screenshots}/t06-story-not-found.png`, fullPage: true });
});

test("403 Story load is shown as an access problem rather than a deleted campaign", async ({ page }) => {
  await installApi(page, 403);
  await installStoryDocument(page);
  await page.goto(`${origin}/story/${campaignId}`);

  await expect(page.locator("#storyLoadRecovery")).toBeVisible();
  await expect(page.locator("#storyLoadRecovery")).toContainText("don't have access");
  await expect(page.locator("#storyLoadRecovery")).not.toContainText("not found");
  await expect(page.locator("#storyLoadRecovery a")).toHaveAttribute("href", "/nexus/#campaigns");
});

test("network failure keeps Story recovery visible and retries the scoped load", async ({ page }) => {
  const api = await installApi(page, 503);
  await installStoryDocument(page);
  await page.goto(`${origin}/story/${campaignId}`);

  await expect(page.locator("#storyLoadRecovery")).toBeVisible();
  await expect(page.locator("#storyLoadRecovery")).toContainText("could not be loaded");
  await expect(page.locator("#storyLoadRetry")).toBeVisible();
  await page.locator("#storyLoadRetry").click();
  await expect.poll(() => api.syncRequests()).toBe(2);
  await expect(page.locator("#storyLoadRecovery")).toBeVisible();
  await expect(page.locator("#storyArea .turn")).toHaveCount(0);
});

test("dashboard validates stale resume IDs and chooses the newest active campaign after the list loads", async ({ page }) => {
  const campaigns = [
    dashboardCampaign("archived-newest", "Archived Story", "archived", "2026-10-02T00:00:00.000Z"),
    dashboardCampaign("active-old", "Older Active Story", "active", "2026-09-01T00:00:00.000Z"),
    dashboardCampaign("active-new", "Newest Active Story", "active", "2026-10-01T00:00:00.000Z")
  ];
  const api = await installDashboardApi(page, campaigns, { delayList: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${origin}/nexus/index.html`);

  await expect(page.locator("#dashboardStoryLink")).toHaveAttribute("href", "/nexus/#campaigns");
  await api.releaseList();
  await expect(page.locator("#dashboardStoryLink")).toHaveAttribute("href", "/story/active-new");
  await expect(page.locator("#storyViewLink")).toHaveAttribute("href", "/story/active-new");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("infiniteQuestLastCampaignId"))).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem("infiniteQuestStoryDraft:preserve"))).toBe("draft-preserved");
  expect(await page.evaluate(() => localStorage.getItem("infiniteQuestReaderPreference:preserve"))).toBe("preference-preserved");
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: `${screenshots}/t06-dashboard-resume-target.png`, fullPage: true });
});

test("dashboard permits an archived campaign after an explicit Campaigns selection", async ({ page }) => {
  const campaigns = [
    dashboardCampaign("archived-explicit", "Archived Story", "archived", "2026-10-02T00:00:00.000Z"),
    dashboardCampaign("active-default", "Active Story", "active", "2026-10-01T00:00:00.000Z")
  ];
  await installDashboardApi(page, campaigns);
  await page.goto(`${origin}/nexus/index.html#campaigns`);
  await page.locator('#campaignList [data-campaign-id="archived-explicit"]').click();
  await expect(page.locator("#storyViewLink")).toHaveAttribute("href", "/story/archived-explicit");
});

test("dashboard disables resume with no campaigns and retries a failed campaign-list request", async ({ page }) => {
  const api = await installDashboardApi(page, [], { failOnce: true });
  await page.goto(`${origin}/nexus/index.html`);

  await expect(page.locator("#dashboardStoryLink")).toHaveAttribute("aria-disabled", "true");
  await expect(page.locator("#dashboardCampaigns")).toContainText("could not be loaded");
  await page.locator("#campaignLoadRetry").click();
  await expect.poll(() => api.campaignRequests()).toBe(2);
  await expect(page.locator("#dashboardCampaigns")).toContainText("No campaigns yet");
  await expect(page.locator("#dashboardStoryLink")).toHaveAttribute("href", "/nexus/#campaigns");
});
