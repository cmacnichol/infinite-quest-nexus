import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import {
  readerSceneWindowResponseSchema,
  readerTurnResponseSchema
} from "../../packages/contracts/src/index.js";
import { installLegacyUiFixture, legacyUiFixture } from "./helpers/legacy-ui-fixtures.js";

const origin = "http://127.0.0.1:" + (process.env.PLAYWRIGHT_LEGACY_PORT ?? "43173");
const timestamp = "2026-10-03T12:00:00.000Z";
const sceneWindowToken = "opaque-synthetic-history-snapshot";
const actionDraftRevision = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type Fixture = ReturnType<typeof legacyUiFixture>;
type TurnRow = Fixture["turns"][number];

interface CapturedRequest {
  readonly method: string;
  readonly pathname: string;
  readonly url: string;
}

interface SceneNeighborRequest {
  readonly anchorTurnNumber: number;
  readonly anchorTurnId: string;
  readonly direction: "older" | "newer";
  readonly neighborLimit: number;
  readonly historyToken: string | null;
}

function withContinuousReading(fixture: Fixture, enabled = false): Fixture {
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

function sparseFixture(ordinals: readonly number[], options: {
  readonly initialPageSize?: number;
  readonly nextCursor?: string | null;
} = {}): Fixture {
  const source = legacyUiFixture({ turnCount: ordinals.length, worldCount: 1, campaignCount: 1 });
  const turns = source.turns.map((turn, index) => ({ ...turn, turnNumber: ordinals[index]! }));
  const lastTurnNumber = ordinals.at(-1) ?? 0;
  const syncCampaign = source.syncStatus.campaign as Record<string, unknown>;
  const syncTurns = source.syncStatus.turns as Record<string, unknown>;
  const syncStatus = {
    ...source.syncStatus,
    campaign: { ...syncCampaign, activeTurnNumber: lastTurnNumber },
    turns: {
      ...syncTurns,
      campaignId: source.campaignId,
      nextCursor: options.nextCursor ?? null,
      turns: turns.slice(-(options.initialPageSize ?? 50))
    }
  };
  const campaigns = source.campaigns.map((campaign, index) => index === 0
    ? { ...campaign, activeTurnNumber: lastTurnNumber }
    : campaign);
  const runtimeState = {
    ...source.runtimeState,
    activeTurnNumber: lastTurnNumber,
    viewedTurnNumber: lastTurnNumber
  };
  return withContinuousReading({ ...source, turnCount: lastTurnNumber, turns, syncStatus, campaigns, runtimeState });
}

async function prepareStoryPage(page: Page, campaignId: string): Promise<void> {
  const html = (await readFile("apps/web/public/story.html", "utf8"))
    .replace("/nexus/legacy-client.js", "/nexus/src/legacy-client-entry.ts");
  await page.route("**/story/" + campaignId, route =>
    route.fulfill({ contentType: "text/html", body: html }));
}

function watchRequests(page: Page): CapturedRequest[] {
  const requests: CapturedRequest[] = [];
  page.on("request", request => {
    const url = new URL(request.url());
    requests.push({ method: request.method(), pathname: url.pathname, url: request.url() });
  });
  return requests;
}

function pageTurns(page: Page): Promise<number[]> {
  return page.locator("#turnHistoryModalList .history-card").evaluateAll(cards =>
    cards.map(card => Number((card as HTMLElement).dataset.turnNumber))
  );
}

async function openHistory(page: Page): Promise<void> {
  await page.locator("[data-story-reader-toolbar]").getByRole("button", { name: "History" }).click();
  await expect(page.locator("#turnHistoryDialog")).toHaveAttribute("open", "");
}

async function seedCurrentBaseDraft(page: Page, fixture: Fixture, baseTurn: TurnRow, text: string): Promise<void> {
  const user = fixture.session.user as { id: string };
  await page.goto(origin + "/nexus/");
  await page.evaluate(async ({ userId, campaignId, baseTurn, text, draftRevision, updatedAt }) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("infiniteQuest-reader-local-v1", 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("actionDrafts")) {
          request.result.createObjectStore("actionDrafts", { keyPath: "storageKey" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("actionDrafts", "readwrite");
      transaction.objectStore("actionDrafts").put({
        storageKey: "draft:" + userId + ":" + campaignId,
        value: JSON.stringify({
          schemaVersion: 1,
          userId,
          campaignId,
          draft: {
            schemaVersion: 1,
            draftRevision,
            text,
            inputMode: "action",
            baseTurnId: baseTurn.id,
            baseTurnNumber: baseTurn.turnNumber,
            updatedAt
          }
        })
      });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  }, {
    userId: String(user.id),
    campaignId: fixture.campaignId,
    baseTurn,
    text,
    draftRevision: actionDraftRevision,
    updatedAt: timestamp
  });
}

async function readStoredDraft(page: Page, fixture: Fixture): Promise<Record<string, unknown> | null> {
  const user = fixture.session.user as { id: string };
  return page.evaluate(async ({ storageKey }) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("infiniteQuest-reader-local-v1", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const value = await new Promise<{ value?: string } | undefined>((resolve, reject) => {
      const request = database.transaction("actionDrafts", "readonly").objectStore("actionDrafts").get(storageKey);
      request.onsuccess = () => resolve(request.result as { value?: string } | undefined);
      request.onerror = () => reject(request.error);
    });
    database.close();
    if (typeof value?.value !== "string") return null;
    return (JSON.parse(value.value) as { draft: Record<string, unknown> }).draft;
  }, { storageKey: "draft:" + String(user.id) + ":" + fixture.campaignId });
}

async function seedReaderPosition(page: Page, fixture: Fixture, turn: TurnRow): Promise<void> {
  const user = fixture.session.user as { id: string };
  await page.goto(origin + "/nexus/index.html");
  await page.evaluate(async ({ userId, campaignId, turn, updatedAt }) => {
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
          updatedAt
        }
      }, userId + ":" + campaignId);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  }, { userId: String(user.id), campaignId: fixture.campaignId, turn, updatedAt: timestamp });
}

