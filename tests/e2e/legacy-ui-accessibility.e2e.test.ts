import { expect, test, type Locator, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { campaignCharacterProfileViewSchema, generationStreamSnapshotSchema, type GenerationStreamSnapshot } from "../../packages/contracts/src/index.js";
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
