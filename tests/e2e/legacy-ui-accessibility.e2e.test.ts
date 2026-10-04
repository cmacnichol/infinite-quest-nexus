import { chromium, expect, test, type BrowserContext, type Locator, type Page, type TestInfo, type Worker } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import sharp from "sharp";
import {
  campaignCharacterProfileViewSchema,
  generationStreamSnapshotSchema,
  illustrationConfigResponseSchema,
  illustrationSegmentSchema,
  imageJobResponseSchema,
  type GenerationStreamSnapshot
} from "../../packages/contracts/src/index.js";
import { installLegacyUiFixture, legacyUiFixture } from "./helpers/legacy-ui-fixtures.js";

const origin = `http://127.0.0.1:${process.env.PLAYWRIGHT_LEGACY_PORT ?? "43173"}`;
const storyDialogHeadings = [
  ["messagePopupDialog", "messagePopupTitle"],
  ["branchStoryDialog", "branchStoryTitle"],
  ["gettingStartedDialog", "gettingStartedTitle"],
  ["worldSetupDialog", "worldSetupTitle"],
  ["editCharacterProfileDialog", "editCharacterProfileTitle"],
  ["editStateDialog", "editStateTitle"],
  ["turnHistoryDialog", "turnHistoryTitle"],
  ["activityLogDialog", "activityLogTitle"],
  ["imagePromptDialog", "imagePromptDialogTitle"],
  ["editResponseDialog", "editResponseTitle"],
  ["retryPromptDialog", "retryPromptTitle"],
  ["userProfileDialog", "userProfileTitle"]
] as const;

async function prepareStoryPage(page: Page, campaignId: string): Promise<void> {
  const html = (await readFile("apps/web/public/story.html", "utf8"))
    .replace("/nexus/legacy-client.js", "/nexus/src/legacy-client-entry.ts");
  await page.route(`**/story/${campaignId}`, route => route.fulfill({ contentType: "text/html", body: html }));
}

async function openStory(page: Page, turnCount = 2) {
  const fixture = legacyUiFixture({ turnCount, worldCount: 1, campaignCount: 1 });
  await installLegacyUiFixture(page, fixture);
  await prepareStoryPage(page, fixture.campaignId);
  const characterProfile = campaignCharacterProfileViewSchema.parse({
    campaignId: fixture.campaignId,
    revision: 0,
    characterId: "fixture-observer",
    name: "The Observer",
    profile: {},
    storedProfile: null,
    inheritedFromSnapshot: true,
    legacyCharacterText: "",
    rpgStats: [],
    defaultTriggers: []
  });
  await page.route(`**/api/v1/campaigns/${fixture.campaignId}/character-profile`, route => route.fulfill({ json: characterProfile }));
  await page.goto(`${origin}/story/${fixture.campaignId}`);
  await expect(page.locator("#storySyncStatus")).toHaveText("Story synced");
  return fixture;
}

async function expectTabGroupState(tabList: Locator): Promise<void> {
  const state = await tabList.evaluate(root => {
    const tabs = [...root.querySelectorAll<HTMLElement>("[role='tab']")];
    return {
      selectedCount: tabs.filter(tab => tab.getAttribute("aria-selected") === "true").length,
      rovingTabIndexCount: tabs.filter(tab => tab.getAttribute("tabindex") === "0").length,
      relationshipsMatch: tabs.every(tab => {
        const panelId = tab.getAttribute("aria-controls");
        const panel = panelId ? document.getElementById(panelId) : null;
        return Boolean(panel && panel.getAttribute("aria-labelledby") === tab.id
          && panel.hidden === (tab.getAttribute("aria-selected") !== "true"));
      })
    };
  });
  expect(state).toEqual({ selectedCount: 1, rovingTabIndexCount: 1, relationshipsMatch: true });
}

test("every_open_dialog_has_accessible_name", async ({ page }) => {
  await openStory(page);

  const missingRelationships = await page.evaluate((pairs) => pairs.flatMap(([dialogId, titleId]) => {
    const dialog = document.getElementById(dialogId);
    const title = document.getElementById(titleId);
    const uniqueTitle = document.querySelectorAll(`[id="${titleId}"]`).length === 1;
    return !dialog || !title || !uniqueTitle || !dialog.contains(title) || dialog.getAttribute("aria-labelledby") !== titleId
      ? [dialogId]
      : [];
  }), storyDialogHeadings);
  const openedDialogs = [
    ["#btnOpenWorldSetup", "worldSetupDialog", "Current World Setup"],
    ["#btnOpenEditState", "editStateDialog", "Edit State"],
    ["#btnOpenEditCharacterProfile", "editCharacterProfileDialog", "Edit Character Profile"],
    ["#btnReaderHistory", "turnHistoryDialog", "Turn History & State"],
    ["#btnOpenActivityLog", "activityLogDialog", "Activity Log"],
    ["#btnOpenUserProfile", "userProfileDialog", "User Profile & Settings"]
  ] as const;
  const missingOpenNames: string[] = [];
  for (const [trigger, dialogId, accessibleName] of openedDialogs) {
    if (trigger === "#btnOpenActivityLog") {
      await page.locator(".nav-menu-trigger").filter({ hasText: "About" }).click();
      await page.locator(`#storyAboutMenu ${trigger}`).click();
    } else if (trigger === "#btnOpenUserProfile") {
      await page.locator(trigger).click();
    } else if (trigger.startsWith("#btnOpen")) {
      await page.locator(".nav-menu-trigger").filter({ hasText: "Setup" }).click();
      await page.locator(`#storySetupMenu ${trigger}`).click();
    } else {
      await page.locator(trigger).click();
    }
    const dialog = page.locator(`#${dialogId}`);
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAccessibleName(accessibleName);
    const labelledBy = await dialog.getAttribute("aria-labelledby");
    const actualName = labelledBy
      ? await page.locator(`#${labelledBy}`).textContent()
      : null;
    if (labelledBy) await expect(page.locator(`#${labelledBy}`)).toBeVisible();
    if (!actualName?.trim().includes(accessibleName)) missingOpenNames.push(dialogId);
    await page.locator(`#${dialogId} button`).first().click();
  }
  expect({ missingRelationships, missingOpenNames }).toEqual({ missingRelationships: [], missingOpenNames: [] });
});

