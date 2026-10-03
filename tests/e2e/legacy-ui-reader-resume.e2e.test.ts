import { expect, test, type Page } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import { installLegacyUiFixture, legacyUiFixture } from "./helpers/legacy-ui-fixtures.js";
import { quietLeafApiPayloads } from "../fixtures/quiet-leaf-payloads.js";
import { generationJobSnapshotSchema, generationResultSchema } from "../../packages/contracts/src/index.js";

const origin = `http://127.0.0.1:${process.env.PLAYWRIGHT_LEGACY_PORT ?? "43173"}`;
const alternateTurnId = "99999999-9999-4999-8999-999999999999";
const screenshotDirectory = ".superpowers/sdd/legacy-ui-2026-10-03/evidence/T11/screenshots";

declare global {
  interface Window {
    __readerPositionReadHeld?: boolean;
    __releaseReaderPositionRead?: () => void;
    __readerPositionStorePuts?: number;
    __readerFontsReadyReads?: number;
    __releaseReaderFonts?: () => void;
    __readerIntentCalls?: number;
  }
}

function fixtureUserId(fixture: ReturnType<typeof legacyUiFixture>): string {
  const user = fixture.session.user as { id: string };
  return String(user.id);
}

async function prepareStoryPage(page: Page, campaignId: string): Promise<void> {
  const html = (await readFile("apps/web/public/story.html", "utf8"))
    .replace("/nexus/legacy-client.js", "/nexus/src/legacy-client-entry.ts");
  await page.route(`**/story/${campaignId}`, (route) => route.fulfill({ contentType: "text/html", body: html }));
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

async function holdNextReaderPositionRead(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const descriptor = Object.getOwnPropertyDescriptor(IDBRequest.prototype, "onsuccess");
    if (!descriptor?.get || !descriptor.set) return;
    Object.defineProperty(IDBRequest.prototype, "onsuccess", {
      configurable: true,
      enumerable: descriptor.enumerable ?? false,
      get() { return descriptor.get?.call(this); },
      set(handler: ((this: IDBRequest, event: Event) => unknown) | null) {
        const request = this;
        if ((request.source as IDBObjectStore | null)?.name !== "positions" || !handler) {
          descriptor.set?.call(request, handler);
          return;
        }
        descriptor.set?.call(request, function (this: IDBRequest, event: Event) {
          window.__readerPositionReadHeld = true;
          window.__releaseReaderPositionRead = () => handler.call(request, event);
        });
      }
    });
  });
}

async function releaseReaderPositionRead(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => window.__readerPositionReadHeld === true)).toBe(true);
  await page.evaluate(() => window.__releaseReaderPositionRead?.());
}

async function readStoredReaderPosition(page: Page, key: string): Promise<Record<string, unknown> | undefined> {
  return page.evaluate(async (storageKey: string) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("infiniteQuest-reader-positions-v1", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const result = await new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
      const request = database.transaction("positions", "readonly").objectStore("positions").get(storageKey);
      request.onsuccess = () => resolve(request.result as Record<string, unknown> | undefined);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return result;
  }, key);
}

async function watchReaderPositionWrites(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__readerPositionStorePuts = 0;
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === "positions") window.__readerPositionStorePuts = (window.__readerPositionStorePuts ?? 0) + 1;
      return originalPut.apply(this, args);
    };
  });
}

async function installExactTurnRoute(page: Page, fixture: ReturnType<typeof legacyUiFixture>, getTurn: () => Record<string, unknown>) {
  const path = `**/api/v1/campaigns/${fixture.campaignId}/reader/turns/12`;
  let requests = 0;
  await page.route(path, async (route) => {
    requests += 1;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ campaignId: fixture.campaignId, turn: getTurn() })
    });
  });
  return () => requests;
}

function installRecoverableGeneration(fixture: ReturnType<typeof legacyUiFixture>): void {
  fixture.syncStatus.generationRecovery = {
    id: "55555555-5555-4555-8555-555555555555",
    status: "recoverable",
    operationKind: "append",
    replacementTurnId: null,
    expectedTurnNumber: fixture.turnCount + 1,
    attempts: 1,
    errorCode: "generation_failed",
    errorMessage: "Generation could not be completed.",
    diagnostic: null,
    resultTurnId: null
  };
}

