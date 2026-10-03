import { expect, test } from "@playwright/test";
import { installLegacyUiFixture, legacyUiFixture } from "./helpers/legacy-ui-fixtures.js";

const origin = `http://127.0.0.1:${process.env.PLAYWRIGHT_LEGACY_PORT ?? "43173"}`;

async function navigateFromSetupMenu(page: import("@playwright/test").Page, destinationId: string): Promise<void> {
  const setup = page.locator("#navSetup");
  if (await setup.getAttribute("aria-expanded") !== "true") await setup.click();
  await page.locator(`#${destinationId}`).click();
}

test("worlds_hides_campaign_workspace", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 2, campaignCount: 2 });
  const api = await installLegacyUiFixture(page, fixture);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${origin}/nexus/index.html#world-library`);

  await expect(page.locator("body")).toHaveAttribute("data-management-view", "worlds");
  await expect(page.locator("#world-library")).toBeVisible();
  await expect(page.locator("#campaigns")).toBeHidden();
  expect(api.writes).toEqual([]);
});

test("campaigns_retains_selection", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 2, campaignCount: 2 });
  await installLegacyUiFixture(page, fixture);
  await page.goto(`${origin}/nexus/index.html#campaigns`);
  const campaignA = fixture.campaigns[0];
  const campaignB = fixture.campaigns[1];
  const worldB = fixture.worlds[1];
  if (!campaignA || !campaignB || !worldB) throw new Error("The two-campaign/two-world fixture was not created.");

  await page.locator(`#campaignList [data-campaign-id="${campaignB.id}"]`).click();
  await expect(page.locator(`#campaignList [data-campaign-id="${campaignB.id}"]`)).toHaveClass(/active/u);
  await expect(page.locator("#campaignTitle")).toHaveValue(String(campaignB.title));
  await navigateFromSetupMenu(page, "navWorlds");
  await page.locator(`#worldManagementCarousel [data-world-id="${worldB.id}"]`).click();
  await expect(page.locator(`#worldManagementCarousel [data-world-id="${worldB.id}"]`)).toHaveAttribute("aria-pressed", "true");
  await navigateFromSetupMenu(page, "navCampaigns");

  await expect(page.locator(`#campaignList [data-campaign-id="${campaignB.id}"]`)).toHaveClass(/active/u);
  await expect(page.locator("#campaignTitle")).toHaveValue(String(campaignB.title));
  await expect(page.locator(`#worldManagementCarousel [data-world-id="${worldB.id}"]`)).toHaveAttribute("aria-pressed", "true");
});

test("direct_hash_selects_correct_workspace", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount: 1 });
  await installLegacyUiFixture(page, fixture);

  await page.goto(`${origin}/nexus/index.html#campaigns`);
  await expect(page.locator("body")).toHaveAttribute("data-management-view", "campaigns");
  await expect(page.locator("#managementTitle")).toHaveText("Campaign Management");
  await expect(page.locator("#campaigns")).toBeVisible();
  await expect(page.locator("#world-library")).toBeHidden();
  await expect(page.locator("#prompt-library")).toBeHidden();
  await expect(page.locator("#providers")).toBeHidden();
  await expect(page.locator("#data-transfer")).toBeHidden();

  await page.goto(`${origin}/nexus/index.html#world-library`);
  await expect(page.locator("body")).toHaveAttribute("data-management-view", "worlds");
  await expect(page.locator("#world-library-title")).toBeVisible();
  await expect(page.locator("#campaigns")).toBeHidden();

  await page.goto(`${origin}/nexus/index.html#imports`);
  await expect(page.locator("body")).toHaveAttribute("data-management-view", "data-transfer");
  await expect(page.locator("#campaigns")).toBeHidden();
  await expect(page.locator("#prompt-library")).toBeHidden();
  await expect(page.locator("#data-transfer")).toBeVisible();
  await page.goto(`${origin}/nexus/index.html#prompt-library`);
  await expect(page.locator("body")).toHaveAttribute("data-management-view", "prompt-library");
  await expect(page.locator("#prompt-library")).toBeVisible();
  await expect(page.locator("#campaigns")).toBeHidden();
});

