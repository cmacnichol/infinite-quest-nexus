import { expect, test, type Page, type Route } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { installLegacyUiFixture, legacyUiFixture } from "./helpers/legacy-ui-fixtures.js";

const origin = `http://127.0.0.1:${process.env.PLAYWRIGHT_LEGACY_PORT ?? "43173"}`;
const evidenceDirectory = resolve(".superpowers/sdd/legacy-ui-2026-10-03/evidence/T20");

async function installCreationApi(page: Page, worldCount = 1) {
  const fixture = legacyUiFixture({ turnCount: 0, worldCount, campaignCount: 0 });
  const base = await installLegacyUiFixture(page, fixture);
  const creates: Array<Record<string, unknown>> = [];
  let failCampaignRefresh = false;
  let failNextCreate = false;
  let holdCreate: Promise<void> | null = null;
  let holdNextReadiness: Promise<void> | null = null;
  let heldReadinessResult: Record<string, unknown> | null = null;
  let signalReadinessStarted!: () => void;
  let signalDelayedReadinessFinished!: () => void;
  const readinessStarted = new Promise<void>(resolve => { signalReadinessStarted = resolve; });
  const delayedReadinessFinished = new Promise<void>(resolve => { signalDelayedReadinessFinished = resolve; });
  await page.route("**/api/v1/campaigns", async (route: Route) => {
    if (route.request().method() === "POST") {
      creates.push(route.request().postDataJSON() as Record<string, unknown>);
      if (failNextCreate) {
        failNextCreate = false;
        return route.fulfill({ status: 503, json: { error: "ServiceUnavailable", message: "Campaign create failed." } });
      }
      await holdCreate;
      return route.fulfill({ status: 201, json: { id: "00000000-0000-4000-8000-000000000099", title: "A campaign", status: "active", activeTurnNumber: 0, storyLengthProfile: "standard", storyContextBudgetTokens: 32000, worldId: fixture.worlds[0]!.id, worldVersionId: "00000000-0000-4000-8000-000000000098", worldVersionNumber: 1, selectedCharacterId: "fixture-observer", selectedCharacterName: "The Observer", textProviderProfileId: null, imageProviderProfileId: null } });
    }
    if (route.request().method() === "GET" && failCampaignRefresh) {
      return route.fulfill({ status: 503, json: { message: "Campaign list refresh failed." } });
    }
    return route.fallback();
  });
  await page.route("**/api/v1/session", route => route.fulfill({ json: {
    user: { id: "10000000-0000-4000-8000-0000000003e7", displayName: "Fixture Reader", settings: { defaultTurnControlStyle: "flexible_scene" } }
  } }));
  await page.route("**/api/v1/world-versions/*/playable-characters", async (route: Route) => {
    if (holdNextReadiness) {
      const gate = holdNextReadiness;
      holdNextReadiness = null;
      signalReadinessStarted();
      await gate;
      if (heldReadinessResult) {
        const result = heldReadinessResult;
        heldReadinessResult = null;
        await route.fulfill({ json: result });
        signalDelayedReadinessFinished();
        return;
      }
    }
    return route.fallback();
  });
  await page.route("**/story/00000000-0000-4000-8000-000000000099", route => route.fulfill({ contentType: "text/html", body: "<title>Committed story</title>" }));
  return {
    creates,
    requests: base.requests,
    failCampaignRefresh: () => { failCampaignRefresh = true; },
    failNextCampaignCreate: () => { failNextCreate = true; },
    delayCreate(gate: Promise<void>) { holdCreate = gate; },
    delayNextReadiness(gate: Promise<void>, result: Record<string, unknown> | null = null) { holdNextReadiness = gate; heldReadinessResult = result; },
    waitForReadiness: () => readinessStarted,
    waitForDelayedReadiness: () => delayedReadinessFinished,
    fixture
  };
}