test("a delayed unavailable position cannot replace an explicitly navigated scene", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 317, worldCount: 1, campaignCount: 1 });
  await installLegacyUiFixture(page, fixture);
  await seedReaderPosition(page, fixtureUserId(fixture), fixture.campaignId, {
    ...fixture.turns[316]!, turnNumber: 999
  });
  await prepareStoryPage(page, fixture.campaignId);
  await holdNextReaderPositionRead(page);

  await page.goto(`${origin}/story/${fixture.campaignId}`);
  await expect(page.locator("#readerTurnCount")).toHaveText("Turn 317 of 317");
  await page.locator("#btnPrev").click();
  await expect(page.locator("#readerTurnCount")).toHaveText("Turn 316 of 317");
  await releaseReaderPositionRead(page);
  await expect(page.locator("#readerPositionNotice")).toBeEmpty();
  await expect(page.locator("#readerTurnCount")).toHaveText("Turn 316 of 317");
});

test("a delayed invalid position cannot take over a hydrated recovery scene", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 317, worldCount: 1, campaignCount: 1 });
  installRecoverableGeneration(fixture);
  const instrumentation = await installLegacyUiFixture(page, fixture);
  await seedReaderPosition(page, fixtureUserId(fixture), fixture.campaignId, {
    ...fixture.turns[316]!, id: alternateTurnId
  });
  await prepareStoryPage(page, fixture.campaignId);
  await holdNextReaderPositionRead(page);

  await page.goto(`${origin}/story/${fixture.campaignId}`);
  await expect(page.locator("#generationRecoveryPanel")).toBeVisible();
  await page.locator("#btnPrev").click();
  await expect(page.locator("#readerTurnCount")).toHaveText("Turn 316 of 317");
  await releaseReaderPositionRead(page);
  await expect(page.locator("#readerPositionNotice")).toBeEmpty();
  await expect(page.locator("#readerTurnCount")).toHaveText("Turn 316 of 317");
  await expect(page.locator("#generationRecoveryPanel")).toBeVisible();
  expect(instrumentation.writes).toEqual([]);
});

test("recovery-owned programmatic scrolling does not overwrite the deferred saved position", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 317, worldCount: 1, campaignCount: 1 });
  installRecoverableGeneration(fixture);
  const instrumentation = await installLegacyUiFixture(page, fixture);
  await seedReaderPosition(page, fixtureUserId(fixture), fixture.campaignId, fixture.turns[11]!);
  await prepareStoryPage(page, fixture.campaignId);
  await watchReaderPositionWrites(page);
  await page.clock.install();
  const key = `${fixtureUserId(fixture)}:${fixture.campaignId}`;

  await page.goto(`${origin}/story/${fixture.campaignId}`);
  await expect(page.locator("#generationRecoveryPanel")).toBeVisible();
  await expect(page.locator("#readerPositionNotice")).toContainText("available after generation or recovery");
  const beforeScroll = await page.evaluate(() => window.scrollY);
  await page.mouse.move(640, 420);
  await page.mouse.wheel(0, 700);
  await expect.poll(() => page.evaluate(() => window.scrollY)).not.toBe(beforeScroll);
  await page.clock.runFor(350);
  expect(await page.evaluate(() => window.__readerPositionStorePuts)).toBe(0);
  await expect.poll(async () => (await readStoredReaderPosition(page, key))?.position
    && ((await readStoredReaderPosition(page, key))?.position as Record<string, unknown>).turnNumber)
    .toBe(12);
  expect(await readStoredReaderPosition(page, key)).toMatchObject({
    schemaVersion: 1,
    userId: fixtureUserId(fixture),
    campaignId: fixture.campaignId,
    position: {
      turnId: fixture.turns[11]!.id,
      turnNumber: 12,
      offsetRatio: 0.5,
      updatedAt: "2026-10-03T12:00:00.000Z"
    }
  });
  await expect(page.locator("#readerPositionNotice")).toContainText("available after generation or recovery");
  expect(instrumentation.writes).toEqual([]);
  expect(instrumentation.requests.filter((request) => request.path.includes("/reader/turns/")).length).toBe(0);
});