test("tab_selected_and_panel_consistent", async ({ page }) => {
  await installLegacyUiFixture(page, legacyUiFixture({ turnCount: 0, worldCount: 1, campaignCount: 0 }));
  await page.goto(`${origin}/nexus/index.html#world-library`);
  await expect(page.locator("#managementInteractiveRoot")).not.toHaveAttribute("inert", "");
  await expect(page.locator("#newWorld")).toBeVisible();
  await page.locator("#newWorld").click();
  const tabs = page.locator("#worldAuthorSteps");
  await expectTabGroupState(tabs);
  await expect(tabs.getByRole("tab", { name: "Basics" })).toHaveAttribute("aria-selected", "true");
  await tabs.getByRole("tab", { name: "Lore" }).click();
  await expectTabGroupState(tabs);
  await expect(tabs.getByRole("tab", { name: "Lore" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#world-author-lore")).toBeVisible();
  await expect(page.locator("#world-author-overview")).toBeHidden();
  await page.locator("#worldAuthorNextStep").click();
  await expectTabGroupState(tabs);
  await expect(tabs.getByRole("tab", { name: "Playable character" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#world-author-mechanics")).toBeVisible();
  await page.locator("#cancelWorldAuthor").click();
  await expect(page.locator("#worldAuthorDialog")).toBeHidden();
  await page.locator("#newWorld").click();
  await expectTabGroupState(tabs);
  await expect(tabs.getByRole("tab", { name: "Basics" })).toHaveAttribute("aria-selected", "true");
});

test("arrows_home_end_scoped", async ({ page, context }) => {
  await installLegacyUiFixture(page, legacyUiFixture({ turnCount: 0, worldCount: 1, campaignCount: 0 }));
  await page.goto(`${origin}/nexus/index.html#world-library`);
  await expect(page.locator("#managementInteractiveRoot")).not.toHaveAttribute("inert", "");
  await expect(page.locator("#newWorld")).toBeVisible();
  await page.locator("#newWorld").click();
  const tabs = page.locator("#worldAuthorSteps");
  const basics = tabs.getByRole("tab", { name: "Basics" });
  const review = tabs.getByRole("tab", { name: "Review" });
  await basics.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(review).toBeFocused();
  await page.keyboard.press("Home");
  await expect(basics).toBeFocused();
  await page.keyboard.press("End");
  await expect(review).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(basics).toBeFocused();

  const storyPage = await context.newPage();
  await openStory(storyPage, 1);
  await storyPage.locator(".nav-menu-trigger").filter({ hasText: "Setup" }).click();
  await storyPage.locator("#storySetupMenu #btnOpenEditState").click();
  const stateTabs = storyPage.locator("#editStateDialog [role=tablist]");
  const overview = stateTabs.getByRole("tab", { name: "Current State" });
  const mechanics = stateTabs.getByRole("tab", { name: "Mechanics" });
  const trackers = stateTabs.getByRole("tab", { name: "Trackers" });
  await expectTabGroupState(stateTabs);
  await overview.focus();
  await storyPage.keyboard.press("End");
  await expect(mechanics).toBeFocused();
  await trackers.click();
  await expectTabGroupState(stateTabs);
  await storyPage.locator("#trackerName").fill("Relationship: Mira");
  await storyPage.locator("#trackerName").press("ArrowLeft");
  await expect(trackers).toHaveAttribute("aria-selected", "true");
  await expectTabGroupState(stateTabs);
  await overview.click();
  await storyPage.locator("#editStateContinuitySummary").fill("A local edit discarded during the reset check.");
  await mechanics.click();
  await expect(mechanics).toHaveAttribute("aria-selected", "true");
  await expectTabGroupState(stateTabs);
  await storyPage.locator("#btnCancelEditState").click();
  await storyPage.locator('#discardChangesDialog button[value="discard"]').click();
  await expect(storyPage.locator("#editStateDialog")).toBeHidden();
  await storyPage.locator(".nav-menu-trigger").filter({ hasText: "Setup" }).click();
  await storyPage.locator("#storySetupMenu #btnOpenEditState").click();
  await expect(storyPage.locator("#editStateDialog")).toBeVisible();
  await expectTabGroupState(stateTabs);
  await expect(overview).toHaveAttribute("aria-selected", "true");
});

test("escape_top_dialog_only", async ({ page }) => {
  await openStory(page, 1);
  await page.locator(".nav-menu-trigger").filter({ hasText: "Setup" }).click();
  await page.locator("#storySetupMenu #btnOpenEditState").click();
  await page.locator("#editStateContinuitySummary").fill("A deliberate unsaved continuity correction.");
  await page.locator("#btnCancelEditState").click();
  await expect(page.locator("#discardChangesDialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#discardChangesDialog")).toBeHidden();
  await expect(page.locator("#editStateDialog")).toBeVisible();
  await expect(page.locator("#editStateContinuitySummary")).toHaveValue("A deliberate unsaved continuity correction.");
});

test("focus_returns_to_trigger", async ({ page }, testInfo) => {
  const fixture = await openStory(page, 2);
  const historyTrigger = page.locator("#btnReaderHistory");
  await historyTrigger.click();
  const firstCard = page.locator("#turnHistoryModalList .history-card").first();
  await expect(firstCard).toBeVisible();
  const turnNumber = await firstCard.getAttribute("data-turn-number");
  await firstCard.focus();
  await page.keyboard.press("Enter");
  const currentCard = page.locator(`#turnHistoryModalList .history-card[data-turn-number="${turnNumber}"]`);
  await expect(currentCard).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath("history-keyboard-focus.png"), fullPage: true });
  await page.locator("#btnTurnHistoryDone").click();
  await expect(page.locator("#turnHistoryDialog")).toBeHidden();
  await expect(historyTrigger).toBeFocused();
  expect(fixture.turns).toHaveLength(2);
});

test("status_not_announced_each_chunk", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount: 1 });
  await installLegacyUiFixture(page, fixture);
  await page.addInitScript(() => {
    type Frame = GenerationStreamSnapshot;
    const sources: Array<{ onmessage: ((event: MessageEvent<string>) => void) | null; emit(frame: Frame): void }> = [];
    class FixtureEventSource {
      onmessage: ((event: MessageEvent<string>) => void) | null = null;
      constructor() { sources.push(this); }
      close() {}
      emit(frame: Frame) { this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(frame) })); }
    }
    Object.defineProperty(window, "EventSource", { configurable: true, value: FixtureEventSource });
    (window as Window & { __statusFixture?: { count(): number; emit(frame: Frame): void } }).__statusFixture = {
      count: () => sources.length,
      emit(frame) { sources.at(-1)?.emit(frame); }
    };
  });
  await page.route(`**/api/v1/campaigns/${fixture.campaignId}/generations`, route => route.fulfill({
    status: 202,
    contentType: "application/json",
    body: JSON.stringify({
      id: "55555555-5555-4555-8555-555555555555",
      status: "queued",
      duplicate: false,
      operationKind: "append",
      replacementTurnId: null
    })
  }));
  const html = (await readFile("apps/web/public/story.html", "utf8"))
    .replace("/nexus/legacy-client.js", "/nexus/src/legacy-client-entry.ts");
  await page.route(`**/story/${fixture.campaignId}`, route => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto(`${origin}/story/${fixture.campaignId}`);
  await expect(page.locator("#storySyncStatus")).toHaveText("Story synced");
  await page.locator("#freeAction").fill("Follow the quiet platform lights.");
  await page.locator("#btnTakeAction").click();
  await expect.poll(() => page.evaluate(() => (window as Window & { __statusFixture?: { count(): number } }).__statusFixture?.count() ?? 0)).toBe(1);

  const frameBase = {
    id: "55555555-5555-4555-8555-555555555555",
    campaignId: fixture.campaignId,
    expectedTurnNumber: 2,
    action: "Follow the quiet platform lights.",
    requestedInputMode: "action" as const,
    resolvedInputMode: "action" as const,
    inputModeSource: "explicit" as const,
    status: "generating" as const,
    attempts: 1,
    resultTurnId: null,
    errorCode: null,
    errorMessage: null,
    diagnostic: null,
    operationKind: "append" as const,
    replacementTurnId: null,
    createdAt: "2026-10-03T12:00:00.000Z",
    updatedAt: "2026-10-03T12:00:00.000Z"
  };
  const firstFrame = generationStreamSnapshotSchema.parse({ ...frameBase, partialNarration: "First complete snapshot." });
  await page.evaluate(frame => {
    (window as Window & { __statusFixture?: { emit(value: unknown): void } }).__statusFixture?.emit(frame);
  }, firstFrame);
  await expect(page.locator("#llmWaitIndicatorText")).toContainText("generating");
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.evaluate(() => {
    const targets = [document.querySelector("#generationProgress"), document.querySelector("#llmWaitIndicatorText")];
    const observed = targets.map(target => {
      if (!target) return null;
      let count = 0;
      const observer = new MutationObserver(records => { count += records.length; });
      observer.observe(target, { subtree: true, childList: true, characterData: true, attributes: true });
      return { observer, count: () => count };
    });
    (window as Window & { __statusObservers?: Array<{ observer: MutationObserver; count: () => number } | null> }).__statusObservers = observed;
  });
  const secondFrame = generationStreamSnapshotSchema.parse({ ...frameBase, partialNarration: "A later cumulative snapshot." });
  const finalFrame = generationStreamSnapshotSchema.parse({ ...frameBase, partialNarration: "The final cumulative snapshot." });
  await page.evaluate(frames => {
    const api = (window as Window & { __statusFixture?: { emit(value: unknown): void } }).__statusFixture;
    frames.forEach(frame => api?.emit(frame));
  }, [secondFrame, finalFrame]);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const repeatedStatusMutations = await page.evaluate(() => {
    const values = (window as Window & { __statusObservers?: Array<{ observer: MutationObserver; count: () => number } | null> }).__statusObservers;
    const counts = values?.map(value => value?.count() ?? -1) ?? [];
    values?.forEach(value => value?.observer.disconnect());
    return counts;
  });
  expect(repeatedStatusMutations).toEqual([0, 0]);
  const changedStage = generationStreamSnapshotSchema.parse({
    ...frameBase,
    status: "validating",
    partialNarration: "The next public stage is visible."
  });
  await page.evaluate(frame => {
    (window as Window & { __statusFixture?: { emit(value: unknown): void } }).__statusFixture?.emit(frame);
  }, changedStage);
  await expect(page.locator("#llmWaitIndicatorText")).toContainText("validating");
  await expect(page.locator("#generationProgress .turn-progress-detail")).toContainText("validating");
});

type T34ZoomFactor = 1 | 2;

type T34ReaderTheme = "dark" | "light" | "sepia";

const t34ReaderPreferences = { widthCh: 72, fontSizePx: 18, lineHeight: 1.7 } as const;

const t34IllustrationConfig = illustrationConfigResponseSchema.parse({
  enabled: true,
  sourcePolicy: "generate_only",
  matchingScope: "campaign",
  confidenceProfile: "balanced",
  repetitionWindow: 0,
  providerProfileId: null,
  model: "synthetic-image-model",
  size: "1024x1024",
  aspectRatio: "1:1",
  quality: "standard",
  outputFormat: "png",
  maxAttempts: 3,
  segmentWordCount: 120,
  imagesPerSegment: 1,
  segmentPromptMode: "direct",
  refinementPrompt: "Synthetic T34 illustration fixture.",
  defaultRefinementPrompt: "Synthetic T34 illustration fixture.",
  updatedAt: "2026-10-03T12:00:00.000Z"
});

type T34ChromeBridge = {
  tabs: {
    query(options: { active: boolean; lastFocusedWindow: boolean }): Promise<Array<{ id?: number; url?: string }>>;
    setZoomSettings(tabId: number, settings: { mode: "automatic"; scope: "per-tab" }): Promise<void>;
    setZoom(tabId: number, zoomFactor: number): Promise<void>;
    getZoom(tabId: number): Promise<number>;
  };
};

type T34ZoomRuntime = {
  context: BrowserContext;
  page: Page;
  worker: Worker;
  baseline: { innerWidth: number; outerWidth: number; devicePixelRatio: number };
  setZoomAfterNavigation(pathname: string, label: string, factor?: T34ZoomFactor, targetPage?: Page): Promise<Record<string, number | string>>;
};

async function assertT34OutputAncestry(allowedOutputRoot: string): Promise<string> {
  const lexicalOutputRoot = resolve(allowedOutputRoot);
  let lexicalCurrent = lexicalOutputRoot;
  while (true) {
    if ((await lstat(lexicalCurrent)).isSymbolicLink()) throw new Error(`Refusing to traverse a reparse path in T34 output ancestry: ${lexicalCurrent}`);
    const parent = dirname(lexicalCurrent);
    if (parent === lexicalCurrent) break;
    lexicalCurrent = parent;
  }
  return realpath(lexicalOutputRoot);
}

