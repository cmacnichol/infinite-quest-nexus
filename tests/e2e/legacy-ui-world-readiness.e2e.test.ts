import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";

const origin = `http://127.0.0.1:${process.env.PLAYWRIGHT_LEGACY_PORT ?? "43173"}`;
const evidenceDirectory = resolve(".superpowers/sdd/legacy-ui-2026-10-03/evidence/T17");
const versionOneId = "10000000-0000-4000-8000-000000000002";
const versionTwoId = "10000000-0000-4000-8000-000000000003";
const worldId = "10000000-0000-4000-8000-000000000001";
const oldCharacter = { id: "fixture-character", name: "Mira Vale", characterText: "A patient guide.", profile: {}, rpgStats: [], defaultTriggers: [], source: {} };

type Assessment = { ready: boolean; issues: Array<Record<string, unknown>> } | null;
type ApiOptions = {
  initialWorld?: Record<string, unknown>;
  assessment?: Assessment;
  assessmentStatus?: number | number[];
  holdWrite?: (method: string, path: string) => Promise<void>;
  holdReadiness?: () => Promise<void>;
  failFirstDraftSave?: boolean;
};

function publishedWorld(options: { draftHasCharacter?: boolean; campaigns?: Record<string, unknown>[] } = {}) {
  const draftContent = {
    schemaVersion: 5,
    world: { title: "Aster Vale", genre: "", tone: "", premise: "", backgroundStory: "", firstAction: "", rules: "" },
    playableCharacters: options.draftHasCharacter ? [oldCharacter] : [],
    entities: [], relationships: [], rpgStats: [], defaultTriggers: [], eventTriggers: [], assets: [], defaults: {}
  };
  const immutableContent = {
    ...draftContent,
    world: { ...draftContent.world, title: "Aster Vale published version" },
    playableCharacters: [oldCharacter]
  };
  return {
    id: worldId,
    title: "Aster Vale",
    status: "active",
    draftRevision: 3,
    draftContent,
    latestVersionId: versionOneId,
    latestVersionNumber: 1,
    versions: [{ id: versionOneId, versionNumber: 1, releaseNotes: "Original release", content: immutableContent }],
    campaigns: options.campaigns ?? []
  };
}

