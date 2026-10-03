import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";

const origin = `http://127.0.0.1:${process.env.PLAYWRIGHT_LEGACY_PORT ?? "43173"}`;
const evidenceDirectory = resolve(".superpowers/sdd/legacy-ui-2026-10-03/evidence/T05");
const worldA = {
  id: "world-a",
  title: "World Alpha",
  status: "active",
  latestVersionId: "world-a-v1",
  latestVersionNumber: 1,
  campaignCount: 0,
  updatedAt: "2026-10-01T00:00:00Z",
  latestPreview: { genre: "Mystery", tone: "Quiet", premise: "Alpha premise", firstAction: "Find the letter." }
};
const worldB = {
  ...worldA,
  id: "world-b",
  title: "World Beta",
  latestVersionId: "world-b-v1",
  latestPreview: { genre: "Fantasy", tone: "Bright", premise: "Beta premise", firstAction: "Enter the grove." }
};
const worldDetails = new Map<string, Record<string, unknown>>();
const apiEvents: Array<{ method: string; path: string; status: number; body: string | null; response: unknown }> = [];
const detailGates = new Map<string, Promise<void>>();
const detailFailures = new Set<string>();
const versionGates = new Map<string, Promise<void>>();

function fullWorld(summary: typeof worldA) {
  const versionId = summary.id === "world-a" ? "world-a-v1" : "world-b-v1";
  return {
    ...summary,
    imageUrl: summary.id === "world-a" ? "https://images.test/world-a-cover.png" : "https://images.test/world-b-cover.png",
    draftRevision: 1,
    draftUpdatedAt: "2026-10-01T00:00:00Z",
    draftContent: { schemaVersion: 5, world: { title: summary.title, genre: summary.latestPreview.genre, tone: summary.latestPreview.tone, premise: summary.latestPreview.premise, backgroundStory: "", firstAction: summary.latestPreview.firstAction, rules: "" }, playableCharacters: [], entities: [], relationships: [], rpgStats: [], defaultTriggers: [], eventTriggers: [], assets: [], defaults: {} },
    versions: [
      { id: versionId, versionNumber: 1, releaseNotes: "First edition", deletion: { deletable: true } },
      ...(summary.id === "world-a" ? [{ id: "world-a-v2", versionNumber: 2, releaseNotes: "Second edition", deletion: { deletable: true } }] : [])
    ],
    campaigns: []
  };
}

function summaries() {
  return [...worldDetails.values()].map((detail) => {
    const { versions: _versions, campaigns: _campaigns, draftContent: _draftContent, ...summary } = detail;
    return summary;
  });
}

function json(body: unknown, status = 200) {
  return { status, contentType: "application/json", body: JSON.stringify(body) };
}