async function ensureT34RunRoot(allowedOutputRoot: string, runRoot: string): Promise<string> {
  const lexicalRoot = resolve(runRoot);
  const lexicalOutputRoot = resolve(allowedOutputRoot);
  const lexicalAllowedRelative = relative(lexicalOutputRoot, lexicalRoot);
  if (!lexicalAllowedRelative || lexicalAllowedRelative === ".." || lexicalAllowedRelative.startsWith(`..${sep}`) || isAbsolute(lexicalAllowedRelative)) {
    throw new Error(`Refusing a T34 run root outside its Playwright output directory: ${lexicalRoot}`);
  }
  let lexicalCurrent = lexicalRoot;
  while (true) {
    if ((await lstat(lexicalCurrent)).isSymbolicLink()) throw new Error(`Refusing to traverse a reparse path in T34 runtime: ${lexicalCurrent}`);
    const parent = dirname(lexicalCurrent);
    if (parent === lexicalCurrent) break;
    lexicalCurrent = parent;
  }
  const canonicalRoot = await realpath(lexicalRoot);
  const canonicalAllowedRoot = await assertT34OutputAncestry(lexicalOutputRoot);
  const canonicalRootRelative = relative(canonicalAllowedRoot, canonicalRoot);
  if (!canonicalRootRelative || canonicalRootRelative === ".." || canonicalRootRelative.startsWith(`..${sep}`) || isAbsolute(canonicalRootRelative)) {
    throw new Error(`Refusing a canonical T34 run root outside its Playwright output directory: ${canonicalRoot}`);
  }
  return canonicalRoot;
}

async function ensureOwnedOutputChild(allowedOutputRoot: string, runRoot: string, childPath: string): Promise<string> {
  const canonicalRoot = await ensureT34RunRoot(allowedOutputRoot, runRoot);
  const lexicalRoot = resolve(runRoot);
  const lexicalChild = resolve(childPath);
  const lexicalRelative = relative(lexicalRoot, lexicalChild);
  if (!lexicalRelative || lexicalRelative === ".." || lexicalRelative.startsWith(`..${sep}`) || isAbsolute(lexicalRelative)) {
    throw new Error(`Refusing to use a T34 runtime path outside its run root: ${lexicalChild}`);
  }
  let lexicalCurrent = lexicalChild;
  while (true) {
    if ((await lstat(lexicalCurrent)).isSymbolicLink()) throw new Error(`Refusing to traverse a reparse path in T34 runtime: ${lexicalCurrent}`);
    if (lexicalCurrent === lexicalRoot) break;
    const parent = dirname(lexicalCurrent);
    if (parent === lexicalCurrent) throw new Error(`T34 runtime path did not reach its run root: ${lexicalChild}`);
    lexicalCurrent = parent;
  }
  const canonicalChild = await realpath(childPath);
  const childRelative = relative(canonicalRoot, canonicalChild);
  if (!childRelative || childRelative === ".." || childRelative.startsWith(`..${sep}`) || isAbsolute(childRelative)) {
    throw new Error(`Refusing to use a T34 runtime path outside its run root: ${canonicalChild}`);
  }
  let current = canonicalChild;
  while (true) {
    if ((await lstat(current)).isSymbolicLink()) throw new Error(`Refusing to use a reparse path in T34 runtime: ${current}`);
    if (current === canonicalRoot) break;
    const parent = dirname(current);
    if (parent === current) throw new Error(`T34 runtime path did not reach its run root: ${canonicalChild}`);
    current = parent;
  }
  return canonicalChild;
}

async function removeOwnedOutputChild(allowedOutputRoot: string, runRoot: string, childPath: string, expectedCanonicalPath: string): Promise<void> {
  const canonicalChild = await ensureOwnedOutputChild(allowedOutputRoot, runRoot, childPath);
  if (canonicalChild !== expectedCanonicalPath) throw new Error(`T34 cleanup target changed after launch: ${canonicalChild}`);
  await rm(canonicalChild, { recursive: true, force: false });
}

async function withT34ZoomRuntime(
  testInfo: TestInfo,
  run: (runtime: T34ZoomRuntime) => Promise<void>
): Promise<void> {
  const allowedOutputRoot = resolve(testInfo.outputDir);
  const runRoot = resolve(testInfo.outputPath(`z-${randomUUID().replaceAll("-", "")}`));
  const profilePath = resolve(runRoot, "p");
  const extensionPath = resolve(runRoot, "e");
  await assertT34OutputAncestry(allowedOutputRoot);
  try {
    await lstat(runRoot);
    throw new Error(`Refusing to reuse an existing T34 runtime directory: ${runRoot}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(runRoot);
  await ensureT34RunRoot(allowedOutputRoot, runRoot);
  await mkdir(profilePath);
  await mkdir(extensionPath);
  const canonicalProfilePath = await ensureOwnedOutputChild(allowedOutputRoot, runRoot, profilePath);
  const canonicalExtensionPath = await ensureOwnedOutputChild(allowedOutputRoot, runRoot, extensionPath);
  await writeFile(testInfo.outputPath("t34-owned-runtime-paths.json"), JSON.stringify({
    profilePath: canonicalProfilePath,
    extensionPath: canonicalExtensionPath,
    runRoot: await realpath(runRoot)
  }, null, 2));
  await writeFile(resolve(extensionPath, "manifest.json"), JSON.stringify({
    manifest_version: 3,
    name: "InfiniteQuest T34 isolated zoom probe",
    version: "1.0.0",
    permissions: ["tabs"],
    background: { service_worker: "worker.js" }
  }, null, 2));
  await writeFile(resolve(extensionPath, "worker.js"), "chrome.runtime.onInstalled.addListener(() => {});\n");

  let context: BrowserContext | undefined;
  try {
    const persistentContextOptions = {
      channel: "chromium",
      headless: true,
      viewport: null,
      args: [
        "--window-size=1280,800",
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`
      ]
    };
    // Playwright test injects its deviceScaleFactor default only when this key is absent.
    if (!Reflect.set(persistentContextOptions, "deviceScaleFactor", undefined)) {
      throw new Error("Could not suppress the Playwright deviceScaleFactor default for the native-window zoom fixture.");
    }
    context = await chromium.launchPersistentContext(profilePath, persistentContextOptions);
    const page = context.pages()[0] ?? await context.newPage();
    const baseline = await page.evaluate(() => ({ innerWidth, outerWidth, devicePixelRatio }));
    const worker = context.serviceWorkers().find(serviceWorker => serviceWorker.url().startsWith("chrome-extension://"))
      ?? await context.waitForEvent("serviceworker");
    let zoomNavigationIndex = 0;
    const setZoomAfterNavigation = async (
      pathname: string,
      label: string,
      factor: T34ZoomFactor = 2,
      targetPage: Page = page
    ): Promise<Record<string, number | string>> => {
      await targetPage.bringToFront();
      const tabId = await worker.evaluate(async ({ expectedOrigin, expectedPath }) => {
        const extensionChrome = (globalThis as typeof globalThis & { chrome?: T34ChromeBridge }).chrome;
        if (!extensionChrome) throw new Error("The owned extension worker cannot access chrome.tabs.");
        const tabs = await extensionChrome.tabs.query({ active: true, lastFocusedWindow: true });
        const matches = tabs.filter(tab => {
          if (!tab.url) return false;
          const url = new URL(tab.url);
          return url.origin === expectedOrigin && url.pathname === expectedPath;
        });
        if (matches.length !== 1 || typeof matches[0]?.id !== "number") {
          throw new Error(`Expected one active owned tab at ${expectedPath}, found ${matches.length}.`);
        }
        return matches[0].id;
      }, { expectedOrigin: new URL(origin).origin, expectedPath: pathname });
      await worker.evaluate(async id => {
        const extensionChrome = (globalThis as typeof globalThis & { chrome?: T34ChromeBridge }).chrome;
        if (!extensionChrome) throw new Error("The owned extension worker cannot scope zoom settings.");
        await extensionChrome.tabs.setZoomSettings(id, { mode: "automatic", scope: "per-tab" });
      }, tabId);
      await worker.evaluate(async ({ id, zoomFactor }) => {
        const extensionChrome = (globalThis as typeof globalThis & { chrome?: T34ChromeBridge }).chrome;
        if (!extensionChrome) throw new Error("The owned extension worker cannot set tab zoom.");
        await extensionChrome.tabs.setZoom(id, zoomFactor);
      }, { id: tabId, zoomFactor: factor });
      await expect.poll(() => worker.evaluate(async id => {
        const extensionChrome = (globalThis as typeof globalThis & { chrome?: T34ChromeBridge }).chrome;
        if (!extensionChrome) throw new Error("The owned extension worker cannot read tab zoom.");
        return extensionChrome.tabs.getZoom(id);
      }, tabId)).toBe(factor);
      const metrics = await targetPage.evaluate(() => ({
        innerWidth,
        innerHeight,
        outerWidth,
        outerHeight,
        devicePixelRatio,
        visualViewportScale: visualViewport?.scale ?? -1,
        rootZoom: getComputedStyle(document.documentElement).zoom,
        userAgent: navigator.userAgent
      }));
      expect(metrics.outerWidth).toBe(baseline.outerWidth);
      expect(metrics.visualViewportScale).toBe(1);
      expect(metrics.rootZoom).toBe("1");
      if (factor === 2) {
        expect(metrics.innerWidth).toBeGreaterThan(baseline.innerWidth * 0.45);
        expect(metrics.innerWidth).toBeLessThan(baseline.innerWidth * 0.55);
        expect(metrics.devicePixelRatio / baseline.devicePixelRatio).toBeCloseTo(2, 1);
      }
      zoomNavigationIndex += 1;
      await writeFile(testInfo.outputPath(`t34-zoom-${zoomNavigationIndex}-${label}.json`), JSON.stringify({
        label,
        pathname,
        testFile: testInfo.file,
        testTitle: testInfo.title,
        browserVersion: context?.browser()?.version() ?? "unavailable",
        requestedZoom: factor,
        actualZoom: await worker.evaluate(async id => {
          const extensionChrome = (globalThis as typeof globalThis & { chrome?: T34ChromeBridge }).chrome;
          if (!extensionChrome) throw new Error("The owned extension worker cannot verify tab zoom.");
          return extensionChrome.tabs.getZoom(id);
        }, tabId),
        baseline,
        metrics
      }, null, 2));
      return metrics;
    };
    await run({ context, page, worker, baseline, setZoomAfterNavigation });
  } finally {
    try {
      await context?.close();
    } finally {
      await removeOwnedOutputChild(allowedOutputRoot, runRoot, profilePath, canonicalProfilePath);
      await removeOwnedOutputChild(allowedOutputRoot, runRoot, extensionPath, canonicalExtensionPath);
    }
  }
}

