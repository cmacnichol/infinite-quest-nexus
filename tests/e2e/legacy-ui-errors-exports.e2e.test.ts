import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { installLegacyUiFixture, legacyUiFixture } from "./helpers/legacy-ui-fixtures.js";

const origin = `http://127.0.0.1:${process.env.PLAYWRIGHT_LEGACY_PORT ?? "43173"}`;
const evidenceDir = process.env.LEGACY_UI_T24_EVIDENCE_DIR ?? ".superpowers/sdd/legacy-ui-2026-10-03/evidence/T24";

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
  await page.screenshot({ path: `${evidenceDir}/fix1-dashboard-startup-error-desktop.png`, fullPage: false });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("#dashboardWorkflowStatus")).toBeVisible();
  await page.screenshot({ path: `${evidenceDir}/fix1-dashboard-startup-error-mobile.png`, fullPage: false });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.locator("#workflowDashboardRetryWorlds").click();
  await expect(page.locator("#dashboardWorlds [data-world-id]")).toHaveCount(1);
  await expect(page.locator("#dashboardWorkflowStatus")).toBeHidden();
  await page.goto(`${origin}/nexus/index.html#world-library`);
  await expect(page.locator("#worldStatus")).not.toContainText("Worlds could not be loaded");
  await expect(page.locator("#workflowRetryWorlds")).toHaveCount(0);
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
  await page.goto(`${origin}/nexus/index.html#providers`);
  await expect(page.locator("#providerStatus")).not.toContainText("Provider profiles could not be loaded");
  await expect(page.locator("#workflowRetryProviders")).toHaveCount(0);
  expect(campaignAttempts).toBe(2);
  expect(providerAttempts).toBe(2);
});

