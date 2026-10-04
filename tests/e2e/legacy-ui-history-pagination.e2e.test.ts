import { expect, test, type Page } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { installLegacyUiFixture, legacyUiFixture } from "./helpers/legacy-ui-fixtures.js";

const origin = `http://127.0.0.1:${process.env.PLAYWRIGHT_LEGACY_PORT ?? "43173"}`;
const evidenceDirectory = ".superpowers/sdd/legacy-ui-2026-10-03/evidence/T13-pagination";

async function prepareStoryPage(page: Page, campaignId: string): Promise<void> {
  const html = (await readFile("apps/web/public/story.html", "utf8"))
    .replace("/nexus/legacy-client.js", "/nexus/src/legacy-client-entry.ts");
  await page.route(`${origin}/story/${campaignId}`, route => route.fulfill({ contentType: "text/html", body: html }));
}

async function seedReaderPosition(page: Page, userId: string, campaignId: string, turn: Record<string, unknown>): Promise<void> {
  await page.goto(`${origin}/nexus/index.html`);
  await page.evaluate(async ({ userId, campaignId, turn }) => {
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
          updatedAt: "2026-10-03T12:00:00.000Z"
        }
      }, `${userId}:${campaignId}`);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  }, { userId, campaignId, turn });
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

async function selectedHistoryCardGeometry(page: Page, turnNumber: number): Promise<{
  readonly turnNumber: number;
  readonly fullyVisible: boolean;
  readonly scrollTop: number;
  readonly clientHeight: number;
  readonly scrollHeight: number;
}> {
  return page.evaluate((selectedTurnNumber) => {
    const scroller = document.querySelector<HTMLElement>("#turnHistoryDialog .dialog-scroll");
    const card = document.querySelector<HTMLElement>(`#turnHistoryDialog .history-card[aria-pressed="true"][data-turn-number="${selectedTurnNumber}"]`);
    if (!scroller || !card) throw new Error(`Missing History scroller or selected Turn ${selectedTurnNumber}.`);
    const scrollerRect = scroller.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const viewportTop = scrollerRect.top + scroller.clientTop;
    const viewportBottom = viewportTop + scroller.clientHeight;
    return {
      turnNumber: Number(card.dataset.turnNumber),
      fullyVisible: cardRect.top >= viewportTop && cardRect.bottom <= viewportBottom,
      scrollTop: scroller.scrollTop,
      clientHeight: scroller.clientHeight,
      scrollHeight: scroller.scrollHeight
    };
  }, turnNumber);
}

