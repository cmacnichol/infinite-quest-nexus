import { expect, test } from "@playwright/test";
import { installLegacyUiFixture, legacyUiFixture } from "./helpers/legacy-ui-fixtures.js";
import type { LegacyUiRequestRecord } from "./helpers/legacy-ui-fixtures.types.js";

const origin = `http://127.0.0.1:${process.env.PLAYWRIGHT_LEGACY_PORT ?? "43173"}`;
const worldPath = (id: string) => `/api/v1/worlds/${id}`;
const detailRequests = (requests: ReadonlyArray<LegacyUiRequestRecord>) => requests.filter((request) => request.method === "GET" && /^\/api\/v1\/worlds\/[0-9a-f-]+$/iu.test(request.path));
const statsRequests = (requests: ReadonlyArray<LegacyUiRequestRecord>) => requests.filter((request) => request.method === "GET" && request.path === "/api/v1/dashboard/stats");

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function waitForInitialLists(requests: ReadonlyArray<LegacyUiRequestRecord>) {
  await expect.poll(() => requests.filter((request) => ["/api/v1/worlds", "/api/v1/campaigns"].includes(request.path) && request.finishedAt !== undefined).length).toBeGreaterThanOrEqual(2);
}

function expectReadOnlyDashboardTraffic(requests: ReadonlyArray<LegacyUiRequestRecord>, writes: ReadonlyArray<unknown>) {
  const expected = (path: string) => ["/api/v1/meta", "/api/v1/session", "/api/v1/worlds", "/api/v1/campaigns", "/api/v1/dashboard/stats", "/api/v1/providers"].includes(path)
    || /^\/api\/v1\/worlds\/[0-9a-f-]+(?:\/cover-job)?$/iu.test(path)
    || /^\/api\/v1\/world-versions\/[0-9a-f-]+\/playable-characters$/iu.test(path);
  expect(requests.filter((request) => !expected(request.path)).map((request) => request.path)).toEqual([]);
  expect(writes).toHaveLength(0);
}

test("dashboard_uses_world_summaries_and_summary_artwork_without_detail_reads", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 39, campaignCount: 59 });
  const imageUrl = `${origin}/synthetic-world-cover.svg`;
  fixture.worlds[0]!.imageUrl = imageUrl;
  const artworkWorldId = String(fixture.worlds[0]!.id);
  await page.route(imageUrl, (route) => route.fulfill({ status: 200, contentType: "image/svg+xml", body: "<svg xmlns='http://www.w3.org/2000/svg' width='1' height='1'></svg>" }));
  const api = await installLegacyUiFixture(page, fixture);
  await page.goto(`${origin}/nexus/index.html#dashboard`);

  await expect(page.locator("#dashboardWorlds [data-world-id]")).toHaveCount(39);
  await expect.poll(() => api.requests.filter((request) => ["/api/v1/worlds", "/api/v1/campaigns"].includes(request.path) && request.finishedAt !== undefined).length).toBe(2);
  expect(detailRequests(api.requests)).toHaveLength(0);
  const summaryCardArtwork = page.locator(`#dashboardWorlds [data-world-id="${artworkWorldId}"] .card-art`);
  await expect.poll(() => summaryCardArtwork.evaluate((element) => getComputedStyle(element).backgroundImage)).toContain(imageUrl);
  expectReadOnlyDashboardTraffic(api.requests, api.writes);
});

test("providers_route_does_not_fetch_world_details", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 39, campaignCount: 59 });
  const api = await installLegacyUiFixture(page, fixture);
  await page.goto(`${origin}/nexus/index.html#providers`);

  await expect(page.locator("#providerProfileList")).toBeVisible();
  await waitForInitialLists(api.requests);
  expect(detailRequests(api.requests)).toHaveLength(0);
  expectReadOnlyDashboardTraffic(api.requests, api.writes);
});

test("opening_a_world_fetches_only_its_detail", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 39, campaignCount: 59 });
  const api = await installLegacyUiFixture(page, fixture);
  await page.goto(`${origin}/nexus/index.html#dashboard`);
  await expect(page.locator("#dashboardWorlds [data-world-id]")).toHaveCount(39);
  const selectedId = String(fixture.worlds[0]!.id);

  await page.locator(`#dashboardWorlds [data-world-id="${selectedId}"]`).click();
  await expect(page.locator("#worldDetailsDialog")).toBeVisible();
  expect(detailRequests(api.requests).map((request) => request.path)).toEqual([worldPath(selectedId)]);
  expectReadOnlyDashboardTraffic(api.requests, api.writes);
});