test("worlds_startup_failure_reaches_workspace_before_dashboard_retry", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount: 1 });
  let worldAttempts = 0;
  await installLegacyUiFixture(page, fixture);
  await page.route("**/api/v1/worlds", async route => {
    worldAttempts += 1;
    if (worldAttempts === 1) {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Private world read diagnostics" }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ worlds: fixture.worlds }) });
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${origin}/nexus/index.html`);
  await expect(page.locator("#workflowDashboardRetryWorlds")).toBeVisible();
  await page.locator("#navSetup").click();
  await page.locator("#navWorlds").click();
  await expect(page).toHaveURL(/#world-library$/u);
  await expect(page.locator("#worldStatus")).toContainText("Worlds could not be loaded");
  await expect(page.locator("#worldStatus")).not.toContainText("Private world read diagnostics");
  await expect(page.locator("#workflowRetryWorlds")).toBeVisible();
  await page.screenshot({ path: `${evidenceDir}/fix2-worlds-read-error-desktop.png`, fullPage: false });

  await page.locator("#workflowRetryWorlds").click();
  await expect(page.locator("#worldManagementCarousel [data-world-id]")).toHaveCount(1);
  await expect(page.locator("#workflowRetryWorlds")).toHaveCount(0);
  await expect(page.locator("#worldStatus")).not.toContainText("Worlds could not be loaded");
  await expect(page.locator("#dashboardWorkflowStatus")).toBeHidden();
  await page.screenshot({ path: `${evidenceDir}/fix2-worlds-read-recovered-desktop.png`, fullPage: false });
  expect(worldAttempts).toBe(2);
});

test("campaign_startup_failure_reaches_workspace_before_dashboard_retry", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount: 1 });
  let campaignAttempts = 0;
  await installLegacyUiFixture(page, fixture);
  await page.route("**/api/v1/campaigns", async route => {
    campaignAttempts += 1;
    if (campaignAttempts === 1) {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Private campaign read diagnostics" }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ campaigns: fixture.campaigns }) });
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${origin}/nexus/index.html`);
  await expect(page.locator("#workflowDashboardRetryCampaigns")).toBeVisible();

  await page.locator("#navSetup").click();
  await page.locator("#navCampaigns").click();
  await expect(page).toHaveURL(/#campaigns$/u);
  await expect(page.locator("#campaignStatusMessage")).toContainText("Campaigns could not be loaded");
  await expect(page.locator("#campaignStatusMessage")).not.toContainText("Private campaign read diagnostics");
  await expect(page.locator("#workflowRetryCampaigns")).toBeVisible();
  await page.screenshot({ path: `${evidenceDir}/fix2-campaigns-read-error-desktop.png`, fullPage: false });
  await page.locator("#workflowRetryCampaigns").click();
  await expect(page.locator("#campaignList [data-campaign-id]")).toHaveCount(1);
  await expect(page.locator("#workflowRetryCampaigns")).toHaveCount(0);
  await expect(page.locator("#campaignStatusMessage")).not.toContainText("Campaigns could not be loaded");
  await expect(page.locator("#dashboardWorkflowStatus")).toBeHidden();
  await page.screenshot({ path: `${evidenceDir}/fix2-campaigns-read-recovered-desktop.png`, fullPage: false });
  expect(campaignAttempts).toBe(2);
});

test("provider_startup_failure_reaches_workspace_before_dashboard_retry", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount: 1 });
  let providerAttempts = 0;
  await installLegacyUiFixture(page, fixture);
  await page.route("**/api/v1/providers", async route => {
    providerAttempts += 1;
    if (providerAttempts === 1) {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Private provider read diagnostics" }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ providers: [] }) });
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${origin}/nexus/index.html`);
  await expect(page.locator("#workflowDashboardRetryProviders")).toBeVisible();

  await page.locator("#navSetup").click();
  await page.locator("#navProviders").click();
  await expect(page).toHaveURL(/#providers$/u);
  await expect(page.locator("#providerStatus")).toContainText("Provider profiles could not be loaded");
  await expect(page.locator("#providerStatus")).not.toContainText("Private provider read diagnostics");
  await expect(page.locator("#workflowRetryProviders")).toBeVisible();
  await page.screenshot({ path: `${evidenceDir}/fix2-providers-read-error-desktop.png`, fullPage: false });
  await page.locator("#workflowRetryProviders").click();
  await expect(page.locator("#providerStatus")).not.toContainText("Provider profiles could not be loaded");
  await expect(page.locator("#workflowRetryProviders")).toHaveCount(0);
  await expect(page.locator("#dashboardWorkflowStatus")).toBeHidden();
  await page.screenshot({ path: `${evidenceDir}/fix2-providers-read-recovered-desktop.png`, fullPage: false });
  expect(providerAttempts).toBe(2);
});

test("workspace_read_retry_coexists_with_newer_world_action_error", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 2, campaignCount: 0 });
  const world = fixture.worlds[0];
  const otherWorld = fixture.worlds[1];
  if (!world) throw new Error("The world fixture was not created.");
  if (!otherWorld) throw new Error("The second world fixture was not created.");
  let worldReads = 0;
  let archiveWrites = 0;
  let playableCharacterReads = 0;
  let releaseRetryPlayableCharacters: (() => void) | undefined;
  await installLegacyUiFixture(page, fixture);
  await page.route("**/api/v1/worlds", async route => {
    worldReads += 1;
    if (worldReads === 2) {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Private world list diagnostics" }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ worlds: fixture.worlds }) });
  });
  await page.route(`**/api/v1/worlds/${fixture.worldId}`, async route => {
    if (route.request().method() === "PATCH") {
      archiveWrites += 1;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Private archive diagnostics" }) });
      return;
    }
    await route.fallback();
  });
  await page.route(`**/api/v1/world-versions/${fixture.worldVersionId}/playable-characters`, async route => {
    playableCharacterReads += 1;
    if (playableCharacterReads === 2) {
      await new Promise<void>(resolve => { releaseRetryPlayableCharacters = resolve; });
    }
    await route.fallback();
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${origin}/nexus/index.html#world-library`);
  await page.locator(`#worldManagementCarousel [data-world-id="${fixture.worldId}"]`).click();
  await page.locator("#refreshWorlds").click();
  await expect(page.locator("#worldStatus")).toContainText("Worlds could not be refreshed");
  await expect(page.locator("#workflowRetryWorlds")).toBeVisible();

  await page.locator("#worldSelectionPanel details.dropdown-menu summary").click();
  await page.locator("#archiveWorld").click();
  await expect(page.locator("#worldStatus")).toContainText("World archive status could not be changed.");
  await expect(page.locator("#worldStatus")).not.toContainText("Private archive diagnostics");
  await expect(page.locator("#worldStatus")).toContainText("Worlds could not be refreshed");
  await expect(page.locator("#worldStatus")).not.toContainText("Private world list diagnostics");
  await expect(page.locator("#workflowRetryWorlds")).toBeVisible();
  await expect.poll(() => archiveWrites).toBe(1);

  await page.locator("#navDashboard").click();
  await page.locator("#navSetup").click();
  await page.locator("#navWorlds").click();
  await expect(page.locator("#worldStatus")).toContainText("World archive status could not be changed.");
  await expect(page.locator("#worldStatus")).toContainText("Worlds could not be refreshed");
  await expect(page.locator("#worldStatus")).not.toContainText("Private archive diagnostics");
  await expect(page.locator("#workflowRetryWorlds")).toBeVisible();
  await page.screenshot({ path: `${evidenceDir}/fix3-worlds-coexisting-errors-desktop.png`, fullPage: false });

  await page.locator("#workflowRetryWorlds").click();
  await expect.poll(() => playableCharacterReads).toBe(2);
  await expect(page.locator("#worldCampaignReadiness")).toHaveText("Checking whether the selected world version is campaign-ready…");
  if (!releaseRetryPlayableCharacters) throw new Error("The retried playable-character request was not held.");
  releaseRetryPlayableCharacters();
  await expect(page.locator("#worldCampaignReadiness")).toHaveText("Campaign-ready with one playable character.");
  await expect(page.locator("#worldStatus")).toContainText("World archive status could not be changed.");
  await expect(page.locator("#worldStatus")).not.toContainText("Worlds could not be refreshed");
  await expect(page.locator("#workflowRetryWorlds")).toHaveCount(0);
  await expect(page.locator("#dashboardWorkflowStatus")).toBeHidden();
  await page.screenshot({ path: `${evidenceDir}/fix3-worlds-action-error-after-retry-desktop.png`, fullPage: false });
  expect(worldReads).toBe(3);
  expect(archiveWrites).toBe(1);

  await page.locator(`#worldManagementCarousel [data-world-id="${otherWorld.id}"]`).click();
  await expect(page.locator("#worldEditorTitle")).toHaveText(String(otherWorld.title));
  await expect(page.locator("#worldStatus")).not.toContainText("World archive status could not be changed.");
});