async function installWorldApi(page: Page, options: ApiOptions = {}) {
  let world: Record<string, any> | null = options.initialWorld ? structuredClone(options.initialWorld) : null;
  let failDraftSave = Boolean(options.failFirstDraftSave);
  const readinessStatuses = Array.isArray(options.assessmentStatus) ? [...options.assessmentStatus] : [options.assessmentStatus || 0];
  let readinessCalls = 0;
  const writes: Array<{ method: string; path: string; body: any }> = [];
  const campaignCreates: any[] = [];
  const existingCampaigns = world?.campaigns || [];
  await page.route("**/api/v1/**", async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const body = method === "GET" ? null : (() => { try { return request.postDataJSON(); } catch { return null; } })();
    if (method !== "GET") writes.push({ method, path, body });
    if (path === "/api/v1/meta") return route.fulfill({ json: { application: { version: "synthetic" }, capabilities: {} } });
    if (path === "/api/v1/session") return route.fulfill({ json: { user: { id: "synthetic-user", displayName: "Fixture" } } });
    if (path === "/api/v1/worlds" && method === "GET") {
      const latest = world?.versions?.at(-1);
      const content = world?.draftContent?.world || {};
      return route.fulfill({ json: { worlds: world ? [{
        id: world.id,
        title: world.title,
        status: world.status,
        campaignCount: world.campaigns?.length || 0,
        latestVersionId: latest?.id || null,
        latestVersionNumber: latest?.versionNumber || null,
        updatedAt: "2026-10-03T12:00:00.000Z",
        latestPreview: content
      }] : [] } });
    }
    if (path === "/api/v1/worlds" && method === "POST") {
      await options.holdWrite?.(method, path);
      world = {
        id: worldId,
        title: body.title,
        status: "draft",
        draftRevision: 1,
        draftContent: body.content,
        latestVersionId: null,
        latestVersionNumber: null,
        versions: [],
        campaigns: []
      };
      return route.fulfill({ status: 201, json: { id: worldId } });
    }
    if (path === `/api/v1/worlds/${worldId}` && method === "GET") return route.fulfill({ json: world || {} });
    if (path === `/api/v1/worlds/${worldId}/draft` && method === "PUT") {
      await options.holdWrite?.(method, path);
      if (failDraftSave) {
        failDraftSave = false;
        return route.fulfill({ status: 503, json: { message: "Synthetic retryable draft save failure." } });
      }
      if (world) {
        world.title = body.title;
        world.draftContent = body.content;
        world.draftRevision += 1;
      }
      return route.fulfill({ json: {} });
    }
    if (path === `/api/v1/worlds/${worldId}/publish` && method === "POST") {
      if (world) {
        const versionNumber = (world.versions?.at(-1)?.versionNumber || 0) + 1;
        const version = { id: versionNumber === 2 ? versionTwoId : versionOneId, versionNumber, releaseNotes: body.releaseNotes || "", content: world.draftContent };
        world.versions.push(version);
        world.latestVersionId = version.id;
        world.latestVersionNumber = versionNumber;
        world.status = "active";
      }
      return route.fulfill({ json: { versionNumber: world?.latestVersionNumber || 1 } });
    }
    if (path.startsWith("/api/v1/world-versions/") && path.endsWith("/playable-characters")) {
      readinessCalls += 1;
      await options.holdReadiness?.();
      const readinessStatus = readinessStatuses.length > 1 ? readinessStatuses.shift()! : readinessStatuses[0];
      if (readinessStatus && readinessStatus >= 400) return route.fulfill({ status: readinessStatus, json: { message: "Synthetic readiness service unavailable." } });
      const version = world?.versions?.find((candidate: any) => path.includes(encodeURIComponent(candidate.id)) || path.endsWith(`/${candidate.id}/playable-characters`));
      const chars = version?.content?.playableCharacters || [];
      const assessment = options.assessment || { ready: chars.length > 0, issues: [] };
      return route.fulfill({ json: { characters: chars.map((character: any) => ({ id: character.id, name: character.name, rpgStatCount: 0, defaultTriggerCount: 0 })), readiness: assessment } });
    }
    if (path === "/api/v1/campaigns" && method === "GET") return route.fulfill({ json: { campaigns: existingCampaigns } });
    if (path === "/api/v1/campaigns" && method === "POST") {
      campaignCreates.push(body);
      return route.fulfill({ status: 201, json: { id: "new-campaign", title: body.title } });
    }
    if (path === "/api/v1/dashboard/stats") return route.fulfill({ json: { worlds: { total: world ? 1 : 0 }, campaigns: { total: existingCampaigns.length }, turns: { total: 0 }, costs: { totalUsd: 0, byProvider: [] } } });
    if (path === "/api/v1/providers") return route.fulfill({ json: { providers: [] } });
    return route.fulfill({ json: {} });
  });
  return { writes, campaignCreates, getWorld: () => world, getReadinessCalls: () => readinessCalls };
}

async function openWorldLibrary(page: Page) {
  await page.setViewportSize({ width: 1280, height: 800 });
  mkdirSync(evidenceDirectory, { recursive: true });
  await page.goto(`${origin}/nexus/index.html#world-library`);
}

async function openNewWorld(page: Page) {
  await openWorldLibrary(page);
  await page.locator("#newWorld").click();
  await page.locator("#worldTitle").fill("Aster Vale");
}

async function openExistingWorld(page: Page, fixture: Record<string, unknown>) {
  await openWorldLibrary(page);
  await page.locator(`#worldManagementCarousel [data-world-id="${worldId}"]`).click();
  await expect(page.locator("#worldEditorTitle")).toHaveText(String(fixture.title));
  await page.locator("#editWorldDraft").click();
}