async function openDashboardCreation(page: Page) {
  await page.goto(`${origin}/nexus/index.html#dashboard`);
  await page.locator("#dashboardWorlds").getByText("Fixture World 1", { exact: true }).click();
  await page.locator("#worldDetailsDialog").getByRole("button", { name: "Create a campaign" }).click();
}

async function openManagementCreation(page: Page) {
  await page.goto(`${origin}/nexus/index.html#world-library`);
  await page.locator("#worldManagementCarousel").getByRole("button", { name: "Select Fixture World 1" }).click();
  await expect(page.locator("#createCampaignModalBtn")).toBeEnabled();
  await page.locator("#createCampaignModalBtn").click();
}

async function fillCampaignBasics(page: Page) {
  await expect(page.locator("#createCampaignDialog")).toBeVisible();
  await expect(page.locator("#createCampaignWorldVersion")).toContainText("Version 1");
  await page.locator("#newCampaignTitle").fill("Shared campaign title");
  await page.locator("#newCampaignCharacter").selectOption("fixture-observer");
}

test("dashboard and management use the same creation payload and show the pinned version", async ({ page }) => {
  const api = await installCreationApi(page);
  mkdirSync(evidenceDirectory, { recursive: true });
  await openDashboardCreation(page);
  await fillCampaignBasics(page);
  await expect(page.locator("#createCampaignAdvanced")).not.toHaveAttribute("open", "");
  await page.screenshot({ path: resolve(evidenceDirectory, "dashboard-campaign-creation.png") });
  await page.getByRole("button", { name: "Create only" }).click();
  await expect(page.locator("#createCampaignDialog")).toBeHidden();

  await openManagementCreation(page);
  await fillCampaignBasics(page);
  await expect(page.locator("#createCampaignAdvanced")).not.toHaveAttribute("open", "");
  await page.screenshot({ path: resolve(evidenceDirectory, "management-campaign-creation.png") });
  await page.getByRole("button", { name: "Create only" }).click();
  await expect(page.locator("#createCampaignDialog")).toBeHidden();

  expect(api.creates).toHaveLength(2);
  expect(api.creates[0]).toEqual(api.creates[1]);
  expect(api.creates[0]).toMatchObject({
    title: "Shared campaign title",
    worldVersionId: "10000000-0000-4000-8000-0000000000c8",
    selectedCharacterId: "fixture-observer",
    turnControlStyle: "flexible_scene"
  });
  expect(api.creates[0]).not.toHaveProperty("startAfterCreate");
});

test("advanced settings collapse without losing entered campaign basics", async ({ page }) => {
  const api = await installCreationApi(page);
  await openManagementCreation(page);
  await fillCampaignBasics(page);
  await page.locator("#createCampaignAdvanced").locator("summary").click();
  await page.locator("#newCampaignTurnControlStyle").selectOption("flexible_action");
  await page.locator("#createCampaignAdvanced").locator("summary").click();
  await expect(page.locator("#newCampaignTitle")).toHaveValue("Shared campaign title");
  await expect(page.locator("#newCampaignCharacter")).toHaveValue("fixture-observer");
  await page.locator("#createCampaignAdvanced").locator("summary").click();
  await expect(page.locator("#newCampaignTurnControlStyle")).toHaveValue("flexible_action");
  await page.getByRole("button", { name: "Create only" }).click();
  await expect(page.locator("#createCampaignDialog")).toBeHidden();
  expect(api.creates[0]).toMatchObject({ turnControlStyle: "flexible_action" });
});

test("create and start opens the committed campaign ID", async ({ page }) => {
  const api = await installCreationApi(page);
  await openDashboardCreation(page);
  await fillCampaignBasics(page);
  await page.getByRole("button", { name: "Create and start" }).click();
  await expect(page).toHaveURL(/\/story\/00000000-0000-4000-8000-000000000099$/u);
  expect(api.creates).toHaveLength(1);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("infinite-quest.user.10000000-0000-4000-8000-0000000003e7.infiniteQuestLastCampaignId"))).toBe("00000000-0000-4000-8000-000000000099");
});

