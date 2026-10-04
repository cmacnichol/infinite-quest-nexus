import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import {
  generationJobSnapshotSchema,
  generationResultSchema,
  readerSceneWindowResponseSchema
} from "../../packages/contracts/src/index.js";
import { installLegacyUiFixture, legacyUiFixture } from "./helpers/legacy-ui-fixtures.js";

const origin = `http://127.0.0.1:${process.env.PLAYWRIGHT_LEGACY_PORT ?? "43173"}`;
const timestamp = "2026-10-03T12:00:00.000Z";
const sceneWindowPath = (campaignId: string) => `/api/v1/campaigns/${campaignId}/reader/scene-window`;
const exactTurnPath = (campaignId: string, turnNumber: number) => `/api/v1/campaigns/${campaignId}/reader/turns/${turnNumber}`;

interface CapturedRequest {
  readonly method: string;
  readonly pathname: string;
  readonly url: string;
}

interface SceneWindowRequestRecord {
  readonly campaignId: string;
  readonly anchorTurnNumber: number;
  readonly anchorTurnId: string;
  readonly direction: "older" | "newer";
  readonly neighborLimit: number;
  readonly historyToken: string | null;
}

function withContinuousReading(fixture: ReturnType<typeof legacyUiFixture>, enabled = true) {
  const user = fixture.session.user as Record<string, unknown>;
  const settings = user.settings as Record<string, unknown>;
  return {
    ...fixture,
    session: {
      ...fixture.session,
      user: { ...user, settings: { ...settings, continuousReading: enabled } }
    }
  };
}

function sparseFixture() {
  const source = legacyUiFixture({ turnCount: 13, worldCount: 1, campaignCount: 1 });
  const acceptedNumbers = [1, 4, 11, 29, 56, 93, 151, 244, 390, 623, 997, 1597, 2000];
  const turns = source.turns.map((turn, index) => ({ ...turn, turnNumber: acceptedNumbers[index]! }));
  const syncCampaign = source.syncStatus.campaign as Record<string, unknown>;
  const syncTurns = source.syncStatus.turns as Record<string, unknown>;
  const syncStatus = {
    ...source.syncStatus,
    campaign: { ...syncCampaign, activeTurnNumber: 2000 },
    turns: { ...syncTurns, campaignId: source.campaignId, nextCursor: null, turns }
  };
  const campaigns = source.campaigns.map((campaign, index) => index === 0
    ? { ...campaign, activeTurnNumber: 2000 }
    : campaign);
  const runtimeState = { ...source.runtimeState, activeTurnNumber: 2000, viewedTurnNumber: 2000 };
  return withContinuousReading({ ...source, turnCount: 2000, turns, syncStatus, campaigns, runtimeState });
}

function watchRequests(page: Page): CapturedRequest[] {
  const requests: CapturedRequest[] = [];
  page.on("request", request => {
    const url = new URL(request.url());
    requests.push({ method: request.method(), pathname: url.pathname, url: request.url() });
  });
  return requests;
}

function cursorRequests(requests: CapturedRequest[], campaignId: string): CapturedRequest[] {
  const turnsPath = `/api/v1/campaigns/${campaignId}/turns`;
  return requests.filter(request => {
    const url = new URL(request.url);
    return request.method === "GET" && request.pathname === turnsPath && url.searchParams.has("before");
  });
}

function sceneWindowRequests(requests: CapturedRequest[], campaignId: string): SceneWindowRequestRecord[] {
  const path = sceneWindowPath(campaignId);
  return requests.filter(request => request.method === "GET" && request.pathname === path).map(request => {
    const url = new URL(request.url);
    const direction = url.searchParams.get("direction");
    if (direction !== "older" && direction !== "newer") throw new Error(`Unexpected scene-window direction: ${direction}`);
    return {
      campaignId,
      anchorTurnNumber: Number(url.searchParams.get("anchorTurnNumber")),
      anchorTurnId: url.searchParams.get("anchorTurnId") ?? "",
      direction,
      neighborLimit: Number(url.searchParams.get("neighborLimit")),
      historyToken: url.searchParams.get("historyToken")
    };
  });
}