async function readStoredPosition(page: Page, fixture: Fixture): Promise<{ turnId: string; turnNumber: number } | null> {
  const user = fixture.session.user as { id: string };
  return page.evaluate(async ({ storageKey }) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("infiniteQuest-reader-positions-v1", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const value = await new Promise<{ position?: { turnId?: string; turnNumber?: number } } | undefined>((resolve, reject) => {
      const request = database.transaction("positions", "readonly").objectStore("positions").get(storageKey);
      request.onsuccess = () => resolve(request.result as { position?: { turnId?: string; turnNumber?: number } } | undefined);
      request.onerror = () => reject(request.error);
    });
    database.close();
    const position = value?.position;
    return position?.turnId && typeof position.turnNumber === "number"
      ? { turnId: position.turnId, turnNumber: position.turnNumber }
      : null;
  }, { storageKey: String(user.id) + ":" + fixture.campaignId });
}

async function installExactAnchorRoute(page: Page, fixture: Fixture, turnNumber = 100): Promise<void> {
  const anchor = fixture.turns.find(turn => Number(turn.turnNumber) === turnNumber);
  if (!anchor) throw new Error("Synthetic sparse fixture has no accepted Turn " + turnNumber + ".");
  const path = "/api/v1/campaigns/" + fixture.campaignId + "/reader/turns/" + turnNumber;
  await page.route("**" + path, async route => {
    const response = readerTurnResponseSchema.parse({ campaignId: fixture.campaignId, turn: anchor });
    await route.fulfill({ contentType: "application/json", json: response });
  });
}