async function installT34StoryRoutes(page: Page, fixture: ReturnType<typeof legacyUiFixture>): Promise<void> {
  await installLegacyUiFixture(page, fixture);
  const characterProfile = campaignCharacterProfileViewSchema.parse({
    campaignId: fixture.campaignId,
    revision: 0,
    characterId: "fixture-observer",
    name: "The Observer",
    profile: {},
    storedProfile: null,
    inheritedFromSnapshot: true,
    legacyCharacterText: "",
    rpgStats: [],
    defaultTriggers: []
  });
  await page.route(`**/api/v1/campaigns/${fixture.campaignId}/character-profile`, route => route.fulfill({ json: characterProfile }));
  await installT34UserProfilePersistence(page, fixture);
  await prepareStoryPage(page, fixture.campaignId);
}

async function installT34UserProfilePersistence(page: Page, fixture: ReturnType<typeof legacyUiFixture>): Promise<void> {
  const user = fixture.session.user as Record<string, unknown>;
  let settings = { ...((user.settings ?? {}) as Record<string, unknown>) };
  await page.route("**/api/v1/users/me/profile", async route => {
    if (route.request().method() !== "PATCH") return route.fallback();
    const input = route.request().postDataJSON() as { settings?: Record<string, unknown> };
    settings = { ...settings, ...(input.settings ?? {}) };
    await route.fulfill({ json: { user: { ...user, settings } } });
  });
}

async function openT34Story(page: Page, fixture: ReturnType<typeof legacyUiFixture>): Promise<void> {
  await installT34StoryRoutes(page, fixture);
  await page.goto(`${origin}/story/${fixture.campaignId}`);
  await expect(page.locator("#storySyncStatus")).toHaveText("Story synced");
}

async function prepareT34ImageFailure(page: Page, fixture: ReturnType<typeof legacyUiFixture>): Promise<{ placeholderSegmentId: string; overlaySegmentId: string }> {
  const turn = fixture.turns.at(-1);
  if (!turn) throw new Error("The T34 optional-image contrast fixture needs one accepted turn.");
  const turnId = String(turn.id);
  const narration = String(turn.narration);
  const splitAt = narration.indexOf(" ", Math.floor(narration.length / 2));
  const splitOffset = splitAt < 0 ? Math.max(1, Math.floor(narration.length / 2)) : splitAt + 1;
  const ranges = [[0, splitOffset], [splitOffset, narration.length]] as const;
  const countWords = (value: string) => value.trim() ? value.trim().split(/\s+/u).length : 0;
  const segments = ranges.map(([startOffset, endOffset], ordinal) => {
    const text = narration.slice(startOffset, endOffset);
    const startWord = countWords(narration.slice(0, startOffset));
    const endWord = startWord + countWords(text);
    const variants = ordinal === 0 ? [] : [0, 1].map(variantIndex => ({
      assetId: `77777777-7777-4777-8777-77777777777${variantIndex + 1}`,
      url: "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=",
      variantIndex,
      prompt: "A quiet observatory beneath a winter sky.",
      providerType: "synthetic",
      model: "synthetic-image-model",
      createdAt: "2026-10-03T12:00:00.000Z",
      selectionReason: null,
      matchScore: null,
      matchThreshold: null,
      matchingAlgorithm: null
    }));
    return illustrationSegmentSchema.parse({
      setId: "66666666-6666-4666-8666-666666666661",
      turnId,
      setStatus: "partial",
      segmentWordCount: 120,
      imagesPerSegment: 1,
      promptMode: "direct",
      id: ordinal === 0 ? "66666666-6666-4666-8666-666666666662" : "66666666-6666-4666-8666-666666666663",
      ordinal,
      startOffset,
      endOffset,
      startWord,
      endWord,
      text,
      status: "failed",
      promptSource: "direct",
      directPrompt: "A quiet observatory beneath a winter sky.",
      resolvedPrompt: "A quiet observatory beneath a winter sky.",
      variants,
      imageJobId: ordinal === 0 ? "55555555-5555-4555-8555-555555555551" : "55555555-5555-4555-8555-555555555552",
      imageJobStatus: "failed",
      providerStatus: "unavailable",
      providerProgress: null,
      errorMessage: "Synthetic optional illustration unavailable.",
      promptJobStatus: null
    });
  });
  const failedJobs = segments.map((segment, ordinal) => imageJobResponseSchema.parse({
    id: ordinal === 0 ? "55555555-5555-4555-8555-555555555551" : "55555555-5555-4555-8555-555555555552",
    campaignId: fixture.campaignId,
    turnId,
    worldId: fixture.worldId,
    targetType: "turn_illustration",
    segmentId: segment.id,
    generationJobId: null,
    imageCount: 1,
    providerProfileId: null,
    model: "synthetic-image-model",
    status: "failed",
    attempts: 3,
    maxAttempts: 3,
    size: "1024x1024",
    aspectRatio: "1:1",
    quality: "standard",
    outputFormat: "png",
    assetId: null,
    assetUrl: "",
    providerType: "synthetic",
    generationRevision: 1,
    remoteJobId: null,
    providerStatus: "unavailable",
    providerProgress: null,
    providerQueuePosition: null,
    providerEtaAt: null,
    submittedAt: "2026-10-03T12:00:00.000Z",
    lastPolledAt: "2026-10-03T12:00:00.000Z",
    nextPollAt: null,
    generationDeadline: null,
    errorCode: "synthetic_image_failure",
    errorMessage: "Synthetic optional illustration unavailable.",
    createdAt: "2026-10-03T12:00:00.000Z",
    updatedAt: "2026-10-03T12:00:00.000Z",
    completedAt: null
  }));
  await page.route("**/api/v1/**", async route => {
    const path = new URL(route.request().url()).pathname;
    const campaignPrefix = `/api/v1/campaigns/${fixture.campaignId}/`;
    if (path === `${campaignPrefix}illustration-config`) return route.fulfill({ json: t34IllustrationConfig });
    if (path === `${campaignPrefix}illustration-segments`) return route.fulfill({ json: { segments } });
    if (path === `${campaignPrefix}image-jobs`) return route.fulfill({ json: { jobs: failedJobs } });
    return route.fallback();
  });
  return { placeholderSegmentId: segments[0]!.id, overlaySegmentId: segments[1]!.id };
}

async function chooseReaderTheme(page: Page, theme: T34ReaderTheme): Promise<void> {
  await page.locator("#btnOpenUserProfile").click();
  await expect(page.locator("#userProfileDialog")).toBeVisible();
  const appearance = page.locator("[data-reading-appearance]");
  if (!(await appearance.evaluate(element => (element as HTMLDetailsElement).open))) await appearance.locator("summary").click();
  await page.locator("select[data-reader-theme]").selectOption(theme);
  await page.locator("[data-reader-preview]").click();
  await page.locator("#btnSaveUserProfile").click();
  await expect(page.locator("#userProfileDialog")).toBeHidden();
  await expect(page.locator("#storyContainer")).toHaveAttribute("data-reader-theme", theme);
}

async function acknowledgeZeroTurnBackground(page: Page, fixture: ReturnType<typeof legacyUiFixture>): Promise<void> {
  const popup = page.locator("#messagePopupDialog");
  if (await popup.isVisible()) {
    await expect(page.locator("#messagePopupTitle")).toHaveText("Background Story");
    await expect(page.locator("#messagePopupBody")).toBeVisible();
    await page.locator("#btnMessagePopupClose").click();
    await expect(popup).toBeHidden();
  }
  expect(fixture.turns).toHaveLength(0);
  await expect(page.locator("#storyArea .empty")).toBeVisible();
}

async function focusByKeyboard(page: Page, selector: string, scopeSelector?: string): Promise<void> {
  for (let index = 0; index < 90; index += 1) {
    const state = await page.evaluate(({ targetSelector, scope }) => {
      const target = document.querySelector(targetSelector);
      const active = document.activeElement;
      return { reached: active === target, inScope: !scope || Boolean(active && document.querySelector(scope)?.contains(active)) };
    }, { targetSelector: selector, scope: scopeSelector });
    if (state.reached) return;
    if (scopeSelector && index > 0 && !state.inScope) throw new Error(`Keyboard focus left ${scopeSelector} before reaching ${selector}.`);
    await page.keyboard.press("Tab");
  }
  throw new Error(`Keyboard Tab did not reach ${selector}.`);
}

async function focusBackwardFrom(page: Page, startingSelector: string, targetSelector: string, scopeSelector: string): Promise<void> {
  await expect(page.locator(startingSelector)).toBeFocused();
  for (let index = 0; index < 30; index += 1) {
    await page.keyboard.press("Shift+Tab");
    const state = await page.evaluate(({ target, scope }) => {
      const active = document.activeElement;
      return {
        reached: active === document.querySelector(target),
        inScope: Boolean(active && document.querySelector(scope)?.contains(active)),
        activeId: active instanceof HTMLElement ? active.id : "",
        activeTag: active instanceof HTMLElement ? active.tagName : "unknown"
      };
    }, { target: targetSelector, scope: scopeSelector });
    if (state.reached) return;
    if (!state.inScope) {
      throw new Error(`Backward keyboard focus left ${scopeSelector} at ${state.activeTag.toLowerCase()}#${state.activeId} before reaching ${targetSelector}.`);
    }
  }
  throw new Error(`Keyboard Shift+Tab did not reach ${targetSelector} from ${startingSelector}.`);
}