test("world authoring controls stay frozen while a draft save is pending", async ({ page }) => {
  let releaseSave!: () => void;
  let markSaveStarted!: () => void;
  const saveHeld = new Promise<void>((resolveHeld) => { releaseSave = resolveHeld; });
  const saveStarted = new Promise<void>((resolveStarted) => { markSaveStarted = resolveStarted; });
  const api = await installWorldApi(page, { holdWrite: async (method, path) => { if (method === "POST" && path === "/api/v1/worlds") { markSaveStarted(); await saveHeld; } } });
  await openNewWorld(page);
  await page.locator('[data-tab-target="world-author-mechanics"]').click();
  await page.locator("#saveWorldDraft").click();
  await saveStarted;
  try {
    await page.screenshot({ path: resolve(evidenceDirectory, "author-save-pending.png") });
    await expect(page.locator("#worldTitle")).toBeDisabled();
    await expect(page.locator("#addPlayableCharacter")).toBeDisabled();
    await expect(page.locator("#worldAuthorStatus")).toContainText("Creating authoritative world draft");
  } finally {
    releaseSave();
  }
  await expect(page.locator("#worldAuthorDialog")).toBeHidden();
  expect(api.writes.find((write) => write.path === "/api/v1/worlds")?.body.title).toBe("Aster Vale");
});

test("a failed draft save preserves values, enables retry, and restores optional controls", async ({ page }) => {
  const api = await installWorldApi(page, { initialWorld: publishedWorld(), failFirstDraftSave: true });
  await openExistingWorld(page, publishedWorld());
  await page.locator("#worldTitle").fill("Aster Vale revised");
  await page.locator("#saveWorldDraft").click();
  await expect(page.locator("#worldAuthorStatus")).toContainText("Synthetic retryable draft save failure");
  await expect(page.locator("#worldTitle")).toBeEnabled();
  await expect(page.locator("#saveWorldDraft")).toBeEnabled();
  await expect(page.locator("#generateWorldPreview")).toBeDisabled();
  await expect(page.locator("#worldTitle")).toHaveValue("Aster Vale revised");
  await page.screenshot({ path: resolve(evidenceDirectory, "author-save-failure-retryable.png") });
  await page.locator("#saveWorldDraft").click();
  await expect(page.locator("#worldAuthorDialog")).toBeHidden();
  expect(api.writes.filter((write) => write.path === `/api/v1/worlds/${worldId}/draft`)).toHaveLength(2);
  await page.locator("#editWorldDraft").click();
  await expect(page.locator("#worldTitle")).toBeEnabled();
  await expect(page.locator("#addPlayableCharacter")).toBeEnabled();
  await expect(page.locator("#saveWorldDraft")).toBeEnabled();
  await page.screenshot({ path: resolve(evidenceDirectory, "author-save-reopened-controls-restored.png") });
});

test("title-only drafts can be saved and the checklist treats lore as guidance", async ({ page }) => {
  const api = await installWorldApi(page);
  await openNewWorld(page);
  await expect(page.locator("#worldAuthorSteps")).toBeVisible();
  await expect(page.locator("#worldAuthorLoreStatus")).toContainText("Optional");
  await page.locator('[data-world-author-step="review"]').click();
  await expect(page.locator("#worldAuthorCharacterStatus")).toContainText("at least one playable character");
  const reviewColumnCount = await page.locator("#world-author-review").evaluate((section) => getComputedStyle(section).gridTemplateColumns.trim().split(/\s+/).length);
  expect(reviewColumnCount).toBe(1);
  await expect(page.locator("#saveWorldDraft")).toBeEnabled();
  await page.locator("#worldAuthorPublishedReadiness").scrollIntoViewIfNeeded();
  await expect(page.locator("#worldAuthorPublishedReadiness")).toBeInViewport();
  await page.screenshot({ path: resolve(evidenceDirectory, "title-only-draft-review.png") });
  await page.locator("#saveWorldDraft").click();
  await expect(page.locator("#worldAuthorDialog")).toBeHidden();
  expect(api.writes.filter((write) => write.path === "/api/v1/worlds")).toHaveLength(1);
  expect(api.writes.some((write) => write.path.endsWith("/publish"))).toBe(false);
  expect(api.writes.some((write) => write.path === "/api/v1/campaigns" && write.method === "POST")).toBe(false);
  expect(api.getWorld()?.draftContent.playableCharacters).toEqual([]);
});