async function traverseHistory(page: Page, testInfo: import("@playwright/test").TestInfo, turnCount: number): Promise<void> {
  const fixture = legacyUiFixture({ turnCount, worldCount: 1, campaignCount: 1 });
  const instrumentation = await installLegacyUiFixture(page, fixture);
  await prepareStoryPage(page, fixture.campaignId);
  await page.goto(`${origin}/story/${fixture.campaignId}`);
  await expect(page.locator("#storySyncStatus")).toContainText("Story synced");

  const turnsPath = `/api/v1/campaigns/${fixture.campaignId}/turns`;
  expect(instrumentation.requests.filter(request => request.path === turnsPath)).toHaveLength(0);
  await openHistory(page);
  const firstPage = await pageTurns(page);
  expect(firstPage.length).toBeGreaterThan(0);
  expect(firstPage.length).toBeLessThanOrEqual(50);
  expect(firstPage.at(-1)).toBe(turnCount);
  expect(firstPage[0]! + firstPage.length - 1).toBe(turnCount);
  expect(firstPage.slice(1).every((turnNumber, index) => turnNumber === firstPage[index]! + 1)).toBe(true);
  expect(await page.locator("#turnHistoryModalList .history-card, #turnHistoryPreviewCard .history-card").count()).toBeLessThanOrEqual(50);
  await mkdir(evidenceDirectory, { recursive: true });
  if (turnCount === 317) await page.screenshot({ path: `${evidenceDirectory}/history-recent-317.png`, fullPage: false });
  expect(instrumentation.requests.filter(request => request.path === turnsPath)).toHaveLength(0);

  const windows = [firstPage];
  const older = page.locator("#btnTurnHistoryOlder");
  const maxTransitions = Math.ceil(turnCount / 49) + 2;
  for (let step = 0; await older.isEnabled(); step += 1) {
    expect(step).toBeLessThan(maxTransitions);
    const before = JSON.stringify(await pageTurns(page));
    await older.click();
    await expect.poll(async () => JSON.stringify(await pageTurns(page))).not.toBe(before);
    const current = await pageTurns(page);
    expect(current.length).toBeLessThanOrEqual(50);
    expect(current.slice(1).every((turnNumber, index) => turnNumber === current[index]! + 1)).toBe(true);
    expect(await page.locator("#turnHistoryModalList .history-card, #turnHistoryPreviewCard .history-card").count()).toBeLessThanOrEqual(50);
    windows.push(current);
  }
  await expect(older).toBeDisabled();

  const chronological = windows.slice().reverse().flat();
  await testInfo.attach("captured-history-window-vectors.json", {
    body: JSON.stringify({ turnCount, windows, chronological }, null, 2),
    contentType: "application/json"
  });
  expect(chronological, `Captured ascending page vectors: ${JSON.stringify(windows)}`).toEqual(Array.from({ length: turnCount }, (_, index) => index + 1));
  expect(new Set(chronological).size).toBe(turnCount);

  const newer = page.locator("#btnTurnHistoryNewer");
  for (let target = windows.length - 2; target >= 0; target -= 1) {
    expect(newer).toBeEnabled();
    await newer.click();
    await expect.poll(async () => JSON.stringify(await pageTurns(page)), `Newer must replay captured window ${target}: ${JSON.stringify(windows[target])}`).toBe(JSON.stringify(windows[target]));
    expect(await page.locator("#turnHistoryModalList .history-card, #turnHistoryPreviewCard .history-card").count()).toBeLessThanOrEqual(50);
  }
  await expect(newer).toBeDisabled();
}

test("history pages all 317 accepted turns exactly once and Newer replays the captured windows", async ({ page }, testInfo) => {
  await traverseHistory(page, testInfo, 317);
});

test("history pages all 2000 accepted turns exactly once and Newer replays the captured windows", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await traverseHistory(page, testInfo, 2000);
});