test("campaign_list_retry_keeps_current_archive_export_error_after_selection_refresh", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount: 2 });
  const campaign = fixture.campaigns[0];
  const otherCampaign = fixture.campaigns[1];
  if (!campaign) throw new Error("The one-campaign fixture was not created.");
  if (!otherCampaign) throw new Error("The second campaign fixture was not created.");
  let campaignReads = 0;
  let embeddingConfigReads = 0;
  await installLegacyUiFixture(page, fixture);
  await page.route("**/api/v1/campaigns", async route => {
    if (route.request().method() !== "GET") return route.fallback();
    campaignReads += 1;
    if (campaignReads === 2) {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Private campaign list diagnostics" }) });
      return;
    }
    await route.fallback();
  });
  await page.route(`**/api/v1/campaigns/${campaign.id}/export`, async route => {
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Campaign Archive export is unavailable." }) });
  });
  await page.route(`**/api/v1/campaigns/${campaign.id}/memory/embedding-config`, async route => {
    if (route.request().method() !== "GET") return route.fallback();
    embeddingConfigReads += 1;
    if (embeddingConfigReads > 1) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        enabled: true,
        retrievalImplementation: "pgvector",
        retrievalShadowEnabled: false,
        providerProfileId: null,
        model: "retry-complete-marker",
        documentPrefix: "",
        queryPrefix: "",
        batchSize: 32,
        effectiveDocumentPrefix: "",
        effectiveQueryPrefix: ""
      }) });
      return;
    }
    await route.fallback();
  });

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${origin}/nexus/index.html#campaigns?campaignId=${campaign.id}`);
  await expect(page.locator("#campaignTitle")).toHaveValue(String(campaign.title));
  await page.locator("#refreshCampaigns").click();
  await expect(page.locator("#campaignStatusMessage")).toContainText("Campaigns could not be refreshed");
  await page.locator("#exportCampaign").click();
  await expect(page.locator("#campaignStatusMessage")).toContainText("Campaign Archive export is unavailable.");
  await expect(page.locator("#workflowRetryCampaigns")).toBeVisible();

  await page.locator("#workflowRetryCampaigns").click();
  await expect(page.locator("#embeddingStatus")).toContainText("retry-complete-marker");
  await expect(page.locator("#campaignStatusMessage")).toBeVisible();
  await expect(page.locator("#campaignStatusMessage")).toContainText("Campaign Archive export is unavailable.");
  await expect(page.locator("#campaignStatusMessage")).not.toContainText("Campaigns could not be refreshed");
  await expect(page.locator("#campaignStatusMessage")).not.toContainText("Private campaign list diagnostics");
  await expect(page.locator("#workflowRetryCampaigns")).toHaveCount(0);
  await page.screenshot({ path: `${evidenceDir}/fix3-campaigns-error-after-retry-desktop.png`, fullPage: false });
  expect(campaignReads).toBe(3);
  expect(embeddingConfigReads).toBe(2);

  await page.locator(`#campaignList [data-campaign-id="${otherCampaign.id}"]`).click();
  await expect(page.locator("#campaignTitle")).toHaveValue(String(otherCampaign.title));
  await expect(page.locator("#campaignStatusMessage")).not.toContainText("Campaign Archive export is unavailable.");
});