async function installSceneWindowRoute(
  page: Page,
  fixture: ReturnType<typeof legacyUiFixture>,
  shouldFail?: (request: SceneWindowRequestRecord) => boolean
): Promise<void> {
  await page.route(`**${sceneWindowPath(fixture.campaignId)}**`, async route => {
    const url = new URL(route.request().url());
    const direction = url.searchParams.get("direction");
    if (direction !== "older" && direction !== "newer") {
      await route.fulfill({ status: 400, contentType: "application/json", json: { error: "invalid_request" } });
      return;
    }
    const request: SceneWindowRequestRecord = {
      campaignId: fixture.campaignId,
      anchorTurnNumber: Number(url.searchParams.get("anchorTurnNumber")),
      anchorTurnId: url.searchParams.get("anchorTurnId") ?? "",
      direction,
      neighborLimit: Number(url.searchParams.get("neighborLimit")),
      historyToken: url.searchParams.get("historyToken")
    };
    if (shouldFail?.(request)) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        json: { error: "PRIVATE_T16_WINDOW_CANARY", message: "Synthetic adjacent-scene storage details." }
      });
      return;
    }

    const anchorIndex = fixture.turns.findIndex(turn =>
      Number(turn.turnNumber) === request.anchorTurnNumber && String(turn.id) === request.anchorTurnId
    );
    if (anchorIndex < 0) {
      await route.fulfill({ status: 404, contentType: "application/json", json: { error: "not_found" } });
      return;
    }
    const neighborLimit = Math.max(1, Math.min(9, request.neighborLimit));
    const start = request.direction === "older" ? Math.max(0, anchorIndex - neighborLimit) : anchorIndex;
    const end = request.direction === "older"
      ? anchorIndex + 1
      : Math.min(fixture.turns.length, anchorIndex + neighborLimit + 1);
    const turns = fixture.turns.slice(start, end);
    const response = readerSceneWindowResponseSchema.parse({
      campaignId: fixture.campaignId,
      anchor: { turnNumber: request.anchorTurnNumber, id: request.anchorTurnId },
      direction: request.direction,
      turns,
      hasMore: request.direction === "older" ? start > 0 : end < fixture.turns.length,
      historyToken: "opaque-synthetic-scene-window-token"
    });
    await route.fulfill({ contentType: "application/json", json: response });
  });
}

function fixtureUserId(fixture: ReturnType<typeof legacyUiFixture>): string {
  const user = fixture.session.user as { id: string };
  return String(user.id);
}

async function prepareStoryPage(page: Page, campaignId: string): Promise<void> {
  const html = (await readFile("apps/web/public/story.html", "utf8"))
    .replace("/nexus/legacy-client.js", "/nexus/src/legacy-client-entry.ts");
  await page.route(`**/story/${campaignId}`, route => route.fulfill({ contentType: "text/html", body: html }));
}

async function seedReaderPosition(page: Page, fixture: ReturnType<typeof legacyUiFixture>, turn: Record<string, unknown>): Promise<void> {
  await page.goto(`${origin}/nexus/index.html`);
  await page.evaluate(async ({ userId, campaignId, turn, timestamp }) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("infiniteQuest-reader-positions-v1", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("positions");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("positions", "readwrite");
      transaction.objectStore("positions").put({
        schemaVersion: 1,
        userId,
        campaignId,
        position: {
          schemaVersion: 1,
          turnId: turn.id,
          turnNumber: turn.turnNumber,
          offsetRatio: 0.5,
          updatedAt: timestamp
        }
      }, `${userId}:${campaignId}`);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  }, { userId: fixtureUserId(fixture), campaignId: fixture.campaignId, turn, timestamp });
}

async function renderedSceneTurns(page: Page): Promise<number[]> {
  return page.locator("#storyArea .scene[data-turn-number]").evaluateAll(scenes =>
    scenes.map(scene => Number((scene as HTMLElement).dataset.turnNumber))
  );
}