function sceneWindowRequests(requests: readonly CapturedRequest[], campaignId: string): SceneNeighborRequest[] {
  const path = "/api/v1/campaigns/" + campaignId + "/reader/scene-window";
  return requests.filter(request => request.method === "GET" && request.pathname === path).map(request => {
    const url = new URL(request.url);
    const direction = url.searchParams.get("direction");
    if (direction !== "older" && direction !== "newer") throw new Error("Unexpected scene-window direction.");
    return {
      anchorTurnNumber: Number(url.searchParams.get("anchorTurnNumber")),
      anchorTurnId: url.searchParams.get("anchorTurnId") ?? "",
      direction,
      neighborLimit: Number(url.searchParams.get("neighborLimit")),
      historyToken: url.searchParams.get("historyToken")
    };
  });
}

async function installSparseNeighborRoute(page: Page, fixture: Fixture): Promise<void> {
  const path = "/api/v1/campaigns/" + fixture.campaignId + "/reader/scene-window";
  let continuationToken: string | null = null;
  await page.route("**" + path + "**", async route => {
    const url = new URL(route.request().url());
    const direction = url.searchParams.get("direction");
    if (direction !== "older" && direction !== "newer") {
      await route.fulfill({ status: 400, contentType: "application/json", json: { error: "invalid_request" } });
      return;
    }
    const suppliedToken = url.searchParams.get("historyToken");
    if ((continuationToken === null && suppliedToken !== null)
      || (continuationToken !== null && suppliedToken !== continuationToken)) {
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        json: { error: "history_snapshot_conflict" }
      });
      return;
    }
    const anchorTurnNumber = Number(url.searchParams.get("anchorTurnNumber"));
    const anchorTurnId = url.searchParams.get("anchorTurnId") ?? "";
    const anchorIndex = fixture.turns.findIndex(turn =>
      Number(turn.turnNumber) === anchorTurnNumber && String(turn.id) === anchorTurnId);
    if (anchorIndex < 0) {
      await route.fulfill({ status: 404, contentType: "application/json", json: { error: "not_found" } });
      return;
    }
    const neighborLimit = Math.min(9, Math.max(1, Number(url.searchParams.get("neighborLimit") ?? 9)));
    const start = direction === "older" ? Math.max(0, anchorIndex - neighborLimit) : anchorIndex;
    const end = direction === "older"
      ? anchorIndex + 1
      : Math.min(fixture.turns.length, anchorIndex + neighborLimit + 1);
    const turns = fixture.turns.slice(start, end);
    const response = readerSceneWindowResponseSchema.parse({
      campaignId: fixture.campaignId,
      anchor: { turnNumber: anchorTurnNumber, id: anchorTurnId },
      direction,
      turns,
      hasMore: direction === "older" ? start > 0 : end < fixture.turns.length,
      historyToken: sceneWindowToken
    });
    continuationToken = response.historyToken;
    await route.fulfill({ contentType: "application/json", json: response });
  });
}

test("History initially renders every sparse accepted resident row without probing ordinal gaps", async ({ page }, testInfo) => {
  const ordinals = [1, 2, 100, 105, 200];
  const fixture = sparseFixture(ordinals, { initialPageSize: 5 });
  const requests = watchRequests(page);
  await installLegacyUiFixture(page, fixture);
  await prepareStoryPage(page, fixture.campaignId);

  await page.goto(origin + "/story/" + fixture.campaignId);
  await expect(page.locator("#storySyncStatus")).toContainText("Story synced");
  await openHistory(page);

  await expect.poll(() => pageTurns(page)).toEqual(ordinals);
  await expect(page.locator("#btnTurnHistoryOlder")).toBeDisabled();
  expect(await page.locator("#turnHistoryModalList .history-card, #turnHistoryPreviewCard .history-card").count())
    .toBeLessThanOrEqual(50);
  expect(requests.filter(request => request.method === "GET"
    && request.pathname === "/api/v1/campaigns/" + fixture.campaignId + "/turns")).toEqual([]);
  expect(requests.filter(request => request.pathname.includes("/reader/turns/"))).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("sparse-history-initial.png"), fullPage: true });
});

