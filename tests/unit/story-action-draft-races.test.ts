import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as storyModule from "../../apps/web/src/story.js";

const storyHtml = readFileSync("apps/web/public/story.html", "utf8");
const USER_ID = "11111111-1111-4111-8111-111111111111";
const CAMPAIGN_A = "22222222-2222-4222-8222-222222222222";
const CAMPAIGN_B = "33333333-3333-4333-8333-333333333333";
const TURN_ID = "44444444-4444-4444-8444-444444444444";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

async function drainMicrotasks() {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

function acceptedTurns(campaignId: string, count = 1) {
  return Array.from({ length: count }, (_, index) => ({
    id: index === 0 ? TURN_ID : `55555555-5555-4555-8555-${String(index).padStart(12, "0")}`,
    turnNumber: index + 1,
    campaignId,
    action: `Accepted action ${index + 1}`,
    narration: `Accepted narration ${index + 1}`,
    choices: [],
    inputMode: "action",
    inputModeSource: "explicit",
    customActionSuggestion: "",
    imagePrompt: "",
    imageUrl: null,
    acceptedAt: "2026-10-04T12:00:00.000Z",
    chronicleRetrieval: null,
    reportedCost: null
  }));
}

function staleDraft(revision: string, text = "Remote older draft") {
  return {
    schemaVersion: 1,
    draftRevision: revision,
    text,
    inputMode: "action",
    baseTurnId: null,
    baseTurnNumber: 0,
    updatedAt: "2026-10-04T11:00:00.000Z"
  };
}

async function bootStory({
  campaigns = { [CAMPAIGN_A]: { turns: acceptedTurns(CAMPAIGN_A) } },
  actionDrafts,
  workflow,
  userId = USER_ID
}: {
  campaigns?: Record<string, { turns: Array<Record<string, unknown>>; world?: Record<string, unknown> }>;
  actionDrafts: {
    read: ReturnType<typeof vi.fn>;
    readExpiryNotice: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    removeIfRevision: ReturnType<typeof vi.fn>;
  };
  workflow: { submit: ReturnType<typeof vi.fn>; resume: ReturnType<typeof vi.fn> };
  userId?: string;
}) {
  const { document, window } = parseHTML(storyHtml);
  const pathname = `/story/${CAMPAIGN_A}`;
  Object.defineProperty(window, "location", {
    value: {
      pathname,
      href: `http://localhost${pathname}`,
      origin: "http://localhost",
      assign: vi.fn()
    },
    configurable: true
  });
  for (const dialog of document.querySelectorAll("dialog")) {
    Object.defineProperty(dialog, "open", {
      get: () => dialog.hasAttribute("open"),
      configurable: true
    });
    (dialog as unknown as { showModal: () => void }).showModal = () => dialog.setAttribute("open", "");
    (dialog as unknown as { close: () => void }).close = () => {
      dialog.removeAttribute("open");
      dialog.dispatchEvent(new window.Event("close"));
    };
  }
  Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", {
    value: () => undefined,
    writable: true,
    configurable: true
  });
  Object.defineProperty(window, "requestAnimationFrame", {
    value: (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0),
    configurable: true
  });
  Object.defineProperty(window.HTMLTextAreaElement.prototype, "select", {
    value: () => undefined,
    writable: true,
    configurable: true
  });
  Object.defineProperty(window.HTMLTextAreaElement.prototype, "focus", {
    value: () => undefined,
    writable: true,
    configurable: true
  });
  Object.defineProperty(window, "cancelAnimationFrame", {
    value: (handle: number) => window.clearTimeout(handle),
    configurable: true
  });
  for (const [selector, value] of [
    ["#userProfileDefaultTurnControlStyle", "flexible_action"],
    ["[data-reader-width]", "72"],
    ["[data-reader-font-size]", "18"],
    ["[data-reader-line-height]", "1.7"],
    ["select[data-reader-theme]", "dark"]
  ] as const) {
    const control = document.querySelector(selector);
    if (control) Object.defineProperty(control, "value", { value, writable: true, configurable: true });
  }
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("Element", window.Element);
  vi.stubGlobal("HTMLElement", window.HTMLElement);
  vi.stubGlobal("HTMLInputElement", window.HTMLInputElement);
  vi.stubGlobal("HTMLSelectElement", window.HTMLSelectElement);
  vi.stubGlobal("HTMLButtonElement", window.HTMLButtonElement);
  vi.stubGlobal("localStorage", { getItem: () => null, removeItem: () => undefined, setItem: () => undefined });

  const syncStatus = vi.fn(async (campaignId: string) => {
    const campaign = campaigns[campaignId] || { turns: [] };
    return {
      campaign: {
        id: campaignId,
        title: campaignId === CAMPAIGN_B ? "Campaign B" : "Campaign A",
        activeTurnNumber: campaign.turns.length,
        storyLengthProfile: "standard",
        turnControlStyle: "flexible_action"
      },
      world: campaign.world || { firstAction: "Open the gate", backgroundStory: "The old road begins here." },
      turns: { campaignId, turns: campaign.turns, nextCursor: null },
      pendingGeneration: null,
      generationRecovery: null
    };
  });
  let id = 0;
  const initialized = (storyModule.startStoryPlayer as (composition: unknown) => Promise<void>)({
    api: {
      session: { get: async () => ({ user: { id: userId, settings: {
        continuousReading: false,
        autoSubmitTurnChoices: false,
        defaultTurnControlStyle: "flexible_action",
        readerPreferences: { width: 72, fontSize: 18, lineHeight: 1.7, theme: "dark" }
      } } }) },
      providers: { list: async () => ({ providers: [{ providerRole: "text" }] }) },
      generation: { syncStatus },
      campaigns: {
        state: async () => ({ activeTurnNumber: 1 }),
        updateState: async () => ({}),
        turns: async (campaignId: string) => ({ campaignId, turns: campaigns[campaignId]?.turns || [], nextCursor: null }),
        rewind: async () => ({}),
        getTurnCorrection: async () => ({ effectiveNarration: "", correctionRevision: 0 }),
        correctTurnNarration: async () => ({ effectiveNarration: "", correctionRevision: 0 })
      },
      meta: { get: async () => ({}) }
    },
    illustrations: {
      config: async () => ({ enabled: false, sourcePolicy: "off" }),
      segments: async () => ({ segments: [] }),
      imageJobs: async () => ({ jobs: [] })
    },
    readerHistory: {
      getTurn: async (campaignId: string, turnNumber: number) => ({
        campaignId,
        turn: acceptedTurns(campaignId, turnNumber).at(-1)
      }),
      searchHistory: async () => ({ items: [], nextCursor: null }),
      getSceneWindow: async () => ({})
    },
    readerPositions: {
      read: async () => null,
      write: async () => undefined,
      removeIfRevision: async () => ({ outcome: "absent" })
    },
    actionDrafts,
    workflow,
    pendingSubmissions: { clear: () => undefined, load: () => null },
    failedTurnPrompts: { load: () => null, save: () => undefined, clear: () => undefined },
    idFactory: { create: () => `88888888-8888-4888-8888-${String(++id).padStart(12, "0")}` },
    clock: { now: () => Date.parse("2026-10-04T12:00:00.000Z") }
  });
  document.dispatchEvent(new window.Event("DOMContentLoaded"));
  await vi.waitFor(() => expect(document.querySelector("#storyTitle")?.textContent).toContain("Campaign"));
  // Empty campaigns intentionally keep initialization pending behind the first-adventure dialog.
  if (campaigns[CAMPAIGN_A]?.turns.length) await initialized;
  await drainMicrotasks();
  return { document, window, initialized, syncStatus };
}