async function sceneOffsetRatio(page: Page, turnNumber: number): Promise<number> {
  return page.evaluate(selectedTurnNumber => {
    const scene = document.querySelector<HTMLElement>(`#scene-${selectedTurnNumber}`);
    if (!scene) throw new Error(`Missing scene ${selectedTurnNumber}.`);
    const inset = Math.max(
      document.querySelector(".universal-nav")?.getBoundingClientRect().height ?? 0,
      document.querySelector("[data-story-reader-toolbar]")?.getBoundingClientRect().bottom ?? 0
    );
    const availableHeight = Math.max(0, window.innerHeight - inset);
    const scrollable = Math.max(0, scene.getBoundingClientRect().height - availableHeight);
    return scrollable ? (inset - scene.getBoundingClientRect().top) / scrollable : 0;
  }, turnNumber);
}

async function visibleKeyboardFocus(page: Page): Promise<{
  readonly connected: boolean;
  readonly focusVisible: boolean;
  readonly inViewport: boolean;
  readonly label: string;
}> {
  return page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    if (!active) return { connected: false, focusVisible: false, inViewport: false, label: "" };
    const rect = active.getBoundingClientRect();
    return {
      connected: active.isConnected,
      focusVisible: active.matches(":focus-visible"),
      inViewport: rect.width > 0 && rect.height > 0
        && rect.bottom > 0 && rect.top < window.innerHeight
        && rect.right > 0 && rect.left < window.innerWidth,
      label: `${active.tagName.toLowerCase()} ${active.getAttribute("aria-label") || active.textContent?.trim() || ""}`
    };
  });
}

async function saveContinuousPreference(page: Page, value: boolean): Promise<void> {
  await page.locator("#btnOpenUserProfile").click();
  const control = page.locator("#userProfileContinuousReading");
  await expect(control).toBeVisible();
  await control.setChecked(value);
  await page.locator("#btnSaveUserProfile").click();
  await expect(page.locator("#userProfileDialog")).not.toHaveAttribute("open", "");
}

for (const turnCount of [317, 2000]) {
  test(`continuous startup stays bounded without walking ${turnCount} turns`, async ({ page }) => {
    const fixture = withContinuousReading(legacyUiFixture({ turnCount, worldCount: 1, campaignCount: 1 }));
    const requests = watchRequests(page);
    await installLegacyUiFixture(page, fixture);
    await installSceneWindowRoute(page, fixture);
    await prepareStoryPage(page, fixture.campaignId);

    await page.goto(`${origin}/story/${fixture.campaignId}`);
    await expect(page.locator("#storySyncStatus")).toContainText("Story synced");
    const scenes = await renderedSceneTurns(page);
    expect(scenes.length).toBeLessThanOrEqual(10);
    expect(scenes).toContain(turnCount);
    expect(new Set(scenes).size).toBe(scenes.length);
    expect(cursorRequests(requests, fixture.campaignId)).toHaveLength(0);
    await expect(page.locator(`#scene-${turnCount}`)).toBeVisible();
  });
}