test("dirty_back_navigation_stays", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount: 1 });
  const api = await installLegacyUiFixture(page, fixture);
  await page.goto(`${origin}/nexus/index.html#campaigns`);
  const campaign = fixture.campaigns[0];
  if (!campaign) throw new Error("The one-campaign fixture was not created.");
  await page.locator(`#campaignList [data-campaign-id="${campaign.id}"]`).click();
  await expect(page.locator("#campaignTitle")).toHaveValue("Fixture Campaign 1");
  await page.evaluate(() => { window.location.hash = "#world-library"; });
  await expect(page.locator("body")).toHaveAttribute("data-management-view", "worlds");
  await page.evaluate(() => { window.location.hash = "#campaigns"; });
  await expect(page.locator("body")).toHaveAttribute("data-management-view", "campaigns");
  await page.locator("#campaignTitle").fill("Unsaved synthetic campaign title");

  await page.goBack();
  await expect(page.locator("#discardChangesDialog")).toBeVisible();
  await expect(page.locator("#saveCampaignEditsDecision")).toBeVisible();
  await page.locator('#discardChangesDialog button[value="keep"]').click();

  await expect(page).toHaveURL(/#campaigns$/u);
  await expect(page.locator("body")).toHaveAttribute("data-management-view", "campaigns");
  await expect(page.locator("#campaignTitle")).toHaveValue("Unsaved synthetic campaign title");
  expect(api.writes).toEqual([]);
});

test("crosslink_carries_id", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 2, campaignCount: 1 });
  await installLegacyUiFixture(page, fixture);
  const campaign = fixture.campaigns[0];
  const world = fixture.worlds[0];
  if (!campaign || !world) throw new Error("The one-campaign/two-world fixture was not created.");

  await page.goto(`${origin}/nexus/index.html#campaigns?campaignId=${campaign.id}`);
  await expect(page.locator("#campaignTitle")).toHaveValue(String(campaign.title));
  const authoredWorldLink = page.locator("#campaignWorldLink");
  await expect(authoredWorldLink).toHaveAttribute("href", `#world-library?worldId=${world.id}`);
  await authoredWorldLink.click();

  await expect(page).toHaveURL(new RegExp(`#world-library\\?worldId=${world.id}$`, "u"));
  await expect(page.locator(`#worldManagementCarousel [data-world-id="${world.id}"]`)).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#worldEditorTitle")).toHaveText(String(world.title));
});

test("direct_record_links_select_exact_uuid_and_report_invalid_or_missing_targets", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 2, campaignCount: 2 });
  await installLegacyUiFixture(page, fixture);
  const world = fixture.worlds[1];
  if (!world) throw new Error("The two-world fixture was not created.");

  await page.goto(`${origin}/nexus/index.html#world-library?worldId=${String(world.id).toUpperCase()}`);
  await expect(page.locator("#worldEditorTitle")).toHaveText(String(world.title));
  await expect(page.locator(`#worldManagementCarousel [data-world-id="${world.id}"]`)).toHaveAttribute("aria-pressed", "true");

  await page.goto(`${origin}/nexus/index.html?invalid-world=1#world-library?worldId=not-a-uuid`);
  await expect(page.locator("#worldStatus")).toContainText("valid world ID");
  await expect(page.locator("#worldManagementCarousel [aria-pressed='true']")).toHaveCount(0);

  await page.goto(`${origin}/nexus/index.html?missing-campaign=1#campaigns?campaignId=10000000-0000-4000-8000-000000009999`);
  await expect(page.locator("#campaignStatusMessage")).toContainText("not available in this library");
  await expect(page.locator("#campaignTitle")).toBeDisabled();
  await expect(page.locator("#campaignList .campaign-button.active")).toHaveCount(0);
});

test("dirty_menu_navigation_save_failure_keeps_workspace_open_and_discard_accepts_destination", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount: 1 });
  const campaign = fixture.campaigns[0];
  if (!campaign) throw new Error("The one-campaign fixture was not created.");
  const api = await installLegacyUiFixture(page, fixture, { failures: { [`PATCH /api/v1/campaigns/${campaign.id}`]: 503 } });
  await page.goto(`${origin}/nexus/index.html#campaigns`);
  await page.locator(`#campaignList [data-campaign-id="${campaign.id}"]`).click();
  await page.locator("#campaignTitle").fill("Unsaved synthetic title");
  await navigateFromSetupMenu(page, "navWorlds");
  await expect(page.locator("#discardChangesDialog")).toBeVisible();
  await page.locator("#saveCampaignEditsDecision").click();
  await expect(page.locator("#campaignTitle")).toHaveValue("Unsaved synthetic title");
  await expect(page.locator("#campaignStatusMessage")).toContainText("A configured synthetic route failure.");
  await expect(page.locator("body")).toHaveAttribute("data-management-view", "campaigns");
  expect(api.writes.filter(write => write.method === "PATCH" && write.path.endsWith(`/${campaign.id}`))).toHaveLength(1);

  await navigateFromSetupMenu(page, "navWorlds");
  await page.locator('#discardChangesDialog button[value="discard"]').click();
  await expect(page.locator("body")).toHaveAttribute("data-management-view", "worlds");
  await expect(page).toHaveURL(/#world-library$/u);
  expect(api.writes.filter(write => write.method === "PATCH" && write.path.endsWith(`/${campaign.id}`))).toHaveLength(1);

});