async function fixtureRoute(route: Route) {
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname.replace(/^\/api\/v1/u, "");
  const parts = path.split("/").filter(Boolean);
  let status = 200;
  let body: unknown = {};

  if (path === "/meta") body = {};
  else if (path === "/session") body = { user: { id: "owner-synthetic", displayName: "Synthetic owner", settings: { autoSubmitTurnChoices: true, continuousReading: false } } };
  else if (path === "/providers") body = { providers: [] };
  else if (path === "/worlds" && request.method() === "GET") body = { worlds: summaries() };
  else if (path === "/campaigns" && request.method() === "GET") body = { campaigns: [] };
  else if (parts[0] === "worlds" && parts.length === 2 && request.method() === "GET") {
    const worldId = parts[1]!;
    const detail = structuredClone(worldDetails.get(worldId) ?? { message: "World not found" });
    const gate = detailGates.get(worldId);
    if (gate) detailGates.delete(worldId);
    if (gate) await gate;
    if (detailFailures.has(worldId)) {
      status = 503;
      body = { message: `Synthetic ${worldId} detail failure` };
    } else body = detail;
  } else if (parts[0] === "world-versions" && parts[2] === "playable-characters" && request.method() === "GET") {
    const versionId = parts[1]!;
    const gate = versionGates.get(versionId);
    if (gate) await gate;
    body = { characters: [{ id: `${versionId}-character`, name: `${versionId} character`, rpgStatCount: 1, defaultTriggerCount: 1 }], readiness: { ready: true, issues: [] } };
  } else if (parts[0] === "worlds" && parts.length === 3 && parts[2] === "cover-job") body = null;
  else if (parts[0] === "worlds" && parts.length === 2 && request.method() === "PATCH") {
    const worldId = parts[1]!;
    const detail = worldDetails.get(worldId);
    if (detail) detail.status = JSON.parse(request.postData() || "{}").status;
    body = detail ?? {};
  } else if (parts[0] === "worlds" && parts[1] === "world-a" && parts[2] === "draft" && request.method() === "PUT") {
    const input = JSON.parse(request.postData() || "{}");
    const detail = worldDetails.get("world-a")!;
    if (input.expectedRevision !== detail.draftRevision) {
      status = 409;
      body = { message: "Synthetic draft revision conflict" };
    } else {
      detail.title = input.title;
      detail.draftRevision = Number(detail.draftRevision) + 1;
      detail.draftContent = input.content;
      body = detail;
    }
  } else if (parts[0] === "worlds" && parts[1] === "world-a" && parts[2] === "publish" && request.method() === "POST") {
    const detail = worldDetails.get("world-a")!;
    (detail.versions as Array<Record<string, unknown>>).push({ id: "world-a-v3", versionNumber: 3, releaseNotes: "Published from test", deletion: { deletable: true } });
    detail.latestVersionId = "world-a-v3";
    detail.latestVersionNumber = 3;
    body = { versionNumber: 3 };
  } else if (parts[0] === "worlds" && parts[1] === "world-a" && parts[2] === "cover-asset" && request.method() === "PUT") {
    worldDetails.get("world-a")!.imageUrl = JSON.parse(request.postData() || "{}").assetId ? "https://images.test/replacement-cover.png" : null;
    body = { ok: true };
  } else if (parts[0] === "worlds" && parts.length === 2 && request.method() === "DELETE") {
    worldDetails.delete(parts[1]!);
    body = { deleted: true };
  }

  await route.fulfill(json(body, status));
  apiEvents.push({ method: request.method(), path, status, body: request.postData() ?? null, response: body });
}

async function openWorldManagement(page: Page, target = "world-library") {
  await page.route("**/api/v1/**", fixtureRoute);
  await page.goto(`${origin}/nexus/index.html#${target}`);
  const carousel = target === "dashboard" ? '#dashboardWorlds [data-world-id="world-b"]' : '#worldManagementCarousel [data-world-id="world-a"]';
  await page.locator(carousel).waitFor();
  await expect.poll(() => apiEvents.filter((event) => event.method === "GET" && /^\/worlds\/world-[ab]$/u.test(event.path)).length).toBeGreaterThanOrEqual(2);
}

function recordEvidence(name: string) {
  mkdirSync(evidenceDirectory, { recursive: true });
  appendFileSync(resolve(evidenceDirectory, "api-events.jsonl"), `${JSON.stringify({ test: name, events: apiEvents })}\n`, "utf8");
}

test.beforeEach(() => {
  apiEvents.length = 0;
  detailGates.clear();
  detailFailures.clear();
  versionGates.clear();
  worldDetails.clear();
  worldDetails.set(worldA.id, fullWorld(worldA));
  worldDetails.set(worldB.id, fullWorld(worldB));
  mkdirSync(evidenceDirectory, { recursive: true });
});
test.afterEach(({}, testInfo) => recordEvidence(testInfo.title));

test("edit_details_selects_the_world_that_was_clicked", async ({ page }) => {
  await openWorldManagement(page, "dashboard");
  await page.locator('#dashboardWorlds [data-world-id="world-b"]').click();
  await expect(page.locator("#worldDetailsTitle")).toHaveText("World Beta");
  await page.locator("#editWorldDetails").click();
  await expect(page.locator("#worldEditorTitle")).toHaveText("World Beta");
  await expect(page.locator("#worldSelectionPanel")).toBeVisible();
  await page.screenshot({ path: resolve(evidenceDirectory, "edit-details-selects-clicked-world.png") });
});

