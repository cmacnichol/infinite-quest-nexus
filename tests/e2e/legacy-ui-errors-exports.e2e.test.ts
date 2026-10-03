import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { installLegacyUiFixture, legacyUiFixture } from "./helpers/legacy-ui-fixtures.js";

const origin = `http://127.0.0.1:${process.env.PLAYWRIGHT_LEGACY_PORT ?? "43173"}`;

test("startup_error_visible_on_dashboard while successful siblings stay available", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount: 1 });
  let worldAttempts = 0;
  await installLegacyUiFixture(page, fixture);
  await page.route("**/api/v1/worlds", async route => {
    worldAttempts += 1;
    if (worldAttempts === 1) {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "World list unavailable", correlationId: "safe-world-correlation" }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ worlds: fixture.worlds }) });
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${origin}/nexus/index.html`);

  await expect(page.locator("#dashboardWorkflowStatus")).toContainText("Worlds could not be loaded");
  await expect(page.locator("#workflowDashboardRetryWorlds")).toBeVisible();
  await expect(page.locator("#dashboardCampaigns [data-campaign-id]")).toHaveCount(1);
  await page.screenshot({ path: ".superpowers/sdd/legacy-ui-2026-10-03/evidence/T24/dashboard-startup-error-desktop.png", fullPage: false });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("#dashboardWorkflowStatus")).toBeVisible();
  await page.screenshot({ path: ".superpowers/sdd/legacy-ui-2026-10-03/evidence/T24/dashboard-startup-error-mobile.png", fullPage: false });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.locator("#workflowDashboardRetryWorlds").click();
  await expect(page.locator("#dashboardWorlds [data-world-id]")).toHaveCount(1);
  await expect(page.locator("#dashboardWorkflowStatus")).toBeHidden();
  expect(worldAttempts).toBe(2);
});

test("campaign_and_provider_startup_errors_have_independent_dashboard_retries", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount: 1 });
  await installLegacyUiFixture(page, fixture);
  let campaignAttempts = 0;
  let providerAttempts = 0;
  await page.route("**/api/v1/campaigns", async route => {
    campaignAttempts += 1;
    if (campaignAttempts === 1) {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Campaign details must stay private" }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ campaigns: fixture.campaigns }) });
  });
  await page.route("**/api/v1/providers", async route => {
    providerAttempts += 1;
    if (providerAttempts === 1) {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Provider details must stay private" }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ providers: [] }) });
  });
  await page.goto(`${origin}/nexus/index.html`);

  await expect(page.locator("#dashboardWorkflowStatus [data-workflow='campaigns']")).toContainText("Campaigns could not be loaded");
  await expect(page.locator("#dashboardWorkflowStatus [data-workflow='providers']")).toContainText("Provider profiles could not be loaded");
  await expect(page.locator("#dashboardWorkflowStatus")).not.toContainText("must stay private");
  await expect(page.locator("#dashboardWorlds [data-world-id]")).toHaveCount(1);
  await page.locator("#workflowDashboardRetryCampaigns").click();
  await expect(page.locator("#dashboardCampaigns [data-campaign-id]")).toHaveCount(1);
  await page.locator("#workflowDashboardRetryProviders").click();
  await expect(page.locator("#dashboardWorkflowStatus")).toBeHidden();
  expect(campaignAttempts).toBe(2);
  expect(providerAttempts).toBe(2);
});

test("retry_does_not_duplicate_writes after a separately retried list read", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount: 1 });
  let committedTitle = "Fixture Campaign 1";
  let campaignReads = 0;
  const writes: string[] = [];
  await installLegacyUiFixture(page, fixture);
  await page.route("**/api/v1/campaigns**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "PATCH" && url.pathname.endsWith(`/${fixture.campaignId}`)) {
      writes.push("PATCH");
      const body = request.postDataJSON() as { title?: string };
      committedTitle = body.title || committedTitle;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...fixture.campaigns[0], title: committedTitle }) });
      return;
    }
    if (request.method() === "GET" && url.pathname === "/api/v1/campaigns") {
      campaignReads += 1;
      if (writes.length && campaignReads > 1 && campaignReads === 2) {
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Campaign list unavailable", correlationId: "safe-campaign-correlation" }) });
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ campaigns: fixture.campaigns.map(campaign => ({ ...campaign, title: committedTitle })) }) });
      return;
    }
    await route.fallback();
  });
  await page.goto(`${origin}/nexus/index.html#campaigns`);
  await page.locator(`#campaignList [data-campaign-id="${fixture.campaignId}"]`).click();
  await page.locator("#campaignTitle").fill("Saved exactly once");
  await page.locator("#saveCampaign").click();
  await expect(page.locator("#campaignSaveStatus")).toHaveAttribute("data-state", "saved");
  await page.locator("#refreshCampaigns").click();
  await expect(page.locator("#campaignStatusMessage")).toContainText("Campaigns could not be refreshed");
  await page.locator("#workflowRetryCampaigns").click();
  await expect(page.locator("#campaignTitle")).toHaveValue("Saved exactly once");
  expect(writes).toEqual(["PATCH"]);
  await expect(page.locator("#campaignSaveStatus")).toHaveAttribute("data-state", "saved");
});