test("Enter uses the safe Create only default and leaves the user in management", async ({ page }) => {
  const api = await installCreationApi(page);
  await openManagementCreation(page);
  await fillCampaignBasics(page);
  await page.locator("#newCampaignTitle").press("Enter");
  await expect(page.locator("#createCampaignDialog")).toBeHidden();
  await expect(page).toHaveURL(`${origin}/nexus/index.html#world-library?worldId=${String(api.fixture.worlds[0]?.id)}`);
  expect(api.creates).toHaveLength(1);
  expect(api.creates[0]).toMatchObject({ turnControlStyle: "flexible_scene" });
});

test("a failed create preserves the draft for an explicit retry", async ({ page }) => {
  const api = await installCreationApi(page);
  api.failNextCampaignCreate();
  await openManagementCreation(page);
  await fillCampaignBasics(page);
  await page.getByRole("button", { name: "Create only" }).click();
  await expect(page.locator("#createCampaignStatus")).toContainText("Campaign create failed.");
  await expect(page.locator("#newCampaignTitle")).toHaveValue("Shared campaign title");
  await expect(page.locator("#newCampaignCharacter")).toHaveValue("fixture-observer");
  await page.getByRole("button", { name: "Create only" }).click();
  await expect(page.locator("#createCampaignDialog")).toBeHidden();
  expect(api.creates).toHaveLength(2);
  expect(api.creates[0]).toEqual(api.creates[1]);
});

test("double submission makes one POST and a failed post-commit refresh offers the committed story", async ({ page }) => {
  const api = await installCreationApi(page);
  mkdirSync(evidenceDirectory, { recursive: true });
  await page.addInitScript(() => {
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "infinite-quest.user.10000000-0000-4000-8000-0000000003e7.infiniteQuestLastCampaignId") throw new Error("Storage unavailable.");
      originalSetItem.call(this, key, value);
    };
  });
  let releaseCreate!: () => void;
  api.delayCreate(new Promise<void>(resolve => { releaseCreate = resolve; }));
  await openManagementCreation(page);
  await fillCampaignBasics(page);
  await page.getByRole("button", { name: "Create only" }).click();
  await expect.poll(() => api.creates.length).toBe(1);
  await expect(page.locator("#newCampaignTitle")).toBeDisabled();
  await expect(page.locator("#newCampaignCharacter")).toBeDisabled();
  await expect(page.locator("#newCampaignTurnControlStyle")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await page.locator("#createCampaignForm").evaluate((form: HTMLFormElement) => { form.requestSubmit(); form.requestSubmit(); });
  expect(api.creates).toHaveLength(1);
  api.failCampaignRefresh();
  releaseCreate();
  await expect(page.getByRole("button", { name: "Open story" })).toBeVisible();
  await expect(page.locator("#newCampaignTitle")).toBeDisabled();
  await expect(page.locator("#newCampaignCharacter")).toBeDisabled();
  await expect(page.locator("#newCampaignTurnControlStyle")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Cancel" })).toBeEnabled();
  await page.screenshot({ path: resolve(evidenceDirectory, "committed-refresh-failure.png") });
  await page.locator("#createCampaignDialog").locator("form").evaluate((form: HTMLFormElement) => form.requestSubmit());
  expect(api.creates).toHaveLength(1);
  await page.getByRole("button", { name: "Open story" }).click();
  await expect(page).toHaveURL(/\/story\/00000000-0000-4000-8000-000000000099$/u);
  expect(api.creates).toHaveLength(1);
});