test("a_delayed_old_world_response_cannot_replace_the_new_selection", async ({ page }) => {
  let releaseA!: () => void;
  const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
  await openWorldManagement(page);
  detailGates.set("world-a", gateA);
  const worldARequest = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/v1/worlds/world-a");
  await page.locator('#worldManagementCarousel [data-world-id="world-a"]').click();
  await worldARequest;
  await page.locator('#worldManagementCarousel [data-world-id="world-b"]').click();
  await expect(page.locator("#worldEditorTitle")).toHaveText("World Beta");
  releaseA();
  await expect.poll(() => apiEvents.some((event) => event.path === "/worlds/world-a" && event.status === 200)).toBe(true);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await expect(page.locator("#worldEditorTitle")).toHaveText("World Beta");
  await expect(page.locator("#worldReleaseNotes")).toBeEnabled();
  await page.screenshot({ path: resolve(evidenceDirectory, "delayed-world-a-after-world-b.png") });
});

test("a_stale_world_error_cannot_replace_the_current_selection", async ({ page }) => {
  let releaseA!: () => void;
  const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await openWorldManagement(page);
  detailGates.set("world-a", gateA);
  detailFailures.add("world-a");
  await page.locator('#worldManagementCarousel [data-world-id="world-a"]').click();
  await page.locator('#worldManagementCarousel [data-world-id="world-b"]').click();
  await expect(page.locator("#worldEditorTitle")).toHaveText("World Beta");
  releaseA();
  await expect.poll(() => apiEvents.some((event) => event.path === "/worlds/world-a" && event.status === 503)).toBe(true);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await expect(page.locator("#worldEditorTitle")).toHaveText("World Beta");
  await expect(page.locator("#worldStatus")).not.toContainText("Synthetic world-a detail failure");
  await expect.poll(() => pageErrors).toEqual([]);
  await page.screenshot({ path: resolve(evidenceDirectory, "stale-world-a-error-after-world-b.png") });
});

test("stay_in_dirty_world_editor_prevents_world_selection", async ({ page }) => {
  await openWorldManagement(page);
  await page.locator('#worldManagementCarousel [data-world-id="world-a"]').click();
  await expect(page.locator("#worldEditorTitle")).toHaveText("World Alpha");
  await page.locator("#editWorldDraft").click();
  await page.locator("#worldTitle").fill("Unsaved Alpha edit");
  await page.locator('#worldManagementCarousel [data-world-id="world-b"]').dispatchEvent("click");
  await expect(page.locator("#discardChangesDialog")).toBeVisible();
  await page.locator('#discardChangesDialog button[value="keep"]').click();
  await expect(page.locator("#worldEditorTitle")).toHaveText("World Alpha");
  await expect(page.locator("#worldTitle")).toHaveValue("Unsaved Alpha edit");
  expect(apiEvents.some((event) => event.method === "PUT" && event.path === "/worlds/world-a/draft")).toBe(false);
  await page.screenshot({ path: resolve(evidenceDirectory, "dirty-world-stay-preserves-alpha.png") });
});

test("older_version_characters_cannot_replace_the_newer_selected_version", async ({ page }) => {
  let releaseV1!: () => void;
  const gateV1 = new Promise<void>((resolve) => { releaseV1 = resolve; });
  await openWorldManagement(page);
  await page.locator('#worldManagementCarousel [data-world-id="world-a"]').click();
  await expect(page.locator("#worldEditorTitle")).toHaveText("World Alpha");
  versionGates.set("world-a-v1", gateV1);
  await page.locator("#worldVersionSelect").selectOption("world-a-v1");
  await page.locator("#worldVersionSelect").selectOption("world-a-v2");
  await expect(page.locator("#newCampaignCharacter")).toContainText("world-a-v2 character");
  releaseV1();
  await expect.poll(() => apiEvents.some((event) => event.path === "/world-versions/world-a-v1/playable-characters")).toBe(true);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await expect(page.locator("#newCampaignCharacter")).toContainText("world-a-v2 character");
  await expect(page.locator("#newCampaignCharacter")).not.toContainText("world-a-v1 character");
});

