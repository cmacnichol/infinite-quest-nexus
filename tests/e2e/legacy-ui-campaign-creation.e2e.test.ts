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
        return route.fulfill({ status: 503, json: { message: "Campaign create failed." } });
      }
      await holdCreate;
      return route.fulfill({ status: 201, json: { id: "created-campaign", title: "A campaign", selectedCharacterName: "The Observer" } });
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
  await page.route("**/story/created-campaign", route => route.fulfill({ contentType: "text/html", body: "<title>Committed story</title>" }));
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
  await expect(page).toHaveURL(/\/story\/created-campaign$/u);
  expect(api.creates).toHaveLength(1);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("infiniteQuestLastCampaignId"))).toBe("created-campaign");
});

test("Enter uses the safe Create only default and leaves the user in management", async ({ page }) => {
  const api = await installCreationApi(page);
  await openManagementCreation(page);
  await fillCampaignBasics(page);
  await page.locator("#newCampaignTitle").press("Enter");
  await expect(page.locator("#createCampaignDialog")).toBeHidden();
  await expect(page).toHaveURL(/#world-library$/u);
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
      if (key === "infiniteQuestLastCampaignId") throw new Error("Storage unavailable.");
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
  await expect(page).toHaveURL(/\/story\/created-campaign$/u);
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
    characters: [{ id: "stale-character", name: "Stale result" }],
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