test("opaque sparse History pages replay without ordinal gaps or excess cards", async ({ page }, testInfo) => {
  const recentOrdinals = Array.from({ length: 50 }, (_, index) => 500 + index * 10);
  const olderOrdinals = [1, 2, 100, 105, 200];
  const fixture = sparseFixture([...olderOrdinals, ...recentOrdinals], {
    initialPageSize: 50,
    nextCursor: "opaque-sparse-older-page"
  });
  const requests = watchRequests(page);
  await installLegacyUiFixture(page, fixture);
  // This counts rows received over the wire; the pure core tests assert retained cache size.
  let networkRowsReceived = recentOrdinals.length;
  await page.route("**/api/v1/campaigns/" + fixture.campaignId + "/turns**", async route => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("before") !== "opaque-sparse-older-page") {
      await route.fallback();
      return;
    }
    expect(url.searchParams.get("limit")).toBe("50");
    networkRowsReceived += olderOrdinals.length;
    await route.fulfill({
      contentType: "application/json",
      json: { campaignId: fixture.campaignId, turns: fixture.turns.slice(0, olderOrdinals.length), nextCursor: null }
    });
  });
  await prepareStoryPage(page, fixture.campaignId);

  await page.goto(origin + "/story/" + fixture.campaignId);
  await expect(page.locator("#storySyncStatus")).toContainText("Story synced");
  await openHistory(page);
  await expect.poll(() => pageTurns(page)).toEqual(recentOrdinals);
  await expect(page.locator("#btnTurnHistoryOlder")).toBeEnabled();
  await page.locator("#btnTurnHistoryOlder").click();
  await expect.poll(() => pageTurns(page)).toEqual(olderOrdinals);
  expect(await page.locator("#turnHistoryModalList .history-card, #turnHistoryPreviewCard .history-card").count())
    .toBeLessThanOrEqual(50);

  await expect(page.locator("#btnTurnHistoryNewer")).toBeEnabled();
  await page.locator("#btnTurnHistoryNewer").click();
  await expect.poll(() => pageTurns(page)).toEqual(recentOrdinals);
  expect(await page.locator("#turnHistoryModalList .history-card, #turnHistoryPreviewCard .history-card").count())
    .toBeLessThanOrEqual(50);

  const opaquePageRequests = requests.filter(request => request.method === "GET"
    && request.pathname === "/api/v1/campaigns/" + fixture.campaignId + "/turns");
  expect(opaquePageRequests.map(request => new URL(request.url).searchParams.get("before")))
    .toEqual(["opaque-sparse-older-page"]);
  expect(networkRowsReceived).toBe(recentOrdinals.length + olderOrdinals.length);
  expect(networkRowsReceived).toBeLessThanOrEqual(100);
  expect(requests.filter(request => request.pathname.includes("/reader/turns/"))).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("sparse-history-replay.png"), fullPage: true });
});