test("published readiness stays attached to its immutable version, separate from current draft guidance", async ({ page }) => {
  const fixture = publishedWorld();
  const api = await installWorldApi(page, { initialWorld: fixture, assessment: { ready: true, issues: [] } });
  await openExistingWorld(page, fixture);
  await page.locator("#worldTitle").fill("Aster Vale working draft");
  await page.locator('[data-world-author-step="review"]').click();
  await expect(page.locator("#worldAuthorCharacterStatus")).toContainText("at least one playable character");
  await expect(page.locator("#worldAuthorPublishedReadiness")).toContainText("Aster Vale");
  await expect(page.locator("#worldAuthorPublishedReadiness")).toContainText("published version 1");
  await expect(page.locator("#worldAuthorPublishedReadiness")).toContainText("Campaign-ready");
  await expect(page.locator("#worldAuthorPublishedReadiness")).toContainText("immutable version only");
  await page.locator("#worldAuthorPublishedReadiness").scrollIntoViewIfNeeded();
  await expect(page.locator("#worldAuthorPublishedReadiness")).toBeInViewport();
  await page.screenshot({ path: resolve(evidenceDirectory, "published-readiness-scoped-to-version.png") });
  expect(api.writes).toEqual([]);
});

test("a new world does not inherit readiness from the previously selected published world", async ({ page }) => {
  const fixture = publishedWorld();
  const api = await installWorldApi(page, { initialWorld: fixture, assessment: { ready: true, issues: [] } });
  await openExistingWorld(page, fixture);
  await page.locator("#cancelWorldAuthor").click();
  await expect(page.locator("#worldAuthorDialog")).toBeHidden();
  await page.locator("#newWorld").click();
  await page.locator("#worldTitle").fill("A wholly new world");
  await page.locator('[data-world-author-step="review"]').click();

  const readiness = page.locator("#worldAuthorPublishedReadiness");
  const fixEvidenceDirectory = resolve(".superpowers/sdd/legacy-ui-2026-10-03/evidence/T17-fix1");
  mkdirSync(fixEvidenceDirectory, { recursive: true });
  await readiness.scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(fixEvidenceDirectory, "new-world-no-inherited-readiness.png") });
  await expect(readiness).toContainText("No published version is available");
  await expect(readiness).toContainText("current draft has not been assessed");
  await expect(readiness).not.toContainText("Aster Vale");
  await expect(readiness).not.toContainText("Campaign-ready");
  await expect(page.locator("#worldAuthorLoreStatus")).toContainText("Optional");
  await expect(page.locator("#saveWorldDraft")).toBeEnabled();
  expect(api.writes).toEqual([]);
});

test("recognized character issues open its editor and unknown messages render as text", async ({ page }) => {
  const fixture = publishedWorld({ draftHasCharacter: true });
  const api = await installWorldApi(page, { initialWorld: fixture, assessment: { ready: false, issues: [
    { code: "missing-character-text", characterIndex: 0, characterId: "fixture-character", message: "Character guidance is required." },
    { code: "unknown-future-rule", message: "<img src=x onerror=alert(1)>" }
  ] } });
  await openExistingWorld(page, fixture);
  await page.locator('[data-world-author-step="review"]').click();
  await expect(page.locator("#worldAuthorPublishedReadiness")).toContainText("Character guidance is required.");
  await expect(page.locator("#worldAuthorPublishedReadiness img")).toHaveCount(0);
  await expect(page.locator("#worldAuthorPublishedReadiness")).toContainText("<img src=x onerror=alert(1)>");
  await page.getByRole("button", { name: "Open character editor for Mira Vale" }).click();
  await expect(page.locator("#characterDialog")).toBeVisible();
  await expect(page.locator("#characterName")).toHaveValue("Mira Vale");
  await page.screenshot({ path: resolve(evidenceDirectory, "readiness-character-link-opens-editor.png") });
  expect(api.writes).toEqual([]);
});

test("failed server readiness stays unknown rather than presenting success", async ({ page }) => {
  const fixture = publishedWorld();
  await installWorldApi(page, { initialWorld: fixture, assessmentStatus: 503 });
  await openExistingWorld(page, fixture);
  await page.locator('[data-world-author-step="review"]').click();
  await expect(page.locator("#worldAuthorPublishedReadiness")).toContainText("could not be checked");
  await expect(page.locator("#worldAuthorPublishedReadiness")).toContainText("not campaign-ready");
  await expect(page.locator("#worldAuthorPublishedReadiness")).not.toContainText("Campaign-ready");
  await page.screenshot({ path: resolve(evidenceDirectory, "readiness-server-failure-not-ready.png") });
});