test("Jump to latest keeps the saved action draft and submits no generation", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 317, worldCount: 1, campaignCount: 1 });
  const instrumentation = await installLegacyUiFixture(page, fixture);
  await seedReaderPosition(page, fixtureUserId(fixture), fixture.campaignId, fixture.turns[11]!);
  await prepareStoryPage(page, fixture.campaignId);
  await installExactTurnRoute(page, fixture, () => fixture.turns[11]!);

  await page.goto(`${origin}/story/${fixture.campaignId}`);
  await expect(page.locator("#readerTurnCount")).toHaveText("Turn 12 of 317");
  await page.locator("#btnReaderJumpLatest").click();
  await expect(page.locator("#readerTurnCount")).toHaveText("Turn 317 of 317");
  await page.locator("#freeAction").fill("Keep this locally saved action draft.");
  await expect(page.locator("#autosaveStatus")).toHaveText("Draft saved");
  await page.locator("#btnPrev").click();
  await expect(page.locator("#readerTurnCount")).toHaveText("Turn 316 of 317");
  await page.locator("#btnReaderJumpLatest").click();
  await expect(page.locator("#readerTurnCount")).toHaveText("Turn 317 of 317");
  await expect(page.locator("#freeAction")).toHaveValue("Keep this locally saved action draft.");
  expect(instrumentation.writes).toEqual([]);
});

test("explicit turn navigation saves identity even when it leaves scroll geometry unchanged", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 317, worldCount: 1, campaignCount: 1 });
  await installLegacyUiFixture(page, fixture);
  await prepareStoryPage(page, fixture.campaignId);
  await page.addInitScript(() => {
    HTMLElement.prototype.scrollIntoView = function () {};
  });
  const key = `${fixtureUserId(fixture)}:${fixture.campaignId}`;

  await page.goto(`${origin}/story/${fixture.campaignId}`);
  await expect(page.locator("#readerTurnCount")).toHaveText("Turn 317 of 317");
  const beforeNavigation = await page.evaluate(() => window.scrollY);
  await page.locator("#btnPrev").click();
  await expect(page.locator("#readerTurnCount")).toHaveText("Turn 316 of 317");
  const afterNavigation = await page.evaluate(() => window.scrollY);
  expect(afterNavigation).toBe(beforeNavigation);
  await expect.poll(async () => (await readStoredReaderPosition(page, key))?.position
    && ((await readStoredReaderPosition(page, key))?.position as Record<string, unknown>).turnNumber)
    .toBe(316);
  expect(await readStoredReaderPosition(page, key)).toMatchObject({
    userId: fixtureUserId(fixture),
    campaignId: fixture.campaignId,
    position: { turnId: fixture.turns[315]!.id, turnNumber: 316 }
  });
});

test("continuous reading renders an exact saved turn when the history page fails", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 317, worldCount: 1, campaignCount: 1 });
  const user = fixture.session.user as Record<string, unknown>;
  user.settings = { ...(user.settings as Record<string, unknown>), continuousReading: true };
  const instrumentation = await installLegacyUiFixture(page, fixture);
  let failedOlderPages = 0;
  await page.route(`**/api/v1/campaigns/${fixture.campaignId}/turns**`, async (route) => {
    if (new URL(route.request().url()).searchParams.has("before")) {
      failedOlderPages += 1;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Fixture failure" }) });
      return;
    }
    await route.fallback();
  });
  await seedReaderPosition(page, fixtureUserId(fixture), fixture.campaignId, fixture.turns[11]!);
  await prepareStoryPage(page, fixture.campaignId);
  const exactLookup = await installExactTurnRoute(page, fixture, () => fixture.turns[11]!);

  await page.goto(`${origin}/story/${fixture.campaignId}`);
  await expect.poll(() => failedOlderPages).toBe(1);
  await expect.poll(() => page.locator("#storySyncStatus").textContent()).toContain("Story synced");
  await expect.poll(() => exactLookup()).toBe(1);
  await expect(page.locator("#readerPositionNotice")).toContainText("Resumed reading at Turn 12");
  await expect.poll(() => page.locator("#readerTurnCount").textContent()).toContain("Turn 12 of 317");
  await expect(page.locator("#scene-12")).toBeVisible();
  expect(exactLookup()).toBe(1);
  expect(failedOlderPages).toBe(1);
});

