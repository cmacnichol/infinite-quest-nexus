import { expect, test, type Page, type Route } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { quietLeafApiPayloads } from "../fixtures/quiet-leaf-payloads.js";
import { campaignSyncStatusSchema, generationJobSnapshotSchema, generationResultSchema } from "../../packages/contracts/src/index.js";

const origin = `http://127.0.0.1:${process.env.PLAYWRIGHT_LEGACY_PORT ?? "43173"}`;
const campaignId = "11111111-1111-4111-8111-111111111111";
const userId = "66666666-6666-4666-8666-666666666666";
const jobId = "55555555-5555-4555-8555-555555555555";
const activeJobId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const replacementJobId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const resultTurnId = "88888888-8888-4888-8888-888888888888";
const replacementResultTurnId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const timestamp = "2026-10-03T12:00:00.000Z";
const databaseName = "infiniteQuest-reader-local-v1";
const storeName = "actionDrafts";

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
  readonly generationReads: string[];
  readonly cancelRequests: string[];
  readonly firstJobReadStarted: Promise<void>;
  readonly errors: string[];
  readonly releaseCompletion: () => void;
}

declare global {
  interface Window {
    __actionDraftRaceTestGate?: {
      arm(): number;
      waitUntilHeld(id: number): Promise<void>;
      release(id: number): void;
    };
  }
}

async function armDraftTransactionGate(page: Page) {
  return page.evaluate(() => window.__actionDraftRaceTestGate?.arm() ?? -1);
}

async function waitForDraftTransactionGate(page: Page, id: number) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      page.evaluate(gateId => window.__actionDraftRaceTestGate?.waitUntilHeld(gateId), id),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("IndexedDB transaction gate was not reached.")), 10_000);
      })
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function releaseDraftTransactionGate(page: Page, id: number) {
  await page.evaluate(gateId => window.__actionDraftRaceTestGate?.release(gateId), id);
}