test("an off-page sparse pin follows accepted neighbors while the current-base draft and live scene stay intact", async ({ page }, testInfo) => {
  const recentOrdinals = Array.from({ length: 50 }, (_, index) => 500 + index * 10);
  const fixture = sparseFixture([1, 2, 100, 105, 200, ...recentOrdinals], {
    initialPageSize: 50,
    nextCursor: "opaque-before-recent-page"
  });
  const requests = watchRequests(page);
  await installLegacyUiFixture(page, fixture);

  const latestTurn = fixture.turns.at(-1);
  if (!latestTurn) throw new Error("The synthetic sparse fixture has no current accepted turn.");
  const draftText = "Keep this current-base draft while restoring and browsing older History.";
  await seedCurrentBaseDraft(page, fixture, latestTurn, draftText);
  expect(await readStoredDraft(page, fixture)).toMatchObject({
    text: draftText,
    baseTurnId: latestTurn.id,
    baseTurnNumber: Number(latestTurn.turnNumber)
  });

  const anchor = fixture.turns.find(turn => Number(turn.turnNumber) === 100);
  if (!anchor) throw new Error("The synthetic sparse fixture has no accepted Turn 100.");
  await seedReaderPosition(page, fixture, anchor);
  await installExactAnchorRoute(page, fixture);
  await installSparseNeighborRoute(page, fixture);
  await prepareStoryPage(page, fixture.campaignId);

  await page.goto(origin + "/story/" + fixture.campaignId);
  await expect(page.locator("#storySyncStatus")).toContainText("Story synced");
  await expect(page.locator("#readerTurnCount")).toHaveText("Turn 100 of 990");
  await expect(page.locator("#freeAction")).toHaveValue(draftText);
  const exactAnchorPath = "/api/v1/campaigns/" + fixture.campaignId + "/reader/turns/100";
  const initialRestoreLookups = requests.filter(request => request.method === "GET"
    && request.pathname.includes("/reader/turns/"));
  expect(initialRestoreLookups.map(request => request.pathname)).toEqual([exactAnchorPath]);

  await openHistory(page);
  await expect(page.locator("#turnHistoryPreviewCard .history-card")).toContainText("Turn 100");
  expect(await page.locator("#turnHistoryModalList .history-card").count()).toBe(49);
  expect(await page.locator("#turnHistoryModalList .history-card, #turnHistoryPreviewCard .history-card").count())
    .toBe(50);
  const previewNavigationStart = requests.length;

  await page.locator("#btnTurnHistoryPreviousTurn").click();
  await expect(page.locator("#turnHistoryPreviewCard .history-card")).toContainText("Turn 2");
  await page.locator("#btnTurnHistoryNextTurn").click();
  await expect(page.locator("#turnHistoryPreviewCard .history-card")).toContainText("Turn 100");
  await page.locator("#btnTurnHistoryNextTurn").click();
  await expect(page.locator("#turnHistoryPreviewCard .history-card")).toContainText("Turn 105");

  const neighborRequests = sceneWindowRequests(requests, fixture.campaignId);
  expect(neighborRequests.map(request => [request.anchorTurnNumber, request.anchorTurnId, request.direction])).toEqual([
    [100, anchor.id, "older"],
    [2, fixture.turns[1]!.id, "newer"],
    [100, anchor.id, "newer"]
  ]);
  expect(neighborRequests.map(request => request.historyToken)).toEqual([
    null,
    sceneWindowToken,
    sceneWindowToken
  ]);
  expect(neighborRequests.every(request => request.neighborLimit >= 1 && request.neighborLimit <= 9)).toBe(true);
  expect(requests.slice(previewNavigationStart).filter(request => request.pathname.includes("/reader/turns/"))).toEqual([]);
  expect(requests.filter(request => request.pathname.endsWith("/state/inspection"))).toEqual([]);
  await expect(page.locator("#readerTurnCount")).toHaveText("Turn 100 of 990");
  await expect(page.locator("#scene-100")).toBeVisible();
  await expect(page.locator("#freeAction")).toHaveValue(draftText);
  await expect.poll(() => readStoredPosition(page, fixture)).toEqual({
    turnId: String(anchor.id),
    turnNumber: 100
  });
  expect(await page.locator("#turnHistoryModalList .history-card, #turnHistoryPreviewCard .history-card").count())
    .toBeLessThanOrEqual(50);
  await page.screenshot({ path: testInfo.outputPath("sparse-history-pinned-neighbors.png"), fullPage: true });
});

