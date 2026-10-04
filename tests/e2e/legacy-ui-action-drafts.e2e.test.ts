import { expect, test, type Page, type Route } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import { quietLeafApiPayloads } from "../fixtures/quiet-leaf-payloads.js";
import { campaignSyncStatusSchema, generationJobSnapshotSchema, generationResultSchema } from "../../packages/contracts/src/index.js";

const origin = `http://127.0.0.1:${process.env.PLAYWRIGHT_LEGACY_PORT ?? "43173"}`;
const campaignId = "11111111-1111-4111-8111-111111111111";
const userId = "66666666-6666-4666-8666-666666666666";
const otherUserId = "77777777-7777-4777-8777-777777777777";
const jobId = "55555555-5555-4555-8555-555555555555";
const activeJobId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const replacementJobId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const resultTurnId = "88888888-8888-4888-8888-888888888888";
const replacementResultTurnId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const timestamp = "2026-10-03T12:00:00.000Z";
const databaseName = "infiniteQuest-reader-local-v1";
const storeName = "actionDrafts";
const screenshotDirectory = ".superpowers/sdd/legacy-ui-2026-10-03/evidence/screenshots/T08";
const fix1EvidenceDirectory = ".superpowers/sdd/legacy-ui-2026-10-03/evidence/T08-fix1";

interface HarnessOptions {
  readonly ownerId?: string;
  readonly campaign?: string;
  readonly pending?: boolean;
  readonly opening?: boolean;
  readonly pendingAction?: string;
  readonly failed?: boolean;
  readonly appendOutcome?: "failed" | "completed";
  readonly activeConflict?: boolean;
  readonly holdCompletion?: boolean;
  readonly holdDraftTransactions?: boolean;
  readonly storageFailure?: "unavailable" | "quota";
}

interface Harness {
  readonly payloads: ReturnType<typeof quietLeafApiPayloads>;
  readonly writes: Array<{ path: string; body: Record<string, unknown> }>;
  readonly syncSnapshots: unknown[];
  readonly jobSnapshots: unknown[];
  readonly resultSnapshots: unknown[];
  readonly errors: string[];
  readonly releaseCompletion: () => void;
}

declare global {
  interface Window {
    __actionDraftTestGate?: {
      arm(): void;
      waitUntilHeld(): Promise<void>;
      release(): void;
    };
  }
}

async function armDraftTransactionGate(page: Page) {
  await page.evaluate(() => window.__actionDraftTestGate?.arm());
}

async function waitForDraftTransactionGate(page: Page) {
  await page.evaluate(() => window.__actionDraftTestGate?.waitUntilHeld());
}

async function releaseDraftTransactionGate(page: Page) {
  await page.evaluate(() => window.__actionDraftTestGate?.release());
}

