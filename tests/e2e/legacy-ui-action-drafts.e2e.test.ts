import { expect, test, type Page, type Route } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import { quietLeafApiPayloads } from "../fixtures/quiet-leaf-payloads.js";
import { generationJobSnapshotSchema, generationResultSchema } from "../../packages/contracts/src/index.js";

const origin = `http://127.0.0.1:${process.env.PLAYWRIGHT_LEGACY_PORT ?? "43173"}`;
const campaignId = "11111111-1111-4111-8111-111111111111";
const userId = "66666666-6666-4666-8666-666666666666";
const otherUserId = "77777777-7777-4777-8777-777777777777";
const jobId = "55555555-5555-4555-8555-555555555555";
const resultTurnId = "88888888-8888-4888-8888-888888888888";
const timestamp = "2026-10-03T12:00:00.000Z";
const databaseName = "infiniteQuest-reader-local-v1";
const storeName = "actionDrafts";
const screenshotDirectory = ".superpowers/sdd/legacy-ui-2026-10-03/evidence/screenshots/T08";

interface HarnessOptions {
  readonly ownerId?: string;
  readonly campaign?: string;
  readonly pending?: boolean;
  readonly failed?: boolean;
  readonly holdCompletion?: boolean;
  readonly storageFailure?: "unavailable" | "quota";
}

interface Harness {
  readonly payloads: ReturnType<typeof quietLeafApiPayloads>;
  readonly writes: Array<{ path: string; body: Record<string, unknown> }>;
  readonly errors: string[];
  readonly releaseCompletion: () => void;
}