test("campaign_manual_selection_keeps_pending_list_retry_visible", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount: 2 });
  const campaign = fixture.campaigns[0];
  const otherCampaign = fixture.campaigns[1];
  if (!campaign) throw new Error("The one-campaign fixture was not created.");
  if (!otherCampaign) throw new Error("The second campaign fixture was not created.");
  let campaignReads = 0;
  await installLegacyUiFixture(page, fixture);
  await page.route("**/api/v1/campaigns", async route => {
    if (route.request().method() !== "GET") return route.fallback();
    campaignReads += 1;
    if (campaignReads === 2) {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Private campaign list diagnostics" }) });
      return;
    }
    await route.fallback();
  });

  await page.goto(`${origin}/nexus/index.html#campaigns?campaignId=${campaign.id}`);
  await expect(page.locator("#campaignTitle")).toHaveValue(String(campaign.title));
  await page.locator("#refreshCampaigns").click();
  await expect(page.locator("#campaignStatusMessage")).toContainText("Campaigns could not be refreshed");
  await page.locator(`#campaignList [data-campaign-id="${otherCampaign.id}"]`).click();
  await expect(page.locator("#campaignTitle")).toHaveValue(String(otherCampaign.title));
  await expect(page.locator("#campaignStatusMessage")).toContainText("Campaigns could not be refreshed");
  await expect(page.locator("#workflowRetryCampaigns")).toBeVisible();
  await expect(page.locator("#campaignStatusMessage")).not.toContainText("Private campaign list diagnostics");

  await page.locator("#workflowRetryCampaigns").click();
  await expect(page.locator("#campaignTitle")).toHaveValue(String(otherCampaign.title));
  await expect(page.locator("#workflowRetryCampaigns")).toHaveCount(0);
  await expect(page.locator("#campaignStatusMessage")).toBeHidden();
  expect(campaignReads).toBe(3);
});