test("a saved Turn 12 stays bounded until an explicit scene group and survives mode switches", async ({ page }) => {
  const sourceFixture = legacyUiFixture({ turnCount: 317, worldCount: 1, campaignCount: 1 });
  sourceFixture.turns[11] = { ...sourceFixture.turns[11]!, narration: "Saved reading position. ".repeat(130) };
  const fixture = withContinuousReading(sourceFixture);
  const instrumentation = await installLegacyUiFixture(page, fixture);
  const requests = watchRequests(page);
  await installSceneWindowRoute(page, fixture);
  await page.route(`**${exactTurnPath(fixture.campaignId, 12)}`, route => route.fulfill({
    contentType: "application/json",
    json: { campaignId: fixture.campaignId, turn: fixture.turns[11] }
  }));
  const profileUser = fixture.session.user as Record<string, unknown>;
  await page.route("**/api/v1/users/me/profile", async route => {
    const body = route.request().postDataJSON() as { displayName: string; settings: Record<string, unknown> };
    await route.fulfill({
      contentType: "application/json",
      json: { user: { ...profileUser, displayName: body.displayName, settings: body.settings } }
    });
  });
  await seedReaderPosition(page, fixture, fixture.turns[11]!);
  await prepareStoryPage(page, fixture.campaignId);

  await page.goto(`${origin}/story/${fixture.campaignId}`);
  await expect(page.locator("#readerPositionNotice")).toContainText("Resumed reading at Turn 12");
  await expect(page.locator("#scene-12")).toBeVisible();
  await expect.poll(() => requests.filter(request => request.pathname === exactTurnPath(fixture.campaignId, 12)).length).toBe(1);
  const initialOffset = await sceneOffsetRatio(page, 12);
  expect(initialOffset).toBeCloseTo(0.5, 1);
  expect(await renderedSceneTurns(page)).toHaveLength(1);
  expect(sceneWindowRequests(requests, fixture.campaignId)).toHaveLength(0);
  expect(cursorRequests(requests, fixture.campaignId)).toHaveLength(0);

  await page.locator("#freeAction").fill("Keep this draft while the reader mode changes.");
  await saveContinuousPreference(page, false);
  await expect(page.locator("#scene-12")).toBeVisible();
  expect(await renderedSceneTurns(page)).toEqual([12]);
  expect(await sceneOffsetRatio(page, 12)).toBeCloseTo(initialOffset, 1);
  await expect(page.locator("#freeAction")).toHaveValue("Keep this draft while the reader mode changes.");

  await saveContinuousPreference(page, true);
  await expect(page.locator("#scene-12")).toBeVisible();
  expect((await renderedSceneTurns(page)).length).toBeLessThanOrEqual(10);
  expect(await sceneOffsetRatio(page, 12)).toBeCloseTo(initialOffset, 1);
  await expect(page.locator("#freeAction")).toHaveValue("Keep this draft while the reader mode changes.");
  expect(sceneWindowRequests(requests, fixture.campaignId)).toHaveLength(0);
  expect(cursorRequests(requests, fixture.campaignId)).toHaveLength(0);
  expect(instrumentation.writes.filter(write => write.path.includes("/generations/"))).toEqual([]);

  const olderButton = page.getByRole("button", { name: "Load older scenes" });
  await expect(olderButton).toBeVisible();
  await olderButton.click();
  await expect.poll(() => sceneWindowRequests(requests, fixture.campaignId).length).toBe(1);
  expect(sceneWindowRequests(requests, fixture.campaignId)[0]).toMatchObject({
    anchorTurnNumber: 12,
    anchorTurnId: fixture.turns[11]!.id,
    direction: "older",
    neighborLimit: expect.any(Number),
    historyToken: null
  });
  expect(sceneWindowRequests(requests, fixture.campaignId)[0]!.neighborLimit).toBeLessThanOrEqual(9);
  const loadedTurns = await renderedSceneTurns(page);
  expect(loadedTurns).toContain(12);
  expect(loadedTurns.length).toBeLessThanOrEqual(10);
  expect(cursorRequests(requests, fixture.campaignId)).toHaveLength(0);
});