async function installHarness(page: Page, options: HarnessOptions = {}): Promise<Harness> {
  const payloads = quietLeafApiPayloads({ turnControlStyle: "flexible_action" });
  const writes: Harness["writes"] = [];
  const errors: string[] = [];
  let releaseCompletion!: () => void;
  const completionReleased = new Promise<void>(resolve => { releaseCompletion = resolve; });
  if (options.storageFailure === "unavailable") {
    await page.addInitScript(() => Object.defineProperty(window, "indexedDB", { configurable: true, value: undefined }));
  } else if (options.storageFailure === "quota") {
    await page.addInitScript(() => {
      const originalPut = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) {
        if (this.name === "actionDrafts") throw new DOMException("Storage quota exceeded", "QuotaExceededError");
        return originalPut.apply(this, args);
      };
    });
  }
  await page.addInitScript(() => Object.defineProperty(window, "EventSource", { configurable: true, value: undefined }));
  await page.route("**/vendor/photoswipe/photoswipe.css", route => route.fulfill({ status: 200, contentType: "text/css", body: "" }));
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.route("**/api/v1/**", async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const respond = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (request.method() === "GET" && path === "/api/v1/session") {
      return respond({ ...payloads.session, user: { ...payloads.session.user, id: options.ownerId ?? userId } });
    }
    if (request.method() === "GET" && path === "/api/v1/meta") return respond({ application: { name: "Infinite Quest Nexus", version: "test", commit: null, builtAt: null }, capabilities: { systemArchive: false } });
    if (request.method() === "GET" && path === "/api/v1/providers") return respond({ providers: [{ id: "99999999-9999-4999-8999-999999999999", name: "Synthetic text", providerType: "openai_compatible", providerRole: "text", enabled: true, isDefault: true }] });
    if (request.method() === "GET" && path === "/api/v1/campaigns") return respond(payloads.campaigns);
    if (request.method() === "GET" && path === "/api/v1/worlds") return respond(payloads.worlds);
    if (request.method() === "GET" && path === `/api/v1/campaigns/${options.campaign ?? campaignId}/sync-status`) {
      return respond({
        ...payloads.syncStatus,
        campaign: { ...payloads.syncStatus.campaign, id: options.campaign ?? campaignId },
        activeTurnNumber: payloads.syncStatus.activeTurnNumber,
        pendingGeneration: options.pending ? {
          id: jobId, status: "generating", action: "Authoritative pending action.", expectedTurnNumber: 2,
          createdAt: timestamp, updatedAt: timestamp, operationKind: "append", replacementTurnId: null
        } : null,
        generationRecovery: options.failed ? {
          id: jobId, status: "failed", operationKind: "append", replacementTurnId: null,
          expectedTurnNumber: 2, attempts: 1, errorCode: "generation_failed", errorMessage: "Generation failed.",
          diagnostic: null, resultTurnId: null, review: null
        } : null
      });
    }
    if (request.method() === "GET" && path === `/api/v1/campaigns/${options.campaign ?? campaignId}/turns`) return respond(payloads.turns);
    if (request.method() === "GET" && (path === `/api/v1/campaigns/${options.campaign ?? campaignId}/state` || path === `/api/v1/campaigns/${options.campaign ?? campaignId}/state/inspection`)) return respond(payloads.runtimeState);
    if (request.method() === "GET" && path === `/api/v1/campaigns/${options.campaign ?? campaignId}/story-memory`) return respond({ level: "off", reviewMode: "off", availableLevels: ["off"] });
    if (request.method() === "GET" && path === `/api/v1/campaigns/${options.campaign ?? campaignId}/character-profile`) return respond({ campaignId: options.campaign ?? campaignId, revision: 1, name: "", profile: {}, storedProfile: null, inheritedFromSnapshot: false, legacyCharacterText: "", rpgStats: [], defaultTriggers: [] });
    if (request.method() === "GET" && path === `/api/v1/campaigns/${options.campaign ?? campaignId}/illustration-config`) return respond(payloads.illustrationConfig);
    if (request.method() === "GET" && path === `/api/v1/campaigns/${options.campaign ?? campaignId}/illustration-segments`) return respond(payloads.illustrationSegments);
    if (request.method() === "GET" && path === `/api/v1/campaigns/${options.campaign ?? campaignId}/image-jobs`) return respond({ jobs: [] });
    if (request.method() === "POST" && path === `/api/v1/campaigns/${options.campaign ?? campaignId}/generations`) {
      writes.push({ path, body: request.postDataJSON() as Record<string, unknown> });
      return respond({ id: jobId, status: "queued", duplicate: false, operationKind: "append", replacementTurnId: null }, 202);
    }
    if (request.method() === "GET" && path === `/api/v1/generation-jobs/${jobId}/stream`) {
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: "" });
    }
    if (request.method() === "GET" && path === `/api/v1/generation-jobs/${jobId}`) {
      if (options.holdCompletion) await completionReleased;
      return respond(generationJobSnapshotSchema.parse({
        id: jobId, campaignId: options.campaign ?? campaignId, expectedTurnNumber: 2, action: "A submitted action.",
        requestedInputMode: "action", resolvedInputMode: "action", inputModeSource: "explicit", operationKind: "append",
        replacementTurnId: null, attempts: 1, resultTurnId, errorCode: null, errorMessage: null,
        createdAt: timestamp, updatedAt: timestamp, partialNarration: null, status: "completed"
      }));
    }
    if (request.method() === "GET" && path === `/api/v1/generation-jobs/${jobId}/result`) return respond(generationResultSchema.parse({
      id: jobId, campaignId: options.campaign ?? campaignId, expectedTurnNumber: 2, action: "A submitted action.",
      requestedInputMode: "action", resolvedInputMode: "action", inputModeSource: "explicit", operationKind: "append",
      replacementTurnId: null, attempts: 1, resultTurnId, errorCode: null, errorMessage: null,
      createdAt: timestamp, updatedAt: timestamp, status: "completed", turnNumber: 2, inputMode: "action",
      narration: "Accepted synthetic narration.", choices: [], customActionSuggestion: "", imagePrompt: "", imageUrl: null,
      acceptedAt: timestamp, chronicleRetrieval: null, modelMetadata: null, mechanics: null, stateSnapshot: {}, reportedCost: null
    }));
    if (request.method() === "POST") writes.push({ path, body: {} });
    return respond({});
  });
  const html = (await readFile("apps/web/public/story.html", "utf8")).replace("/nexus/legacy-client.js", "/nexus/src/legacy-client-entry.ts");
  await page.route(`**/story/${options.campaign ?? campaignId}`, route => route.fulfill({ contentType: "text/html", body: html }));
  return { payloads, writes, errors, releaseCompletion };
}