test("campaign_selection_during_pending_retry_keeps_latest_route_and_editor", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount: 2 });
  const campaign = fixture.campaigns[0];
  const otherCampaign = fixture.campaigns[1];
  if (!campaign || !otherCampaign) throw new Error("Two synthetic campaigns are required.");
  let campaignReads = 0;
  let releaseRetry = () => {};
  const retryGate = new Promise<void>(resolve => { releaseRetry = resolve; });
  const stateIds: string[] = [];
  const writes: string[] = [];
  page.on("request", request => {
    const stateMatch = /\/api\/v1\/campaigns\/([^/]+)\/state$/.exec(new URL(request.url()).pathname);
    if (stateMatch?.[1]) stateIds.push(stateMatch[1]);
    if (request.url().includes("/api/v1/") && !["GET", "HEAD"].includes(request.method())) writes.push(request.method());
  });
  await installLegacyUiFixture(page, fixture);
  await page.route("**/api/v1/campaigns", async route => {
    if (route.request().method() !== "GET") return route.fallback();
    campaignReads += 1;
    if (campaignReads === 2) {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Private campaign list diagnostics" }) });
      return;
    }
    if (campaignReads === 3) await retryGate;
    await route.fallback();
  });
  await page.goto(`${origin}/nexus/index.html#campaigns?campaignId=${campaign.id}`);
  await expect(page.locator("#campaignTitle")).toHaveValue(String(campaign.title));
  await page.locator("#refreshCampaigns").click();
  await expect(page.locator("#workflowRetryCampaigns")).toBeVisible();
  await page.locator("#workflowRetryCampaigns").click();
  await expect.poll(() => campaignReads).toBe(3);
  await page.locator(`#campaignList [data-campaign-id="${otherCampaign.id}"]`).click();
  await expect(page.locator("#campaignTitle")).toHaveValue(String(otherCampaign.title));
  await expect(page).toHaveURL(`${origin}/nexus/index.html#campaigns?campaignId=${otherCampaign.id}`);
  releaseRetry();
  // Wait for the released list and its optional detail consumers to settle before asserting ownership.
  await page.waitForLoadState("networkidle");
  await expect(page.locator("#workflowRetryCampaigns")).toHaveCount(0);
  await expect(page.locator("#campaignTitle")).toHaveValue(String(otherCampaign.title));
  await expect(page.locator("#memoryTitle")).toHaveText(String(otherCampaign.title));
  await expect(page).toHaveURL(`${origin}/nexus/index.html#campaigns?campaignId=${otherCampaign.id}`);
  expect(stateIds).toEqual([campaign.id, otherCampaign.id]);
  expect(writes).toEqual([]);
  await page.screenshot({ path: `${evidenceDir}/fix4-campaign-selection-during-retry-desktop.png`, fullPage: false });
});
for (const kind of ["worlds", "campaigns"] as const) {
  test(`${kind}_missing_link_during_pending_retry_keeps_recovery_until_target_available`, async ({ page }) => {
    const fixture = { ...legacyUiFixture({ turnCount: 1, worldCount: 2, campaignCount: 2 }) };
    const records = kind === "worlds" ? fixture.worlds : fixture.campaigns;
    const first = records[0];
    const target = records[1];
    if (!first || !target) throw new Error("Two synthetic records are required.");
    const routeName = kind === "worlds" ? "world-library" : "campaigns";
    const parameter = kind === "worlds" ? "worldId" : "campaignId";
    const retryId = kind === "worlds" ? "workflowRetryWorlds" : "workflowRetryCampaigns";
    const statusId = kind === "worlds" ? "worldStatus" : "campaignStatusMessage";
    let reads = 0;
    let releaseRetry = () => {};
    const gate = new Promise<void>(resolve => { releaseRetry = resolve; });
    await installLegacyUiFixture(page, fixture);
    await page.route(`**/api/v1/${kind}`, async route => {
      if (route.request().method() !== "GET") return route.fallback();
      reads += 1;
      if (reads === 2) {
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Private list diagnostics" }) });
        return;
      }
      if (reads === 3) await gate;
      if (reads >= 4 && kind === "campaigns") fixture.campaignId = String(target.id);
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ [kind]: reads >= 4 ? records : [first] }) });
    });
    await page.goto(`${origin}/nexus/index.html#${routeName}?${parameter}=${first.id}`);
    if (kind === "worlds") await expect(page.locator("#worldEditorTitle")).toHaveText(String(first.title));
    else await expect(page.locator("#campaignTitle")).toHaveValue(String(first.title));
    await page.locator(kind === "worlds" ? "#refreshWorlds" : "#refreshCampaigns").click();
    await expect(page.locator(`#${retryId}`)).toBeVisible();
    await page.locator(`#${retryId}`).click();
    await expect.poll(() => reads).toBe(3);
    await page.goto(`${origin}/nexus/index.html#${routeName}?${parameter}=${target.id}`);
    await expect(page.locator(`#${statusId}`)).toContainText(`${target.id} is not available`);
    releaseRetry();
    await page.waitForLoadState("networkidle");
    await expect(page.locator(`#${statusId}`)).toContainText(`${target.id} is not available`);
    await expect(page.locator(`#${retryId}`)).toBeVisible();
    await expect(page.locator(`#${statusId}`)).not.toContainText("Private list diagnostics");
    await page.locator(`#${retryId}`).click();
    if (kind === "worlds") await expect(page.locator("#worldEditorTitle")).toHaveText(String(target.title));
    else await expect(page.locator("#campaignTitle")).toHaveValue(String(target.title));
    await expect(page.locator(`#${statusId}`)).not.toContainText(`${target.id} is not available`);
    await expect(page.locator(`#${retryId}`)).toHaveCount(0);
    await expect(page).toHaveURL(`${origin}/nexus/index.html#${routeName}?${parameter}=${target.id}`);
    expect(reads).toBe(4);
    await page.screenshot({ path: `${evidenceDir}/fix5-${kind}-missing-target-recovered-desktop.png`, fullPage: false });
  });
}
test("provider_list_retry_keeps_current_save_error_after_profile_selection_refresh", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount: 1 });
  let providerReads = 0;
  await installLegacyUiFixture(page, fixture);
  await page.route("**/api/v1/providers", async route => {
    if (route.request().method() === "GET") {
      providerReads += 1;
      if (providerReads === 1) {
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Private provider list diagnostics" }) });
        return;
      }
      return route.fallback();
    }
    if (route.request().method() === "POST") {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Private provider save diagnostics" }) });
      return;
    }
    await route.fallback();
  });

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${origin}/nexus/index.html#providers`);
  await expect(page.locator("#providerStatus")).toContainText("Provider profiles could not be loaded");
  await page.locator("#newProviderButton").click();
  await page.locator("#providerForm button[type=submit]").click();
  await expect(page.locator("#providerStatus")).toContainText("Provider profile could not be saved.");
  await expect(page.locator("#providerStatus")).not.toContainText("Private provider save diagnostics");
  await expect(page.locator("#workflowRetryProviders")).toBeVisible();
  await page.locator("#cancelProviderEdit").click();
  if (await page.locator("#discardChangesDialog").isVisible()) {
    await page.locator('#discardChangesDialog button[value="discard"]').click();
  }
  await expect(page.locator("#providerDialog")).toBeHidden();

  await page.locator("#workflowRetryProviders").click();
  await expect(page.locator("#providerProfileList")).toContainText("Synthetic text profile");
  await expect(page.locator("#providerStatus")).toHaveText("Provider profile could not be saved.");
  await expect(page.locator("#providerStatus")).not.toContainText("Provider profiles could not be loaded");
  await expect(page.locator("#providerStatus")).not.toContainText("Private provider list diagnostics");
  await expect(page.locator("#workflowRetryProviders")).toHaveCount(0);
  await page.screenshot({ path: `${evidenceDir}/fix3-providers-error-after-retry-desktop.png`, fullPage: false });
  expect(providerReads).toBe(2);

  await page.locator("#providerProfileList .provider-profile").filter({ hasText: "Synthetic text profile" }).getByRole("button", { name: "Edit" }).click();
  await expect(page.locator("#providerDialog")).toBeVisible();
  await expect(page.locator("#providerStatus")).toHaveText("Editing Synthetic text profile. Leave the API key blank to keep the stored credential.");
});