test("a same-number replacement accepted during font layout supersedes the saved identity", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 317, worldCount: 1, campaignCount: 1 });
  const instrumentation = await installLegacyUiFixture(page, fixture);
  const jobId = "55555555-5555-4555-8555-555555555555";
  const replacementId = "99999999-9999-4999-8999-999999999998";
  const timestamp = "2026-10-03T12:00:00.000Z";
  await seedReaderPosition(page, fixtureUserId(fixture), fixture.campaignId, {
    ...fixture.turns[316]!, narration: "Old accepted scene. ".repeat(110)
  });
  await prepareStoryPage(page, fixture.campaignId);
  await page.addInitScript(() => {
    Object.defineProperty(window, "EventSource", { configurable: true, value: undefined });
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    window.__readerFontsReadyReads = 0;
    Object.defineProperty(document.fonts, "ready", {
      configurable: true,
      get() {
        window.__readerFontsReadyReads = (window.__readerFontsReadyReads ?? 0) + 1;
        return ready;
      }
    });
    window.__releaseReaderFonts = release;
  });
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const respond = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
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
        status: "completed", turnNumber: 317, inputMode: "action", narration: "Replacement accepted scene. ".repeat(110),
        choices: [], customActionSuggestion: "", imagePrompt: "", imageUrl: null, acceptedAt: timestamp,
        chronicleRetrieval: null, modelMetadata: null, mechanics: null, stateSnapshot: {}, reportedCost: null
      }));
    }
    return route.fallback();
  });

  await page.goto(`${origin}/story/${fixture.campaignId}`);
  await expect.poll(() => page.evaluate(() => (window.__readerFontsReadyReads ?? 0) > 0)).toBe(true);
  await expect(page.locator("#readerTurnCount")).toHaveText("Turn 317 of 317");
  await page.locator("[data-story-more] summary").click();
  await page.locator("#btnRetry").click();
  await page.locator("#retryPromptEditor").fill("Replacement action.");
  await page.locator("#btnRetryPromptSubmit").click();
  await expect(page.locator("#scene-317")).toContainText("Replacement accepted scene.");
  await expect.poll(() => page.locator("#storySyncStatus").textContent()).toContain("Story synced");
  const acceptedViewport = await page.evaluate(() => {
    const scene = document.querySelector<HTMLElement>("#scene-317")!;
    const inset = Math.max(
      document.querySelector(".universal-nav")?.getBoundingClientRect().height ?? 0,
      document.querySelector("[data-story-reader-toolbar]")?.getBoundingClientRect().bottom ?? 0
    );
    const rect = scene.getBoundingClientRect();
    const available = Math.max(0, rect.height - (window.innerHeight - inset));
    window.scrollTo({ top: Math.max(0, rect.top + window.scrollY + available * 0.2 - inset), behavior: "auto" });
    return new Promise<{ ratio: number; scrollY: number }>((resolve) => requestAnimationFrame(() => {
      const settled = scene.getBoundingClientRect();
      const scrollable = Math.max(0, settled.height - (window.innerHeight - inset));
      resolve({
        ratio: scrollable ? (window.scrollY + inset - (settled.top + window.scrollY)) / scrollable : 0,
        scrollY: window.scrollY
      });
    }));
  });
  expect(acceptedViewport.ratio).toBeGreaterThan(0.1);
  await page.evaluate(() => window.__releaseReaderFonts?.());
  await expect.poll(() => page.evaluate((expected) => Math.abs(window.scrollY - expected), acceptedViewport.scrollY)).toBeLessThan(5);
  await expect(page.locator("#readerPositionNotice")).not.toContainText("Resumed reading at Turn 317");
  expect(instrumentation.writes.map((write) => write.path)).toEqual([`/api/v1/campaigns/${fixture.campaignId}/generations/retry-latest`]);
});

