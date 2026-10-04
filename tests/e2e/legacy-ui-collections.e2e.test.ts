import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { installLegacyUiFixture, legacyUiFixture } from "./helpers/legacy-ui-fixtures.js";
import type { LegacyUiRequestRecord } from "./helpers/legacy-ui-fixtures.types.js";

const origin = `http://127.0.0.1:${process.env.PLAYWRIGHT_LEGACY_PORT ?? "43173"}`;
const evidenceDirectory = join(process.cwd(), ".superpowers", "sdd", "legacy-ui-2026-10-03", "evidence", "T22");

function collectionsFixture() {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 39, campaignCount: 59 });
  fixture.campaigns.forEach((campaign, index) => {
    campaign.status = index === 0 ? "archived" : "active";
    campaign.title = index === 0 ? "Archived Expedition" : index < 3 ? "Repeated Expedition" : `Expedition ${String(index).padStart(2, "0")}`;
    campaign.updatedAt = "2026-10-03T12:00:00.000Z";
  });
  fixture.worlds.forEach((world, index) => {
    world.status = index === 0 ? "draft" : index === 1 ? "archived" : "active";
    world.title = index === 1 ? "Archived World" : index < 3 ? "Repeated World" : `Fixture World ${String(index + 1).padStart(2, "0")}`;
    world.updatedAt = "2026-10-03T12:00:00.000Z";
    if (index === 0) {
      world.latestVersionId = null;
      world.latestVersionNumber = null;
    }
  });
  return fixture;
}

function worldDetailRequests(requests: ReadonlyArray<LegacyUiRequestRecord>) {
  return requests.filter((request) => request.method === "GET" && /^\/api\/v1\/worlds\/[0-9a-f-]+$/iu.test(request.path));
}

test("archived_excluded_from_default_resume_and_recent_panel_is_compact", async ({ page }) => {
  const fixture = collectionsFixture();
  await installLegacyUiFixture(page, fixture);
  await page.goto(`${origin}/nexus/index.html#dashboard`);

  const activeIds = fixture.campaigns.filter((campaign) => campaign.status === "active").map((campaign) => campaign.id);
  const archivedId = String(fixture.campaigns[0]?.id);
  await expect(page.locator("#dashboardCampaigns [data-campaign-id]")).toHaveCount(5);
  await expect(page.locator(`#dashboardCampaigns [data-campaign-id="${archivedId}"]`)).toHaveCount(0);
  await expect(page.locator("#dashboardStoryLink")).toHaveAttribute("href", `/story/${activeIds[0]}`);

  await page.goto(`${origin}/nexus/index.html#campaigns`);
  await page.locator("#managementCampaignStatus").selectOption("archived");
  await expect(page.locator(`#campaignList [data-campaign-id="${archivedId}"]`)).toHaveCount(1);
  await expect(page.locator("#managementCampaignResults")).toHaveText("Showing 1 of 59 campaigns");
});

test("same_titles_distinct_ids_and_equal_sort_keys_are_stable", async ({ page }) => {
  const fixture = collectionsFixture();
  await installLegacyUiFixture(page, fixture);
  await page.goto(`${origin}/nexus/index.html#campaigns`);
  const sameTitleIds = fixture.campaigns.slice(1, 3).map((campaign) => String(campaign.id)).sort();
  await page.locator("#managementCampaignSearch").fill("Repeated Expedition");
  await expect(page.locator("#campaignList [data-campaign-id]")).toHaveCount(2);
  await page.locator("#managementCampaignSort").selectOption("title");
  await expect(page.locator("#campaignList [data-campaign-id]").nth(0)).toHaveAttribute("data-campaign-id", sameTitleIds[0]!);
  await expect(page.locator("#campaignList [data-campaign-id]").nth(1)).toHaveAttribute("data-campaign-id", sameTitleIds[1]!);
  expect(await page.locator("#campaignList [data-campaign-id]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-campaign-id")))).toEqual(sameTitleIds);

  await page.goto(`${origin}/nexus/index.html#world-library`);
  const sameTitleWorldIds = [String(fixture.worlds[0]?.id), String(fixture.worlds[2]?.id)].sort();
  await page.locator("#managementWorldSearch").fill("Repeated World");
  await expect(page.locator("#worldManagementCarousel [data-world-id]")).toHaveCount(2);
  await page.locator("#managementWorldSort").selectOption("title");
  expect(await page.locator("#worldManagementCarousel [data-world-id]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-world-id")))).toEqual(sameTitleWorldIds);
});

test("search_debounces_collection_render_for_250ms", async ({ page }) => {
  const fixture = collectionsFixture();
  await installLegacyUiFixture(page, fixture);
  await page.goto(`${origin}/nexus/index.html#campaigns`);
  await expect(page.locator("#managementCampaignResults")).toHaveText("Showing 58 of 59 campaigns");
  const collectionClockTime = new Date("2030-01-01T00:00:00.000Z");
  await page.clock.install({ time: collectionClockTime });
  await page.clock.pauseAt(collectionClockTime);
  const search = page.locator("#managementCampaignSearch");
  await search.fill("Expedition 58");
  await page.clock.runFor(249);
  await expect(page.locator("#managementCampaignResults")).toHaveText("Showing 58 of 59 campaigns");
  await expect(search).toBeFocused();
  await page.clock.runFor(1);
  await expect(page.locator("#managementCampaignResults")).toHaveText("Showing 1 of 59 campaigns");
  await expect(search).toBeFocused();
});