test("Cancel closes committed state without a discard prompt and reopening starts a new draft", async ({ page }) => {
  const api = await installCreationApi(page);
  api.failCampaignRefresh();
  await openManagementCreation(page);
  await fillCampaignBasics(page);
  await page.getByRole("button", { name: "Create only" }).click();
  await expect(page.getByRole("button", { name: "Open story" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator("#createCampaignDialog")).toBeHidden();
  await expect(page.locator("#discardChangesDialog")).toBeHidden();
  expect(api.creates).toHaveLength(1);

  await openManagementCreation(page);
  await fillCampaignBasics(page);
  await page.getByRole("button", { name: "Create only" }).click();
  await expect(page.getByRole("button", { name: "Open story" })).toBeVisible();
  expect(api.creates).toHaveLength(2);
});

test("late readiness from a closed dialog cannot overwrite a reopened draft", async ({ page }) => {
  const api = await installCreationApi(page);
  let releaseReadiness!: () => void;
  api.delayNextReadiness(new Promise<void>(resolve => { releaseReadiness = resolve; }), {
    characters: [{ id: "stale-character", name: "Stale result", rpgStatCount: 0, defaultTriggerCount: 0 }],
    startingCastCandidates: [],
    readiness: { ready: true, issues: [] }
  });
  await openDashboardCreation(page);
  await api.waitForReadiness();
  await page.locator("#createCampaignAdvanced").locator("summary").click();
  await page.locator("#newCampaignTurnControlStyle").selectOption("flexible_action");
  await page.locator("#createCampaignAdvanced").locator("summary").click();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator("#discardChangesDialog")).toBeVisible();
  await page.locator('#discardChangesDialog button[value="discard"]').click();
  await expect(page.locator("#createCampaignDialog")).toBeHidden();

  await openDashboardCreation(page);
  await expect(page.locator("#newCampaignTitle")).toHaveValue("Fixture World 1 Adventure");
  await expect(page.locator("#newCampaignCharacter")).toHaveValue("fixture-observer");
  releaseReadiness();
  await api.waitForDelayedReadiness();
  await expect(page.locator("#createCampaignDialog")).toBeVisible();
  await expect(page.locator("#newCampaignTitle")).toHaveValue("Fixture World 1 Adventure");
  await expect(page.locator("#newCampaignCharacter")).toHaveValue("fixture-observer");
});

test("management readiness for another world cannot replace the open dashboard campaign scope", async ({ page }) => {
  const api = await installCreationApi(page, 2);
  const otherWorld = api.fixture.worlds[1]! as { id: string; latestVersionId: string };
  let signalOtherReadiness!: () => void;
  const otherReadinessFinished = new Promise<void>(resolve => { signalOtherReadiness = resolve; });
  await page.route(`**/api/v1/world-versions/${otherWorld.latestVersionId}/playable-characters`, async route => {
    await route.fulfill({ json: {
      characters: [{ id: "other-world-character", name: "Other World Hero", rpgStatCount: 0, defaultTriggerCount: 0 }],
      startingCastCandidates: [],
      readiness: { ready: true, issues: [] }
    } });
    signalOtherReadiness();
  });
  await openDashboardCreation(page);
  await expect(page.locator("#newCampaignCharacter")).toHaveValue("fixture-observer");
  await page.evaluate((worldId) => {
    document.querySelector<HTMLButtonElement>(`#worldManagementCarousel [data-world-id="${worldId}"]`)?.click();
  }, otherWorld.id);
  await expect.poll(() => api.requests.some(request => request.path === `/api/v1/worlds/${otherWorld.id}` && request.finishedAt !== undefined)).toBe(true);
  await otherReadinessFinished;
  await expect(page.locator("#newCampaignCharacter")).toHaveValue("fixture-observer");
  await expect(page.locator("#createCampaignWorldVersion")).toContainText("Fixture World 1 · Version 1");
});

test("starting cast keeps selections as the protagonist changes", async ({ page }) => {
  await installCreationApi(page);
  await page.route("**/api/v1/meta", route => route.fulfill({ json: { application: { version: "fixture" }, capabilities: { castPresets: true } } }));
  await page.route("**/api/v1/world-versions/*/playable-characters", route => route.fulfill({ json: {
    characters: [{ id: "fixture-observer", name: "The Observer", rpgStatCount: 0, defaultTriggerCount: 0 }, { id: "ally", name: "Ally", rpgStatCount: 0, defaultTriggerCount: 0 }],
    startingCastCandidates: [{ id: "ally", name: "Ally", campaignUse: "both", startingCastDefault: true, alwaysInContext: false, role: "Guide", summary: "Knows the roads." }, { id: "scout", name: "Scout", campaignUse: "supporting", startingCastDefault: true, alwaysInContext: true, role: "Scout", summary: "" }],
    readiness: { ready: true, issues: [] }
  } }));
  await openDashboardCreation(page);
  await fillCampaignBasics(page);
  await expect(page.getByLabel("Ally · Guide")).toBeChecked();
  await page.locator("#newCampaignCharacter").selectOption("ally");
  await expect(page.getByLabel("Ally · Guide")).toHaveCount(0);
  await page.locator("#newCampaignCharacter").selectOption("fixture-observer");
  await expect(page.getByLabel("Ally · Guide")).toBeChecked();
  await expect(page.locator("#startingCastNotice")).toContainText("2 of 30");
  if (process.env.CAST_SCREENSHOT_ROOT) await page.screenshot({ path: resolve(process.env.CAST_SCREENSHOT_ROOT, "starting-cast.png") });
});

for (const intent of ["Create only", "Create and start"]) {
  test(`skipped starting cast leaves a committed result for ${intent}`, async ({ page }) => {
    await installCreationApi(page);
    let creates = 0;
    await page.route("**/api/v1/campaigns", async route => {
      if (route.request().method() !== "POST") return route.fallback();
      creates += 1;
      return route.fulfill({ status: 201, json: { id: "00000000-0000-4000-8000-000000000099", title: "Campaign", status: "active", activeTurnNumber: 0, storyLengthProfile: "standard", storyContextBudgetTokens: 32000, worldId: "00000000-0000-4000-8000-000000000097", worldVersionId: "00000000-0000-4000-8000-000000000098", worldVersionNumber: 1, selectedCharacterId: "fixture-observer", selectedCharacterName: "The Observer", textProviderProfileId: null, imageProviderProfileId: null, skippedStartingCast: [{ characterId: "bad", name: "Bad name", aliases: [], reason: "invalid_name" }, { characterId: "ally", name: "Ally", aliases: ["bad alias"], reason: "invalid_alias" }] } });
    });
    await openDashboardCreation(page);
    await fillCampaignBasics(page);
    await page.getByRole("button", { name: intent, exact: true }).click();
    await expect(page.locator("#createCampaignStatus")).toContainText("Bad name: character was skipped");
    await expect(page.locator("#createCampaignStatus")).toContainText("bad alias");
    await expect(page.locator("#openCommittedCampaign")).toBeVisible();
    await expect(page.locator("#confirmCreateCampaign")).toBeDisabled();
    expect(creates).toBe(1);
  });
}

test("starting cast caps defaults and keeps ticks across protagonist switches", async ({ page }) => {
  await installCreationApi(page);
  await page.route("**/api/v1/meta", route => route.fulfill({ json: { application: { version: "fixture" }, capabilities: { castPresets: true } } }));
  const candidates = Array.from({ length: 31 }, (_, i) => ({ id: `cast-${i}`, name: `Companion ${i}`, campaignUse: i === 0 ? "both" : "supporting", startingCastDefault: true, alwaysInContext: i < 6, role: "", summary: "" }));
  await page.route("**/api/v1/world-versions/*/playable-characters", route => route.fulfill({ json: {
    characters: [{ id: "fixture-observer", name: "The Observer", rpgStatCount: 0, defaultTriggerCount: 0 }, { id: "cast-0", name: "Companion 0", rpgStatCount: 0, defaultTriggerCount: 0 }],
    startingCastCandidates: candidates, readiness: { ready: true, issues: [] }
  } }));
  await openDashboardCreation(page);
  await fillCampaignBasics(page);
  await expect(page.locator("#startingCastNotice")).toContainText("30 of 30");
  await expect(page.locator("#startingCastNotice")).toContainText("take up narrator context");
  await expect(page.getByLabel("Companion 30", { exact: true })).toBeDisabled();
  await page.locator("#newCampaignCharacter").selectOption("cast-0");
  await expect(page.locator("#startingCastNotice")).toContainText("29 of 30");
  await expect(page.getByLabel("Companion 30", { exact: true })).toBeEnabled();
  await page.locator("#newCampaignCharacter").selectOption("fixture-observer");
  await expect(page.getByLabel("Companion 0", { exact: true })).toBeChecked();
  await expect(page.locator("#startingCastNotice")).toContainText("30 of 30");
  await page.setViewportSize({ width: 390, height: 844 });
  if (process.env.CAST_SCREENSHOT_ROOT) await page.screenshot({ path: resolve(process.env.CAST_SCREENSHOT_ROOT, "starting-cast-mobile.png") });
});

test("character loading can be retried without losing the campaign title", async ({ page }) => {
  await installCreationApi(page);
  let failed = false;
  await page.route("**/api/v1/world-versions/*/playable-characters", async route => {
    if (!failed && await page.locator("#createCampaignDialog").isVisible()) {
      failed = true;
      return route.fulfill({ status: 503, json: { message: "Temporary failure" } });
    }
    return route.fallback();
  });
  await openDashboardCreation(page);
  await page.locator("#newCampaignTitle").fill("Keep this draft");
  await expect(page.locator("#retryCampaignCharacters")).toBeVisible();
  await expect(page.locator("#confirmCreateCampaign")).toBeDisabled();
  await page.locator("#retryCampaignCharacters").click();
  await expect(page.locator("#newCampaignCharacter")).toHaveValue("fixture-observer");
  await expect(page.locator("#newCampaignTitle")).toHaveValue("Keep this draft");
  await expect(page.locator("#confirmCreateCampaign")).toBeEnabled();
});

for (const [state, intent, label, section] of [
  ["installation_disabled", "Create campaign", "Character settings", "characters"],
  ["capability_insufficient", "Create and start", "Character settings", "characters"],
  ["enrollment_missing", "Create and start", "Story Memory settings", "campaign"]
] as const) {
  test(`does not interrupt ${intent} for the ${state} narrator notice`, async ({ page }) => {
    const api = await installCreationApi(page);
    await page.route("**/api/v1/meta", route => route.fulfill({ json: { capabilities: { castPresets: true, castContext: state !== "installation_disabled" } } }));
    await page.route("**/api/v1/world-versions/*/playable-characters", route => route.fulfill({ json: {
      characters: [{ id: "fixture-observer", name: "Observer", rpgStatCount: 0, defaultTriggerCount: 0 }],
      startingCastCandidates: [{ id: "guide", name: "Guide", campaignUse: "supporting", startingCastDefault: true, alwaysInContext: false, role: "", summary: "" }],
      readiness: { ready: true, issues: [] }
    } }));
    await page.route("**/cast/workspace-status", route => route.fulfill({ json: {
      revision: 1, boundary: { turnNumber: 0, timelineRevision: 0 }, capabilities: { editing: true, discovery: false, autoMatch: false, backfill: false, context: false },
      counts: { identities: 0, details: 0, conflicts: 0 }, narratorState: state, tracking: null, contextDisabledReason: "Unavailable"
    } }));
    await openDashboardCreation(page); await fillCampaignBasics(page);
    await expect(page.locator("#startingCastNotice")).toContainText(state === "installation_disabled" ? "won't reach the narrator" : "after you create it");
    await page.locator(intent === "Create and start" ? "#createAndStartCampaign" : "#confirmCreateCampaign").click();
    if (intent === "Create and start") await page.waitForURL("**/story/00000000-0000-4000-8000-000000000099");
    else await expect(page.locator("#createCampaignDialog")).toBeHidden();
    await expect(page.getByRole("link", { name: label, exact: true })).toHaveCount(0);
    void section;
    expect(api.creates).toHaveLength(1);
  });
}