test("failed readiness can be retried without losing current draft or character edits", async ({ page }) => {
  const fixture = publishedWorld({ draftHasCharacter: true });
  const api = await installWorldApi(page, { initialWorld: fixture, assessmentStatus: [503, 0], assessment: { ready: true, issues: [] } });
  await openExistingWorld(page, fixture);
  await page.locator("#worldTitle").fill("Unsaved title during readiness retry");
  await page.locator('[data-world-author-step="character"]').click();
  await page.getByRole("button", { name: "Edit Mira Vale" }).click();
  await page.locator("#characterOtherGuidance").fill("Unsaved character guidance during readiness retry.");
  await page.locator("#saveCharacter").click();
  await page.locator('[data-world-author-step="review"]').click();
  await expect(page.locator("#worldAuthorPublishedReadiness")).toContainText("could not be checked");
  expect(api.getReadinessCalls()).toBe(1);
  await page.locator("#worldAuthorPublishedReadiness").getByRole("button", { name: "Retry server assessment" }).click();
  await expect(page.locator("#worldAuthorPublishedReadiness")).toContainText("Campaign-ready");
  await expect(page.locator("#worldTitle")).toHaveValue("Unsaved title during readiness retry");
  await page.locator('[data-world-author-step="character"]').click();
  await expect(page.getByRole("button", { name: "Edit Mira Vale" })).toBeVisible();
  await page.getByRole("button", { name: "Edit Mira Vale" }).click();
  await expect(page.locator("#characterOtherGuidance")).toHaveValue("Unsaved character guidance during readiness retry.");
  await page.locator("#cancelCharacter").click();
  await expect(page.locator("#characterDialog")).toBeHidden();
  expect(api.getReadinessCalls()).toBe(2);
  expect(api.writes).toEqual([]);
  await page.screenshot({ path: resolve(evidenceDirectory, "readiness-retry-preserves-unsaved-authoring.png") });
});

test("a readiness issue button rendered during a failed draft save becomes usable afterward", async ({ page }) => {
  const fixture = publishedWorld({ draftHasCharacter: true });
  let releaseReadiness!: () => void;
  let readinessStarted!: () => void;
  const heldReadiness = new Promise<void>((resolveReadiness) => { releaseReadiness = resolveReadiness; });
  const readinessPending = new Promise<void>((resolveStarted) => { readinessStarted = resolveStarted; });
  let releaseSave!: () => void;
  let saveStarted!: () => void;
  const heldSave = new Promise<void>((resolveSave) => { releaseSave = resolveSave; });
  const savePending = new Promise<void>((resolveStarted) => { saveStarted = resolveStarted; });
  const api = await installWorldApi(page, {
    initialWorld: fixture,
    assessmentStatus: [503, 0],
    assessment: { ready: false, issues: [{ code: "missing-character-text", characterId: "fixture-character", message: "Character guidance is required." }] },
    failFirstDraftSave: true,
    holdReadiness: async () => { if (api.getReadinessCalls() > 1) { readinessStarted(); await heldReadiness; } },
    holdWrite: async (method, path) => { if (method === "PUT" && path.endsWith("/draft")) { saveStarted(); await heldSave; } }
  });
  await openExistingWorld(page, fixture);
  await page.locator('[data-world-author-step="review"]').click();
  await page.locator("#worldAuthorPublishedReadiness").getByRole("button", { name: "Retry server assessment" }).click();
  await readinessPending;
  await page.locator('[data-world-author-step="basics"]').click();
  await page.locator("#worldTitle").fill("Retry issue action draft");
  await page.locator('[data-world-author-step="review"]').click();
  await page.locator("#saveWorldDraft").click();
  await savePending;
  releaseReadiness();
  const issueAction = page.getByRole("button", { name: "Open character editor for Mira Vale" });
  await expect(issueAction).toBeDisabled();
  releaseSave();
  await expect(page.locator("#worldAuthorStatus")).toContainText("Synthetic retryable draft save failure");
  await expect(page.getByRole("button", { name: "Open character editor for Mira Vale" })).toBeEnabled();
  await page.screenshot({ path: resolve(evidenceDirectory, "readiness-issue-action-restored-after-save-failure.png") });
  await page.getByRole("button", { name: "Open character editor for Mira Vale" }).click();
  await expect(page.locator("#characterDialog")).toBeVisible();
  expect(api.writes.filter((write) => write.path.endsWith("/draft"))).toHaveLength(1);
});