test("dirty_menu_navigation_save_success_accepts_destination", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount: 1 });
  const campaign = fixture.campaigns[0];
  if (!campaign) throw new Error("The one-campaign fixture was not created.");
  const api = await installLegacyUiFixture(page, fixture);
  await page.goto(`${origin}/nexus/index.html#campaigns`);
  await page.locator(`#campaignList [data-campaign-id="${campaign.id}"]`).click();
  await page.locator("#campaignTitle").fill("Saved synthetic title");
  await navigateFromSetupMenu(page, "navWorlds");
  await page.locator("#saveCampaignEditsDecision").click();
  await expect(page.locator("body")).toHaveAttribute("data-management-view", "worlds");
  await expect(page).toHaveURL(/#world-library$/u);
  expect(api.writes.filter(write => write.method === "PATCH" && write.path.endsWith(`/${campaign.id}`))).toHaveLength(1);
});

test("stale_world_load_cannot_replace_a_newer_deep_link_selection", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 2, campaignCount: 1 });
  const first = fixture.worlds[0];
  const second = fixture.worlds[1];
  if (!first || !second) throw new Error("The two-world fixture was not created.");
  const api = await installLegacyUiFixture(page, fixture, { delays: { [`GET /api/v1/worlds/${first.id}`]: 800 } });
  const firstRequest = page.waitForRequest(request => request.url().endsWith(`/api/v1/worlds/${first.id}`));
  await page.goto(`${origin}/nexus/index.html#world-library?worldId=${first.id}`);
  await firstRequest;
  await page.evaluate((worldId) => { window.location.hash = `#world-library?worldId=${worldId}`; }, second.id);
  await expect(page.locator("#worldEditorTitle")).toHaveText(String(second.title));
  api.releaseDelayedRoute();
  await expect(page.locator("#worldEditorTitle")).toHaveText(String(second.title));
  await expect(page.locator(`#worldManagementCarousel [data-world-id="${second.id}"]`)).toHaveAttribute("aria-pressed", "true");
});

test("rapid_history_intent_keeps_latest_route_after_stay_and_another_navigation", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount: 1 });
  const api = await installLegacyUiFixture(page, fixture);
  const campaign = fixture.campaigns[0];
  if (!campaign) throw new Error("The one-campaign fixture was not created.");
  await page.goto(`${origin}/nexus/index.html#dashboard`);
  await navigateFromSetupMenu(page, "navWorlds");
  await navigateFromSetupMenu(page, "navCampaigns");
  await page.locator(`#campaignList [data-campaign-id="${campaign.id}"]`).click();
  await page.locator("#campaignTitle").fill("Preserve selection across navigation race");
  await page.goBack();
  await expect(page).toHaveURL(/#campaigns$/u);
  await page.goBack();
  await expect(page.locator("#discardChangesDialog")).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(/#campaigns$/u);
  await page.locator('#discardChangesDialog button[value="keep"]').click();
  await expect(page.locator("#campaignTitle")).toHaveValue("Preserve selection across navigation race");
  await page.goBack();
  await expect(page.locator("#discardChangesDialog")).toBeVisible();
  await page.locator('#discardChangesDialog button[value="keep"]').click();
  await expect(page).toHaveURL(/#campaigns$/u);
  const acceptedIndex = await page.evaluate(() => (window.history.state as { __infiniteQuestNexusManagement?: { index: number } }).__infiniteQuestNexusManagement?.index ?? -1);
  await page.evaluate(() => {
    window.location.hash = "#providers";
    window.setTimeout(() => { window.location.hash = "#world-library"; }, 0);
  });
  await expect(page.locator("#discardChangesDialog")).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window.history.state as { __infiniteQuestNexusManagement?: { index: number } }).__infiniteQuestNexusManagement?.index ?? -1)).toBe(acceptedIndex + 2);
  await page.locator('#discardChangesDialog button[value="keep"]').click();
  await expect(page.locator("body")).toHaveAttribute("data-management-view", "campaigns");
  await expect(page).toHaveURL(/#campaigns$/u);
  await page.evaluate(() => { window.location.hash = "#world-library"; });
  await page.locator('#discardChangesDialog button[value="discard"]').click();
  await expect(page.locator("body")).toHaveAttribute("data-management-view", "worlds");
  await expect(page.locator("#worldManagementCarousel [aria-pressed='true']")).toHaveCount(0);
  expect(api.writes.filter(write => write.method === "PATCH")).toHaveLength(0);
});