async function installHarness(page: Page, options: HarnessOptions = {}): Promise<Harness> {
  const fixturePayloads = quietLeafApiPayloads({ turnControlStyle: "flexible_action" });
  const acceptedTurnTemplate = fixturePayloads.turns.turns.at(-1)!;
  const payloads: Harness["payloads"] = options.opening ? {
    ...fixturePayloads,
    campaigns: {
      ...fixturePayloads.campaigns,
      campaigns: fixturePayloads.campaigns.campaigns.map(campaign => ({ ...campaign, activeTurnNumber: 0 }))
    },
    syncStatus: {
      ...fixturePayloads.syncStatus,
      activeTurnNumber: 0,
      campaign: { ...fixturePayloads.syncStatus.campaign, activeTurnNumber: 0 },
      turns: { ...fixturePayloads.syncStatus.turns, nextCursor: null, turns: [] }
    },
    turns: { ...fixturePayloads.turns, nextCursor: null, turns: [] }
  } as Harness["payloads"] : fixturePayloads;
  const syncTurns = payloads.syncStatus.turns ?? { nextCursor: null, turns: [] };
  const writes: Harness["writes"] = [];
  const syncSnapshots: Harness["syncSnapshots"] = [];
  const jobSnapshots: Harness["jobSnapshots"] = [];
  const resultSnapshots: Harness["resultSnapshots"] = [];
  const errors: string[] = [];
  let openingJobStarted = false;
  let replacementJobStarted = false;
  let activeConflictReturned = false;
  let appendFailed = false;
  let ordinaryAppend: { action: string; campaignId: string; expectedTurnNumber: number; idempotencyKey: string } | null = null;
  let acceptedGeneration: { id: string; expectedTurnNumber: number; resultTurnId: string; action: string; operationKind: "append" | "replace_latest" } | null = null;
  let releaseCompletion!: () => void;
  const completionReleased = new Promise<void>(resolve => { releaseCompletion = resolve; });
  if (options.holdDraftTransactions) {
    await page.addInitScript(() => {
      const descriptor = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, "oncomplete");
      if (!descriptor?.set || !descriptor.get) return;
      const originalGetAll = IDBObjectStore.prototype.getAll;
      let armed = false;
      let gatedTransaction: IDBTransaction | null = null;
      let observedResolve: (() => void) | null = null;
      let releaseResolve: (() => void) | null = null;
      let observed = Promise.resolve();
      let released = Promise.resolve();
      window.__actionDraftTestGate = {
        arm() {
          armed = true;
          gatedTransaction = null;
          observed = new Promise(resolve => { observedResolve = resolve; });
          released = new Promise(resolve => { releaseResolve = resolve; });
        },
        waitUntilHeld() { return observed; },
        release() { releaseResolve?.(); releaseResolve = null; }
      };
      IDBObjectStore.prototype.getAll = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["getAll"]>) {
        const request = originalGetAll.apply(this, args);
        if (armed && this.name === "actionDrafts") {
          armed = false;
          gatedTransaction = this.transaction;
        }
        return request;
      };
      Object.defineProperty(IDBTransaction.prototype, "oncomplete", {
        configurable: true,
        enumerable: descriptor.enumerable ?? false,
        get() { return descriptor.get?.call(this); },
        set(handler: ((this: IDBTransaction, event: Event) => unknown) | null) {
          descriptor.set?.call(this, function (this: IDBTransaction, event: Event) {
            if (this === gatedTransaction) {
              gatedTransaction = null;
              observedResolve?.();
              void released.then(() => handler?.call(this, event));
              return;
            }
            handler?.call(this, event);
          });
        }
      });
    });
  }
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
      const pending = !acceptedGeneration && Boolean(options.pending || openingJobStarted || activeConflictReturned);
      const acceptedTurn = acceptedGeneration ? {
        ...acceptedTurnTemplate,
        id: acceptedGeneration.resultTurnId,
        turnNumber: acceptedGeneration.expectedTurnNumber,
        action: acceptedGeneration.action,
        narration: "Accepted synthetic narration.",
        acceptedAt: timestamp
      } : null;
      const projectedTurns = acceptedTurn ? [
        ...syncTurns.turns.filter(turn => Number(turn.turnNumber) < acceptedTurn.turnNumber),
        acceptedTurn
      ].sort((left, right) => left.turnNumber - right.turnNumber) : syncTurns.turns;
      const activeTurnNumber = acceptedGeneration?.operationKind === "append"
        ? acceptedGeneration.expectedTurnNumber
        : payloads.syncStatus.activeTurnNumber;
      const snapshot = {
        ...payloads.syncStatus,
        campaign: { ...payloads.syncStatus.campaign, id: options.campaign ?? campaignId, activeTurnNumber },
        activeTurnNumber,
        turns: { ...payloads.syncStatus.turns, turns: projectedTurns },
        pendingGeneration: pending ? {
          id: options.activeConflict ? activeJobId : jobId, status: "generating",
          action: options.pendingAction ?? (options.opening ? "Survey the empty platform." : "Authoritative pending action."),
          expectedTurnNumber: options.opening ? 1 : 2,
          createdAt: timestamp, updatedAt: timestamp, operationKind: "append", replacementTurnId: null
        } : null,
        generationRecovery: !acceptedGeneration && (options.failed || appendFailed) ? {
          id: jobId, status: "failed", operationKind: "append", replacementTurnId: null,
          expectedTurnNumber: 2, attempts: 1, errorCode: "generation_failed", errorMessage: "Generation could not be completed.",
          diagnostic: null, resultTurnId: null
        } : null
      };
      syncSnapshots.push(snapshot);
      return respond(campaignSyncStatusSchema.parse(snapshot));
    }
    if (request.method() === "GET" && path === `/api/v1/campaigns/${options.campaign ?? campaignId}/turns`) return respond(payloads.turns);
    if (request.method() === "GET" && (path === `/api/v1/campaigns/${options.campaign ?? campaignId}/state` || path === `/api/v1/campaigns/${options.campaign ?? campaignId}/state/inspection`)) return respond(payloads.runtimeState);
    if (request.method() === "GET" && path === `/api/v1/campaigns/${options.campaign ?? campaignId}/story-memory`) return respond({ level: "off", reviewMode: "off", availableLevels: ["off"] });
    if (request.method() === "GET" && path === `/api/v1/campaigns/${options.campaign ?? campaignId}/character-profile`) return respond({ campaignId: options.campaign ?? campaignId, revision: 1, name: "", profile: {}, storedProfile: null, inheritedFromSnapshot: false, legacyCharacterText: "", rpgStats: [], defaultTriggers: [] });
    if (request.method() === "GET" && path === `/api/v1/campaigns/${options.campaign ?? campaignId}/illustration-config`) return respond(payloads.illustrationConfig);
    if (request.method() === "GET" && path === `/api/v1/campaigns/${options.campaign ?? campaignId}/illustration-segments`) return respond(payloads.illustrationSegments);
    if (request.method() === "GET" && path === `/api/v1/campaigns/${options.campaign ?? campaignId}/image-jobs`) return respond({ jobs: [] });
    if (request.method() === "POST" && path === `/api/v1/campaigns/${options.campaign ?? campaignId}/generations/retry-latest`) {
      replacementJobStarted = true;
      writes.push({ path, body: request.postDataJSON() as Record<string, unknown> });
      return respond({ id: replacementJobId, status: "queued", duplicate: false, operationKind: "replace_latest", replacementTurnId: "44444444-4444-4444-8444-444444444444" }, 202);
    }
    if (request.method() === "POST" && path === `/api/v1/campaigns/${options.campaign ?? campaignId}/generations`) {
      const body = request.postDataJSON() as Record<string, unknown>;
      writes.push({ path, body });
      if (options.activeConflict) {
        activeConflictReturned = true;
        return respond({
          error: "GenerationConflictError", message: "A generation is already active.", correlationId: "fixture-correlation",
          details: { code: "active_generation_exists", pendingGeneration: {
            id: activeJobId, status: "generating", action: "Another tab's action.", expectedTurnNumber: 2,
            createdAt: timestamp, updatedAt: timestamp, operationKind: "append", replacementTurnId: null
          } }
        }, 409);
      }
      ordinaryAppend = {
        action: String(body.action),
        campaignId: options.campaign ?? campaignId,
        expectedTurnNumber: Number(payloads.syncStatus.activeTurnNumber) + 1,
        idempotencyKey: String(body.idempotencyKey)
      };
      if (options.appendOutcome === "failed") appendFailed = true;
      if (options.opening) openingJobStarted = true;
      return respond({ id: jobId, status: "queued", duplicate: false, operationKind: "append", replacementTurnId: null }, 202);
    }
    const currentJob = replacementJobStarted ? replacementJobId : options.activeConflict ? activeJobId : jobId;
    const acceptedOperation = replacementJobStarted ? "replace_latest" : "append";
    const acceptedExpectedTurn = replacementJobStarted
      ? 1
      : options.opening
        ? 1
        : ordinaryAppend?.expectedTurnNumber ?? 2;
    const acceptedAction = replacementJobStarted
      ? "Replacement action."
      : options.activeConflict
        ? "Another tab's action."
        : options.pendingAction ?? (options.pending
          ? "Authoritative pending action."
          : options.opening
            ? "Survey the empty platform."
            : ordinaryAppend?.action ?? "A submitted action.");
    const acceptedResultTurn = replacementJobStarted ? replacementResultTurnId : resultTurnId;
    if (request.method() === "GET" && path === `/api/v1/generation-jobs/${currentJob}/stream`) {
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: "" });
    }
    if (request.method() === "GET" && path === `/api/v1/generation-jobs/${currentJob}`) {
      if (options.holdCompletion) await completionReleased;
      if (!(options.appendOutcome === "failed" && !replacementJobStarted)) {
        acceptedGeneration = {
          id: currentJob,
          expectedTurnNumber: acceptedExpectedTurn,
          resultTurnId: acceptedResultTurn,
          action: acceptedAction,
          operationKind: acceptedOperation
        };
      }
      const jobSnapshot = generationJobSnapshotSchema.parse({
        id: currentJob, campaignId: options.campaign ?? campaignId, expectedTurnNumber: acceptedExpectedTurn, action: acceptedAction,
        requestedInputMode: "action", resolvedInputMode: "action", inputModeSource: "explicit", operationKind: acceptedOperation,
        replacementTurnId: replacementJobStarted ? "44444444-4444-4444-8444-444444444444" : null,
        attempts: 1, resultTurnId: options.appendOutcome === "failed" && !replacementJobStarted ? null : acceptedResultTurn,
        errorCode: options.appendOutcome === "failed" && !replacementJobStarted ? "generation_failed" : null,
        errorMessage: options.appendOutcome === "failed" && !replacementJobStarted ? "Generation could not be completed." : null,
        createdAt: timestamp, updatedAt: timestamp, partialNarration: null,
        status: options.appendOutcome === "failed" && !replacementJobStarted ? "failed" : "completed"
      });
      jobSnapshots.push(jobSnapshot);
      return respond(jobSnapshot);
    }
    if (request.method() === "GET" && path === `/api/v1/generation-jobs/${currentJob}/result`) {
      const resultSnapshot = generationResultSchema.parse({
        id: currentJob, campaignId: options.campaign ?? campaignId, expectedTurnNumber: acceptedExpectedTurn, action: acceptedAction,
        requestedInputMode: "action", resolvedInputMode: "action", inputModeSource: "explicit", operationKind: acceptedOperation,
        replacementTurnId: replacementJobStarted ? "44444444-4444-4444-8444-444444444444" : null,
        attempts: 1, resultTurnId: acceptedResultTurn, errorCode: null, errorMessage: null,
        createdAt: timestamp, updatedAt: timestamp, status: "completed", turnNumber: acceptedExpectedTurn, inputMode: "action",
        narration: "Accepted synthetic narration.", choices: [], customActionSuggestion: "", imagePrompt: "", imageUrl: null,
        acceptedAt: timestamp, chronicleRetrieval: null, modelMetadata: null, mechanics: null, stateSnapshot: {}, reportedCost: null
      });
      resultSnapshots.push(resultSnapshot);
      return respond(resultSnapshot);
    }
    if (request.method() === "POST") writes.push({ path, body: {} });
    return respond({});
  });
  const html = (await readFile("apps/web/public/story.html", "utf8")).replace("/nexus/legacy-client.js", "/nexus/src/legacy-client-entry.ts");
  await page.route(`**/story/${options.campaign ?? campaignId}`, route => route.fulfill({ contentType: "text/html", body: html }));
  return { payloads, writes, syncSnapshots, jobSnapshots, resultSnapshots, errors, releaseCompletion };
}