test("restores an accepted turn outside the recent window once and explains a replacement", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 317, worldCount: 1, campaignCount: 1 });
  const instrumentation = await installLegacyUiFixture(page, fixture);
  let replaceTurn = false;
  const savedTurn = {
    ...fixture.turns[11]!,
    narration: "A saved scene passage remains readable as the story layout changes. ".repeat(180)
  };
  const lookupCount = await installExactTurnRoute(page, fixture, () => replaceTurn
    ? { ...savedTurn, id: alternateTurnId }
    : savedTurn);
  await seedReaderPosition(page, fixtureUserId(fixture), fixture.campaignId, fixture.turns[11]!);
  await prepareStoryPage(page, fixture.campaignId);
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto(`${origin}/story/${fixture.campaignId}`);
  await expect(page.locator("#readerTurnCount")).toHaveText("Turn 12 of 317");
  await expect(page.locator("#scene-12")).toBeVisible();
  await expect.poll(() => page.locator("#readerPositionNotice").textContent())
    .toContain("Resumed reading at Turn 12");
  await page.evaluate(() => document.fonts.ready);
  const restoredRatio = await page.evaluate(() => {
    const scene = document.querySelector<HTMLElement>("#scene-12")!;
    const headerHeight = document.querySelector(".universal-nav")?.getBoundingClientRect().height ?? 0;
    const toolbarBottom = document.querySelector("[data-story-reader-toolbar]")?.getBoundingClientRect().bottom ?? 0;
    const inset = Math.max(headerHeight, toolbarBottom);
    const rect = scene.getBoundingClientRect();
    const available = Math.max(0, rect.height - (window.innerHeight - inset));
    return available > 0 ? (window.scrollY + inset - (rect.top + window.scrollY)) / available : 0;
  });
  expect(restoredRatio).toBeCloseTo(0.5, 1);
  const firstLookupCount = lookupCount();
  expect(firstLookupCount).toBe(1);
  expect(instrumentation.requests.filter((request) => request.path.includes("/turns?before=")).map((request) => request.path)).toEqual([]);
  await mkdir(screenshotDirectory, { recursive: true });
  await page.screenshot({ path: `${screenshotDirectory}/reader-resumed-turn-12-390x844.png`, fullPage: true });

  const desktopPage = await page.context().newPage();
  await desktopPage.setViewportSize({ width: 1280, height: 800 });
  await installLegacyUiFixture(desktopPage, fixture);
  await prepareStoryPage(desktopPage, fixture.campaignId);
  const desktopLookupCount = await installExactTurnRoute(desktopPage, fixture, () => replaceTurn
    ? { ...savedTurn, id: alternateTurnId }
    : savedTurn);
  const readerPositionKey = `${fixtureUserId(fixture)}:${fixture.campaignId}`;
  await expect.poll(() => page.evaluate(async (key: string) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("infiniteQuest-reader-positions-v1", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const value = await new Promise<{ position?: { updatedAt?: string } } | undefined>((resolve, reject) => {
      const request = database.transaction("positions", "readonly").objectStore("positions").get(key);
      request.onsuccess = () => resolve(request.result as { position?: { updatedAt?: string } } | undefined);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return value?.position?.updatedAt;
  }, readerPositionKey)).not.toBe("2026-10-03T12:00:00.000Z");
  await desktopPage.goto(`${origin}/story/${fixture.campaignId}`);
  await expect(desktopPage.locator("#readerTurnCount")).toHaveText("Turn 12 of 317");
  await expect.poll(() => desktopPage.locator("#readerPositionNotice").textContent())
    .toContain("Resumed reading at Turn 12");
  await desktopPage.evaluate(() => document.fonts.ready);
  const resizedReloadRatio = await desktopPage.evaluate(() => {
    const scene = document.querySelector<HTMLElement>("#scene-12")!;
    const headerHeight = document.querySelector(".universal-nav")?.getBoundingClientRect().height ?? 0;
    const toolbarBottom = document.querySelector("[data-story-reader-toolbar]")?.getBoundingClientRect().bottom ?? 0;
    const inset = Math.max(headerHeight, toolbarBottom);
    const rect = scene.getBoundingClientRect();
    const available = Math.max(0, rect.height - (window.innerHeight - inset));
    return available > 0 ? (window.scrollY + inset - (rect.top + window.scrollY)) / available : 0;
  });
  expect(resizedReloadRatio).toBeCloseTo(0.5, 1);
  await desktopPage.screenshot({ path: `${screenshotDirectory}/reader-resumed-turn-12-1280x800.png`, fullPage: true });
  expect(desktopLookupCount()).toBe(1);

  replaceTurn = true;
  await desktopPage.reload();
  await expect(desktopPage.locator("#readerTurnCount")).toHaveText("Turn 317 of 317");
  await expect(desktopPage.locator("#scene-317")).toBeVisible();
  await expect(desktopPage.locator("#readerPositionNotice")).toContainText("saved turn is no longer available");
  expect(desktopLookupCount()).toBe(2);
});