async function gotoStory(page: Page, harness: Harness, campaign = campaignId) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${origin}/story/${campaign}`);
  await expect(page.locator("#freeAction")).toBeVisible();
}

async function seedDraft(page: Page, draft: { text: string; inputMode?: "action" | "scene"; baseTurnId?: string | null; baseTurnNumber?: number }, scope = { userId, campaignId }) {
  await page.goto(`${origin}/nexus/`);
  await page.evaluate(async ({ scope, draft }) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("infiniteQuest-reader-local-v1", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("actionDrafts", { keyPath: "storageKey" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("actionDrafts", "readwrite");
      transaction.objectStore("actionDrafts").put({
        storageKey: `draft:${scope.userId}:${scope.campaignId}`,
        value: JSON.stringify({ schemaVersion: 1, ...scope, draft: {
          schemaVersion: 1, draftRevision: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", text: draft.text,
          inputMode: draft.inputMode ?? "action", baseTurnId: draft.baseTurnId === undefined ? "44444444-4444-4444-8444-444444444444" : draft.baseTurnId,
          baseTurnNumber: draft.baseTurnNumber ?? 1, updatedAt: "2026-10-03T12:00:00.000Z"
        } })
      });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  }, { scope, draft });
}

async function readDraft(page: Page, scope = { userId, campaignId }) {
  return page.evaluate(async ({ scope, databaseName, storeName }) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(storeName, { keyPath: "storageKey" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const value = await new Promise<unknown>((resolve, reject) => {
      const transaction = database.transaction(storeName, "readonly");
      const request = transaction.objectStore(storeName).get(`draft:${scope.userId}:${scope.campaignId}`);
      request.onsuccess = () => resolve(request.result?.value ? JSON.parse(request.result.value).draft : null);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return value;
  }, { scope, databaseName, storeName });
}

test("reload_restores_unsent_text_without_submit", async ({ page }) => {
  const harness = await installHarness(page);
  await gotoStory(page, harness);
  await expect(page.locator("#storySyncStatus")).toHaveText("Story synced");
  await expect(page.locator("#autosaveStatus")).toHaveText("No draft");
  await page.locator("[data-turn-input-mode='scene']").check();
  await page.locator("#freeAction").fill("Find the hidden station.");
  await expect(page.locator("#autosaveStatus")).toHaveText("Draft saved");
  await page.reload();
  await expect(page.locator("#freeAction")).toHaveValue("Find the hidden station.");
  await expect(page.locator("[data-turn-input-mode='scene']")).toBeChecked();
  await expect(page.locator("#storySyncStatus")).toHaveText("Story synced");
  await mkdir(screenshotDirectory, { recursive: true });
  await page.screenshot({ path: `${screenshotDirectory}/action-draft-1440x900.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${screenshotDirectory}/action-draft-390x844.png`, fullPage: true });
  expect(harness.writes).toEqual([]);
  expect(harness.errors).toEqual([]);
});

test("failed_storage_never_reports_saved_and_does_not_block_submission", async ({ page, context }) => {
  const harness = await installHarness(page, { storageFailure: "quota" });
  await gotoStory(page, harness);
  await page.locator("#freeAction").fill("Keep this if storage lets me.");
  await expect(page.locator("#autosaveStatus")).toHaveText("Draft not saved");
  await page.locator("#btnTakeAction").click();
  await expect(page.getByText("Accepted synthetic narration.", { exact: true })).toBeVisible();
  await expect.poll(() => harness.writes.length).toBe(1);
  expect(harness.writes[0]?.body.action).toBe("Keep this if storage lets me.");
  await expect(page.locator("#freeAction")).toHaveValue("Keep this if storage lets me.");
  await expect(page.locator("#autosaveStatus")).toHaveText("Draft not saved");
  await page.locator("#btnNexusDashboard").click();
  await expect(page.locator("#actionDraftNavigationDialog")).toBeVisible();
  await page.locator("#actionDraftNavigationDialog button[value='stay']").click();
  await expect(page).toHaveURL(new RegExp(`/story/${campaignId}$`));
  await page.locator("#btnNexusDashboard").click();
  await page.locator("#actionDraftNavigationDialog button[value='discard']").click();
  await expect(page).toHaveURL(`${origin}/nexus/`);

  const unavailablePage = await context.newPage();
  const unavailable = await installHarness(unavailablePage, { storageFailure: "unavailable", campaign: "99999999-9999-4999-8999-999999999997" });
  await gotoStory(unavailablePage, unavailable, "99999999-9999-4999-8999-999999999997");
  await unavailablePage.locator("#freeAction").fill("Keep this without IndexedDB.");
  await expect(unavailablePage.locator("#autosaveStatus")).toHaveText("Draft not saved");
  await unavailablePage.locator("#btnTakeAction").click();
  await expect(unavailablePage.getByText("Accepted synthetic narration.", { exact: true })).toBeVisible();
  await expect.poll(() => unavailable.writes.length).toBe(1);
  expect(unavailable.writes[0]?.body.action).toBe("Keep this without IndexedDB.");
  await expect(unavailablePage.locator("#freeAction")).toHaveValue("Keep this without IndexedDB.");
  expect(unavailable.errors).toEqual([]);
});

test("campaign_and_user_switch_do_not_leak", async ({ page, context }) => {
  const first = await installHarness(page);
  await gotoStory(page, first);
  await page.locator("#freeAction").fill("Private campaign note.");
  await expect(page.locator("#autosaveStatus")).toHaveText("Draft saved");
  const otherCampaignPage = await context.newPage();
  const otherCampaign = await installHarness(otherCampaignPage, { campaign: "99999999-9999-4999-8999-999999999998" });
  await gotoStory(otherCampaignPage, otherCampaign, "99999999-9999-4999-8999-999999999998");
  await expect(otherCampaignPage.locator("#freeAction")).toHaveValue("");
  const otherUserPage = await context.newPage();
  const otherUser = await installHarness(otherUserPage, { ownerId: otherUserId });
  await gotoStory(otherUserPage, otherUser);
  await expect(otherUserPage.locator("#freeAction")).toHaveValue("");
  expect(first.writes).toEqual([]);
});

test("pending_recovery_wins_over_old_local_draft", async ({ page }) => {
  const harness = await installHarness(page, { pending: true, holdCompletion: true });
  await seedDraft(page, { text: "Old local action." });
  await gotoStory(page, harness);
  await expect(page.locator("#freeAction")).toHaveValue("");
  expect(harness.writes).toEqual([]);
  harness.releaseCompletion();
});

test("acceptance_clears_matching_not_newer_draft", async ({ page }) => {
  const harness = await installHarness(page);
  await gotoStory(page, harness);
  await page.locator("#freeAction").fill("A submitted action.");
  await expect(page.locator("#autosaveStatus")).toHaveText("Draft saved");
  await page.locator("#btnTakeAction").click();
  await expect(page.getByText("Accepted synthetic narration.", { exact: true })).toBeVisible();
  await expect.poll(() => readDraft(page)).toBeNull();
  expect(harness.writes).toHaveLength(1);
});

test("retyped_same_text_new_revision_survives_acceptance", async ({ page }) => {
  const harness = await installHarness(page, { holdCompletion: true });
  await gotoStory(page, harness);
  await page.locator("#freeAction").fill("A submitted action.");
  await expect(page.locator("#autosaveStatus")).toHaveText("Draft saved");
  const submitted = await readDraft(page) as { draftRevision: string };
  await page.locator("#btnTakeAction").click();
  await expect.poll(() => harness.writes.length).toBe(1);
  const secondPage = await page.context().newPage();
  const second = await installHarness(secondPage);
  await gotoStory(secondPage, second);
  await expect(secondPage.locator("#freeAction")).toHaveValue("A submitted action.");
  await secondPage.locator("#freeAction").fill("");
  await secondPage.locator("#freeAction").fill("A submitted action.");
  await expect(secondPage.locator("#autosaveStatus")).toHaveText("Draft saved");
  const newer = await readDraft(secondPage) as { draftRevision: string };
  expect(newer.draftRevision).not.toBe(submitted.draftRevision);
  harness.releaseCompletion();
  await expect(page.getByText("Accepted synthetic narration.", { exact: true })).toBeVisible();
  await expect.poll(() => readDraft(secondPage)).toMatchObject({ text: "A submitted action.", draftRevision: newer.draftRevision });
  await expect(page.locator("#actionDraftConflict")).toBeVisible();
});

test("second_tab_edits_survive_first_tab_acceptance", async ({ page, context }) => {
  const first = await installHarness(page, { holdCompletion: true });
  await gotoStory(page, first);
  await page.locator("#freeAction").fill("The first tab action.");
  await expect(page.locator("#autosaveStatus")).toHaveText("Draft saved");
  const submitted = await readDraft(page) as { draftRevision: string };
  await page.locator("#btnTakeAction").click();
  await expect.poll(() => first.writes.length).toBe(1);
  const secondPage = await context.newPage();
  const second = await installHarness(secondPage);
  await gotoStory(secondPage, second);
  await expect(secondPage.locator("#freeAction")).toHaveValue("The first tab action.");
  await secondPage.locator("#freeAction").fill("A newer action in another tab.");
  await expect(secondPage.locator("#autosaveStatus")).toHaveText("Draft saved");
  const newer = await readDraft(secondPage) as { draftRevision: string };
  expect(newer.draftRevision).not.toBe(submitted.draftRevision);
  first.releaseCompletion();
  await expect(page.getByText("Accepted synthetic narration.", { exact: true })).toBeVisible();
  await expect.poll(() => readDraft(secondPage)).toMatchObject({ text: "A newer action in another tab.", draftRevision: newer.draftRevision });
  await expect(page.locator("#actionDraftConflict")).toBeVisible();
  await page.locator("#restoreActionDraft").click();
  await expect(page.locator("#freeAction")).toHaveValue("A newer action in another tab.");
});

test("newer_draft_survives_recovery_reconciliation", async ({ page }) => {
  const harness = await installHarness(page, { failed: true });
  await seedDraft(page, { text: "Stale saved action." });
  await gotoStory(page, harness);
  const laterTab = await page.context().newPage();
  const ordinary = await installHarness(laterTab);
  await gotoStory(laterTab, ordinary);
  await expect(laterTab.locator("#freeAction")).toHaveValue("Stale saved action.");
  await laterTab.locator("#freeAction").fill("Fresh local action.");
  await expect(laterTab.locator("#autosaveStatus")).toHaveText("Draft saved");
  await expect.poll(() => readDraft(laterTab)).toMatchObject({ text: "Fresh local action." });
  await expect(page.locator("#freeAction")).toHaveValue("");
  expect(harness.writes).toEqual([]);
});

test("app_navigation_awaits_transaction_commit", async ({ page }) => {
  const harness = await installHarness(page);
  await gotoStory(page, harness);
  await page.locator("#freeAction").fill("Save before leaving.");
  await page.locator("#btnNexusDashboard").click();
  await expect(page).toHaveURL(`${origin}/nexus/`);
  await expect.poll(() => readDraft(page)).toMatchObject({ text: "Save before leaving." });
});

test("browser_close_warns_without_claiming_async_completion", async ({ page }) => {
  const harness = await installHarness(page);
  await gotoStory(page, harness);
  await page.locator("#freeAction").fill("Still waiting for its first save.");
  const state = await page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    const accepted = window.dispatchEvent(event);
    return { accepted, prevented: event.defaultPrevented, status: document.getElementById("autosaveStatus")?.textContent };
  });
  expect(state.prevented).toBe(true);
  expect(state.status).not.toBe("Draft saved");
  await expect(page.locator("#autosaveStatus")).toHaveText("Draft saved");
  expect(harness.writes).toEqual([]);
});

test("changed_base_requires_restore_choice", async ({ page }) => {
  const harness = await installHarness(page);
  await seedDraft(page, { text: "Action from the earlier turn.", baseTurnId: null, baseTurnNumber: 0 });
  await gotoStory(page, harness);
  await expect(page.locator("#freeAction")).toHaveValue("");
  await expect(page.locator("#actionDraftConflict")).toBeVisible();
  await page.locator("#restoreActionDraft").click();
  await expect(page.locator("#freeAction")).toHaveValue("Action from the earlier turn.");
});

test("explicit_clear_removes_local_draft", async ({ page }) => {
  const harness = await installHarness(page);
  await gotoStory(page, harness);
  await page.locator("#freeAction").fill("Remove this local action.");
  await expect(page.locator("#autosaveStatus")).toHaveText("Draft saved");
  await page.locator("#btnClearTurnInput").click();
  await expect(page.locator("#autosaveStatus")).toHaveText("No draft");
  await expect.poll(() => readDraft(page)).toBeNull();
  expect(harness.writes).toEqual([]);
});