async function expectFocusReachable(page: Page, selector: string): Promise<Record<string, number | boolean | string | string[]>> {
  const evidence = await page.evaluate(targetSelector => {
    const target = document.querySelector<HTMLElement>(targetSelector);
    if (!target) throw new Error(`Missing focus target ${targetSelector}.`);
    const rect = target.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    const modal = target.closest("dialog:modal");
    const overlays = [...document.querySelectorAll<HTMLElement>(".universal-nav, .story-reader-toolbar, .world-author-steps, .world-author-step-guidance")]
      .filter(overlay => overlay !== target && !overlay.contains(target))
      .filter(overlay => !modal || modal.contains(overlay))
      .filter(overlay => {
        const style = getComputedStyle(overlay);
        return style.display !== "none" && style.visibility !== "hidden" && ["sticky", "fixed"].includes(style.position);
      })
      .map(overlay => {
        const overlayRect = overlay.getBoundingClientRect();
        return x >= overlayRect.left && x <= overlayRect.right && y >= overlayRect.top && y <= overlayRect.bottom
          ? overlay.id || overlay.className.toString()
          : "";
      });
    const coveringOverlays = overlays.filter(Boolean);
    return {
      focused: document.activeElement === target,
      insideViewport: x >= 0 && x <= innerWidth && y >= 0 && y <= innerHeight,
      hitTarget: hit === target || Boolean(hit && target.contains(hit)),
      coveredByStickyOverlay: coveringOverlays.length > 0,
      modalId: modal?.id ?? "",
      coveringOverlayIds: coveringOverlays,
      hitId: hit instanceof HTMLElement ? hit.id : "",
      x,
      y,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight
    };
  }, selector);
  expect(evidence.focused).toBe(true);
  expect(evidence.insideViewport).toBe(true);
  expect(evidence.hitTarget).toBe(true);
  expect(evidence.coveredByStickyOverlay).toBe(false);
  return evidence;
}

async function measureTargetGroup(
  page: Page,
  selectors: readonly string[],
  spacingNeighborSelector?: string
): Promise<Array<Record<string, number | string | boolean>>> {
  const measured = await page.evaluate(({ targetSelectors, neighborSelector }) => targetSelectors.map(selector => {
    const target = document.querySelector<HTMLElement>(selector);
    if (!target) throw new Error(`Missing planned touch target ${selector}.`);
    const rect = target.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(centerX, centerY);
    const neighbors = neighborSelector
      ? [...document.querySelectorAll<HTMLElement>(neighborSelector)]
      : targetSelectors.flatMap(targetSelector => [...document.querySelectorAll<HTMLElement>(targetSelector)]);
    let nearestTargetGap = Number.POSITIVE_INFINITY;
    for (const neighbor of neighbors) {
      if (neighbor === target) continue;
      const neighborRect = neighbor.getBoundingClientRect();
      if (!neighborRect.width || !neighborRect.height || getComputedStyle(neighbor).visibility === "hidden") continue;
      const horizontalGap = Math.max(0, rect.left - neighborRect.right, neighborRect.left - rect.right);
      const verticalGap = Math.max(0, rect.top - neighborRect.bottom, neighborRect.top - rect.bottom);
      nearestTargetGap = Math.min(nearestTargetGap, Math.hypot(horizontalGap, verticalGap));
    }
    return {
      selector,
      width: rect.width,
      height: rect.height,
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      visible: Boolean(rect.width && rect.height && getComputedStyle(target).visibility !== "hidden"),
      hitTarget: hit === target || Boolean(hit && target.contains(hit)),
      comfort44: rect.width >= 44 && rect.height >= 44,
      minimum24: rect.width >= 24 && rect.height >= 24,
      nearestTargetGap
    };
  }), { targetSelectors: selectors, neighborSelector: spacingNeighborSelector ?? null });
  expect(measured.every(target => target.visible && target.hitTarget)).toBe(true);
  for (let leftIndex = 0; leftIndex < measured.length; leftIndex += 1) {
    const left = measured[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < measured.length; rightIndex += 1) {
      const right = measured[rightIndex]!;
      const overlapX = Math.min(left.right as number, right.right as number) - Math.max(left.left as number, right.left as number);
      const overlapY = Math.min(left.bottom as number, right.bottom as number) - Math.max(left.top as number, right.top as number);
      expect(overlapX <= 0 || overlapY <= 0, `${String(left.selector)} must not overlap ${String(right.selector)}`).toBe(true);
      const horizontalGap = Math.max(0, (left.left as number) - (right.right as number), (right.left as number) - (left.right as number));
      const verticalGap = Math.max(0, (left.top as number) - (right.bottom as number), (right.top as number) - (left.bottom as number));
      const gap = Math.hypot(horizontalGap, verticalGap);
      left.nearestTargetGap = Math.min(left.nearestTargetGap as number, gap);
      right.nearestTargetGap = Math.min(right.nearestTargetGap as number, gap);
    }
  }
  expect(measured.every(target => target.minimum24 === true || (Number.isFinite(target.nearestTargetGap) && (target.nearestTargetGap as number) >= 8)), "targets below 24 CSS px need at least 8 CSS px separation from another visible interactive target").toBe(true);
  return measured;
}

async function expectPageHasNoHorizontalOverflow(page: Page, label: string): Promise<Record<string, number>> {
  const size = await page.evaluate(() => ({
    documentClientWidth: document.documentElement.clientWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
    bodyClientWidth: document.body.clientWidth,
    bodyScrollWidth: document.body.scrollWidth
  }));
  expect(size.documentScrollWidth, `${label} document width`).toBeLessThanOrEqual(size.documentClientWidth);
  expect(size.bodyScrollWidth, `${label} body width`).toBeLessThanOrEqual(size.bodyClientWidth);
  return size;
}

function parseComputedForeground(value: string): [number, number, number, number] {
  const srgb = value.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)$/iu);
  if (srgb) return [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255, Number(srgb[4] ?? 1)];
  const rgb = value.match(/^rgba?\(([^)]+)\)$/iu);
  if (!rgb) throw new Error(`Unsupported computed foreground color: ${value}`);
  const channels = rgb[1]!.replace("/", " ").split(/[\s,]+/u).filter(Boolean).map(Number);
  if (channels.length < 3) throw new Error(`Incomplete computed foreground color: ${value}`);
  return [channels[0]!, channels[1]!, channels[2]!, channels[3] ?? 1];
}