test("a pinned resumed turn disables Previous and Next catches up to latest", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 317, worldCount: 1, campaignCount: 1 });
  await installLegacyUiFixture(page, fixture);
  await seedReaderPosition(page, fixtureUserId(fixture), fixture.campaignId, fixture.turns[11]!);
  await prepareStoryPage(page, fixture.campaignId);
  const lookupCount = await installExactTurnRoute(page, fixture, () => fixture.turns[11]!);

  await page.goto(`${origin}/story/${fixture.campaignId}`);
  await expect(page.locator("#readerTurnCount")).toHaveText("Turn 12 of 317");
  await expect(page.locator("#scene-12")).toBeVisible();
  await expect(page.locator("#btnPrev")).toBeDisabled();
  await expect(page.locator("#btnNext")).toBeEnabled();
  await page.locator("#btnNext").click();
  await expect(page.locator("#readerTurnCount")).toHaveText("Turn 317 of 317");
  await expect(page.locator("#scene-317")).toBeVisible();
  expect(lookupCount()).toBe(1);
});
test("a manual scroll cancels a pending exact-turn restore", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 317, worldCount: 1, campaignCount: 1 });
  const instrumentation = await installLegacyUiFixture(page, fixture);
  await seedReaderPosition(page, fixtureUserId(fixture), fixture.campaignId, fixture.turns[11]!);
  await prepareStoryPage(page, fixture.campaignId);
  await page.addInitScript(() => {
    const addEventListener = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, listener, options) {
      if (this === document && type === "wheel" && typeof listener === "function" && listener.name === "noteReaderPositionIntent") {
        const observed = function (this: EventTarget, event: Event) {
          window.__readerIntentCalls = (window.__readerIntentCalls ?? 0) + 1;
          return listener.call(this, event);
        };
        return addEventListener.call(this, type, observed, options);
      }
      return addEventListener.call(this, type, listener, options);
    };
  });

  let releaseLookup!: () => void;
  let markLookupStarted!: () => void;
  let markLookupFulfilled!: () => void;
  const lookupStarted = new Promise<void>((resolve) => { markLookupStarted = resolve; });
  const lookupFulfilled = new Promise<void>((resolve) => { markLookupFulfilled = resolve; });
  const lookupBlocked = new Promise<void>((resolve) => { releaseLookup = resolve; });
  await page.route(`**/api/v1/campaigns/${fixture.campaignId}/reader/turns/12`, async (route) => {
    markLookupStarted();
    await lookupBlocked;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ campaignId: fixture.campaignId, turn: fixture.turns[11] }) });
    markLookupFulfilled();
  });

  await page.goto(`${origin}/story/${fixture.campaignId}`);
  await lookupStarted;
  const scrollBeforeIntent = await page.evaluate(() => window.scrollY);
  await page.mouse.move(640, 400);
  await page.mouse.wheel(0, 700);
  await expect.poll(() => page.evaluate(() => window.scrollY)).not.toBe(scrollBeforeIntent);
  await expect.poll(() => page.evaluate(() => window.__readerIntentCalls ?? 0)).toBe(1);


  releaseLookup();
  await lookupFulfilled;
  await expect(page.locator("#readerTurnCount")).toHaveText("Turn 317 of 317");
  await expect(page.locator("#scene-317")).toBeVisible();
  await expect(page.getByRole("button", { name: "Resume reading" })).toBeVisible();
  expect(instrumentation.requests.filter((request) => request.path.includes("/turns?before=")).length).toBe(0);
});