test("a resumed Turn 12 remains pinned through a private adjacent-lookup error and retry", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 317, worldCount: 1, campaignCount: 1 });
  const instrumentation = await installLegacyUiFixture(page, fixture);
  const userId = String((fixture.session.user as Record<string, unknown>).id);
  await seedReaderPosition(page, userId, fixture.campaignId, fixture.turns[11]!);
  await prepareStoryPage(page, fixture.campaignId);

  let initialLookupCount = 0;
  await page.route(`**/api/v1/campaigns/${fixture.campaignId}/reader/turns/12`, async route => {
    initialLookupCount += 1;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ campaignId: fixture.campaignId, turn: fixture.turns[11] })
    });
  });
  let adjacentLookupCount = 0;
  await page.route(`**/api/v1/campaigns/${fixture.campaignId}/reader/turns/11`, async route => {
    adjacentLookupCount += 1;
    if (adjacentLookupCount === 1) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "PRIVATE_ADJACENT_LOOKUP_CANARY", message: "database shard credentials and storage path" })
      });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ campaignId: fixture.campaignId, turn: fixture.turns[10] })
    });
  });

  await page.goto(`${origin}/story/${fixture.campaignId}`);
  await expect(page.locator("#readerTurnCount")).toHaveText("Turn 12 of 317");
  await expect.poll(() => initialLookupCount).toBe(1);
  await openHistory(page);
  const previousPages = await pageTurns(page);
  const initialPageCount = previousPages.length;
  await expect(page.locator("#turnHistoryPreviewCard .history-card")).toContainText("Turn 12");
  expect(await page.locator("#turnHistoryModalList .history-card, #turnHistoryPreviewCard .history-card").count()).toBeLessThanOrEqual(50);

  const previousTurn = page.locator("#btnTurnHistoryPreviousTurn");
  await expect(previousTurn).toBeEnabled();
  await previousTurn.click();
  await expect.poll(() => adjacentLookupCount).toBe(1);
  await expect(page.locator("#turnHistoryLoadStatus")).toContainText("Could not load adjacent turn.");
  await expect(page.locator("#turnHistoryLoadStatus")).not.toContainText("PRIVATE_ADJACENT_LOOKUP_CANARY");
  await expect(page.locator("#turnHistoryDialog")).not.toContainText("storage path");
  await expect(page.locator("#turnHistoryPreviewCard .history-card")).toContainText("Turn 12");
  await expect(previousTurn).toBeEnabled();
  expect(await pageTurns(page)).toEqual(previousPages);
  expect(await page.locator("#turnHistoryModalList .history-card").count()).toBe(initialPageCount);
  expect(await page.locator("#turnHistoryModalList .history-card, #turnHistoryPreviewCard .history-card").count()).toBeLessThanOrEqual(50);

  await previousTurn.click();
  await expect.poll(() => adjacentLookupCount).toBe(2);
  await expect(page.locator("#turnHistoryPreviewCard .history-card")).toContainText("Turn 11");
  expect(await pageTurns(page)).toEqual(previousPages);
  expect(await page.locator("#turnHistoryModalList .history-card, #turnHistoryPreviewCard .history-card").count()).toBeLessThanOrEqual(50);
  expect(instrumentation.requests.filter(request => request.path.endsWith("/state/inspection"))).toHaveLength(0);
});

test("history disclosure keyboard activation is separate from turn selection and Inspect", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 317, worldCount: 1, campaignCount: 1 });
  const instrumentation = await installLegacyUiFixture(page, fixture);
  await prepareStoryPage(page, fixture.campaignId);
  await page.goto(`${origin}/story/${fixture.campaignId}`);
  await expect(page.locator("#storySyncStatus")).toContainText("Story synced");
  await openHistory(page);

  const firstEntry = page.locator("#turnHistoryModalList .history-entry").first();
  const card = firstEntry.locator("button.history-card");
  const details = firstEntry.locator("details");
  const summary = details.locator("summary");
  await expect(card).toHaveAttribute("aria-pressed", "false");
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(details).toHaveAttribute("open", "");
  await expect(card).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("Space");
  await expect(details).not.toHaveAttribute("open", "");
  await expect(card).toHaveAttribute("aria-pressed", "false");
  expect(instrumentation.requests.filter(request => request.path.endsWith("/state/inspection"))).toHaveLength(0);

  await card.focus();
  await page.keyboard.press("Enter");
  await expect(card).toHaveAttribute("aria-pressed", "true");
  expect(instrumentation.requests.filter(request => request.path.endsWith("/state/inspection"))).toHaveLength(0);
  expect(await page.locator("#turnHistoryModalList .history-card, #turnHistoryPreviewCard .history-card").count()).toBeLessThanOrEqual(50);
});