test("failed_world_detail_read_can_be_retried", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 3, campaignCount: 1 });
  for (const world of fixture.worlds) {
    world.status = "draft";
    world.latestVersionId = null;
    world.latestVersionNumber = null;
  }
  const api = await installLegacyUiFixture(page, fixture);
  const selectedId = String(fixture.worlds[0]!.id);
  let attempts = 0;
  await page.route(`**${worldPath(selectedId)}`, async (route) => {
    attempts += 1;
    if (attempts === 1) await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Synthetic detail read failure" }) });
    else await route.fallback();
  });
  await page.goto(`${origin}/nexus/index.html#world-library`);
  await expect(page.locator(`#worldManagementCarousel [data-world-id="${selectedId}"]`)).toBeVisible();
  await waitForInitialLists(api.requests);
  expect(detailRequests(api.requests)).toHaveLength(0);

  await page.locator(`#worldManagementCarousel [data-world-id="${selectedId}"]`).click();
  await expect(page.locator("#worldStatus")).toContainText("The selected world could not be loaded.");
  await page.locator(`#worldManagementCarousel [data-world-id="${selectedId}"]`).click();
  await expect(page.locator("#worldEditorTitle")).toHaveText("Fixture World 1");
  expect(attempts).toBe(2);
  expect(detailRequests(api.requests)).toHaveLength(1);
  expectReadOnlyDashboardTraffic(api.requests, api.writes);
});

test("one_initial_stats_read_is_held_and_shared_by_both_summary_loaders", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 3, campaignCount: 1 });
  const api = await installLegacyUiFixture(page, fixture);
  const statsGate = deferred();
  const listsReached = { worlds: deferred(), campaigns: deferred() };
  let statsRouteStarts = 0;
  await page.route("**/api/v1/worlds", async (route) => { listsReached.worlds.resolve(); await route.fallback(); });
  await page.route("**/api/v1/campaigns", async (route) => { listsReached.campaigns.resolve(); await route.fallback(); });
  await page.route("**/api/v1/dashboard/stats", async (route) => { statsRouteStarts += 1; await statsGate.promise; await route.fallback(); });

  await page.goto(`${origin}/nexus/index.html#dashboard`);
  await Promise.all([listsReached.worlds.promise, listsReached.campaigns.promise]);
  await expect(page.locator("#dashboardWorlds [data-world-id]")).toHaveCount(3);
  await expect(page.locator("#dashboardCampaigns [data-campaign-id]")).toHaveCount(1);
  await expect.poll(() => statsRouteStarts).toBeGreaterThan(0);
  expect(statsRouteStarts).toBe(1);
  expect(statsRequests(api.requests)).toHaveLength(0);
  statsGate.resolve();
  await expect.poll(() => statsRequests(api.requests)[0]?.finishedAt).toBeDefined();
  expect(statsRequests(api.requests)).toHaveLength(1);
  expectReadOnlyDashboardTraffic(api.requests, api.writes);
});

test("initial_stats_read_is_shared_when_it_finishes_before_the_campaign_list", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 3, campaignCount: 1 });
  const api = await installLegacyUiFixture(page, fixture);
  const campaignsGate = deferred();
  const campaignsReached = deferred();
  let statsRouteStarts = 0;
  await page.route("**/api/v1/campaigns", async (route) => { campaignsReached.resolve(); await campaignsGate.promise; await route.fallback(); });
  await page.route("**/api/v1/dashboard/stats", async (route) => { statsRouteStarts += 1; await route.fallback(); });

  await page.goto(`${origin}/nexus/index.html#dashboard`);
  await campaignsReached.promise;
  await expect(page.locator("#dashboardWorlds [data-world-id]")).toHaveCount(3);
  await expect.poll(() => statsRequests(api.requests).length).toBe(1);
  await expect.poll(() => statsRequests(api.requests)[0]?.finishedAt).toBeDefined();
  expect(statsRouteStarts).toBe(1);
  campaignsGate.resolve();
  await expect(page.locator("#dashboardCampaigns [data-campaign-id]")).toHaveCount(1);
  await expect.poll(() => api.requests.filter((request) => request.path === "/api/v1/campaigns" && request.finishedAt !== undefined).length).toBe(1);
  expect(statsRequests(api.requests)).toHaveLength(1);
  expectReadOnlyDashboardTraffic(api.requests, api.writes);
});