function relativeLuminance(rgb: readonly number[]): number {
  const channels = rgb.map(value => {
    const srgb = value / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

async function measureCompositedTextContrast(
  page: Page,
  selector: string,
  theme: T34ReaderTheme
): Promise<Record<string, number | string | readonly number[]>> {
  const target = page.locator(selector);
  await target.scrollIntoViewIfNeeded();
  await expect(target).toBeVisible();
  const snapshot = () => target.evaluate(element => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return {
      text: element.textContent?.trim() ?? "",
      color: style.color,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      scroll: { x: window.scrollX, y: window.scrollY },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      inlineColor: (element as HTMLElement).style.getPropertyValue("color"),
      inlineColorPriority: (element as HTMLElement).style.getPropertyPriority("color"),
      inlineShadow: (element as HTMLElement).style.getPropertyValue("text-shadow"),
      inlineShadowPriority: (element as HTMLElement).style.getPropertyPriority("text-shadow")
    };
  });
  const geometry = (value: Awaited<ReturnType<typeof snapshot>>) => ({ rect: value.rect, scroll: value.scroll, viewport: value.viewport });
  const sameGeometry = (left: Awaited<ReturnType<typeof snapshot>>, right: Awaited<ReturnType<typeof snapshot>>) =>
    JSON.stringify(geometry(left)) === JSON.stringify(geometry(right));
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const before = await snapshot();
  expect(before.text.length, `${theme} ${selector} rendered text`).toBeGreaterThan(0);
  let normalImage: Buffer | undefined;
  let backgroundImage: Buffer | undefined;
  let stableBefore: Awaited<ReturnType<typeof snapshot>> | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const captureBefore = await snapshot();
      if (attempt === 0 && !sameGeometry(before, captureBefore)) throw new Error("T34_CAPTURE_DRIFT");
      const clip = { x: captureBefore.rect.x, y: captureBefore.rect.y, width: captureBefore.rect.width, height: captureBefore.rect.height };
      const normal = await page.screenshot({ clip, scale: "css" });
      if (!sameGeometry(captureBefore, await snapshot())) throw new Error("T34_CAPTURE_DRIFT");
      await target.evaluate(element => {
        const htmlElement = element as HTMLElement;
        htmlElement.style.setProperty("color", "transparent", "important");
        htmlElement.style.setProperty("text-shadow", "none", "important");
      });
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const hiddenText = await snapshot();
      if (!sameGeometry(captureBefore, hiddenText)) throw new Error("T34_CAPTURE_DRIFT");
      let background: Buffer;
      try {
        background = await page.screenshot({ clip, scale: "css" });
        if (!sameGeometry(captureBefore, await snapshot())) throw new Error("T34_CAPTURE_DRIFT");
      } finally {
        await target.evaluate((element, style) => {
          const htmlElement = element as HTMLElement;
          if (style.color) htmlElement.style.setProperty("color", style.color, style.colorPriority);
          else htmlElement.style.removeProperty("color");
          if (style.shadow) htmlElement.style.setProperty("text-shadow", style.shadow, style.shadowPriority);
          else htmlElement.style.removeProperty("text-shadow");
        }, { color: before.inlineColor, colorPriority: before.inlineColorPriority, shadow: before.inlineShadow, shadowPriority: before.inlineShadowPriority });
      }
      normalImage = normal;
      backgroundImage = background;
      stableBefore = captureBefore;
      break;
    } catch (error) {
      await target.evaluate((element, style) => {
        const htmlElement = element as HTMLElement;
        if (style.color) htmlElement.style.setProperty("color", style.color, style.colorPriority);
        else htmlElement.style.removeProperty("color");
        if (style.shadow) htmlElement.style.setProperty("text-shadow", style.shadow, style.shadowPriority);
        else htmlElement.style.removeProperty("text-shadow");
      }, { color: before.inlineColor, colorPriority: before.inlineColorPriority, shadow: before.inlineShadow, shadowPriority: before.inlineShadowPriority });
      if (!(error instanceof Error) || error.message !== "T34_CAPTURE_DRIFT" || attempt > 0) throw error;
      await target.scrollIntoViewIfNeeded();
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    }
  }
  expect(normalImage, `${theme} ${selector} stable foreground capture`).toBeDefined();
  expect(backgroundImage, `${theme} ${selector} stable background capture`).toBeDefined();
  expect(stableBefore, `${theme} ${selector} stable capture geometry`).toBeDefined();
  const [normal, background] = await Promise.all([
    sharp(normalImage!).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(backgroundImage!).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  ]);
  expect({ width: normal.info.width, height: normal.info.height }).toEqual({ width: background.info.width, height: background.info.height });
  const foreground = parseComputedForeground(before.color);
  const sampled: Array<{ x: number; y: number; background: readonly number[]; contrast: number }> = [];
  let firstGlyphSample: { x: number; y: number; background: readonly number[]; contrast: number } | undefined;
  let minimumSample: { x: number; y: number; background: readonly number[]; contrast: number } | undefined;
  let changedPixels = 0;
  const pixelCount = normal.info.width * normal.info.height;
  let minimumContrast = Number.POSITIVE_INFINITY;
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const offset = pixel * normal.info.channels;
    const normalRgb = [normal.data[offset]!, normal.data[offset + 1]!, normal.data[offset + 2]!];
    const backgroundRgb = [background.data[offset]!, background.data[offset + 1]!, background.data[offset + 2]!];
    if (Math.max(...normalRgb.map((channel, index) => Math.abs(channel - backgroundRgb[index]!))) < 3) continue;
    changedPixels += 1;
    const composited = foreground.slice(0, 3).map((channel, index) => channel * foreground[3] + backgroundRgb[index]! * (1 - foreground[3]));
    const foregroundLuminance = relativeLuminance(composited);
    const backgroundLuminance = relativeLuminance(backgroundRgb);
    const contrast = (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
      / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
    minimumContrast = Math.min(minimumContrast, contrast);
    const evidence = { x: pixel % normal.info.width, y: Math.floor(pixel / normal.info.width), background: backgroundRgb, contrast };
    firstGlyphSample ??= evidence;
    if (!minimumSample || contrast < minimumSample.contrast) minimumSample = evidence;
    if (sampled.length < 96 && pixel % Math.max(1, Math.floor(pixelCount / 96)) === 0) {
      sampled.push(evidence);
    }
  }
  expect(changedPixels, `${theme} ${selector} must produce identifiable rendered glyph pixels`).toBeGreaterThan(0);
  expect(firstGlyphSample, `${theme} ${selector} must retain a changed glyph sample`).toBeDefined();
  expect(minimumSample, `${theme} ${selector} must retain its minimum-contrast glyph sample`).toBeDefined();
  const evidenceSamples = new Map<string, { x: number; y: number; background: readonly number[]; contrast: number }>();
  for (const sample of [firstGlyphSample, ...sampled, minimumSample]) {
    if (sample) evidenceSamples.set(`${sample.x},${sample.y}`, sample);
  }
  const after = await snapshot();
  expect(after.color).toBe(before.color);
  expect(after.text).toBe(before.text);
  expect(geometry(after)).toEqual(geometry(stableBefore!));
  return {
    selector,
    theme,
    foreground: before.color,
    foregroundAlpha: foreground[3],
    targetRect: [stableBefore!.rect.x, stableBefore!.rect.y, stableBefore!.rect.width, stableBefore!.rect.height],
    changedGlyphPixels: changedPixels,
    sampledBackgrounds: evidenceSamples.size,
    minimumContrast: Number(minimumContrast.toFixed(3)),
    samples: [...evidenceSamples.values()].flatMap(sample => [sample.x, sample.y, ...sample.background, Number(sample.contrast.toFixed(3))])
  };
}

test("reduced_motion_no_smooth_scroll", async ({}, testInfo) => {
  await withT34ZoomRuntime(testInfo, async ({ page, context, setZoomAfterNavigation }) => {
    const fixture = legacyUiFixture({ turnCount: 2, worldCount: 4, campaignCount: 4 });
    await installT34StoryRoutes(page, fixture);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.addInitScript(() => {
      const records: Array<{ method: string; behavior: string }> = [];
      const wrap = (object: object, key: string, method: "scrollIntoView" | "scrollTo" | "scrollBy") => {
        const target = object as Record<string, unknown>;
        const original = target[key];
        if (typeof original !== "function") return;
        target[key] = function (this: unknown, ...args: unknown[]) {
          const options = args[0];
          const behavior = typeof options === "object" && options !== null && "behavior" in options
            ? String((options as { behavior?: unknown }).behavior)
            : "default";
          records.push({ method, behavior });
          return Reflect.apply(original, this, args);
        };
      };
      wrap(Element.prototype, "scrollIntoView", "scrollIntoView");
      wrap(Element.prototype, "scrollTo", "scrollTo");
      wrap(Element.prototype, "scrollBy", "scrollBy");
      wrap(window, "scrollTo", "scrollTo");
      (window as Window & { __t34ScrollCalls?: typeof records }).__t34ScrollCalls = records;
    });
    await page.goto(`${origin}/story/${fixture.campaignId}`);
    await expect(page.locator("#storySyncStatus")).toHaveText("Story synced");
    await setZoomAfterNavigation(`/story/${fixture.campaignId}`, "reduced-motion-story");
    await page.locator("#btnPrev").click();
    await expect(page.locator("#readerTurnCount")).toContainText("1");
    await page.locator("#btnNext").click();
    await expect(page.locator("#readerTurnCount")).toContainText("2");
    const storyScroll = await page.evaluate(() => ({
      calls: (window as Window & { __t34ScrollCalls?: Array<{ method: string; behavior: string }> }).__t34ScrollCalls ?? [],
      documentBehavior: getComputedStyle(document.documentElement).scrollBehavior,
      bodyBehavior: getComputedStyle(document.body).scrollBehavior
    }));
    await writeFile(testInfo.outputPath("t34-reduced-motion-evidence.json"), JSON.stringify({ story: storyScroll }, null, 2));
    await page.screenshot({ path: testInfo.outputPath("t34-reduced-motion-story.png"), fullPage: false });

    await page.goto(`${origin}/nexus/index.html#dashboard`);
    await expect(page.locator("#managementInteractiveRoot")).not.toHaveAttribute("inert", "");
    await setZoomAfterNavigation("/nexus/index.html", "reduced-motion-nexus");
    const worlds = page.locator("#dashboardWorlds");
    await expect(worlds.locator("[data-world-id]")).toHaveCount(4);
    const beforeScrollLeft = await worlds.evaluate(element => element.scrollLeft);
    await page.locator("#worldCarouselNext").click();
    await expect.poll(() => worlds.evaluate(element => element.scrollLeft)).toBeGreaterThan(beforeScrollLeft);
    const nexusScroll = await page.evaluate(() => ({
      calls: (window as Window & { __t34ScrollCalls?: Array<{ method: string; behavior: string }> }).__t34ScrollCalls ?? [],
      carouselBehavior: getComputedStyle(document.querySelector("#dashboardWorlds")!).scrollBehavior
    }));
    expect(nexusScroll.calls.some(call => call.method === "scrollBy")).toBe(true);
    await writeFile(testInfo.outputPath("t34-reduced-motion-evidence.json"), JSON.stringify({ story: storyScroll, nexus: nexusScroll }, null, 2));
    expect(storyScroll.calls.filter(call => call.behavior === "smooth")).toEqual([]);
    expect(["auto", "instant"]).toContain(storyScroll.documentBehavior);
    expect(["auto", "instant"]).toContain(storyScroll.bodyBehavior);
    expect(nexusScroll.calls.filter(call => call.method === "scrollBy" && call.behavior === "smooth")).toEqual([]);
    expect(["auto", "instant"]).toContain(nexusScroll.carouselBehavior);
    await page.screenshot({ path: testInfo.outputPath("t34-reduced-motion-nexus.png"), fullPage: false });
  });
});