test("successful_draft_refreshes_only_the_changed_world_detail_cache", async ({ page }) => {
  await openWorldManagement(page);
  await page.locator('#worldManagementCarousel [data-world-id="world-a"]').click();
  await expect(page.locator("#worldEditorTitle")).toHaveText("World Alpha");
  const aBefore = apiEvents.filter((event) => event.method === "GET" && event.path === "/worlds/world-a").length;
  const bBefore = apiEvents.filter((event) => event.method === "GET" && event.path === "/worlds/world-b").length;
  await page.locator("#editWorldDraft").click();
  await page.locator("#worldTitle").fill("World Alpha Revised");
  await page.locator("#saveWorldDraft").click();
  await expect(page.locator("#worldEditorTitle")).toHaveText("World Alpha Revised");
  const aAfter = apiEvents.filter((event) => event.method === "GET" && event.path === "/worlds/world-a").length;
  const bAfter = apiEvents.filter((event) => event.method === "GET" && event.path === "/worlds/world-b").length;
  expect(aAfter - aBefore).toBe(2);
  expect(bAfter - bBefore).toBe(0);
});

test("saved_world_draft_reopens_with_the_new_revision_for_the_next_save", async ({ page }) => {
  await openWorldManagement(page);
  await page.locator('#worldManagementCarousel [data-world-id="world-a"]').click();
  await expect(page.locator("#worldEditorTitle")).toHaveText("World Alpha");
  await page.locator("#editWorldDraft").click();
  await page.locator("#worldTitle").fill("World Alpha First Save");
  await page.locator("#saveWorldDraft").click();
  await expect(page.locator("#worldAuthorDialog")).not.toBeVisible();
  await expect(page.locator("#worldEditorMeta")).toContainText("draft revision 2");
  await page.locator("#editWorldDraft").click();
  await expect(page.locator("#worldTitle")).toHaveValue("World Alpha First Save");
  await page.locator("#worldTitle").fill("World Alpha Second Save");
  await page.locator("#saveWorldDraft").click();
  await expect(page.locator("#worldAuthorDialog")).not.toBeVisible();
  const draftWrites = apiEvents.filter((event) => event.method === "PUT" && event.path === "/worlds/world-a/draft");
  expect(draftWrites.map((event) => JSON.parse(event.body || "{}").expectedRevision)).toEqual([1, 2]);
  await page.screenshot({ path: resolve(evidenceDirectory, "world-draft-second-save-uses-refreshed-revision.png") });
});

test("a_detail_hydration_started_before_a_cover_write_cannot_repopulate_the_stale_cache", async ({ page }) => {
  let releaseOldHydration!: () => void;
  const oldHydrationGate = new Promise<void>((resolve) => { releaseOldHydration = resolve; });
  detailGates.set("world-a", oldHydrationGate);
  await page.route("**/api/v1/**", fixtureRoute);
  const oldHydrationRequest = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/v1/worlds/world-a");
  await page.goto(`${origin}/nexus/index.html#world-library`);
  await page.locator('#worldManagementCarousel [data-world-id="world-a"]').waitFor();
  await oldHydrationRequest;
  await page.locator('#worldManagementCarousel [data-world-id="world-a"]').click();
  await expect(page.locator("#worldEditorTitle")).toHaveText("World Alpha");
  await page.locator("#editWorldDraft").click();
  await page.locator("#worldCoverOptions summary").click();
  await page.locator('input[name="worldCoverMode"][value="remove"]').check();
  await page.locator("#saveWorldDraft").click();
  await expect.poll(() => apiEvents.some((event) => event.method === "PUT" && event.path === "/worlds/world-a/cover-asset")).toBe(true);
  await expect(page.locator("#worldAuthorDialog")).not.toBeVisible();
  await expect.poll(() => apiEvents.filter((event) => event.method === "GET" && event.path === "/worlds/world-a").length).toBeGreaterThanOrEqual(3);
  releaseOldHydration();
  await expect.poll(() => apiEvents.some((event) => event.method === "GET" && event.path === "/worlds/world-a" && (event.response as { imageUrl?: string | null }).imageUrl === "https://images.test/world-a-cover.png")).toBe(true);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await page.evaluate(() => { window.location.hash = "#dashboard"; });
  await page.locator('#dashboardWorlds [data-world-id="world-a"]').click();
  await expect(page.locator("#worldDetailsMedia")).not.toHaveCSS("background-image", /world-a-cover/u);
  await page.screenshot({ path: resolve(evidenceDirectory, "stale-detail-hydration-after-cover-removal.png") });
});