test("campaign_list_retry_keeps_the_latest_missing_route_and_selected_campaign", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount: 1 });
  const missingCampaignId = "10000000-0000-4000-8000-000000009999";
  let campaignReads = 0;
  await installLegacyUiFixture(page, fixture);
  await page.route("**/api/v1/campaigns", async route => {
    campaignReads += 1;
    if (campaignReads === 2 || campaignReads === 3) {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Private database diagnostics" }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ campaigns: fixture.campaigns }) });
  });
  await page.goto(`${origin}/nexus/index.html#campaigns`);
  await page.locator(`#campaignList [data-campaign-id="${fixture.campaignId}"]`).click();
  await page.evaluate(id => { window.location.hash = `#campaigns?campaignId=${encodeURIComponent(id)}`; }, missingCampaignId);
  await expect(page.locator("#campaignStatusMessage")).toContainText("not available in this library");
  await page.locator("#workflowRetryCampaigns").click();

  await expect(page.locator("#workflowRetryCampaigns")).toBeVisible();
  await expect(page.locator("#campaignStatusMessage")).toContainText("not available in this library");
  await expect(page.locator("#campaignStatusMessage")).not.toContainText("Private database diagnostics");
  await expect(page.locator("#campaignStatusMessage .workflow-retry-feedback")).toHaveCount(1);
  await page.locator("#workflowRetryCampaigns").click();
  await expect(page.locator("#campaignStatusMessage .workflow-retry-feedback")).toHaveCount(1);
  await expect(page.locator("#campaignStatusMessage")).not.toContainText("Private database diagnostics");
  await page.locator("#workflowRetryCampaigns").click();
  await expect(page.locator("#campaignTitle")).toHaveValue("Fixture Campaign 1");
  await expect(page).toHaveURL(new RegExp(`#campaigns\\?campaignId=${missingCampaignId}$`, "u"));
  await expect(page.locator("#campaignStatusMessage")).toContainText(missingCampaignId);
  expect(campaignReads).toBe(4);
});

test("html_error_rendered_as_text with only safe correlation detail", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount: 0 });
  await installLegacyUiFixture(page, fixture);
  await page.route("**/api/v1/worlds/*", route => route.fulfill({
    status: 503,
    contentType: "application/json",
    headers: { "x-correlation-id": "safe-html-correlation" },
    body: JSON.stringify({ message: "<img src=x onerror=alert(1)> diagnostic details are private" })
  }));
  await page.goto(`${origin}/nexus/index.html#world-library`);
  await page.locator(`#worldManagementCarousel [data-world-id="${fixture.worldId}"]`).click();

  await expect(page.locator("#worldStatus")).toContainText("could not be loaded");
  await expect(page.locator("#worldStatus")).toContainText("safe-html-correlation");
  await expect(page.locator("#worldStatus img")).toHaveCount(0);
  await expect(page.locator("#worldStatus")).not.toContainText("diagnostic details are private");
});

test("export_reading_goes_story without starting a download", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount: 1 });
  await installLegacyUiFixture(page, fixture);
  let downloaded = false;
  page.on("download", () => { downloaded = true; });
  await page.goto(`${origin}/nexus/index.html#campaigns`);
  await page.locator(`#campaignList [data-campaign-id="${fixture.campaignId}"]`).click();
  await expect(page.locator("#campaignTitle")).toHaveValue("Fixture Campaign 1");
  const storyHtml = (await readFile("apps/web/public/story.html", "utf8"))
    .replace("/nexus/legacy-client.js", "/nexus/src/legacy-client-entry.ts");
  await page.route(`**/story/${fixture.campaignId}`, route => route.fulfill({ contentType: "text/html", body: storyHtml }));
  await page.goto(`${origin}/nexus/index.html#data-transfer`);

  await expect(page.locator("#readingStoryExportLink")).toHaveAttribute("href", `/story/${fixture.campaignId}`);
  await page.locator("#readingStoryExportLink").click();
  await expect(page).toHaveURL(new RegExp(`/story/${fixture.campaignId}$`, "u"));
  await page.locator('[aria-controls="storyExportMenu"]').click();
  await expect(page.locator("#storyExportMenu")).toBeVisible();
  await expect(page.locator("#storyExportMenu").getByRole("button", { name: /Markdown|HTML|PDF/u })).toHaveCount(3);
  expect(downloaded).toBe(false);
});

test("archive_export_stays_zip and distinct from readable copies", async ({ page }) => {
  await page.goto(`${origin}/nexus/index.html#data-transfer`);
  await expect(page.locator("#systemArchiveTitle")).toHaveText("System Archive");
  await expect(page.locator("#systemArchiveTitle").locator("xpath=.."))
    .toContainText("ZIP");
  await expect(page.locator("#createSystemArchive")).toHaveText("Create System Archive");
  await expect(page.locator("#readingStoryExportLink")).toContainText("Choose a campaign to open its Story exports");
  await expect(page.locator("#readingStoryExportLink")).toHaveAttribute("href", "/nexus/#campaigns");
});

test("missing_campaign_not_empty_adventure keeps the Story recovery view authoritative", async ({ page }) => {
  const missingCampaignId = "10000000-0000-4000-8000-000000009999";
  const storyHtml = (await readFile("apps/web/public/story.html", "utf8"))
    .replace("/nexus/legacy-client.js", "/nexus/src/legacy-client-entry.ts");
  await page.route(`**/story/${missingCampaignId}`, route => route.fulfill({ contentType: "text/html", body: storyHtml }));
  await page.route("**/api/v1/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/sync-status")) {
      await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ code: "campaign_not_found", message: "Campaign not found" }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ campaigns: [], worlds: [] }) });
  });
  await page.goto(`${origin}/story/${missingCampaignId}`);
  await expect(page.locator("#storyLoadRecovery")).toContainText("Campaign not found");
  await expect(page.locator("#storyArea .turn")).toHaveCount(0);
  await expect(page.getByText("No adventure yet", { exact: false })).toHaveCount(0);
  await expect(page.locator("#storyLoadRecovery a")).toHaveAttribute("href", "/nexus/#campaigns");
});