test("a native scrollbar drag cancels a pending exact-turn restore when the browser exposes one", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 317, worldCount: 1, campaignCount: 1 });
  const latest = fixture.turns[316]!;
  latest.narration = "A long accepted scene provides a real document scrollbar. ".repeat(130);
  const instrumentation = await installLegacyUiFixture(page, fixture);
  await seedReaderPosition(page, fixtureUserId(fixture), fixture.campaignId, fixture.turns[11]!);
  await prepareStoryPage(page, fixture.campaignId);
  let releaseLookup!: () => void;
  let markLookupStarted!: () => void;
  let markLookupFulfilled!: () => void;
  const lookupStarted = new Promise<void>((resolve) => { markLookupStarted = resolve; });
  const lookupFulfilled = new Promise<void>((resolve) => { markLookupFulfilled = resolve; });
  const lookupBlocked = new Promise<void>((resolve) => { releaseLookup = resolve; });
  await page.route(`**/api/v1/campaigns/${fixture.campaignId}/reader/turns/12`, async (route) => {
    markLookupStarted();
    await lookupBlocked;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ campaignId: fixture.campaignId, turn: fixture.turns[11] }) });
    markLookupFulfilled();
  });

  await page.goto(`${origin}/story/${fixture.campaignId}`);
  await lookupStarted;
  const metrics = await page.evaluate(() => ({
    scrollHeight: document.documentElement.scrollHeight,
    clientHeight: document.documentElement.clientHeight,
    clientWidth: document.documentElement.clientWidth,
    innerWidth: window.innerWidth,
    scrollY: window.scrollY
  }));
  test.skip(metrics.scrollHeight <= metrics.clientHeight || metrics.clientWidth === metrics.innerWidth,
    "This rendered browser does not expose a non-overlay native scrollbar to drag.");
  const thumb = Math.max(18, metrics.clientHeight * metrics.clientHeight / metrics.scrollHeight);
  const startY = (metrics.clientHeight - thumb) / 2;
  const endY = Math.min(metrics.clientHeight - thumb / 2, startY + metrics.clientHeight * 0.35);
  await page.mouse.move(metrics.innerWidth - 5, startY);
  await page.mouse.down();
  await page.mouse.move(metrics.innerWidth - 5, endY, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.scrollY)).not.toBe(metrics.scrollY);
  releaseLookup();
  await lookupFulfilled;
  await expect(page.locator("#readerTurnCount")).toHaveText("Turn 317 of 317");
  await expect(page.locator("#scene-317")).toBeVisible();
  await expect(page.getByRole("button", { name: "Resume reading" })).toBeVisible();
  expect(instrumentation.requests.filter((request) => request.path.includes("/turns?before=")).length).toBe(0);
});

test("a saved reader position does not take over an active generation", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 317, worldCount: 1, campaignCount: 1 });
  const pending = quietLeafApiPayloads({ pendingGeneration: true }).syncStatus.pendingGeneration!;
  const instrumentation = await installLegacyUiFixture(page, fixture);
  await seedReaderPosition(page, fixtureUserId(fixture), fixture.campaignId, fixture.turns[11]!);
  await prepareStoryPage(page, fixture.campaignId);
  await page.route(`**/api/v1/campaigns/${fixture.campaignId}/sync-status`, (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ ...fixture.syncStatus, pendingGeneration: pending })
  }));
  const exactLookup = await installExactTurnRoute(page, fixture, () => fixture.turns[11]!);

  await page.goto(`${origin}/story/${fixture.campaignId}`);
  await expect(page.locator("#readerTurnCount")).toHaveText("Turn 317 of 317");
  await expect(page.locator("#readerPositionNotice"))
    .toContainText("available after generation or recovery is resolved");
  await expect(page.locator("#btnTakeAction")).toBeDisabled();
  await expect(page.locator("#readerResumePrompt")).toBeHidden();
  expect(exactLookup()).toBe(0);
  expect(instrumentation.requests.filter((request) => request.method !== "GET" && request.method !== "HEAD")).toEqual([]);
});

test("a new reader stays at the latest turn when position storage is unavailable", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 317, worldCount: 1, campaignCount: 1 });
  await installLegacyUiFixture(page, fixture);
  await page.addInitScript(() => {
    const originalOpen = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (name, version) {
      if (name === "infiniteQuest-reader-positions-v1") throw new Error("Reader storage is blocked.");
      return originalOpen.call(this, name, version);
    };
  });
  await prepareStoryPage(page, fixture.campaignId);

  await page.goto(`${origin}/story/${fixture.campaignId}`);
  await expect(page.locator("#readerTurnCount")).toHaveText("Turn 317 of 317");
  await expect(page.locator("#scene-317")).toBeVisible();
  await expect(page.locator("#readerResumePrompt")).toBeHidden();
});