test("search_and_status_combine_and_no_results_has_clear_filters", async ({ page }) => {
  const fixture = collectionsFixture();
  await installLegacyUiFixture(page, fixture);
  await page.goto(`${origin}/nexus/index.html#campaigns`);
  await page.locator("#managementCampaignStatus").selectOption("archived");
  await page.locator("#managementCampaignSearch").fill("Archived Expedition");
  await expect(page.locator("#campaignList [data-campaign-id]")).toHaveCount(1);
  await expect(page.locator("#managementCampaignResults")).toHaveText("Showing 1 of 59 campaigns");

  await page.locator("#managementCampaignSearch").fill("no synthetic campaign matches");
  await expect(page.locator("#campaignList")).toContainText("No campaigns match this search and filter.");
  await page.getByRole("button", { name: "Clear campaign search and filters" }).click();
  await expect(page.locator("#managementCampaignSearch")).toHaveValue("");
  await expect(page.locator("#managementCampaignStatus")).toHaveValue("active");
  await expect(page.locator("#managementCampaignResults")).toHaveText("Showing 58 of 59 campaigns");
});

test("keyboard_selection_persists_through_collection_rerenders", async ({ page }) => {
  const fixture = collectionsFixture();
  await installLegacyUiFixture(page, fixture);
  await page.goto(`${origin}/nexus/index.html#campaigns`);
  const search = page.locator("#managementCampaignSearch");
  await search.fill("Repeated");
  const firstId = String(fixture.campaigns[1]?.id);
  const firstButton = page.locator(`#campaignList [data-campaign-id="${firstId}"]`);
  await firstButton.focus();
  await page.keyboard.press("Enter");
  await expect(firstButton).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#campaignTitle")).toHaveValue("Repeated Expedition");
  await search.fill("Repeated Expedition");
  await expect(firstButton).toHaveAttribute("aria-pressed", "true");
  await expect(search).toBeFocused();
  await page.locator("#managementCampaignSort").selectOption("title");
  await expect(firstButton).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#campaignTitle")).toHaveValue("Repeated Expedition");
});

test("zero_extra_detail_requests_on_search_after_initial_hydration", async ({ page }) => {
  const fixture = collectionsFixture();
  const api = await installLegacyUiFixture(page, fixture);
  await mkdir(evidenceDirectory, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${origin}/nexus/index.html#world-library`);
  await expect(page.locator("#managementWorldResults")).toHaveText("Showing 39 of 39 worlds");
  await expect.poll(() => worldDetailRequests(api.requests).length).toBe(37);
  await expect.poll(() => worldDetailRequests(api.requests).every((request) => request.finishedAt !== undefined)).toBe(true);
  const initialDetailRequestCount = worldDetailRequests(api.requests).length;

  await page.locator("#managementWorldSearch").fill("Fixture World 39");
  await expect(page.locator("#managementWorldResults")).toHaveText("Showing 1 of 39 worlds");
  expect(worldDetailRequests(api.requests)).toHaveLength(initialDetailRequestCount);
  await page.locator("#managementWorldFilters [data-world-filter='archived']").click();
  await expect(page.locator("#managementWorldResults")).toHaveText("Showing 0 of 39 worlds");
  await page.locator("#managementWorldSearch").fill("Repeated World");
  await expect(page.locator("#managementWorldResults")).toHaveText("Showing 0 of 39 worlds");
  await page.locator("#managementWorldSearch").fill("Archived World");
  await expect(page.locator("#managementWorldResults")).toHaveText("Showing 1 of 39 worlds");
  await page.locator("#managementWorldFilters [data-world-filter='all']").click();
  await expect(page.locator("#managementWorldResults")).toHaveText("Showing 1 of 39 worlds");
  await page.locator("#managementWorldSearch").fill("no synthetic world matches");
  await expect(page.locator("#worldManagementCarousel")).toContainText("No worlds match this search and filter.");
  await page.getByRole("button", { name: "Clear world search and filters" }).click();
  await expect(page.locator("#managementWorldResults")).toHaveText("Showing 39 of 39 worlds");
  expect(worldDetailRequests(api.requests)).toHaveLength(initialDetailRequestCount);

  await page.goto(`${origin}/nexus/index.html#dashboard`);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => window.scrollTo(0, 0));
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await expect(page.locator("#dashboardCampaigns [data-campaign-id]")).toHaveCount(5);
  const firstRecentCard = page.locator("#dashboardCampaigns [data-campaign-id]").first();
  const firstRecentTitle = firstRecentCard.locator(".card-body h3");
  const firstRecentAction = firstRecentCard.locator(".card-cta");
  await expect(firstRecentTitle).toBeVisible();
  await expect(firstRecentAction).toContainText("Resume story");
  for (const visibleTarget of [firstRecentTitle, firstRecentAction]) {
    const bounds = await visibleTarget.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1280);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(800);
  }
  await page.screenshot({ path: join(evidenceDirectory, "dashboard-collections-desktop.png"), fullPage: false });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: join(evidenceDirectory, "dashboard-collections-narrow.png"), fullPage: false });

  await page.goto(`${origin}/nexus/index.html#campaigns`);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: join(evidenceDirectory, "campaign-collections-desktop.png"), fullPage: false });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: join(evidenceDirectory, "campaign-collections-narrow.png"), fullPage: false });
});