test("older and newer scene groups use sparse accepted neighbors and retry atomically with visible keyboard focus", async ({ page }) => {
  const fixture = sparseFixture();
  const requests = watchRequests(page);
  await installLegacyUiFixture(page, fixture);
  let failAnchor: number | null = null;
  let failedOnce = false;
  await installSceneWindowRoute(page, fixture, request => {
    if (!failedOnce && failAnchor === request.anchorTurnNumber && request.direction === "newer") {
      failedOnce = true;
      return true;
    }
    return false;
  });
  await prepareStoryPage(page, fixture.campaignId);

  await page.goto(`${origin}/story/${fixture.campaignId}`);
  await expect(page.locator("#storySyncStatus")).toContainText("Story synced");
  const initialTurns = await renderedSceneTurns(page);
  expect(initialTurns.length).toBeLessThanOrEqual(10);
  expect(initialTurns).toEqual([29, 56, 93, 151, 244, 390, 623, 997, 1597, 2000]);
  expect(cursorRequests(requests, fixture.campaignId)).toHaveLength(0);

  const olderButton = page.getByRole("button", { name: "Load older scenes" });
  await expect(olderButton).toBeVisible();
  await olderButton.focus();
  const anchorTopBefore = await page.locator("#scene-29").evaluate(element => element.getBoundingClientRect().top);
  await page.keyboard.press("Enter");
  await expect.poll(() => sceneWindowRequests(requests, fixture.campaignId).some(request => request.direction === "older")).toBe(true);
  await expect.poll(() => renderedSceneTurns(page)).toEqual([1, 4, 11, 29]);
  const olderRequest = sceneWindowRequests(requests, fixture.campaignId).at(-1)!;
  expect(olderRequest).toMatchObject({
    anchorTurnNumber: 29,
    anchorTurnId: fixture.turns[3]!.id,
    direction: "older",
    historyToken: null
  });
  expect(olderRequest.neighborLimit).toBeGreaterThanOrEqual(1);
  expect(olderRequest.neighborLimit).toBeLessThanOrEqual(9);
  expect((await renderedSceneTurns(page)).length).toBeLessThanOrEqual(10);
  await expect(page.locator("#scene-29")).toBeVisible();
  const anchorTopAfter = await page.locator("#scene-29").evaluate(element => element.getBoundingClientRect().top);
  expect(Math.abs(anchorTopAfter - anchorTopBefore)).toBeLessThanOrEqual(2);
  const focusedAfterOlder = await visibleKeyboardFocus(page);
  expect(focusedAfterOlder.connected).toBe(true);
  expect(focusedAfterOlder.focusVisible).toBe(true);
  expect(focusedAfterOlder.inViewport).toBe(true);

  await page.locator("#freeAction").fill("Draft remains while moving through sparse scenes.");
  const retainedOlderGroup = await renderedSceneTurns(page);
  failAnchor = 29;
  await page.getByRole("button", { name: "Load newer scenes" }).click();
  await expect(page.locator("#continuousReaderStatus")).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry scene group" })).toBeVisible();
  await expect(page.locator("#continuousReaderStatus")).not.toContainText("PRIVATE_T16_WINDOW_CANARY");
  expect(await renderedSceneTurns(page)).toEqual(retainedOlderGroup);
  await expect(page.locator("#freeAction")).toHaveValue("Draft remains while moving through sparse scenes.");

  const newRequests = sceneWindowRequests(requests, fixture.campaignId);
  const failedNewerRequest = newRequests.at(-1)!;
  expect(failedNewerRequest).toMatchObject({
    anchorTurnNumber: 29,
    anchorTurnId: fixture.turns[3]!.id,
    direction: "newer",
    historyToken: "opaque-synthetic-scene-window-token"
  });
  await page.getByRole("button", { name: "Retry scene group" }).click();
  await expect.poll(() => sceneWindowRequests(requests, fixture.campaignId).filter(request => request.direction === "newer").length).toBe(2);
  expect(sceneWindowRequests(requests, fixture.campaignId).at(-1)).toEqual(failedNewerRequest);
  await expect.poll(() => renderedSceneTurns(page)).toEqual([29, 56, 93, 151, 244, 390, 623, 997, 1597, 2000]);
  expect((await renderedSceneTurns(page)).length).toBeLessThanOrEqual(10);
  await expect(page.locator("#freeAction")).toHaveValue("Draft remains while moving through sparse scenes.");
  expect(cursorRequests(requests, fixture.campaignId)).toHaveLength(0);
});