test("campaign_world_link_and_world_detail_edit_link_carry_authoritative_ids", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 2, campaignCount: 1 });
  await installLegacyUiFixture(page, fixture);
  const campaign = fixture.campaigns[0];
  const worldA = fixture.worlds[0];
  const worldB = fixture.worlds[1];
  if (!campaign || !worldA || !worldB) throw new Error("The campaign/two-world fixture was not created.");
  await page.goto(`${origin}/nexus/index.html#campaigns?campaignId=${campaign.id}`);
  await expect(page.locator("#campaignWorldLink")).toHaveAttribute("href", `#world-library?worldId=${campaign.worldId}`);
  await page.goto(`${origin}/nexus/index.html#dashboard`);
  await page.locator(`#dashboardWorlds [data-world-id="${worldB.id}"]`).click();
  await expect(page.locator("#worldDetailsDialog")).toBeVisible();
  await expect(page.locator("#editWorldDetails")).toHaveAttribute("href", `#world-library?worldId=${worldB.id}`);
  await page.locator("#editWorldDetails").click();
  await expect(page.locator(`#worldManagementCarousel [data-world-id="${worldB.id}"]`)).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#worldEditorTitle")).toHaveText(String(worldB.title));
});

test("committed_campaign_recovery_modal_remains_reachable_during_route_intent", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount: 1 });
  await installLegacyUiFixture(page, fixture);
  let campaignListReads = 0;
  await page.route("**/api/v1/campaigns", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ id: "10000000-0000-4000-8000-000000008888", title: "Committed fixture" }) });
      return;
    }
    campaignListReads += 1;
    if (campaignListReads > 1) {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Refresh failed after commit." }) });
      return;
    }
    await route.fallback();
  });
  const world = fixture.worlds[0];
  if (!world) throw new Error("The one-world fixture was not created.");
  await page.goto(`${origin}/nexus/index.html#world-library?worldId=${world.id}`);
  await page.locator("#createCampaignModalBtn").click();
  await expect(page.locator("#createCampaignDialog")).toBeVisible();
  await page.locator("#newCampaignTitle").fill("Committed recovery fixture");
  await page.locator("#newCampaignCharacter").selectOption("fixture-observer");
  await page.getByRole("button", { name: "Create only" }).click();
  await expect(page.getByRole("button", { name: "Open story" })).toBeVisible();
  await page.evaluate(() => { window.location.hash = "#world-library"; });
  await expect(page.locator("#createCampaignDialog")).toBeVisible();
  await expect(page.locator("body")).toHaveAttribute("data-management-view", "worlds");
  await expect(page.locator("#world-library")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`#world-library\\?worldId=${world.id}$`, "u"));
});

test("unindexed_back_stay_returns_one_step_without_growing_history", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, "navigation", { value: undefined, configurable: true }));
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount: 1 });
  const api = await installLegacyUiFixture(page, fixture);
  const campaign = fixture.campaigns[0];
  if (!campaign) throw new Error("The one-campaign fixture was not created.");
  await page.goto(`${origin}/nexus/index.html#providers`);
  await page.evaluate((campaignId) => {
    window.history.replaceState({ unrelated: "preserved predecessor" }, "", window.location.href);
    window.history.pushState({ unrelatedEntry: "also preserved" }, "", `#campaigns?campaignId=${campaignId}`);
    window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
  }, campaign.id);
  await expect(page.locator("#campaignTitle")).toHaveValue(String(campaign.title));
  await page.evaluate(() => { window.history.replaceState({ unrelatedEntry: "also preserved" }, "", window.location.href); });
  await page.locator("#campaignTitle").fill("Keep this history state");
  const historyLength = await page.evaluate(() => window.history.length);
  await page.goBack();
  await expect(page.locator("#discardChangesDialog")).toBeVisible();
  await page.locator('#discardChangesDialog button[value="keep"]').click();
  await expect(page).toHaveURL(/#campaigns\?campaignId=/u);
  await expect(page.locator("#campaignTitle")).toHaveValue("Keep this history state");
  await expect.poll(() => page.evaluate(() => window.history.length)).toBe(historyLength);
  expect(await page.evaluate(() => window.history.state?.unrelated)).toBe("preserved predecessor");
  expect(api.writes).toEqual([]);
});

