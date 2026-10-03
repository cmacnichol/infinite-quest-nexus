import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";

const origin = `http://127.0.0.1:${process.env.PLAYWRIGHT_LEGACY_PORT ?? "43173"}`;
const evidenceDirectory = resolve(".superpowers/sdd/legacy-ui-2026-10-03/evidence/T05-fix3");
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
const worldListGates: Array<Promise<void>> = [];
const worldPatchGates = new Map<string, Promise<void>>();
const coverJobGates = new Map<string, Promise<void>>();
const worldImportGates: Array<Promise<void>> = [];

function fullWorld(summary: {
  id: string;
  title: string;
  status: string;
  latestVersionId?: string | null;
  latestVersionNumber?: number | null;
  campaignCount: number;
  updatedAt: string;
  latestPreview: typeof worldA.latestPreview;
}) {
  const versionId = `${summary.id}-v1`;
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
  else if (path === "/worlds" && request.method() === "GET") {
    body = { worlds: summaries() };
    const gate = worldListGates.shift();
    if (gate) await gate;
  }
  else if (path === "/worlds" && request.method() === "POST") {
    const input = JSON.parse(request.postData() || "{}");
    const id = "world-c";
    const created = fullWorld({ ...worldB, id, title: input.title, latestVersionId: "", latestVersionNumber: null, status: "draft" });
    created.versions = [];
    created.latestVersionId = null;
    created.latestVersionNumber = null;
    created.draftContent.world.title = input.title;
    worldDetails.set(id, created);
    body = { id };
  }
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
  } else if (parts[0] === "worlds" && parts.length === 3 && parts[2] === "cover-job") {
    body = parts[1] === "world-a" && coverJobGates.has("cover-job-a")
      ? { id: "cover-job-a", status: "generating" }
      : null;
  } else if (parts[0] === "image-jobs" && parts[1] === "cover-job-a" && request.method() === "GET") {
    const gate = coverJobGates.get("cover-job-a");
    if (gate) await gate;
    const detail = worldDetails.get("world-a");
    if (detail) detail.imageUrl = "https://images.test/world-a-new-cover.png";
    body = { id: "cover-job-a", status: "completed", assetUrl: "https://images.test/world-a-new-cover.png" };
  }
  else if (parts[0] === "worlds" && parts.length === 2 && request.method() === "PATCH") {
    const worldId = parts[1]!;
    const gate = worldPatchGates.get(worldId);
    if (gate) worldPatchGates.delete(worldId);
    if (gate) await gate;
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
  } else if (parts[0] === "worlds" && parts[1] === "world-a" && parts[2] === "fork" && request.method() === "POST") {
    const input = JSON.parse(request.postData() || "{}");
    const id = "world-c";
    const fork = fullWorld({ ...worldB, id, title: input.title, latestVersionId: "", latestVersionNumber: null, status: "draft" });
    fork.versions = [];
    fork.latestVersionId = null;
    fork.latestVersionNumber = null;
    fork.draftContent.world.title = input.title;
    worldDetails.set(id, fork);
    body = { worldId: id };
  } else if (parts[0] === "worlds" && parts[1] === "world-a" && parts[2] === "cover-asset" && request.method() === "PUT") {
    worldDetails.get("world-a")!.imageUrl = JSON.parse(request.postData() || "{}").assetId ? "https://images.test/replacement-cover.png" : null;
    body = { ok: true };
  } else if (parts[0] === "worlds" && parts.length === 2 && request.method() === "DELETE") {
    worldDetails.delete(parts[1]!);
    body = { deleted: true };
  } else if (path === "/imports/world/preview" && request.method() === "POST") {
    body = { duplicate: false, counts: { entities: 0, relationships: 0, triggers: 0 }, warnings: [] };
  } else if (path === "/imports/world" && request.method() === "POST") {
    const gate = worldImportGates.shift();
    if (gate) await gate;
    const id = "world-c";
    const imported = fullWorld({ ...worldB, id, title: "World Gamma", latestVersionId: "", latestVersionNumber: null, status: "draft" });
    imported.versions = [];
    imported.latestVersionId = null;
    imported.latestVersionNumber = null;
    imported.draftContent.world.title = "World Gamma";
    worldDetails.set(id, imported);
    body = { worldId: id, duplicate: false };
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
  worldListGates.length = 0;
  worldPatchGates.clear();
  coverJobGates.clear();
  worldImportGates.length = 0;
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

test("a_delayed_details_navigation_list_cannot_reselect_its_obsolete_world", async ({ page }) => {
  let releaseWorldList!: () => void;
  const worldListGate = new Promise<void>((resolve) => { releaseWorldList = resolve; });
  await openWorldManagement(page, "dashboard");
  await page.locator('#dashboardWorlds [data-world-id="world-a"]').click();
  await expect(page.locator("#worldDetailsTitle")).toHaveText("World Alpha");
  const listCountBefore = apiEvents.filter((event) => event.method === "GET" && event.path === "/worlds").length;
  worldListGates.push(worldListGate);
  const delayedListRequest = page.waitForRequest((request) => request.method() === "GET" && new URL(request.url()).pathname === "/api/v1/worlds");
  await page.locator("#editWorldDetails").click();
  await delayedListRequest;
  await page.locator('#worldManagementCarousel [data-world-id="world-b"]').click();
  await expect(page.locator("#worldEditorTitle")).toHaveText("World Beta");
  releaseWorldList();
  await expect.poll(() => apiEvents.filter((event) => event.method === "GET" && event.path === "/worlds").length).toBeGreaterThan(listCountBefore);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await expect(page.locator("#worldEditorTitle")).toHaveText("World Beta");
  await expect(page.locator('#worldManagementCarousel [data-world-id="world-b"]')).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({ path: resolve(evidenceDirectory, "delayed-navigation-list-keeps-current-world.png") });
});

test("a_delayed_post_archive_list_refresh_preserves_a_newer_world_selection", async ({ page }) => {
  let releaseWorldList!: () => void;
  let releaseWorldB!: () => void;
  const worldListGate = new Promise<void>((resolve) => { releaseWorldList = resolve; });
  const worldBGate = new Promise<void>((resolve) => { releaseWorldB = resolve; });
  await openWorldManagement(page);
  await page.locator('#worldManagementCarousel [data-world-id="world-a"]').click();
  await expect(page.locator("#worldEditorTitle")).toHaveText("World Alpha");
  const listCountBefore = apiEvents.filter((event) => event.method === "GET" && event.path === "/worlds").length;
  const aDetailGetsBefore = apiEvents.filter((event) => event.method === "GET" && event.path === "/worlds/world-a").length;
  const bDetailGetsBefore = apiEvents.filter((event) => event.method === "GET" && event.path === "/worlds/world-b").length;
  worldListGates.push(worldListGate);
  detailGates.set("world-b", worldBGate);
  const delayedListRequest = page.waitForRequest((request) => request.method() === "GET" && new URL(request.url()).pathname === "/api/v1/worlds");
  await page.locator("#worldSelectionPanel details summary").click();
  await page.locator("#archiveWorld").click();
  await delayedListRequest;
  const worldBRequest = page.waitForRequest((request) => request.method() === "GET" && new URL(request.url()).pathname === "/api/v1/worlds/world-b");
  await page.locator('#worldManagementCarousel [data-world-id="world-b"]').click();
  await worldBRequest;
  releaseWorldList();
  await expect.poll(() => apiEvents.filter((event) => event.method === "GET" && event.path === "/worlds").length).toBeGreaterThan(listCountBefore);
  await page.evaluate(() => new Promise<void>((resolve) => setTimeout(() => requestAnimationFrame(() => resolve()), 0)));
  expect(apiEvents.filter((event) => event.method === "GET" && event.path === "/worlds/world-a").length).toBe(aDetailGetsBefore);
  releaseWorldB();
  await expect.poll(() => apiEvents.filter((event) => event.method === "GET" && event.path === "/worlds/world-b").length).toBeGreaterThan(bDetailGetsBefore);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await expect(page.locator("#worldEditorTitle")).toHaveText("World Beta");
  await expect(page.locator('#worldManagementCarousel [data-world-id="world-b"]')).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({ path: resolve(evidenceDirectory, "delayed-post-archive-list-keeps-current-world.png") });
});

test("a_delayed_archive_write_and_list_refresh_follow_an_inflight_world_selection", async ({ page }) => {
  let releasePatch!: () => void;
  let releaseWorldList!: () => void;
  let releaseWorldB!: () => void;
  const patchGate = new Promise<void>((resolve) => { releasePatch = resolve; });
  const worldListGate = new Promise<void>((resolve) => { releaseWorldList = resolve; });
  const worldBGate = new Promise<void>((resolve) => { releaseWorldB = resolve; });
  await openWorldManagement(page);
  await page.locator('#worldManagementCarousel [data-world-id="world-a"]').click();
  await expect(page.locator("#worldEditorTitle")).toHaveText("World Alpha");
  const aDetailGetsBefore = apiEvents.filter((event) => event.method === "GET" && event.path === "/worlds/world-a").length;
  const bDetailGetsBefore = apiEvents.filter((event) => event.method === "GET" && event.path === "/worlds/world-b").length;
  worldPatchGates.set("world-a", patchGate);
  worldListGates.push(worldListGate);
  const archiveRequest = page.waitForRequest((request) => request.method() === "PATCH" && new URL(request.url()).pathname === "/api/v1/worlds/world-a");
  const delayedListRequest = page.waitForRequest((request) => request.method() === "GET" && new URL(request.url()).pathname === "/api/v1/worlds");
  await page.locator("#worldSelectionPanel details summary").click();
  await page.locator("#archiveWorld").click();
  await archiveRequest;
  detailGates.set("world-b", worldBGate);
  const worldBRequest = page.waitForRequest((request) => request.method() === "GET" && new URL(request.url()).pathname === "/api/v1/worlds/world-b");
  await page.locator('#worldManagementCarousel [data-world-id="world-b"]').click();
  await worldBRequest;
  releasePatch();
  await expect.poll(() => apiEvents.some((event) => event.method === "PATCH" && event.path === "/worlds/world-a" && event.status === 200)).toBe(true);
  const listCountBefore = apiEvents.filter((event) => event.method === "GET" && event.path === "/worlds").length;
  await delayedListRequest;
  releaseWorldList();
  await expect.poll(() => apiEvents.filter((event) => event.method === "GET" && event.path === "/worlds").length).toBeGreaterThan(listCountBefore);
  await page.evaluate(() => new Promise<void>((resolve) => setTimeout(() => requestAnimationFrame(() => resolve()), 0)));
  expect(apiEvents.filter((event) => event.method === "GET" && event.path === "/worlds/world-a").length).toBe(aDetailGetsBefore);
  const bCompletedBeforeRelease = apiEvents.filter((event) => event.method === "GET" && event.path === "/worlds/world-b").length;
  releaseWorldB();
  await expect.poll(() => apiEvents.filter((event) => event.method === "GET" && event.path === "/worlds/world-b").length).toBeGreaterThan(bCompletedBeforeRelease);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await expect(page.locator("#worldEditorTitle")).toHaveText("World Beta");
  await expect(page.locator('#worldManagementCarousel [data-world-id="world-b"]')).toHaveAttribute("aria-pressed", "true");
  expect(apiEvents.filter((event) => event.method === "GET" && event.path === "/worlds/world-b").length).toBeGreaterThan(bDetailGetsBefore);
  await page.screenshot({ path: resolve(evidenceDirectory, "delayed-archive-write-keeps-inflight-world-selection.png") });
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

test("a_late_completed_cover_job_invalidates_its_world_cache_without_touching_the_current_world", async ({ page }) => {
  let releaseCoverJob!: () => void;
  const coverJobGate = new Promise<void>((resolve) => { releaseCoverJob = resolve; });
  coverJobGates.set("cover-job-a", coverJobGate);
  await openWorldManagement(page, "dashboard");
  await page.locator('#dashboardWorlds [data-world-id="world-a"]').click();
  await expect(page.locator("#worldDetailsTitle")).toHaveText("World Alpha");
  await page.locator("#closeWorldDetails").click();
  await page.evaluate(() => { window.location.hash = "#world-library"; });
  await page.locator('#worldManagementCarousel [data-world-id="world-a"]').waitFor({ state: "visible" });
  const coverJobRequest = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/v1/image-jobs/cover-job-a");
  await page.locator('#worldManagementCarousel [data-world-id="world-a"]').click();
  await coverJobRequest;
  await page.locator('#worldManagementCarousel [data-world-id="world-b"]').click();
  await expect(page.locator("#worldEditorTitle")).toHaveText("World Beta");
  const bDetailGetsBefore = apiEvents.filter((event) => event.method === "GET" && event.path === "/worlds/world-b").length;
  releaseCoverJob();
  await expect.poll(() => apiEvents.some((event) => event.method === "GET" && event.path === "/image-jobs/cover-job-a" && (event.response as { status?: string }).status === "completed")).toBe(true);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await expect(page.locator("#worldEditorTitle")).toHaveText("World Beta");
  await expect(page.locator('#worldManagementCarousel [data-world-id="world-b"]')).toHaveAttribute("aria-pressed", "true");
  await page.evaluate(() => { window.location.hash = "#dashboard"; });
  await page.locator('#dashboardWorlds [data-world-id="world-a"]').click();
  await expect(page.locator("#worldDetailsTitle")).toHaveText("World Alpha");
  await expect(page.locator("#worldDetailsMedia")).toHaveCSS("background-image", /world-a-new-cover/u);
  const bDetailGetsAfter = apiEvents.filter((event) => event.method === "GET" && event.path === "/worlds/world-b").length;
  expect(bDetailGetsAfter).toBe(bDetailGetsBefore);
  await page.locator("#closeWorldDetails").click();
  await page.locator('#dashboardWorlds [data-world-id="world-b"]').click();
  await expect(page.locator("#worldDetailsTitle")).toHaveText("World Beta");
  await expect(page.locator("#worldDetailsMedia")).toHaveCSS("background-image", /world-b-cover/u);
  await page.screenshot({ path: resolve(evidenceDirectory, "late-cover-job-invalidates-only-captured-world.png") });
});

test("creating_a_world_selects_its_returned_draft_instead_of_the_previous_world", async ({ page }) => {
  await openWorldManagement(page);
  await page.locator('#worldManagementCarousel [data-world-id="world-a"]').click();
  await expect(page.locator("#worldEditorTitle")).toHaveText("World Alpha");
  await page.locator("#newWorld").click();
  await page.locator("#worldTitle").fill("World Gamma");
  await page.locator("#saveWorldDraft").click();
  await expect(page.locator("#worldEditorTitle")).toHaveText("World Gamma");
  const createRequest = apiEvents.find((event) => event.method === "POST" && event.path === "/worlds");
  expect(JSON.parse(createRequest?.body || "{}").content.world.title).toBe("World Gamma");
  await expect(page.locator('#worldManagementCarousel [data-world-id="world-c"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('#worldManagementCarousel [data-world-id="world-a"]')).toHaveAttribute("aria-pressed", "false");
  await page.screenshot({ path: resolve(evidenceDirectory, "create-selects-returned-world.png") });
});

test("forking_a_world_selects_its_returned_draft", async ({ page }) => {
  await openWorldManagement(page);
  await page.locator('#worldManagementCarousel [data-world-id="world-a"]').click();
  await expect(page.locator("#worldEditorTitle")).toHaveText("World Alpha");
  await page.locator("#forkWorldModalBtn").click();
  await page.locator("#forkWorldTitle").fill("World Gamma Fork");
  await page.locator("#confirmForkWorld").click();
  await expect(page.locator("#worldEditorTitle")).toHaveText("World Gamma Fork");
  const forkRequest = apiEvents.find((event) => event.method === "POST" && event.path === "/worlds/world-a/fork");
  expect(JSON.parse(forkRequest?.body || "{}")).toMatchObject({ title: "World Gamma Fork", sourceWorldVersionId: "world-a-v1" });
  await expect(page.locator('#worldManagementCarousel [data-world-id="world-c"]')).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({ path: resolve(evidenceDirectory, "fork-selects-returned-world.png") });
});

test("portable_world_import_selects_its_returned_world", async ({ page }) => {
  await openWorldManagement(page);
  await page.locator('#worldManagementCarousel [data-world-id="world-a"]').click();
  await expect(page.locator("#worldEditorTitle")).toHaveText("World Alpha");
  await page.evaluate(() => { window.location.hash = "#imports"; });
  await expect(page.locator("#imports")).toBeVisible();
  await page.locator("#storyFile").setInputFiles({
    name: "portable.world.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ format: "infinite-quest-world", formatVersion: 1, title: "World Gamma", content: {} }))
  });
  await expect(page.locator("#importStory")).toBeEnabled();
  await page.locator("#importStory").click();
  await expect.poll(() => apiEvents.some((event) => event.method === "POST" && event.path === "/imports/world" && event.status === 200)).toBe(true);
  await expect(page.locator("#worldEditorTitle")).toHaveText("World Gamma");
  const importRequest = apiEvents.find((event) => event.method === "POST" && event.path === "/imports/world");
  expect(JSON.parse(importRequest?.body || "{}")).toMatchObject({ sourceName: "portable.world.json", worldExport: { format: "infinite-quest-world", title: "World Gamma" } });
  await expect(page.locator('#worldManagementCarousel [data-world-id="world-c"]')).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({ path: resolve(evidenceDirectory, "portable-import-selects-returned-world.png") });
});

test("a_later_world_selection_wins_over_a_delayed_portable_import_result", async ({ page }) => {
  let releaseImport!: () => void;
  const importGate = new Promise<void>((resolve) => { releaseImport = resolve; });
  worldImportGates.push(importGate);
  await openWorldManagement(page);
  await page.locator('#worldManagementCarousel [data-world-id="world-a"]').click();
  await expect(page.locator("#worldEditorTitle")).toHaveText("World Alpha");
  await page.evaluate(() => { window.location.hash = "#imports"; });
  await expect(page.locator("#imports")).toBeVisible();
  await page.locator("#storyFile").setInputFiles({
    name: "portable.world.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ format: "infinite-quest-world", formatVersion: 1, title: "World Gamma", content: {} }))
  });
  await expect(page.locator("#importStory")).toBeEnabled();
  const importRequest = page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/imports/world");
  await page.locator("#importStory").click();
  await importRequest;
  await page.evaluate(() => { window.location.hash = "#world-library"; });
  await expect(page.locator("#world-library")).toBeVisible();
  await page.locator('#worldManagementCarousel [data-world-id="world-b"]').click();
  await expect(page.locator("#worldEditorTitle")).toHaveText("World Beta");
  const listsBeforeRelease = apiEvents.filter((event) => event.method === "GET" && event.path === "/worlds").length;
  releaseImport();
  await expect.poll(() => apiEvents.some((event) => event.method === "POST" && event.path === "/imports/world" && event.status === 200)).toBe(true);
  await expect.poll(() => apiEvents.filter((event) => event.method === "GET" && event.path === "/worlds").length).toBeGreaterThan(listsBeforeRelease);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await expect(page.locator("#worldEditorTitle")).toHaveText("World Beta");
  await expect(page.locator('#worldManagementCarousel [data-world-id="world-b"]')).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({ path: resolve(evidenceDirectory, "delayed-import-result-respects-later-selection.png") });
});

test("a_stayed_import_result_does_not_become_the_world_selected_by_a_later_refresh", async ({ page }) => {
  let releaseImport!: () => void;
  const importGate = new Promise<void>((resolve) => { releaseImport = resolve; });
  worldImportGates.push(importGate);
  await openWorldManagement(page);
  await page.locator('#worldManagementCarousel [data-world-id="world-a"]').click();
  await expect(page.locator("#worldEditorTitle")).toHaveText("World Alpha");
  await page.evaluate(() => { window.location.hash = "#imports"; });
  await expect(page.locator("#imports")).toBeVisible();
  await page.locator("#storyFile").setInputFiles({
    name: "portable.world.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ format: "infinite-quest-world", formatVersion: 1, title: "World Gamma", content: {} }))
  });
  await expect(page.locator("#importStory")).toBeEnabled();
  const importRequest = page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/imports/world");
  await page.locator("#importStory").click();
  await importRequest;
  await page.evaluate(() => { window.location.hash = "#world-library"; });
  await expect(page.locator("#world-library")).toBeVisible();
  await page.locator("#editWorldDraft").click();
  await expect(page.locator("#worldAuthorDialog")).toBeVisible();
  await page.locator("#worldTitle").fill("Unsaved Alpha edit");
  const listsBeforeRelease = apiEvents.filter((event) => event.method === "GET" && event.path === "/worlds").length;
  releaseImport();
  await expect.poll(() => apiEvents.some((event) => event.method === "POST" && event.path === "/imports/world" && event.status === 200)).toBe(true);
  await expect.poll(() => apiEvents.filter((event) => event.method === "GET" && event.path === "/worlds").length).toBeGreaterThan(listsBeforeRelease);
  await expect(page.locator("#discardChangesDialog")).toBeVisible();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await page.screenshot({ path: resolve(evidenceDirectory, "import-result-dirty-stay-before-refresh.png") });
  await page.locator('#discardChangesDialog button[value="keep"]').click();
  await expect(page.locator("#worldAuthorDialog")).toBeVisible();
  await expect(page.locator("#worldTitle")).toHaveValue("Unsaved Alpha edit");
  await expect(page.locator("#worldEditorTitle")).toHaveText("World Alpha");
  await expect(page.locator('#worldManagementCarousel [data-world-id="world-a"]')).toHaveAttribute("aria-pressed", "true");
  expect(apiEvents.some((event) => event.method === "GET" && event.path === "/worlds/world-c")).toBe(false);
  expect(apiEvents.some((event) => ["PUT", "PATCH", "DELETE"].includes(event.method))).toBe(false);

  await page.locator("#cancelWorldAuthor").click();
  await expect(page.locator("#discardChangesDialog")).toBeVisible();
  await page.locator('#discardChangesDialog button[value="discard"]').click();
  await expect(page.locator("#worldAuthorDialog")).toBeHidden();
  const worldListsBeforeRefresh = apiEvents.filter((event) => event.method === "GET" && event.path === "/worlds").length;
  const worldDetailReadsBeforeRefresh = apiEvents.filter((event) => event.method === "GET" && /^\/worlds\/world-[ac]$/u.test(event.path)).length;
  await page.locator("#refreshWorlds").click();
  await expect.poll(() => apiEvents.filter((event) => event.method === "GET" && event.path === "/worlds").length).toBeGreaterThan(worldListsBeforeRefresh);
  await expect.poll(() => apiEvents.filter((event) => event.method === "GET" && /^\/worlds\/world-[ac]$/u.test(event.path)).length).toBeGreaterThan(worldDetailReadsBeforeRefresh);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await expect(page.locator("#worldEditorTitle")).toHaveText("World Alpha");
  await expect(page.locator('#worldManagementCarousel [data-world-id="world-a"]')).toHaveAttribute("aria-pressed", "true");
  expect(apiEvents.some((event) => event.method === "GET" && event.path === "/worlds/world-c")).toBe(false);
  expect(apiEvents.some((event) => ["PUT", "PATCH", "DELETE"].includes(event.method))).toBe(false);
  await page.screenshot({ path: resolve(evidenceDirectory, "import-result-dirty-stay-refresh-keeps-alpha.png") });
});