function expectOrdinaryAppendIdentity(harness: Harness, action: string, status: "completed" | "failed") {
  const post = harness.writes.find(write => write.path.endsWith("/generations"));
  expect(post?.body).toMatchObject({ action, idempotencyKey: expect.any(String) });
  const submittedCampaignId = post?.path.split("/")[4];
  const expectedTurnNumber = Number(harness.payloads.syncStatus.activeTurnNumber) + 1;
  expect(harness.jobSnapshots.at(-1)).toMatchObject({
    id: jobId, campaignId: submittedCampaignId, expectedTurnNumber, action, operationKind: "append", status
  });
  if (status === "completed") {
    expect(harness.resultSnapshots.at(-1)).toMatchObject({
      id: jobId, campaignId: submittedCampaignId, expectedTurnNumber, turnNumber: expectedTurnNumber, action, status
    });
  }
}

function expectGenerationIdentity(harness: Harness, identity: {
  id: string; campaignId: string; expectedTurnNumber: number; action: string;
  operationKind: "append" | "replace_latest"; status: "completed" | "failed"
}) {
  expect(harness.jobSnapshots.at(-1)).toMatchObject(identity);
  if (identity.status === "completed") {
    const { operationKind: _operationKind, ...resultIdentity } = identity;
    expect(harness.resultSnapshots.at(-1)).toMatchObject(resultIdentity);
  }
}