function draftStore({
  onRead = () => null,
  onWrite = async (_scope: unknown, draft: Record<string, unknown>, options: { expectedRevision: string | null }) => ({
    outcome: "saved",
    currentRevision: options.expectedRevision || String(draft.draftRevision)
  }),
  onRemove = async () => ({ outcome: "absent" })
}: {
  onRead?: (scope: { campaignId: string }) => unknown | Promise<unknown>;
  onWrite?: (scope: unknown, draft: Record<string, unknown>, options: { expectedRevision: string | null }) => unknown | Promise<unknown>;
  onRemove?: (scope: unknown, revision: string) => unknown | Promise<unknown>;
} = {}) {
  return {
    read: vi.fn(onRead),
    readExpiryNotice: vi.fn(async () => false),
    write: vi.fn(onWrite),
    removeIfRevision: vi.fn(onRemove)
  };
}

function workflowAdapter() {
  const submissions: Array<{ campaignId: string; input: Record<string, unknown> }> = [];
  const submit = vi.fn(async (campaignId: string, input: Record<string, unknown>) => {
    submissions.push({ campaignId, input });
    return {
      jobId: `job-${submissions.length}`,
      async *watch() { await new Promise<void>(() => undefined); }
    };
  });
  return { submissions, submit, resume: vi.fn(async () => null) };
}