test("operation_errors_do_not_offer_unrelated_list_retries", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount: 1 });
  await installLegacyUiFixture(page, fixture);
  await page.route(`**/api/v1/campaigns/${fixture.campaignId}`, async route => {
    if (route.request().method() === "PATCH") {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Private save diagnostics" }) });
      return;
    }
    await route.fallback();
  });
  await page.route("**/api/v1/providers", async route => {
    if (route.request().method() === "POST") {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Private provider diagnostics" }) });
      return;
    }
    await route.fallback();
  });
  await page.goto(`${origin}/nexus/index.html#campaigns`);
  await page.locator(`#campaignList [data-campaign-id="${fixture.campaignId}"]`).click();
  await page.locator("#campaignTitle").fill("Unsaved campaign title");
  await page.locator("#saveCampaign").click();
  await expect(page.locator("#campaignSaveStatus")).toHaveAttribute("data-state", "error");
  await expect(page.locator("#campaignStatusMessage")).toContainText("could not be saved");
  await expect(page.locator("#campaignStatusMessage")).not.toContainText("Private save diagnostics");
  await expect(page.locator("#workflowRetryCampaigns")).toHaveCount(0);
  await expect(page.locator("#campaignTitle")).toHaveValue("Unsaved campaign title");

  await page.goto(`${origin}/nexus/index.html#providers`);
  await expect(page.locator("#discardChangesDialog")).toBeVisible();
  await page.locator('#discardChangesDialog button[value="discard"]').click();
  await expect(page.locator("#providers")).toBeVisible();
  await page.locator("#newProviderButton").click();
  await page.locator("#providerForm button[type=submit]").click();
  await expect(page.locator("#providerStatus")).toContainText("could not be saved");
  await expect(page.locator("#providerStatus")).not.toContainText("Private provider diagnostics");
  await expect(page.locator("#workflowRetryProviders")).toHaveCount(0);
  await page.locator("#cancelProviderEdit").click();
  if (await page.locator("#discardChangesDialog").isVisible()) {
    await page.locator('#discardChangesDialog button[value="discard"]').click();
  }
  await expect(page.locator("#providerDialog")).toBeHidden();

  await page.route(`**/api/v1/worlds/${fixture.worldId}`, async route => {
    if (route.request().method() === "PATCH") {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Private world action diagnostics" }) });
      return;
    }
    await route.fallback();
  });
  await page.goto(`${origin}/nexus/index.html#world-library`);
  await page.locator(`#worldManagementCarousel [data-world-id="${fixture.worldId}"]`).click();
  await page.locator("#worldSelectionPanel details.dropdown-menu summary").click();
  await page.locator("#archiveWorld").click();
  await expect(page.locator("#worldStatus")).toContainText("World archive status could not be changed.");
  await expect(page.locator("#worldStatus")).not.toContainText("Private world action diagnostics");
  await expect(page.locator("#workflowRetryWorlds")).toHaveCount(0);
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