async function gotoStory(page: Page, harness: Harness, campaign = campaignId) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${origin}/story/${campaign}`);
  await expect(page.locator("#freeAction")).toBeVisible();
}

async function seedDraft(page: Page, draft: { text: string; inputMode?: "action" | "scene"; baseTurnId?: string | null; baseTurnNumber?: number; draftRevision?: string }, scope = { userId, campaignId }) {
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
          schemaVersion: 1, draftRevision: draft.draftRevision ?? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", text: draft.text,
          inputMode: draft.inputMode ?? "action", baseTurnId: draft.baseTurnId === undefined ? "44444444-4444-4444-8444-444444444444" : draft.baseTurnId,
          baseTurnNumber: draft.baseTurnNumber ?? 1, updatedAt: new Date().toISOString()
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
  expectOrdinaryAppendIdentity(harness, "Keep this if storage lets me.", "completed");
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
  expectOrdinaryAppendIdentity(unavailable, "Keep this without IndexedDB.", "completed");
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
  expectOrdinaryAppendIdentity(harness, "A submitted action.", "completed");
  await expect.poll(() => readDraft(page)).toBeNull();
  expect(harness.writes).toHaveLength(1);
});

test("active_job_completion_preserves_unowned_local_draft", async ({ page }) => {
  const harness = await installHarness(page, { activeConflict: true });
  await gotoStory(page, harness);
  await page.locator("#freeAction").fill("My ordinary action.");
  await expect(page.locator("#autosaveStatus")).toHaveText("Draft saved");
  const submitted = await readDraft(page) as { text: string; draftRevision: string };
  await page.locator("#btnTakeAction").click();
  await expect(page.getByText("Accepted synthetic narration.", { exact: true })).toBeVisible();
  expectGenerationIdentity(harness, {
    id: activeJobId, campaignId, expectedTurnNumber: 2, action: "Another tab's action.",
    operationKind: "append", status: "completed"
  });
  await expect(page.locator("#actionDraftConflict")).toBeVisible();
  await mkdir(fix1EvidenceDirectory, { recursive: true });
  await page.screenshot({ path: `${fix1EvidenceDirectory}/active-conflict-preserves-local-draft.png`, fullPage: true });
  await expect.poll(() => readDraft(page)).toMatchObject(submitted);
  await expect(page.locator("#freeAction")).toHaveValue("My ordinary action.");
  expect(harness.writes[0]?.body.action).toBe("My ordinary action.");
  expect(harness.writes[0]?.path).toMatch(/\/generations$/u);
});

test("same_text_ordinary_revision_survives_pending_opening_reload", async ({ page, context }) => {
  const harness = await installHarness(page, { opening: true, holdCompletion: true });
  await gotoStory(page, harness);
  await page.locator("#btnMessagePopupClose").click();
  await expect.poll(() => harness.writes.length).toBe(1);
  const otherTab = await context.newPage();
  await seedDraft(otherTab, {
    text: "Survey the empty platform.", baseTurnId: null, baseTurnNumber: 0,
    draftRevision: "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
  });
  const ordinary = await readDraft(otherTab) as { text: string; draftRevision: string };
  await page.reload();
  await expect(page.locator("#freeAction")).toBeVisible();
  harness.releaseCompletion();
  await expect(page.getByText("Accepted synthetic narration.", { exact: true })).toBeVisible();
  expectGenerationIdentity(harness, {
    id: jobId, campaignId, expectedTurnNumber: 1, action: "Survey the empty platform.",
    operationKind: "append", status: "completed"
  });
  await expect(page.locator("#actionDraftConflict")).toBeVisible();
  await expect(page.locator("#restoreActionDraft")).toBeVisible();
  await mkdir(fix1EvidenceDirectory, { recursive: true });
  await page.screenshot({ path: `${fix1EvidenceDirectory}/opening-preserves-same-text-draft-after-acceptance.png`, fullPage: true });
  await page.locator("#restoreActionDraft").click();
  await expect(page.locator("#freeAction")).toHaveValue(ordinary.text);
  await expect.poll(() => readDraft(otherTab)).toMatchObject(ordinary);
  expect(harness.writes).toHaveLength(1);
});

test("failed_append_followed_by_replacement_preserves_ordinary_draft", async ({ page }) => {
  const harness = await installHarness(page, { appendOutcome: "failed" });
  await gotoStory(page, harness);
  await page.locator("#freeAction").fill("My ordinary action.");
  await expect(page.locator("#autosaveStatus")).toHaveText("Draft saved");
  const submitted = await readDraft(page) as { text: string; draftRevision: string };
  await page.locator("#btnTakeAction").click();
  await expect.poll(() => harness.writes.length).toBe(1);
  await expect(page.locator("#toast")).toContainText("Generation failed:");
  expectOrdinaryAppendIdentity(harness, "My ordinary action.", "failed");
  await page.reload();
  expect(harness.errors, harness.errors.join("\n")).toEqual([]);
  await expect(page.locator("#storySyncStatus")).toHaveText("Story synced");
  expect((harness.syncSnapshots.at(-1) as { generationRecovery?: unknown })?.generationRecovery).not.toBeNull();
  await expect(page.locator("#generationRecoveryPanel")).toBeVisible();
  await expect(page.locator("#freeAction")).toHaveValue("My ordinary action.");
  await page.locator(".story-more > summary").click();
  await page.locator("#btnRetry").click();
  await expect(page.locator("#retryPromptDialog")).toBeVisible();
  await page.locator("#retryPromptEditor").fill("Replacement action.");
  await page.locator("#btnRetryPromptSubmit").click();
  await expect(page.getByText("Accepted synthetic narration.", { exact: true })).toBeVisible();
  expectGenerationIdentity(harness, {
    id: replacementJobId, campaignId, expectedTurnNumber: 1, action: "Replacement action.",
    operationKind: "replace_latest", status: "completed"
  });
  await expect(page.locator("#actionDraftConflict")).toBeVisible();
  await page.locator("#restoreActionDraft").click();
  await expect(page.locator("#freeAction")).toHaveValue("My ordinary action.");
  await expect.poll(() => readDraft(page)).toMatchObject(submitted);
  expect(harness.writes.map(write => write.path)).toEqual([
    `/api/v1/campaigns/${campaignId}/generations`,
    `/api/v1/campaigns/${campaignId}/generations/retry-latest`
  ]);
});

test("keep_this_draft_retries_after_remote_delete", async ({ page, context }) => {
  const first = await installHarness(page);
  await gotoStory(page, first);
  await page.locator("#freeAction").fill("Initial draft.");
  await expect(page.locator("#autosaveStatus")).toHaveText("Draft saved");
  const otherTab = await context.newPage();
  const second = await installHarness(otherTab);
  await gotoStory(otherTab, second);
  await expect(otherTab.locator("#freeAction")).toHaveValue("Initial draft.");
  await otherTab.locator("#btnClearTurnInput").click();
  await expect.poll(() => readDraft(otherTab)).toBeNull();
  await page.locator("#freeAction").fill("Keep my new local edit.");
  await expect(page.locator("#actionDraftConflict")).toBeVisible();
  await expect(page.locator("#keepActionDraft")).toBeVisible();
  await page.locator("#keepActionDraft").click();
  await expect(page.locator("#autosaveStatus")).toHaveText("Draft saved");
  await expect.poll(() => readDraft(page)).toMatchObject({ text: "Keep my new local edit." });
});

test("keep_does_not_overwrite_revision_inserted_after_reconciliation_read", async ({ page, context }) => {
  const first = await installHarness(page, { holdDraftTransactions: true });
  await gotoStory(page, first);
  await page.locator("#freeAction").fill("Initial draft.");
  await expect(page.locator("#autosaveStatus")).toHaveText("Draft saved");
  const otherTab = await context.newPage();
  const second = await installHarness(otherTab);
  await gotoStory(otherTab, second);
  await otherTab.locator("#btnClearTurnInput").click();
  await expect.poll(() => readDraft(otherTab)).toBeNull();
  await page.locator("#freeAction").fill("Keep my local version.");
  await expect(page.locator("#actionDraftConflict")).toBeVisible();
  await armDraftTransactionGate(page);
  await page.locator("#keepActionDraft").click();
  await waitForDraftTransactionGate(page);
  await seedDraft(otherTab, {
    text: "Concurrent foreign version.", draftRevision: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
  });
  await releaseDraftTransactionGate(page);
  await expect(page.locator("#actionDraftConflict")).toBeVisible();
  await expect.poll(() => readDraft(otherTab)).toMatchObject({
    text: "Concurrent foreign version.", draftRevision: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
  });
  await expect(page.locator("#freeAction")).toHaveValue("Keep my local version.");
});

test("delayed_restore_does_not_replace_typing", async ({ page }) => {
  const harness = await installHarness(page, { holdDraftTransactions: true });
  await seedDraft(page, { text: "Remote saved edit.", baseTurnId: null, baseTurnNumber: 0 });
  await gotoStory(page, harness);
  await expect(page.locator("#actionDraftConflict")).toBeVisible();
  await armDraftTransactionGate(page);
  await page.locator("#restoreActionDraft").click();
  await waitForDraftTransactionGate(page);
  await page.locator("#freeAction").fill("Typed while restore waited.");
  await releaseDraftTransactionGate(page);
  await mkdir(fix1EvidenceDirectory, { recursive: true });
  await page.screenshot({ path: `${fix1EvidenceDirectory}/delayed-restore-preserves-typing.png`, fullPage: true });
  await expect(page.locator("#freeAction")).toHaveValue("Typed while restore waited.");
  await expect(page.locator("#actionDraftConflict")).toBeVisible();
});

test("delayed_write_clear_removes_own_revision_and_preserves_foreign_revision", async ({ page, context }) => {
  const harness = await installHarness(page, { holdDraftTransactions: true });
  await gotoStory(page, harness);
  await expect(page.locator("#storySyncStatus")).toHaveText("Story synced");
  await expect(page.locator("#freeAction")).toBeEnabled();
  await armDraftTransactionGate(page);
  await page.locator("#freeAction").fill("Clear this after its write commits.");
  await waitForDraftTransactionGate(page);
  await page.locator("#btnClearTurnInput").click();
  await releaseDraftTransactionGate(page);
  await expect(page.locator("#autosaveStatus")).toHaveText("No draft");
  await expect.poll(() => readDraft(page)).toBeNull();

  const foreignPage = await context.newPage();
  await gotoStory(foreignPage, await installHarness(foreignPage));
  await armDraftTransactionGate(page);
  await page.locator("#freeAction").fill("Clear while a foreign write races.");
  await waitForDraftTransactionGate(page);
  await page.locator("#btnClearTurnInput").click();
  await seedDraft(foreignPage, {
    text: "Foreign revision to preserve.", draftRevision: "ffffffff-ffff-4fff-8fff-ffffffffffff"
  });
  await releaseDraftTransactionGate(page);
  await expect(page.locator("#actionDraftConflict")).toBeVisible();
  await expect.poll(() => readDraft(foreignPage)).toMatchObject({
    text: "Foreign revision to preserve.", draftRevision: "ffffffff-ffff-4fff-8fff-ffffffffffff"
  });
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
  expectOrdinaryAppendIdentity(harness, "A submitted action.", "completed");
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
  expectOrdinaryAppendIdentity(first, "The first tab action.", "completed");
  await expect.poll(() => readDraft(secondPage)).toMatchObject({ text: "A newer action in another tab.", draftRevision: newer.draftRevision });
  await expect(page.locator("#actionDraftConflict")).toBeVisible();
  await page.locator("#restoreActionDraft").click();
  await expect(page.locator("#freeAction")).toHaveValue("A newer action in another tab.");
});

test("newer_draft_survives_recovery_reconciliation", async ({ page }) => {
  const harness = await installHarness(page, { pending: true, pendingAction: "Stale saved action.", holdCompletion: true });
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
  harness.releaseCompletion();
  await expect(page.getByText("Accepted synthetic narration.", { exact: true })).toBeVisible();
  await expect(page.locator("#actionDraftConflict")).toBeVisible();
  await page.locator("#restoreActionDraft").click();
  await expect(page.locator("#freeAction")).toHaveValue("Fresh local action.");
  await mkdir(fix1EvidenceDirectory, { recursive: true });
  await page.screenshot({ path: `${fix1EvidenceDirectory}/recovery-restores-newer-local-draft.png`, fullPage: true });
  await expect.poll(() => readDraft(laterTab)).toMatchObject({ text: "Fresh local action.", draftRevision: expect.any(String) });
  expect(harness.writes).toEqual([]);
});

test("app_navigation_awaits_transaction_commit", async ({ page }) => {
  const harness = await installHarness(page, { holdDraftTransactions: true });
  await gotoStory(page, harness);
  await expect(page.locator("#storySyncStatus")).toHaveText("Story synced");
  await expect(page.locator("#freeAction")).toBeEnabled();
  await armDraftTransactionGate(page);
  await page.locator("#freeAction").fill("Save before leaving.");
  await page.locator("#btnNexusDashboard").click();
  await waitForDraftTransactionGate(page);
  await expect(page).toHaveURL(new RegExp(`/story/${campaignId}$`));
  await expect.poll(() => readDraft(page)).toMatchObject({ text: "Save before leaving." });
  await releaseDraftTransactionGate(page);
  await expect(page).toHaveURL(`${origin}/nexus/`);
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
  const harness = await installHarness(page, { holdDraftTransactions: true });
  await gotoStory(page, harness);
  await expect(page.locator("#storySyncStatus")).toHaveText("Story synced");
  await expect(page.locator("#freeAction")).toBeEnabled();
  await armDraftTransactionGate(page);
  await page.locator("#freeAction").fill("Remove this local action.");
  await waitForDraftTransactionGate(page);
  await page.locator("#btnClearTurnInput").click();
  await releaseDraftTransactionGate(page);
  await expect(page.locator("#autosaveStatus")).toHaveText("No draft");
  await expect.poll(() => readDraft(page)).toBeNull();
  expect(harness.writes).toEqual([]);
});