test("an anchor-only sparse boundary settles and its snapshot token continues toward the next accepted turn", async ({ page }, testInfo) => {
  const recentOrdinals = Array.from({ length: 50 }, (_, index) => 500 + index * 10);
  const fixture = sparseFixture([2, 100, 105, 200, ...recentOrdinals], {
    initialPageSize: 50,
    nextCursor: "opaque-before-earliest-window"
  });
  const requests = watchRequests(page);
  await installLegacyUiFixture(page, fixture);

  const currentTurn = fixture.turns.at(-1);
  const anchor = fixture.turns[0];
  if (!currentTurn || !anchor) throw new Error("Synthetic sparse boundary fixture is incomplete.");
  const draftText = "Keep the latest-base action draft while probing the earliest accepted pin.";
  await seedCurrentBaseDraft(page, fixture, currentTurn, draftText);
  await seedReaderPosition(page, fixture, anchor);
  const savedPosition = { turnId: String(anchor.id), turnNumber: Number(anchor.turnNumber) };
  await installExactAnchorRoute(page, fixture, 2);
  await installSparseNeighborRoute(page, fixture);
  await prepareStoryPage(page, fixture.campaignId);

  await page.goto(origin + "/story/" + fixture.campaignId);
  await expect(page.locator("#storySyncStatus")).toContainText("Story synced");
  await expect(page.locator("#readerTurnCount")).toHaveText("Turn 2 of 990");
  await expect(page.locator("#scene-2")).toBeVisible();
  await expect(page.locator("#freeAction")).toHaveValue(draftText);
  await expect.poll(() => readStoredPosition(page, fixture)).toEqual(savedPosition);
  await openHistory(page);
  await expect(page.locator("#turnHistoryPreviewCard .history-card")).toContainText("Turn 2");
  const currentPage = await pageTurns(page);
  const previousTurn = page.locator("#btnTurnHistoryPreviousTurn");
  await expect(previousTurn).toBeEnabled();
  await previousTurn.click();
  await expect.poll(() => sceneWindowRequests(requests, fixture.campaignId)).toHaveLength(1);
  await expect(page.locator("#turnHistoryLoadStatus")).toHaveText("No earlier accepted turn.");
  await expect(page.locator("#turnHistoryPreviewCard .history-card")).toContainText("Turn 2");
  await expect.poll(() => pageTurns(page)).toEqual(currentPage);
  await expect(page.locator("#readerTurnCount")).toHaveText("Turn 2 of 990");
  await expect(page.locator("#scene-2")).toBeVisible();
  await expect(page.locator("#freeAction")).toHaveValue(draftText);
  expect(await readStoredDraft(page, fixture)).toMatchObject({ text: draftText, baseTurnId: currentTurn.id });
  await expect.poll(() => readStoredPosition(page, fixture)).toEqual(savedPosition);

  await page.locator("#btnTurnHistoryNextTurn").click();
  await expect(page.locator("#turnHistoryPreviewCard .history-card")).toContainText("Turn 100");
  await expect.poll(() => sceneWindowRequests(requests, fixture.campaignId)).toHaveLength(2);
  await expect.poll(() => pageTurns(page)).toEqual(currentPage);
  const neighborRequests = sceneWindowRequests(requests, fixture.campaignId);
  expect(neighborRequests.map(request => [request.anchorTurnNumber, request.anchorTurnId, request.direction, request.historyToken])).toEqual([
    [2, anchor.id, "older", null],
    [2, anchor.id, "newer", sceneWindowToken]
  ]);
  expect(requests.filter(request => request.method === "GET" && request.pathname.includes("/reader/turns/"))
    .map(request => request.pathname)).toEqual(["/api/v1/campaigns/" + fixture.campaignId + "/reader/turns/2"]);
  await expect(page.locator("#readerTurnCount")).toHaveText("Turn 2 of 990");
  await expect(page.locator("#scene-2")).toBeVisible();
  await expect(page.locator("#freeAction")).toHaveValue(draftText);
  expect(await readStoredDraft(page, fixture)).toMatchObject({ text: draftText, baseTurnId: currentTurn.id });
  await expect.poll(() => readStoredPosition(page, fixture)).toEqual(savedPosition);
  await page.screenshot({ path: testInfo.outputPath("sparse-history-earliest-boundary.png"), fullPage: true });
});