test("campaign_startup_retry_resolves_the_exact_missing_id_before_clearing_absence", async ({ page }) => {
  const fixtureBase = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount: 2 });
  const requestedCampaign = fixtureBase.campaigns[1];
  if (!requestedCampaign) throw new Error("The two-campaign fixture was not created.");
  const requestedCampaignId = String(requestedCampaign.id);
  const requestedWorldId = String(requestedCampaign.worldId);
  const fixture = { ...fixtureBase, campaignId: requestedCampaignId };
  let campaignReads = 0;
  let notifyCampaignStateRequest: () => void = () => {};
  let releaseCampaignState: () => void = () => {};
  let notifyWorldDetailRequest: () => void = () => {};
  let releaseWorldDetail: () => void = () => {};
  const campaignStateRequest = new Promise<void>(resolve => { notifyCampaignStateRequest = resolve; });
  const campaignStateGate = new Promise<void>(resolve => { releaseCampaignState = resolve; });
  const worldDetailRequest = new Promise<void>(resolve => { notifyWorldDetailRequest = resolve; });
  const worldDetailGate = new Promise<void>(resolve => { releaseWorldDetail = resolve; });
  await installLegacyUiFixture(page, fixture);
  await page.route("**/api/v1/campaigns", async route => {
    campaignReads += 1;
    if (campaignReads === 1) {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Private database diagnostics" }) });
      return;
    }
    const visibleCampaigns = campaignReads === 2
      ? [fixture.campaigns[0]]
      : fixture.campaigns;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ campaigns: visibleCampaigns }) });
  });
  await page.route(`**/api/v1/campaigns/${requestedCampaignId}/state`, async route => {
    notifyCampaignStateRequest();
    await campaignStateGate;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ activeTurnNumber: 1, revision: 1 }) });
  });
  await page.route(`**/api/v1/worlds/${requestedWorldId}`, async route => {
    notifyWorldDetailRequest();
    await worldDetailGate;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fixture.worldDetails.get(requestedWorldId)) });
  });
  await page.route(`**/api/v1/campaigns/${requestedCampaignId}`, route => route.fulfill({
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({ message: "Private save diagnostics" })
  }), { times: 1 });
  await page.goto(`${origin}/nexus/index.html#campaigns?campaignId=${requestedCampaignId}`);

  await expect(page.locator("#campaignStatusMessage")).toContainText("could not be loaded to resolve this link");
  await page.locator("#workflowRetryCampaigns").click();
  await expect(page.locator("#campaignStatusMessage")).toContainText("not available in this library");
  await expect(page).toHaveURL(new RegExp(`#campaigns\\?campaignId=${requestedCampaignId}$`, "u"));
  await page.locator("#workflowRetryCampaigns").click();
  await campaignStateRequest;
  await expect(page.locator("#campaignStatusMessage")).toContainText("not available in this library");
  await expect(page.locator("#workflowRetryCampaigns")).toBeVisible();
  releaseCampaignState();
  await worldDetailRequest;

  await expect(page.locator("#campaignTitle")).toHaveValue(String(requestedCampaign.title));
  await page.locator("#campaignTitle").fill("Unsaved retry-time campaign title");
  await page.locator("#saveCampaign").click();
  await expect(page.locator("#campaignStatusMessage")).toContainText("Campaign settings could not be saved.");
  await expect(page.locator("#campaignStatusMessage")).not.toContainText("Private save diagnostics");
  releaseWorldDetail();
  await expect(page.locator("#campaignTitle")).toHaveValue("Unsaved retry-time campaign title");
  await expect(page.locator("#campaignStatusMessage")).toContainText("Campaign settings could not be saved.");
  await expect(page.locator("#campaignStatusMessage")).not.toContainText("not available in this library");
  await expect(page.locator("#campaignStatusMessage")).not.toContainText("Private save diagnostics");
  await expect(page.locator("#workflowRetryCampaigns")).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`#campaigns\\?campaignId=${requestedCampaignId}$`, "u"));
  expect(campaignReads).toBe(3);
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
  await expect(page.locator("#storySyncStatus")).toHaveText("Story synced");
  await expect(page.locator("#storyArea .scene")).toHaveCount(1);
  const exportMenuTrigger = page.locator('[aria-controls="storyExportMenu"]');
  await exportMenuTrigger.click();
  await expect(exportMenuTrigger).toHaveAttribute("aria-expanded", "true");
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
  await expect(page.locator("#storyArea .scene")).toHaveCount(0);
  await expect(page.getByText("No adventure yet", { exact: false })).toHaveCount(0);
  await expect(page.locator("#storyLoadRecovery a")).toHaveAttribute("href", "/nexus/#campaigns");
});