test("focus_not_hidden_by_sticky_toolbar", async ({}, testInfo) => {
  await withT34ZoomRuntime(testInfo, async ({ page, context, setZoomAfterNavigation }) => {
    const fixture = legacyUiFixture({ turnCount: 2, worldCount: 2, campaignCount: 1 });
    await installT34StoryRoutes(page, fixture);
    await page.goto(`${origin}/story/${fixture.campaignId}`);
    await expect(page.locator("#storySyncStatus")).toHaveText("Story synced");
    const desktopStoryZoom = await setZoomAfterNavigation(`/story/${fixture.campaignId}`, "focus-story-desktop", 1);
    await focusByKeyboard(page, "#btnReaderHistory");
    const desktopHistoryFocus = await expectFocusReachable(page, "#btnReaderHistory");
    await page.screenshot({ path: testInfo.outputPath("t34-focus-story-desktop.png"), fullPage: false });
    const zoom = await setZoomAfterNavigation(`/story/${fixture.campaignId}`, "focus-story-200");
    await focusByKeyboard(page, "#btnReaderHistory");
    const historyFocus = await expectFocusReachable(page, "#btnReaderHistory");
    await page.screenshot({ path: testInfo.outputPath("t34-focus-story-200.png"), fullPage: false });

    await page.goto(`${origin}/nexus/index.html#world-library`);
    await expect(page.locator("#managementInteractiveRoot")).not.toHaveAttribute("inert", "");
    const desktopNexusZoom = await setZoomAfterNavigation("/nexus/index.html", "focus-nexus-desktop", 1);
    await focusByKeyboard(page, "#navSetup");
    const desktopSetupFocus = await expectFocusReachable(page, "#navSetup");
    await page.screenshot({ path: testInfo.outputPath("t34-focus-nexus-desktop.png"), fullPage: false });
    await setZoomAfterNavigation("/nexus/index.html", "focus-nexus-200");
    await focusByKeyboard(page, "#navSetup");
    const setupFocus = await expectFocusReachable(page, "#navSetup");
    await page.screenshot({ path: testInfo.outputPath("t34-focus-nexus-200.png"), fullPage: false });
    await page.locator("#newWorld").click();
    await expect(page.locator("#worldAuthorDialog")).toBeVisible();
    await focusBackwardFrom(page, "#worldTitle", "#worldAuthorTabBasics", "#worldAuthorDialog");
    const authorTabFocus = await expectFocusReachable(page, "#worldAuthorTabBasics");
    await page.screenshot({ path: testInfo.outputPath("t34-focus-world-author-tab-200.png"), fullPage: false });
    await page.locator("#cancelWorldAuthor").click();
    await expect(page.locator("#worldAuthorDialog")).toBeHidden();

    const narrowPage = await context.newPage();
    await narrowPage.setViewportSize({ width: 390, height: 844 });
    await installT34StoryRoutes(narrowPage, fixture);
    await narrowPage.goto(`${origin}/story/${fixture.campaignId}`);
    await expect(narrowPage.locator("#storySyncStatus")).toHaveText("Story synced");
    const narrowZoom = await setZoomAfterNavigation(`/story/${fixture.campaignId}`, "focus-story-390", 1, narrowPage);
    expect(narrowZoom.innerWidth).toBe(390);
    await focusByKeyboard(narrowPage, "#btnReaderHistory");
    const narrowHistoryFocus = await expectFocusReachable(narrowPage, "#btnReaderHistory");
    await narrowPage.screenshot({ path: testInfo.outputPath("t34-focus-story-390.png"), fullPage: false });
    await writeFile(testInfo.outputPath("t34-focus-geometry.json"), JSON.stringify({
      desktopStoryZoom,
      desktopNexusZoom,
      desktopHistoryFocus,
      desktopSetupFocus,
      zoom,
      historyFocus,
      setupFocus,
      authorTabFocus,
      narrowZoom,
      narrowHistoryFocus
    }, null, 2));
  });
});