async function waitForFirstJobRead(harness: Harness) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      harness.firstJobReadStarted,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("The generation polling request was not observed.")), 10_000);
      })
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
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
  const generationReads: string[] = [];
  const cancelRequests: string[] = [];
  const errors: string[] = [];
  let openingJobStarted = false;
  let replacementJobStarted = false;
  let activeConflictReturned = false;
  let appendFailed = false;
  let ordinaryAppend: { action: string; campaignId: string; expectedTurnNumber: number; idempotencyKey: string } | null = null;
  let acceptedGeneration: { id: string; expectedTurnNumber: number; resultTurnId: string; action: string; operationKind: "append" | "replace_latest" } | null = null;
  let releaseCompletion!: () => void;
  const completionReleased = new Promise<void>(resolve => { releaseCompletion = resolve; });
  let firstJobReadResolve!: () => void;
  const firstJobReadStarted = new Promise<void>(resolve => { firstJobReadResolve = resolve; });
  if (options.holdDraftTransactions) {
    await page.addInitScript(() => {
      const descriptor = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, "oncomplete");
      if (!descriptor?.set || !descriptor.get) return;
      const originalGetAll = IDBObjectStore.prototype.getAll;
      let nextId = 0;
      const gates: Array<{
        id: number;
        armed: boolean;
        transaction: IDBTransaction | null;
        observed: Promise<void>;
        observedResolve: (() => void) | null;
        released: Promise<void>;
        releaseResolve: (() => void) | null;
      }> = [];
      window.__actionDraftRaceTestGate = {
        arm() {
          let observedResolve: (() => void) | null = null;
          let releaseResolve: (() => void) | null = null;
          const observed = new Promise<void>(resolve => { observedResolve = resolve; });
          const released = new Promise<void>(resolve => { releaseResolve = resolve; });
          const gate = {
            id: ++nextId,
            armed: true,
            transaction: null as IDBTransaction | null,
            observed,
            observedResolve,
            released,
            releaseResolve
          };
          gates.push(gate);
          return gate.id;
        },
        waitUntilHeld(id) {
          return gates.find(gate => gate.id === id)?.observed ?? Promise.reject(new Error("Unknown IndexedDB gate."));
        },
        release(id) {
          const gate = gates.find(candidate => candidate.id === id);
          gate?.releaseResolve?.();
          if (gate) gate.releaseResolve = null;
        }
      };
      IDBObjectStore.prototype.getAll = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["getAll"]>) {
        const request = originalGetAll.apply(this, args);
        const gate = this.name === "actionDrafts" ? gates.find(candidate => candidate.armed) : undefined;
        if (gate) {
          gate.armed = false;
          gate.transaction = this.transaction;
        }
        return request;
      };
      Object.defineProperty(IDBTransaction.prototype, "oncomplete", {
        configurable: true,
        enumerable: descriptor.enumerable ?? false,
        get() { return descriptor.get?.call(this); },
        set(handler: ((this: IDBTransaction, event: Event) => unknown) | null) {
          descriptor.set?.call(this, function (this: IDBTransaction, event: Event) {
            const gate = gates.find(candidate => candidate.transaction === this);
            if (gate) {
              gate.transaction = null;
              gate.observedResolve?.();
              void gate.released.then(() => handler?.call(this, event));
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
    if (request.method() === "POST" && path === `/api/v1/generation-jobs/${jobId}/cancel`) {
      cancelRequests.push(path);
      return respond({ id: jobId, status: "cancelled", operationKind: "append", replacementTurnId: null });
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
      generationReads.push(path);
      firstJobReadResolve();
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
      generationReads.push(path);
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
  return { payloads, writes, syncSnapshots, jobSnapshots, resultSnapshots, errors, releaseCompletion, generationReads, cancelRequests, firstJobReadStarted };
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
    const value = await new Promise<{ text: string } | null>((resolve, reject) => {
      const transaction = database.transaction(storeName, "readonly");
      const request = transaction.objectStore(storeName).get(`draft:${scope.userId}:${scope.campaignId}`);
      request.onsuccess = () => {
        const raw = request.result?.value;
        if (typeof raw !== "string") {
          resolve(null);
          return;
        }
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null || !("draft" in parsed)) {
          resolve(null);
          return;
        }
        const draft = parsed.draft;
        resolve(typeof draft === "object" && draft !== null && "text" in draft && typeof draft.text === "string"
          ? { text: draft.text }
          : null);
      };
      request.onerror = () => reject(request.error);
    });
    database.close();
    return value;
  }, { scope, databaseName, storeName });
}


test("take_action_during_draft_commit_coalesces_and_preserves_newer_text", async ({ page }, testInfo) => {
  const harness = await installHarness(page, { holdDraftTransactions: true, holdCompletion: true });
  await gotoStory(page, harness);
  await expect(page.locator("#freeAction")).toBeEnabled();
  const firstGate = await armDraftTransactionGate(page);
  const submittedAction = "The first action should be accepted.";
  const newerDraft = "Keep this newer text for the next turn.";

  try {
    await page.locator("#freeAction").fill(submittedAction);
    await page.locator("#btnTakeAction").click();
    await waitForDraftTransactionGate(page, firstGate);

    await page.locator("#freeAction").fill(newerDraft);
    await page.locator("#freeAction").press("Enter");
    await releaseDraftTransactionGate(page, firstGate);
    await waitForFirstJobRead(harness);

    const generationPosts = harness.writes.filter(write => write.path === "/api/v1/campaigns/" + campaignId + "/generations");
    expect(generationPosts).toHaveLength(1);
    expect(generationPosts[0]?.body).toMatchObject({ action: submittedAction, idempotencyKey: expect.any(String) });
    expect(harness.generationReads.filter(path => path.endsWith("/generation-jobs/" + jobId))).toHaveLength(1);
  } finally {
    await releaseDraftTransactionGate(page, firstGate);
    harness.releaseCompletion();
  }

  await expect(page.locator("#scene-2 .scene-narration .narration")).toHaveText("Accepted synthetic narration.");
  await expect(page.locator("#scene-2")).toHaveCount(1);

  const generationPosts = harness.writes.filter(write => write.path === "/api/v1/campaigns/" + campaignId + "/generations");
  expect(generationPosts).toHaveLength(1);
  expect(generationPosts[0]?.body).toMatchObject({ action: submittedAction, idempotencyKey: expect.any(String) });
  expect(harness.jobSnapshots).toHaveLength(1);
  expect(harness.resultSnapshots).toHaveLength(1);
  expect(harness.generationReads.filter(path => path.endsWith("/generation-jobs/" + jobId + "/result"))).toHaveLength(1);

  await expect.poll(async () => (await readDraft(page))?.text).toBe(newerDraft);
  await expect(page.locator("#freeAction")).toHaveValue(newerDraft);
  await page.screenshot({ path: testInfo.outputPath("take-action-draft-race.png"), fullPage: true });
});

test("discarding_stale_base_does_not_erase_edit_made_before_removal_resolves", async ({ page }, testInfo) => {
  const harness = await installHarness(page, { holdDraftTransactions: true });
  const newerDraft = "A newer action entered while the stale draft is discarded.";
  await seedDraft(page, {
    text: "An action saved before the first accepted turn.",
    baseTurnId: null,
    baseTurnNumber: 0,
    draftRevision: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
  });
  await gotoStory(page, harness);
  await expect(page.locator("#freeAction")).toBeEnabled();
  await expect(page.locator("#actionDraftConflict")).toBeVisible();
  await expect(page.locator("#freeAction")).toHaveValue("");

  const removalGate = await armDraftTransactionGate(page);
  let saveGate: number | null = null;
  try {
    await page.locator("#discardActionDraft").click();
    await waitForDraftTransactionGate(page, removalGate);

    saveGate = await armDraftTransactionGate(page);
    await page.locator("#freeAction").fill(newerDraft);
    await releaseDraftTransactionGate(page, removalGate);

    const unload = await page.evaluate(() => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return { prevented: event.defaultPrevented, status: document.getElementById("autosaveStatus")?.textContent };
    });
    expect(unload.prevented).toBe(true);
    await waitForDraftTransactionGate(page, saveGate);
    await expect(page.locator("#autosaveStatus")).toHaveText("Draft saving");
  } finally {
    await releaseDraftTransactionGate(page, removalGate);
    if (saveGate !== null) await releaseDraftTransactionGate(page, saveGate);
  }

  await expect(page.locator("#autosaveStatus")).toHaveText("Draft saved");
  await expect.poll(async () => (await readDraft(page))?.text).toBe(newerDraft);

  await page.reload();
  await expect(page.locator("#freeAction")).toHaveValue(newerDraft);
  await expect(page.locator("#autosaveStatus")).toHaveText("Draft saved");
  expect(harness.writes).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("discard-draft-race-after-reload.png"), fullPage: true });
});

test("cancelling_generation_and_reloading_clears_retired_progress", async ({ page }, testInfo) => {
  const harness = await installHarness(page, { holdCompletion: true });
  await gotoStory(page, harness);
  await page.locator("#freeAction").fill("Cancel this synthetic action.");
  await page.locator("#btnTakeAction").click();
  const cancelButton = page.locator('#streamingPreviewCard [data-action="cancel-generation"]');
  await expect(cancelButton).toBeVisible();

  try {
    await cancelButton.click();
    await expect.poll(() => harness.cancelRequests.length).toBe(1);
    await expect(page.locator("#busyPill")).toHaveText("Ready");
    await expect(page.locator("#storySyncStatus")).toHaveText("Story synced");
    await expect(page.locator("#generationProgress")).toBeHidden();
    await page.screenshot({ path: testInfo.outputPath("cancelled-generation-reload-ready.png"), fullPage: true });
  } finally {
    harness.releaseCompletion();
  }

  expect(harness.errors).toEqual([]);
});