test("publishing and creating a campaign remain explicit and preserve existing version pins", async ({ page }) => {
  const existingCampaign = { id: "existing-campaign", title: "Existing campaign", worldId, worldTitle: "Aster Vale", worldVersionId: versionOneId, worldVersionNumber: 1, activeTurnNumber: 3, status: "active", updatedAt: "2026-10-03T12:00:00.000Z" };
  const fixture = publishedWorld({ draftHasCharacter: true, campaigns: [existingCampaign] });
  const api = await installWorldApi(page, { initialWorld: fixture, assessment: { ready: true, issues: [] } });
  await openExistingWorld(page, fixture);
  await page.locator("#worldTitle").fill("Aster Vale revision");
  await page.locator("#saveWorldDraft").click();
  await expect(page.locator("#worldAuthorDialog")).toBeHidden();
  expect(api.writes.some((write) => write.path.endsWith("/publish"))).toBe(false);
  expect(api.writes.some((write) => write.path === "/api/v1/campaigns" && write.method === "POST")).toBe(false);
  await page.locator("#publishWorld").click();
  await expect(page.locator("#worldStatus")).toContainText("Version 2 published");
  expect(api.writes.filter((write) => write.path.endsWith("/publish"))).toHaveLength(1);
  expect(api.writes.some((write) => write.path === "/api/v1/campaigns" && write.method === "POST")).toBe(false);
  expect(api.getWorld()?.campaigns[0].worldVersionId).toBe(versionOneId);
  await expect(page.locator("#createCampaignModalBtn")).toBeEnabled();
  await page.screenshot({ path: resolve(evidenceDirectory, "publish-does-not-create-campaign.png") });
  await page.locator("#createCampaignModalBtn").click();
  await expect(page.locator("#createCampaignDialog")).toBeVisible();
  await page.locator("#newCampaignTitle").fill("Explicit campaign action");
  expect(api.writes.some((write) => write.path === "/api/v1/campaigns" && write.method === "POST")).toBe(false);
  await page.locator("#cancelCreateCampaign").click();
  await expect(page.locator("#discardChangesDialog")).toBeVisible();
  await page.locator('#discardChangesDialog button[value="discard"]').click();
  await expect(page.locator("#createCampaignDialog")).toBeHidden();
  expect(api.campaignCreates).toEqual([]);
  expect(api.getWorld()?.campaigns[0].worldVersionId).toBe(versionOneId);
  await page.locator("#worldVersionSelect").selectOption(versionTwoId);
  await expect(page.locator("#worldCampaignReadiness")).toContainText("Campaign-ready");
  await page.locator("#createCampaignModalBtn").click();
  await page.locator("#newCampaignTitle").fill("Explicit version two campaign");
  await page.getByRole("button", { name: "Create only" }).click();
  await expect(page.locator("#createCampaignDialog")).toBeHidden();
  await expect(page.locator("#worldStatus")).toContainText("Campaign created");
  expect(api.campaignCreates).toHaveLength(1);
  expect(api.campaignCreates[0]).toMatchObject({ title: "Explicit version two campaign", worldVersionId: versionTwoId });
  expect(api.getWorld()?.campaigns[0].worldVersionId).toBe(versionOneId);
});

test("world author steps remain usable at 200 percent page zoom", async ({ page }) => {
  await installWorldApi(page);
  await openNewWorld(page);
  await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
  await expect(page.locator("#worldAuthorSteps")).toBeVisible();
  await expect(page.locator('[data-world-author-step="basics"]')).toBeVisible();
  await page.locator('[data-world-author-step="lore"]').click();
  await expect(page.locator("#world-author-lore")).toBeVisible();
  await page.screenshot({ path: resolve(evidenceDirectory, "world-author-steps-200-percent.png"), fullPage: false });
});