test("an accepted replacement updates one visible keyed scene without duplicating its neighbors", async ({ page }) => {
  const fixture = withContinuousReading(legacyUiFixture({ turnCount: 317, worldCount: 1, campaignCount: 1 }));
  const instrumentation = await installLegacyUiFixture(page, fixture);
  const jobId = "55555555-5555-4555-8555-555555555555";
  const replacementId = "99999999-9999-4999-8999-999999999998";
  await installSceneWindowRoute(page, fixture);
  await prepareStoryPage(page, fixture.campaignId);
  await page.route("**/api/v1/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const respond = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", json: body });
    if (request.method() === "POST" && path === `/api/v1/campaigns/${fixture.campaignId}/generations/retry-latest`) {
      instrumentation.writes.push({ method: request.method(), path, body: request.postDataJSON() });
      return respond({ id: jobId, status: "queued", duplicate: false, operationKind: "replace_latest", replacementTurnId: fixture.turns[316]!.id }, 202);
    }
    if (request.method() === "GET" && path === `/api/v1/generation-jobs/${jobId}/stream`) {
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: "" });
    }
    if (request.method() === "GET" && path === `/api/v1/generation-jobs/${jobId}`) {
      return respond(generationJobSnapshotSchema.parse({
        id: jobId, campaignId: fixture.campaignId, expectedTurnNumber: 317, action: "Replacement action.",
        requestedInputMode: "action", resolvedInputMode: "action", inputModeSource: "explicit",
        operationKind: "replace_latest", replacementTurnId: fixture.turns[316]!.id, attempts: 1,
        resultTurnId: replacementId, errorCode: null, errorMessage: null, createdAt: timestamp, updatedAt: timestamp,
        partialNarration: null, status: "completed"
      }));
    }
    if (request.method() === "GET" && path === `/api/v1/generation-jobs/${jobId}/result`) {
      return respond(generationResultSchema.parse({
        id: jobId, campaignId: fixture.campaignId, expectedTurnNumber: 317, action: "Replacement action.",
        requestedInputMode: "action", resolvedInputMode: "action", inputModeSource: "explicit",
        operationKind: "replace_latest", replacementTurnId: fixture.turns[316]!.id, attempts: 1,
        resultTurnId: replacementId, errorCode: null, errorMessage: null, createdAt: timestamp, updatedAt: timestamp,
        status: "completed", turnNumber: 317, inputMode: "action", narration: "Replacement accepted scene.",
        choices: [], customActionSuggestion: "", imagePrompt: "", imageUrl: null, acceptedAt: timestamp,
        chronicleRetrieval: null, modelMetadata: null, mechanics: null, stateSnapshot: {}, reportedCost: null
      }));
    }
    return route.fallback();
  });

  await page.goto(`${origin}/story/${fixture.campaignId}`);
  await expect(page.locator("#storySyncStatus")).toContainText("Story synced");
  const beforeReplacement = await renderedSceneTurns(page);
  expect(beforeReplacement.length).toBeLessThanOrEqual(10);
  expect(beforeReplacement).toContain(317);
  await page.locator("#scene-317 .story-more > summary").click();
  await page.locator("#btnRetry").click();
  await page.locator("#retryPromptEditor").fill("Replacement action.");
  await page.locator("#btnRetryPromptSubmit").click();
  await expect(page.locator("#scene-317 .scene-narration")).toContainText("Replacement accepted scene.");
  await expect(page.locator("#scene-317")).toHaveCount(1);
  await expect(page.locator("#scene-317 .scene-narration")).not.toContainText(fixture.turns[316]!.narration as string);
  expect(await renderedSceneTurns(page)).toEqual(beforeReplacement);
  expect(new Set(await renderedSceneTurns(page)).size).toBe(beforeReplacement.length);
  expect((await renderedSceneTurns(page)).length).toBeLessThanOrEqual(10);
  expect(instrumentation.writes.map(write => write.path)).toEqual([`/api/v1/campaigns/${fixture.campaignId}/generations/retry-latest`]);
});

test("explicit print export still contains the complete ledger while continuous scenes stay bounded", async ({ page }) => {
  const fixture = withContinuousReading(legacyUiFixture({ turnCount: 317, worldCount: 1, campaignCount: 1 }));
  const requests = watchRequests(page);
  await installLegacyUiFixture(page, fixture);
  await installSceneWindowRoute(page, fixture);
  await prepareStoryPage(page, fixture.campaignId);

  await page.goto(`${origin}/story/${fixture.campaignId}`);
  await expect(page.locator("#storySyncStatus")).toContainText("Story synced");
  expect((await renderedSceneTurns(page)).length).toBeLessThanOrEqual(10);
  expect(cursorRequests(requests, fixture.campaignId)).toHaveLength(0);

  const popupPromise = page.waitForEvent("popup");
  await page.locator('[aria-controls="storyExportMenu"]').click();
  await page.locator("#btnExportPdf").click();
  const printPage = await popupPromise;
  await expect(printPage.locator("section.turn")).toHaveCount(317);
  await expect(printPage.locator("section.turn").first()).toContainText("Turn 1");
  await expect(printPage.locator("section.turn").last()).toContainText("Turn 317");
  expect(cursorRequests(requests, fixture.campaignId).length).toBeGreaterThan(0);
  expect((await renderedSceneTurns(page)).length).toBeLessThanOrEqual(10);
});