test("controls_no_overlap_at_zoom", async ({}, testInfo) => {
  await withT34ZoomRuntime(testInfo, async ({ page, setZoomAfterNavigation }) => {
    const fixture = legacyUiFixture({ turnCount: 2, worldCount: 2, campaignCount: 1 });
    await installT34StoryRoutes(page, fixture);
    await page.route("**/api/v1/**", async route => {
      const path = new URL(route.request().url()).pathname;
      const prefix = `/api/v1/campaigns/${fixture.campaignId}/`;
      if (path === `${prefix}illustration-config`) return route.fulfill({ json: t34IllustrationConfig });
      if (path === `${prefix}illustration-segments`) return route.fulfill({ json: { segments: [] } });
      if (path === `${prefix}image-jobs`) return route.fulfill({ json: { jobs: [] } });
      return route.fallback();
    });
    await page.goto(`${origin}/story/${fixture.campaignId}`);
    await expect(page.locator("#storySyncStatus")).toHaveText("Story synced");
    await setZoomAfterNavigation(`/story/${fixture.campaignId}`, "controls-story-200");
    await page.locator("#freeAction").fill("A brief test action for clearing.");
    await expect(page.locator("#btnClearTurnInput")).toBeVisible();
    const storyTargets = ["#btnPrev", "#btnNext", "#btnReaderHistory", "#btnOpenUserProfile"] as const;
    const storyRects = await measureTargetGroup(page, storyTargets, "#storyContainer button:not([disabled])");
    await page.locator("#btnClearTurnInput").scrollIntoViewIfNeeded();
    const clearGeometry = await measureTargetGroup(page, ["#btnClearTurnInput"], "#storyContainer button:not([disabled])");
    expect(clearGeometry[0]?.width).toBeGreaterThanOrEqual(44);
    expect(clearGeometry[0]?.height).toBeGreaterThanOrEqual(44);
    storyRects.push(...clearGeometry);
    await expect(page.locator("#storyIllustrationPanel [data-action='refresh-illustrations']")).toBeVisible();
    await page.locator("#storyIllustrationPanel [data-action='refresh-illustrations']").scrollIntoViewIfNeeded();
    const refreshGeometry = await measureTargetGroup(
      page,
      ["#storyIllustrationPanel [data-action='refresh-illustrations']"],
      "#storyIllustrationPanel button:not([disabled])"
    );
    expect(refreshGeometry[0]?.height).toBeGreaterThanOrEqual(44);
    storyRects.push(...refreshGeometry);
    await page.screenshot({ path: testInfo.outputPath("t34-controls-story-200.png"), fullPage: false });
    await page.locator("#btnReaderHistory").click();
    await expect(page.locator("#turnHistoryDialog")).toBeVisible();
    await page.locator("#btnTurnHistoryDone").click();
    await expect(page.locator("#turnHistoryDialog")).toBeHidden();
    await page.locator("#btnOpenUserProfile").click();
    await expect(page.locator("#userProfileDialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#userProfileDialog")).toBeHidden();

    await page.goto(`${origin}/nexus/index.html#dashboard`);
    await expect(page.locator("#managementInteractiveRoot")).not.toHaveAttribute("inert", "");
    await setZoomAfterNavigation("/nexus/index.html", "controls-nexus-200");
    const nexusRects = await measureTargetGroup(page, ["#navSetup", "#openNexusUserProfile"], "#managementInteractiveRoot button:not([disabled])");
    await page.locator("#navSetup").click();
    await expect(page.locator("#nexusSetupMenu")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.locator("#openNexusUserProfile").click();
    await expect(page.locator("#nexusUserProfileDialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#nexusUserProfileDialog")).toBeHidden();
    await page.screenshot({ path: testInfo.outputPath("t34-controls-nexus-200.png"), fullPage: false });
    const shortfallList = [...storyRects, ...nexusRects].filter(target => target.comfort44 !== true);
    await writeFile(testInfo.outputPath("t34-target-geometry.json"), JSON.stringify({
      targetGroups: { story: storyRects, nexus: nexusRects },
      below44ComfortGoal: shortfallList,
      thresholdNote: "44 CSS px is recorded as a comfort goal; every measured target must be at least 24 by 24 CSS px or separated from another measured target by at least 8 CSS px."
    }, null, 2));
  });
});

test("narrow_page_no_horizontal_overflow", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = legacyUiFixture({ turnCount: 2, worldCount: 5, campaignCount: 5 });
  await installT34StoryRoutes(page, fixture);
  await page.goto(`${origin}/nexus/index.html#world-library`);
  await expect(page.locator("#managementInteractiveRoot")).not.toHaveAttribute("inert", "");
  const nexusWidth = await expectPageHasNoHorizontalOverflow(page, "Nexus 390x844");
  const worldRail = page.locator("#worldManagementCarousel");
  await expect(worldRail.locator("[data-world-id]")).toHaveCount(5);
  const railDimensions = await worldRail.evaluate(element => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
  expect(railDimensions.scrollWidth).toBeGreaterThan(railDimensions.clientWidth);
  const cards = worldRail.locator("[data-world-id]");
  await focusByKeyboard(page, "#worldManagementCarousel [data-world-id]:first-child");
  await expect(cards.first()).toBeFocused();
  await expect(cards.first()).toBeInViewport();
  for (let index = 1; index < 5; index += 1) {
    await page.keyboard.press("Tab");
    await expect(cards.nth(index)).toBeFocused();
  }
  await expect.poll(() => worldRail.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
  await expect(cards.last()).toBeInViewport();
  await expectPageHasNoHorizontalOverflow(page, "Nexus 390x844 after rail navigation");
  await page.screenshot({ path: testInfo.outputPath("t34-narrow-nexus-world-rail.png"), fullPage: false });

  await page.goto(`${origin}/story/${fixture.campaignId}`);
  await expect(page.locator("#storySyncStatus")).toHaveText("Story synced");
  const storyWidth = await expectPageHasNoHorizontalOverflow(page, "Story 390x844");
  await expect(page.locator("#btnReaderHistory")).toBeVisible();
  await expect(page.locator("#btnNext")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("t34-narrow-story.png"), fullPage: false });
  await writeFile(testInfo.outputPath("t34-narrow-geometry.json"), JSON.stringify({ viewport: { width: 390, height: 844 }, nexusWidth, railDimensions, storyWidth }, null, 2));
});

test("dialog_actions_reachable", async ({}, testInfo) => {
  await withT34ZoomRuntime(testInfo, async ({ page, context, worker, baseline, setZoomAfterNavigation }) => {
    const fixture = legacyUiFixture({ turnCount: 2, worldCount: 2, campaignCount: 1 });
    await installT34StoryRoutes(page, fixture);
    await page.goto(`${origin}/story/${fixture.campaignId}`);
    await expect(page.locator("#storySyncStatus")).toHaveText("Story synced");
    await setZoomAfterNavigation(`/story/${fixture.campaignId}`, "dialog-history-200");
    const historyTrigger = page.locator("#btnReaderHistory");
    await historyTrigger.click();
    await expect(page.locator("#turnHistoryDialog")).toBeVisible();
    await focusByKeyboard(page, "#btnTurnHistoryDone", "#turnHistoryDialog");
    const historyDone = await expectFocusReachable(page, "#btnTurnHistoryDone");
    await page.screenshot({ path: testInfo.outputPath("t34-dialog-history-done-200.png"), fullPage: false });
    await page.keyboard.press("Enter");
    await expect(page.locator("#turnHistoryDialog")).toBeHidden();
    await expect(historyTrigger).toBeFocused();

    await page.goto(`${origin}/nexus/index.html#world-library`);
    await expect(page.locator("#managementInteractiveRoot")).not.toHaveAttribute("inert", "");
    await setZoomAfterNavigation("/nexus/index.html", "dialog-world-author-200");
    await page.locator("#newWorld").click();
    await expect(page.locator("#worldAuthorDialog")).toBeVisible();
    await focusByKeyboard(page, "#cancelWorldAuthor", "#worldAuthorDialog");
    const worldAuthorCancel = await expectFocusReachable(page, "#cancelWorldAuthor");
    await page.screenshot({ path: testInfo.outputPath("t34-dialog-world-author-cancel-200.png"), fullPage: false });
    await page.keyboard.press("Enter");
    await expect(page.locator("#worldAuthorDialog")).toBeHidden();

    const narrowPage = await context.newPage();
    await narrowPage.setViewportSize({ width: 390, height: 844 });
    await installT34StoryRoutes(narrowPage, fixture);
    await narrowPage.goto(`${origin}/story/${fixture.campaignId}`);
    await expect(narrowPage.locator("#storySyncStatus")).toHaveText("Story synced");
    await narrowPage.bringToFront();
    const narrowTabId = await worker.evaluate(async expectedPath => {
      const extensionChrome = (globalThis as typeof globalThis & { chrome?: T34ChromeBridge }).chrome;
      if (!extensionChrome) throw new Error("The owned extension worker cannot inspect the narrow tab.");
      const tabs = await extensionChrome.tabs.query({ active: true, lastFocusedWindow: true });
      const matches = tabs.filter(tab => tab.url && new URL(tab.url).origin === new URL(expectedPath.origin).origin && new URL(tab.url).pathname === expectedPath.pathname);
      if (matches.length !== 1 || typeof matches[0]?.id !== "number") throw new Error("Could not identify the single narrow T34 Story tab.");
      return matches[0].id;
    }, { origin: new URL(origin).origin, pathname: `/story/${fixture.campaignId}` });
    await worker.evaluate(async id => {
      const extensionChrome = (globalThis as typeof globalThis & { chrome?: T34ChromeBridge }).chrome;
      if (!extensionChrome) throw new Error("The owned extension worker cannot set narrow zoom.");
      await extensionChrome.tabs.setZoomSettings(id, { mode: "automatic", scope: "per-tab" });
      await extensionChrome.tabs.setZoom(id, 1);
    }, narrowTabId);
    await expect.poll(() => worker.evaluate(async id => {
      const extensionChrome = (globalThis as typeof globalThis & { chrome?: T34ChromeBridge }).chrome;
      if (!extensionChrome) throw new Error("The owned extension worker cannot verify narrow zoom.");
      return extensionChrome.tabs.getZoom(id);
    }, narrowTabId)).toBe(1);
    await expect.poll(() => narrowPage.evaluate(() => innerWidth)).toBe(390);
    await narrowPage.locator("#btnReaderHistory").click();
    await expect(narrowPage.locator("#turnHistoryDialog")).toBeVisible();
    await focusByKeyboard(narrowPage, "#btnTurnHistoryDone", "#turnHistoryDialog");
    const narrowHistoryDone = await expectFocusReachable(narrowPage, "#btnTurnHistoryDone");
    await narrowPage.screenshot({ path: testInfo.outputPath("t34-dialog-history-done-390.png"), fullPage: false });
    await narrowPage.keyboard.press("Enter");
    await expect(narrowPage.locator("#turnHistoryDialog")).toBeHidden();
    await writeFile(testInfo.outputPath("t34-dialog-geometry.json"), JSON.stringify({ historyDone, worldAuthorCancel, narrowHistoryDone, zoomBaseline: baseline }, null, 2));
  });
});

async function assertSegmentImageRowsDoNotOverlap(page: Page, segmentId: string): Promise<Record<string, unknown>> {
  const result = await page.locator(`#storyArea .segment-illustration-content[data-segment-id="${segmentId}"]`).evaluate(root => {
    const rect = (element: Element | null) => {
      if (!element) return null;
      const bounds = element.getBoundingClientRect();
      return { x: bounds.x, y: bounds.y, right: bounds.right, bottom: bounds.bottom, width: bounds.width, height: bounds.height };
    };
    const footer = root.querySelector<HTMLElement>(".segment-image-footer");
    const status = footer?.querySelector(".image-job-status p") ?? null;
    const metadata = footer?.querySelector(".segment-illustration-meta") ?? null;
    const carousel = footer?.querySelector(".illustration-carousel") ?? null;
    const controls = root.querySelector(".segment-image-controls");
    const rows = { status: rect(status), metadata: rect(metadata), carousel: rect(carousel), controls: rect(controls) };
    const intersects = (left: typeof rows.status, right: typeof rows.status) => Boolean(left && right
      && Math.min(left.right, right.right) > Math.max(left.x, right.x)
      && Math.min(left.bottom, right.bottom) > Math.max(left.y, right.y));
    return {
      rows,
      visible: { status: Boolean(status && getComputedStyle(status).visibility !== "hidden"), metadata: Boolean(metadata), carousel: Boolean(carousel), controls: Boolean(controls) },
      overlaps: {
        statusMetadata: intersects(rows.status, rows.metadata),
        statusCarousel: intersects(rows.status, rows.carousel),
        metadataCarousel: intersects(rows.metadata, rows.carousel),
        statusControls: intersects(rows.status, rows.controls)
      }
    };
  });
  expect(result.visible).toEqual({ status: true, metadata: true, carousel: true, controls: true });
  expect(result.overlaps).toEqual({ statusMetadata: false, statusCarousel: false, metadataCarousel: false, statusControls: false });
  return result;
}

test("zero_turn_and_optional_image_theme_contrast", async ({ page, context }, testInfo) => {
  const zeroFixture = await openStory(page, 0);
  await acknowledgeZeroTurnBackground(page, zeroFixture);
  await installT34UserProfilePersistence(page, zeroFixture);
  const samples: Array<Record<string, number | string | readonly number[]>> = [];
  for (const theme of ["dark", "light", "sepia"] as const) {
    await chooseReaderTheme(page, theme);
    for (const selector of [
      "#storyArea .empty .story-empty-title",
      "#storyArea .empty .story-empty-character:first-of-type",
      "#storyArea .empty .story-empty-guidance"
    ] as const) {
      samples.push(await measureCompositedTextContrast(page, selector, theme));
      await writeFile(testInfo.outputPath("t34-composited-theme-contrast.json"), JSON.stringify(samples, null, 2));
    }
    await page.screenshot({ path: testInfo.outputPath(`t34-zero-turn-${theme}.png`), fullPage: false });
  }

  const imagePage = await context.newPage();
  const imageFixture = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount: 1 });
  await installT34StoryRoutes(imagePage, imageFixture);
  const imageTargets = await prepareT34ImageFailure(imagePage, imageFixture);
  await imagePage.goto(`${origin}/story/${imageFixture.campaignId}`);
  await expect(imagePage.locator("#storySyncStatus")).toHaveText("Story synced");
  await expect(imagePage.locator("#storyIllustrationPanel")).toBeVisible();
  await expect(imagePage.locator("#storyIllustrationContent .image-placeholder").first()).toBeVisible();
  await expect(imagePage.locator("#storyIllustrationContent .image-job-status p").first()).toBeVisible();
  const placeholderSelector = `#storyArea .segment-illustration-content[data-segment-id="${imageTargets.placeholderSegmentId}"] .image-placeholder`;
  const statusSelector = `#storyArea .segment-illustration-content[data-segment-id="${imageTargets.overlaySegmentId}"] .image-job-status p`;
  const regenerateSelector = `#storyArea .segment-illustration-content[data-segment-id="${imageTargets.overlaySegmentId}"] [data-action="regenerate-segment-image"]`;
  let rowGeometry: Record<string, unknown> | undefined;
  let imageControl: Array<Record<string, number | string | boolean>> | undefined;
  for (const theme of ["dark", "light", "sepia"] as const) {
    await chooseReaderTheme(imagePage, theme);
    await expect(imagePage.locator(`#storyArea .segment-illustration-content[data-segment-id="${imageTargets.overlaySegmentId}"] .segment-image-footer`)).toBeVisible();
    await expect(imagePage.locator(statusSelector)).toBeVisible();
    if (!rowGeometry) {
      rowGeometry = await assertSegmentImageRowsDoNotOverlap(imagePage, imageTargets.overlaySegmentId);
      await imagePage.locator(regenerateSelector).scrollIntoViewIfNeeded();
      imageControl = await measureTargetGroup(imagePage, [regenerateSelector], `#storyArea .segment-illustration-content[data-segment-id="${imageTargets.overlaySegmentId}"] button:not([disabled])`);
      expect(imageControl[0]?.width).toBeGreaterThanOrEqual(44);
      expect(imageControl[0]?.height).toBeGreaterThanOrEqual(44);
    }
    for (const selector of [placeholderSelector, statusSelector] as const) {
      samples.push(await measureCompositedTextContrast(imagePage, selector, theme));
      await writeFile(testInfo.outputPath("t34-composited-theme-contrast.json"), JSON.stringify(samples, null, 2));
    }
    if (theme === "dark") await writeFile(testInfo.outputPath("t34-segment-footer-geometry.json"), JSON.stringify({ rowGeometry, imageControl }, null, 2));
    await imagePage.screenshot({ path: testInfo.outputPath(`t34-optional-image-${theme}.png`), fullPage: false });
  }
  expect(samples).toHaveLength(15);
  for (const sample of samples) {
    expect(sample.minimumContrast, `${String(sample.theme)} ${String(sample.selector)} composited contrast`).toBeGreaterThanOrEqual(4.5);
  }
});