test("null_state_unindexed_back_stay_uses_bounded_replace_and_forward_does_not_loop", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, "navigation", { value: undefined, configurable: true }));
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount: 1 });
  const api = await installLegacyUiFixture(page, fixture);
  const campaign = fixture.campaigns[0];
  if (!campaign) throw new Error("The one-campaign fixture was not created.");
  await page.goto(`${origin}/nexus/index.html#campaigns?campaignId=${campaign.id}`);
  await page.locator("#campaignTitle").fill("Retain edits on a state-less legacy entry");
  await page.evaluate((campaignId) => {
    const previous = new URL(window.location.href);
    previous.hash = "#providers";
    window.history.replaceState(null, "", previous.href);
    const current = new URL(window.location.href);
    current.hash = `#campaigns?campaignId=${campaignId}`;
    window.history.pushState(null, "", current.href);
  }, campaign.id);
  const historyLength = await page.evaluate(() => window.history.length);
  await page.goBack();
  await expect(page.locator("#discardChangesDialog")).toBeVisible();
  await page.locator('#discardChangesDialog button[value="keep"]').click();
  await expect(page).toHaveURL(new RegExp(`#campaigns\\?campaignId=${campaign.id}$`, "u"));
  await expect(page.locator("#campaignTitle")).toHaveValue("Retain edits on a state-less legacy entry");
  await expect.poll(() => page.evaluate(() => window.history.length)).toBe(historyLength);
  expect(api.writes).toEqual([]);
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`#campaigns\\?campaignId=${campaign.id}$`, "u"));
  await expect(page.locator("#discardChangesDialog")).toBeHidden();
});

test("hashchange_fallback_without_navigation_api_rolls_back_after_back_truncates_forward_entries", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, "navigation", { value: undefined, configurable: true }));
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount: 1 });
  const api = await installLegacyUiFixture(page, fixture);
  const campaign = fixture.campaigns[0];
  if (!campaign) throw new Error("The one-campaign fixture was not created.");
  await page.goto(`${origin}/nexus/index.html#dashboard`);
  await navigateFromSetupMenu(page, "navWorlds");
  await navigateFromSetupMenu(page, "navCampaigns");
  await page.locator(`#campaignList [data-campaign-id="${campaign.id}"]`).click();
  await page.locator("#campaignTitle").fill("Fallback route stays indexed safely");
  await page.goBack();
  await expect(page).toHaveURL(/#campaigns$/u);
  const lengthBeforeHash = await page.evaluate(() => window.history.length);
  await page.evaluate(() => { window.location.hash = "#providers"; });
  await expect(page.locator("#discardChangesDialog")).toBeVisible();
  await page.locator('#discardChangesDialog button[value="keep"]').click();
  await expect(page).toHaveURL(/#campaigns$/u);
  await expect(page.locator("#campaignTitle")).toHaveValue("Fallback route stays indexed safely");
  await expect.poll(() => page.evaluate(() => window.history.length)).toBe(lengthBeforeHash);
  expect(api.writes).toEqual([]);
});

test("workspace_viewports_capture_worlds_and_campaigns", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 2, campaignCount: 2 });
  await installLegacyUiFixture(page, fixture);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${origin}/nexus/index.html#world-library`);
  await expect(page.locator("#world-library")).toBeVisible();
  await expect(page.locator("#campaigns")).toBeHidden();
  await page.screenshot({ path: ".superpowers/sdd/legacy-ui-2026-10-03/evidence/T21/worlds-desktop.png", fullPage: false });
  await page.goto(`${origin}/nexus/index.html#campaigns`);
  await expect(page.locator("#campaigns")).toBeVisible();
  await expect(page.locator("#world-library")).toBeHidden();
  await page.screenshot({ path: ".superpowers/sdd/legacy-ui-2026-10-03/evidence/T21/campaigns-desktop.png", fullPage: false });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/nexus/index.html#world-library`);
  await expect(page.locator("#world-library")).toBeVisible();
  await page.screenshot({ path: ".superpowers/sdd/legacy-ui-2026-10-03/evidence/T21/worlds-mobile.png", fullPage: false });
  await page.goto(`${origin}/nexus/index.html#campaigns`);
  await expect(page.locator("#campaigns")).toBeVisible();
  await page.screenshot({ path: ".superpowers/sdd/legacy-ui-2026-10-03/evidence/T21/campaigns-mobile.png", fullPage: false });
});