test("History reveals the selected card on open, reopen, and explicit selection", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 317, worldCount: 1, campaignCount: 1 });
  await installLegacyUiFixture(page, fixture);
  await prepareStoryPage(page, fixture.campaignId);
  await page.goto(`${origin}/story/${fixture.campaignId}`);
  await expect(page.locator("#readerTurnCount")).toHaveText("Turn 317 of 317");
  await page.setViewportSize({ width: 1280, height: 800 });
  await openHistory(page);

  const selected = page.locator('#turnHistoryModalList .history-card[data-turn-number="317"][aria-pressed="true"]');
  const desktopGeometry = await selectedHistoryCardGeometry(page, 317);
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({ path: `${evidenceDirectory}/history-selected-desktop.png`, fullPage: false });
  await writeFile(`${evidenceDirectory}/history-selected-desktop-geometry.json`, JSON.stringify(desktopGeometry, null, 2));
  await expect(selected).toBeVisible();
  expect(desktopGeometry.scrollHeight).toBeGreaterThan(desktopGeometry.clientHeight);
  expect(desktopGeometry.fullyVisible).toBe(true);
  expect(desktopGeometry.scrollTop).toBeGreaterThan(0);

  await page.locator("#btnTurnHistoryDone").click();
  await expect(page.locator("#turnHistoryDialog")).not.toHaveAttribute("open", "");
  await page.setViewportSize({ width: 390, height: 844 });
  await openHistory(page);
  const mobileGeometry = await selectedHistoryCardGeometry(page, 317);
  await page.screenshot({ path: `${evidenceDirectory}/history-selected-mobile.png`, fullPage: false });
  await writeFile(`${evidenceDirectory}/history-selected-mobile-geometry.json`, JSON.stringify(mobileGeometry, null, 2));
  expect(mobileGeometry.fullyVisible).toBe(true);

  const offscreenCard = page.locator('#turnHistoryModalList .history-card[data-turn-number="268"]');
  await offscreenCard.evaluate(element => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await expect(offscreenCard).toHaveAttribute("aria-pressed", "true");
  const explicitlySelectedGeometry = await selectedHistoryCardGeometry(page, 268);
  await writeFile(`${evidenceDirectory}/history-explicit-selection-geometry.json`, JSON.stringify(explicitlySelectedGeometry, null, 2));
  expect(explicitlySelectedGeometry.fullyVisible).toBe(true);
});

test("History keeps native scrolling and pages only on explicit Older/Newer without changing the scene", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 317, worldCount: 1, campaignCount: 1 });
  const instrumentation = await installLegacyUiFixture(page, fixture);
  await prepareStoryPage(page, fixture.campaignId);
  await page.goto(`${origin}/story/${fixture.campaignId}`);
  await expect(page.locator("#readerTurnCount")).toHaveText("Turn 317 of 317");
  await openHistory(page);

  const scroller = page.locator("#turnHistoryDialog .dialog-scroll");
  const initialScrollTop = await scroller.evaluate(element => element.scrollTop);
  const scrollBox = await scroller.boundingBox();
  if (!scrollBox) throw new Error("History scroll container has no rendered box.");
  await page.mouse.move(scrollBox.x + scrollBox.width / 2, scrollBox.y + scrollBox.height / 2);
  await page.mouse.wheel(0, 180);
  await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBeGreaterThan(initialScrollTop);

  const pageBeforeOlder = await pageTurns(page);
  const turnBeforePaging = await page.locator("#readerTurnCount").textContent();
  const turnsPath = `/api/v1/campaigns/${fixture.campaignId}/turns`;
  await page.locator("#btnTurnHistoryOlder").click();
  await expect.poll(async () => JSON.stringify(await pageTurns(page))).not.toBe(JSON.stringify(pageBeforeOlder));
  expect(await page.locator("#readerTurnCount")).toHaveText(turnBeforePaging ?? "");
  expect(instrumentation.requests.filter(request => request.path === turnsPath)).toHaveLength(1);
  const olderPage = await pageTurns(page);

  await page.locator("#btnTurnHistoryNewer").click();
  await expect.poll(async () => JSON.stringify(await pageTurns(page))).toBe(JSON.stringify(pageBeforeOlder));
  expect(await page.locator("#readerTurnCount")).toHaveText(turnBeforePaging ?? "");
  expect(await pageTurns(page)).not.toEqual(olderPage);
  expect(instrumentation.requests.filter(request => request.path === turnsPath)).toHaveLength(1);
  expect(await page.locator("#turnHistoryModalList .history-card, #turnHistoryPreviewCard .history-card").count()).toBeLessThanOrEqual(50);
});