afterEach(() => {
  return new Promise<void>((resolve) => setTimeout(resolve, 300)).then(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
});

describe("Story action-draft intent races", () => {
  it("hides retired generation progress on cancellation reload and keeps a successor visible", async () => {
    const retiredMonitor = deferred<void>();
    const successorMonitor = deferred<void>();
    let submissionCount = 0;
    const workflow = {
      submit: vi.fn(async () => {
        submissionCount += 1;
        const currentSubmission = submissionCount;
        const release = currentSubmission === 1 ? retiredMonitor : successorMonitor;
        return {
          jobId: `job-${currentSubmission}`,
          cancelGeneration: vi.fn(async () => undefined),
          async *watch() {
            await release.promise;
            if (currentSubmission === 1) throw Object.assign(new Error("Retired monitor stopped."), { name: "AbortError" });
            yield { type: "settled", outcome: "failed", error: new Error("Successor monitor settled.") };
          }
        };
      }),
      resume: vi.fn(async () => null)
    };
    const ui = await bootStory({ actionDrafts: draftStore(), workflow });
    const progress = ui.document.querySelector<HTMLElement>("#generationProgress")!;
    const input = ui.document.querySelector<HTMLTextAreaElement>("#freeAction")!;
    input.value = "Action to cancel";
    input.dispatchEvent(new ui.window.Event("input", { bubbles: true }));
    ui.document.querySelector<HTMLButtonElement>("#btnTakeAction")!.click();
    await vi.waitFor(() => expect(workflow.submit).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(ui.document.querySelector('#streamingPreviewCard [data-action="cancel-generation"]')).not.toBeNull());

    ui.document.querySelector<HTMLButtonElement>('#streamingPreviewCard [data-action="cancel-generation"]')!.click();
    await vi.waitFor(() => expect(ui.syncStatus).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(ui.document.querySelector("#storySyncStatus")?.textContent).toBe("Story synced"));
    expect(progress.classList.contains("hidden")).toBe(true);

    input.value = "Successor action";
    input.dispatchEvent(new ui.window.Event("input", { bubbles: true }));
    ui.document.querySelector<HTMLButtonElement>("#btnTakeAction")!.click();
    await vi.waitFor(() => expect(workflow.submit).toHaveBeenCalledTimes(2));
    expect(progress.classList.contains("hidden")).toBe(false);

    retiredMonitor.resolve();
    await drainMicrotasks();
    expect(progress.classList.contains("hidden")).toBe(false);
    successorMonitor.resolve();
    await vi.waitFor(() => expect(progress.classList.contains("hidden")).toBe(true));
  });

  it("does not enqueue a predecessor action or release a successor across same-campaign reload", async () => {
    const firstWrite = deferred<unknown>();
    const secondWrite = deferred<unknown>();
    const writeStarted = [deferred<void>(), deferred<void>()];
    let writeIndex = 0;
    const drafts = draftStore({
      onWrite: async (_scope, draft, options) => {
        const index = writeIndex++;
        writeStarted[index]?.resolve();
        if (index === 0) await firstWrite.promise;
        if (index === 1) await secondWrite.promise;
        return { outcome: "saved", currentRevision: options.expectedRevision || String(draft.draftRevision) };
      }
    });
    const workflow = workflowAdapter();
    const ui = await bootStory({ actionDrafts: drafts, workflow });
    const input = ui.document.querySelector<HTMLTextAreaElement>("#freeAction");
    const submit = ui.document.querySelector<HTMLButtonElement>("#btnTakeAction");
    expect(input).not.toBeNull();
    expect(submit).not.toBeNull();

    input!.value = "Old campaign action";
    input!.dispatchEvent(new ui.window.Event("input", { bubbles: true }));
    submit!.click();
    await writeStarted[0]!.promise;

    // The registered recovery control invokes loadCampaign without re-registering DOM handlers.
    ui.document.querySelector<HTMLButtonElement>("#storyLoadRetry")!.click();
    await vi.waitFor(() => expect(ui.syncStatus).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(drafts.read.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(drafts.read.mock.calls.slice(0, 2).every(([scope]) =>
      (scope as { campaignId: string }).campaignId === CAMPAIGN_A)).toBe(true);

    input!.value = "New draft after reload";
    input!.dispatchEvent(new ui.window.Event("input", { bubbles: true }));
    submit!.click();
    firstWrite.resolve({ outcome: "saved", currentRevision: "revision-a" });
    await writeStarted[1]!.promise;

    // A stale completion from the prior load must not release the successor intent.
    submit!.click();
    await drainMicrotasks();
    secondWrite.resolve({ outcome: "saved", currentRevision: "revision-b" });
    await vi.waitFor(() => expect(workflow.submissions.length).toBeGreaterThan(0));
    await drainMicrotasks();
    const submittedActions = workflow.submissions.map(({ campaignId, input: submitted }) => ({
      campaignId,
      action: (submitted.request as Record<string, unknown> | undefined)?.action
    }));
    expect(submittedActions.map(({ action }) => action)).toEqual(["New draft after reload"]);
    expect(submittedActions.every(({ campaignId }) => campaignId === CAMPAIGN_A)).toBe(true);
  });

  it("prevents a programmatic ordinary submit from racing first-adventure startup", async () => {
    const drafts = draftStore();
    const workflow = workflowAdapter();
    const ui = await bootStory({
      campaigns: { [CAMPAIGN_A]: { turns: [], world: { firstAction: "Opening action", backgroundStory: "Opening background." } } },
      actionDrafts: drafts,
      workflow
    });
    await vi.waitFor(() => expect(ui.document.querySelector("#messagePopupDialog")?.hasAttribute("open")).toBe(true));
    const input = ui.document.querySelector<HTMLTextAreaElement>("#freeAction")!;
    input.value = "Competing player action";
    input.dispatchEvent(new ui.window.Event("input", { bubbles: true }));
    ui.document.querySelector<HTMLButtonElement>("#btnTakeAction")!.click();
    ui.document.querySelector<HTMLButtonElement>("#btnMessagePopupClose")!.click();
    await vi.waitFor(() => expect(workflow.submissions).toHaveLength(1));
    expect((workflow.submissions[0]?.input.request as Record<string, unknown> | undefined)?.action).toBe("Opening action");
    expect(workflow.submissions[0]?.campaignId).toBe(CAMPAIGN_A);
  });

  it("prevents a programmatic replacement from bypassing an append with an unpersisted draft", async () => {
    const pendingWrite = deferred<unknown>();
    const started = deferred<void>();
    const drafts = draftStore({ onWrite: async (_scope, draft, options) => {
      started.resolve();
      await pendingWrite.promise;
      return { outcome: "saved", currentRevision: options.expectedRevision || String(draft.draftRevision) };
    } });
    const workflow = workflowAdapter();
    const ui = await bootStory({ actionDrafts: drafts, workflow });
    const input = ui.document.querySelector<HTMLTextAreaElement>("#freeAction")!;
    input.value = "Append action";
    input.dispatchEvent(new ui.window.Event("input", { bubbles: true }));
    ui.document.querySelector<HTMLButtonElement>("#btnTakeAction")!.click();
    await started.promise;
    ui.document.querySelector<HTMLButtonElement>("#btnRetry")!.click();
    await drainMicrotasks();
    const retryDialog = ui.document.querySelector<HTMLDialogElement>("#retryPromptDialog")!;
    const retryEditor = ui.document.querySelector<HTMLTextAreaElement>("#retryPromptEditor")!;
    retryDialog.setAttribute("open", "");
    retryEditor.value = "Replacement action";
    ui.document.querySelector<HTMLButtonElement>("#btnRetryPromptSubmit")!.click();
    pendingWrite.resolve({ outcome: "saved", currentRevision: "revision-append" });
    await vi.waitFor(() => expect(workflow.submissions).toHaveLength(1));
    expect((workflow.submissions[0]?.input.request as Record<string, unknown> | undefined)?.action).toBe("Append action");
    expect(workflow.submissions[0]?.input.operationKind).toBe("append");
  });

  it.each(["removed", "absent"] as const)("preserves and saves a newer edit when stale-base discard is %s", async (outcome) => {
    const revision = "66666666-6666-4666-8666-666666666666";
    const removal = deferred<unknown>();
    const removeStarted = deferred<void>();
    const drafts = draftStore({
      onRead: () => staleDraft(revision),
      onRemove: async () => {
        removeStarted.resolve();
        return removal.promise;
      }
    });
    const workflow = workflowAdapter();
    const ui = await bootStory({ actionDrafts: drafts, workflow });
    await vi.waitFor(() => expect(ui.document.querySelector("#actionDraftConflict")?.classList.contains("hidden")).toBe(false));
    ui.document.querySelector<HTMLButtonElement>("#discardActionDraft")!.click();
    await removeStarted.promise;
    const input = ui.document.querySelector<HTMLTextAreaElement>("#freeAction")!;
    input.value = "New local edit";
    input.dispatchEvent(new ui.window.Event("input", { bubbles: true }));
    removal.resolve({ outcome });
    await drainMicrotasks();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(drafts.write).toHaveBeenCalledWith(
      { userId: USER_ID, campaignId: CAMPAIGN_A },
      expect.objectContaining({ text: "New local edit" }),
      { expectedRevision: null }
    );
    expect(input.value).toBe("New local edit");
    expect(ui.document.querySelector("#autosaveStatus")?.textContent).toBe("Draft saved");
  });

  it("keeps a newer acknowledged write when stale-base removal reports a conflict", async () => {
    const oldRevision = "66666666-6666-4666-8666-666666666666";
    const newRevision = "77777777-7777-4777-8777-777777777777";
    const removal = deferred<unknown>();
    const removeStarted = deferred<void>();
    let remote: Record<string, unknown> = staleDraft(oldRevision);
    const drafts = draftStore({
      onRead: () => remote,
      onRemove: async () => {
        removeStarted.resolve();
        return removal.promise;
      },
      onWrite: async (_scope, draft, options) => {
        remote = { ...draft, draftRevision: newRevision };
        return { outcome: "saved", currentRevision: newRevision, expectedRevision: options.expectedRevision };
      }
    });
    const workflow = workflowAdapter();
    const ui = await bootStory({ actionDrafts: drafts, workflow });
    await vi.waitFor(() => expect(ui.document.querySelector("#actionDraftConflict")?.classList.contains("hidden")).toBe(false));
    ui.document.querySelector<HTMLButtonElement>("#discardActionDraft")!.click();
    await removeStarted.promise;
    const input = ui.document.querySelector<HTMLTextAreaElement>("#freeAction")!;
    input.value = "Newer acknowledged edit";
    input.dispatchEvent(new ui.window.Event("input", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(drafts.write).toHaveBeenCalledWith(
      { userId: USER_ID, campaignId: CAMPAIGN_A },
      expect.objectContaining({ text: "Newer acknowledged edit" }),
      { expectedRevision: oldRevision }
    );
    removal.resolve({ outcome: "conflict" });
    await drainMicrotasks();
    expect(remote.draftRevision).toBe(newRevision);
    expect(remote.text).toBe("Newer acknowledged edit");
    expect(ui.document.querySelector("#autosaveStatus")?.textContent).toBe("Draft saved");
    expect(ui.document.querySelector("#actionDraftConflict")?.classList.contains("hidden")).toBe(true);
    expect(input.value).toBe("Newer acknowledged edit");
  });

  it("keeps an unsaved navigation guard when stale-base removal is unavailable", async () => {
    const removal = deferred<unknown>();
    const removeStarted = deferred<void>();
    const drafts = draftStore({
      onRead: () => staleDraft("66666666-6666-4666-8666-666666666666"),
      onWrite: async () => ({ outcome: "unavailable" }),
      onRemove: async () => {
        removeStarted.resolve();
        return removal.promise;
      }
    });
    const workflow = workflowAdapter();
    const ui = await bootStory({ actionDrafts: drafts, workflow });
    await vi.waitFor(() => expect(ui.document.querySelector("#actionDraftConflict")?.classList.contains("hidden")).toBe(false));
    ui.document.querySelector<HTMLButtonElement>("#discardActionDraft")!.click();
    await removeStarted.promise;
    const input = ui.document.querySelector<HTMLTextAreaElement>("#freeAction")!;
    input.value = "Unsaved local action";
    input.dispatchEvent(new ui.window.Event("input", { bubbles: true }));
    removal.resolve({ outcome: "unavailable" });
    await drainMicrotasks();
    const guard = new ui.window.Event("beforeunload", { cancelable: true });
    ui.window.dispatchEvent(guard);
    expect(guard.defaultPrevented).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(ui.document.querySelector("#autosaveStatus")?.textContent).toBe("Draft not saved");
    expect(input.value).toBe("Unsaved local action");
  });

  it("keeps an unsaved navigation guard when stale-base removal rejects", async () => {
    const drafts = draftStore({
      onRead: () => staleDraft("66666666-6666-4666-8666-666666666666"),
      onWrite: async () => ({ outcome: "unavailable" }),
      onRemove: async () => { throw new Error("storage unavailable"); }
    });
    const workflow = workflowAdapter();
    const ui = await bootStory({ actionDrafts: drafts, workflow });
    await vi.waitFor(() => expect(ui.document.querySelector("#actionDraftConflict")?.classList.contains("hidden")).toBe(false));
    ui.document.querySelector<HTMLButtonElement>("#discardActionDraft")!.click();
    const input = ui.document.querySelector<HTMLTextAreaElement>("#freeAction")!;
    input.value = "Unsaved after rejected discard";
    input.dispatchEvent(new ui.window.Event("input", { bubbles: true }));
    await vi.waitFor(() => expect(drafts.write).toHaveBeenCalled());

    const guard = new ui.window.Event("beforeunload", { cancelable: true });
    ui.window.dispatchEvent(guard);
    expect(guard.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(ui.document.querySelector("#autosaveStatus")?.textContent).toBe("Draft not saved"));
    expect(ui.document.querySelector("#autosaveStatus")?.textContent).toBe("Draft not saved");
    expect(input.value).toBe("Unsaved after rejected discard");
  });
});
