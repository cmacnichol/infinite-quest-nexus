import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import {
  captureCampaignStateEditSession,
  renderCampaignStateInspector,
  saveCampaignStateFromEditor
// @ts-expect-error Browser JavaScript modules intentionally do not publish TypeScript declarations.
} from "../../apps/web/src/story-state-editor.js";
import {
  cancelGeneration,
  reconcileRemoteGenerationCancellation,
  syncCancelGenerationButton
// @ts-expect-error Browser JavaScript modules intentionally do not publish TypeScript declarations.
} from "../../apps/web/src/story-generation-cancellation.js";
import * as storyModule from "../../apps/web/src/story.js";
import { DEDICATED_CHUNKED_AUDIT, TEXT_FALLBACK_LEGACY_AUDIT } from "../fixtures/chronicle-retrieval-audits.js";

const storyHtml = readFileSync("apps/web/public/story.html", "utf8");
const storyScript = readFileSync("apps/web/src/story.js", "utf8");
const storyCss = readFileSync("apps/web/public/story.css", "utf8");
const tokensCss = readFileSync("apps/web/public/tokens.css", "utf8");
const navigationCss = readFileSync("apps/web/public/navigation.css", "utf8");

async function bootLegacyStory({
  turns,
  nextCursor = null,
  continuousReading = false,
  fetchTurns = vi.fn(),
  syncStatus,
  updateProfile,
  rewindCampaign = vi.fn().mockResolvedValue({}),
  fetchCampaignState = vi.fn().mockResolvedValue({ activeTurnNumber: 100 }),
  classifyTurnInput,
  workflow = { resume: async () => null }
}: {
  turns: Array<Record<string, unknown>>;
  nextCursor?: string | null;
  continuousReading?: boolean;
  fetchTurns?: ReturnType<typeof vi.fn>;
  syncStatus?: ReturnType<typeof vi.fn>;
  updateProfile?: ReturnType<typeof vi.fn>;
  rewindCampaign?: ReturnType<typeof vi.fn>;
  fetchCampaignState?: ReturnType<typeof vi.fn>;
  classifyTurnInput?: ReturnType<typeof vi.fn>;
  workflow?: Record<string, unknown>;
}) {
  const { document, window } = parseHTML(storyHtml);
  Object.defineProperty(window, "location", { value: { pathname: "/story/campaign-1" }, configurable: true });
  for (const dialog of document.querySelectorAll("dialog")) {
    (dialog as unknown as { showModal: () => void }).showModal = () => dialog.setAttribute("open", "");
    (dialog as unknown as { close: () => void }).close = () => dialog.removeAttribute("open");
  }
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("Element", window.Element);
  vi.stubGlobal("HTMLElement", window.HTMLElement);
  vi.stubGlobal("HTMLInputElement", window.HTMLInputElement);
  vi.stubGlobal("localStorage", { getItem: () => null, removeItem: () => undefined, setItem: () => undefined });
  Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", { value: () => undefined, writable: true, configurable: true });
  Object.defineProperty(document.getElementById("userProfileDefaultTurnControlStyle"), "value", {
    value: "flexible_auto",
    writable: true,
    configurable: true
  });
  const syncCampaign = syncStatus || vi.fn().mockResolvedValue({
    campaign: { id: "campaign-1", title: "Long campaign", activeTurnNumber: 100, storyLengthProfile: "standard" },
    world: {},
    turns: { campaignId: "campaign-1", turns, nextCursor }
  });
  const saveProfile = updateProfile || vi.fn(async (profile) => ({
    user: { displayName: profile.displayName, settings: profile.settings }
  }));

  (storyModule.startStoryPlayer as (composition: unknown) => void)({
    api: {
      session: {
        get: async () => ({ user: { settings: { continuousReading, autoSubmitTurnChoices: false, defaultTurnControlStyle: "flexible_auto" } } }),
        updateProfile: saveProfile
      },
      providers: { list: async () => ({ providers: [{ providerRole: "text" }] }) },
      generation: { syncStatus: syncCampaign },
      campaigns: {
        state: fetchCampaignState,
        turns: fetchTurns,
        rewind: rewindCampaign,
        ...(classifyTurnInput ? { classifyTurnInput } : {})
      },
      meta: { get: async () => ({}) }
    },
    illustrations: { config: async () => ({ enabled: false, sourcePolicy: "off" }), segments: async () => ({ segments: [] }), imageJobs: async () => ({ jobs: [] }) },
    workflow,
    pendingSubmissions: { clear: () => undefined },
    idFactory: { create: () => "submission-101" },
    clock: { now: () => 1 }
  });
  document.dispatchEvent(new window.Event("DOMContentLoaded"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { document, window, fetchTurns, fetchCampaignState, rewindCampaign };
}

function controlledPrintWindow() {
  const writes: string[] = [];
  const printWindow = {
    opener: null,
    document: {
      images: [],
      open: vi.fn(),
      write: vi.fn((markup: string) => writes.push(markup)),
      close: vi.fn()
    },
    focus: vi.fn(),
    print: vi.fn(),
    close: vi.fn()
  };
  return { printWindow, writes };
}

const makeTurns = (first: number, last: number) => Array.from(
  { length: last - first + 1 },
  (_, offset) => ({
    id: `turn-${first + offset}`,
    turnNumber: first + offset,
    action: `Action ${first + offset}`,
    narration: `Narration ${first + offset}`
  })
);

function selectOption(select: HTMLSelectElement, value: string) {
  select.querySelectorAll("option").forEach((option) => { option.selected = false; });
  const option = select.querySelector(`option[value="${value}"]`) as HTMLOptionElement | null;
  if (!option) throw new Error(`Missing select option: ${value}`);
  option.selected = true;
}

describe("story-player: new Story Player UI contracts & gameplay logic", () => {
  it("uses semantic progress and a served stylesheet for printable story documents", () => {
    expect(storyScript).toContain('<progress class="turn-progress-meter" max="100" value="${percent}"');
    expect(storyScript).toContain('href="/nexus/story-print.css"');
  });

  it("dismisses player modals from their backdrop while protecting unsaved form edits", () => {
    expect(storyHtml).toContain('id="discardChangesDialog"');
    expect(storyHtml).toContain("Discard unsaved changes?");
    expect(storyScript).toContain("function modalFormSnapshot(dialog)");
    expect(storyScript).toContain("function openManagedModal(dialog)");
    expect(storyScript).toContain("function clickedDialogBackdrop(dialog, event)");
    expect(storyScript).toContain("function requestModalDismissal(dialog)");
    expect(storyScript).toContain("function installClickAwayModalDismissal()");
    expect(storyScript).toContain('discardModalTarget?.open');
    expect(storyScript).toContain('modalBaselines.get(dialog) !== modalFormSnapshot(dialog)');
  });

  it("routes Escape through the managed dismissal policy", () => {
    expect(storyScript).toContain('import { handleStoryEscape } from "./story-keyboard.js";');
    expect(storyScript).toContain('handleStoryEscape(event, { document, requestModalDismissal, closeNavigationMenus });');
    expect(storyScript).not.toContain('document.querySelectorAll("dialog[open]").forEach');
  });

  it("shows turn costs to four decimal places without a generated label", () => {
    expect(storyScript).toContain("minimumFractionDigits: 4");
    expect(storyScript).toContain("maximumFractionDigits: 4");
    expect(storyScript).toContain("${escapeHtml(reportedCost)}</span>");
    expect(storyScript).not.toContain("${escapeHtml(reportedCost)} generated</span>");
  });

  it("defines the complete Story Player DOM layout with story area, title bar, and input controls", () => {
    expect(storyHtml).toContain('id="storyArea"');
    expect(storyHtml).toContain('id="storyTitle"');
    expect(storyHtml).toContain('id="turnPill"');
    expect(storyHtml).toContain('id="viewPill"');
    expect(storyHtml).toContain('id="busyPill"');
    expect(storyHtml).toContain('id="choiceArea"');
    expect(storyHtml).toContain('id="freeAction"');
    expect(storyHtml).toContain('id="btnTakeAction"');
    expect(storyHtml).toContain('id="btnPrev"');
    expect(storyHtml).toContain('id="btnNext"');
    expect(storyHtml).toContain('id="btnUndo"');
    expect(storyHtml).toContain('id="btnRetry"');
  });

  it("contains all necessary dialog shells for in-game modals and setup", () => {
    expect(storyHtml).toContain('id="editStateDialog"');
    expect(storyHtml).toContain('id="worldSetupDialog"');
    expect(storyHtml).toContain('id="imagePromptDialog"');
    expect(storyHtml).not.toContain('id="assetLibraryDialog"');
    expect(storyHtml).not.toContain('id="assetLibraryFilters"');
    expect(storyHtml).toContain('/vendor/photoswipe/photoswipe.css');
    expect(storyHtml).toContain('id="editResponseDialog"');
    expect(storyHtml).toContain('id="retryPromptDialog"');
    expect(storyHtml).toContain('id="retryPromptEditor"');
    expect(storyHtml).toContain('id="btnRetryPromptCancel"');
    expect(storyHtml).toContain('id="btnRetryPromptSubmit"');
    expect(storyHtml).toContain('id="branchStoryDialog"');
    expect(storyHtml).toContain('id="activityLogDialog"');
    expect(storyHtml).toContain('id="messagePopupDialog"');
    expect(storyHtml).toContain('id="gettingStartedDialog"');
    expect(storyHtml).toContain('id="turnHistoryDialog"');
  });

  it("implements clean URL loading from /story/:campaignId without requiring sessionStorage", () => {
    expect(storyScript).toContain('const match = window.location.pathname.match(/\\/story\\/([^/]+)/);');
    expect(storyScript).toContain('state.campaignId = decodeURIComponent(match[1]);');
    expect(storyScript).toContain('recordActivity("system", "Empty Story page opened"');
    expect(storyScript).not.toContain('window.location.href = "/nexus/#campaigns";');
    expect(storyScript).toContain('await loadCampaign(state.campaignId);');
  });

  it("renders story narration separately from the illustration rail", () => {
    expect(storyScript).toContain('function renderScene(turn, index)');
    expect(storyScript).toContain('sceneDiv.className = "scene";');
    expect(storyScript).toContain('class="narration"');
    expect(storyScript).toContain('class="action-tag"');
    expect(storyScript).toContain('class="roll-disclosure"');
    expect(storyScript).toContain('class="roll-card ${passed ? "success" : "failure"}"');
    expect(storyHtml).toContain('id="storyIllustrationPanel"');
    expect(storyHtml).toContain('id="storyIllustrationContent"');
    expect(storyScript).toContain("function renderStoryIllustration()");
    expect(storyScript).toContain('class="image-wrap${selected ? "" : " image-job-placeholder"}"');
    expect(storyCss).toContain(".layout.has-illustration {");
    expect(storyCss).toContain(".story-illustration-panel {");
    expect(storyCss).toContain("position: sticky;");
    expect(storyScript).toContain('if (state.turns.length === 0) {');
    expect(storyScript).toContain('class="empty"');
  });

  it("supports choice selection and free action submission with input validation and busy indicator", () => {
    expect(storyScript).toContain('async function submitAction(actionText, options = {})');
    expect(storyScript).toContain('if (state.busy) return;');
    expect(storyScript).toContain('if (!action) { toast("Enter an action first."); return; }');
    expect(storyScript).toContain('function renderChoices(choices, customSuggestion, ownerKey)');
    expect(storyScript).toContain('submitAction(text)');
    expect(storyScript).toContain('freeAction.addEventListener("keydown", (e) => {');
    expect(storyScript).toContain('if (e.key === "Enter" && !e.shiftKey)');
  });

  it("supports campaign-controlled Action, Scene direction, and Auto turn input", () => {
    expect(storyHtml).toContain('id="turnInputModeSelector"');
    expect(storyHtml).toContain('data-turn-input-mode="auto"');
    expect(storyHtml).toContain('data-turn-input-mode="action"');
    expect(storyHtml).toContain('data-turn-input-mode="scene"');
    expect(storyHtml).toContain('id="turnInputModeLock"');
    expect(storyHtml).toContain('maxlength="12000"');
    expect(storyScript).toContain('function campaignTurnControlStyle()');
    expect(storyScript).toContain('state.campaign?.turnControlStyle || "flexible_auto"');
    expect(storyScript).toContain('campaignTurnControlStyle() === "action_only"');
    expect(storyScript).toContain('function setTurnInputMode(mode, options = {})');
    expect(storyScript).toContain('state.nextTurnInputModeSource = "generated_choice"');
    expect(storyScript).toContain('inputModeSource: "opening_action"');
  });

  it("exposes one-shot story-length overrides for normal and retry submissions", () => {
    expect(storyHtml).toContain('id="turnStoryLengthProfileOverride"');
    expect(storyHtml).toContain('id="retryStoryLengthProfileOverride"');
    expect(storyHtml).toContain('Campaign default — Standard');
    expect(storyHtml).toContain('<option value="brief">Brief</option>');
    expect(storyHtml).toContain('<option value="standard">Standard</option>');
    expect(storyHtml).toContain('<option value="long">Long</option>');
    expect(storyHtml).toContain('<option value="extended">Extended</option>');
    expect(storyScript).toContain('function selectedStoryLengthOverride(controlId)');
    expect(storyScript).toContain('function syncStoryLengthOverrideControls()');
    expect(storyScript).toContain('function resetStoryLengthOverrideControls()');
    expect(storyScript).toContain('storyLengthProfileOverride: submission.storyLengthProfileOverride');
  });

  it("submits and resets a one-shot legacy turn-length override after durable attachment", async () => {
    const workflow = {
      resume: async () => null,
      submit: vi.fn().mockResolvedValue({ jobId: "generation-override", watch: async function* () {} })
    };
    try {
      const { document, window } = await bootLegacyStory({ turns: makeTurns(1, 1), workflow });
      const length = document.getElementById("turnStoryLengthProfileOverride") as HTMLSelectElement;
      const action = document.getElementById("freeAction") as HTMLTextAreaElement;
      expect(length.options[0]?.textContent).toBe("Campaign default — Standard");

      selectOption(length, "extended");
      document.querySelector<HTMLElement>('[data-turn-input-mode="action"]')
        ?.dispatchEvent(new window.Event("click", { bubbles: true }));
      action.value = "Inspect the ruins";
      document.getElementById("btnTakeAction")?.dispatchEvent(new window.Event("click", { bubbles: true }));
      for (let attempt = 0; attempt < 8 && workflow.submit.mock.calls.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(workflow.submit).toHaveBeenCalledWith("campaign-1", expect.objectContaining({
        request: expect.objectContaining({ storyLengthProfileOverride: "extended" })
      }));
      expect(length.value).toBe("");
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps the captured Auto override through ambiguity and preserves it after an enqueue rejection", async () => {
    const classified = vi.fn().mockResolvedValue({ classification: "mixed", confidenceBand: "ambiguous", resolvedMode: "scene" });
    const rejectedWorkflow = {
      resume: async () => null,
      submit: vi.fn().mockRejectedValue(new Error("queue unavailable"))
    };
    try {
      const { document, window } = await bootLegacyStory({
        turns: makeTurns(1, 1),
        workflow: rejectedWorkflow,
        classifyTurnInput: classified,
        syncStatus: vi.fn().mockResolvedValue({
          campaign: { id: "campaign-1", title: "Long campaign", activeTurnNumber: 1, turnControlStyle: "flexible_auto", storyLengthProfile: "standard" },
          world: {},
          turns: { campaignId: "campaign-1", turns: makeTurns(1, 1), nextCursor: null }
        })
      });
      const length = document.getElementById("turnStoryLengthProfileOverride") as HTMLSelectElement;
      const action = document.getElementById("freeAction") as HTMLTextAreaElement;
      selectOption(length, "extended");
      action.value = "A mixed prompt";
      document.getElementById("btnTakeAction")?.dispatchEvent(new window.Event("click", { bubbles: true }));
      for (let attempt = 0; attempt < 8 && document.getElementById("turnIntentDecision")?.classList.contains("hidden"); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      expect(classified).toHaveBeenCalledWith("campaign-1", expect.objectContaining({ text: "A mixed prompt" }));
      selectOption(length, "brief");
      document.getElementById("btnSubmitAsAction")?.dispatchEvent(new window.Event("click", { bubbles: true }));
      for (let attempt = 0; attempt < 8 && rejectedWorkflow.submit.mock.calls.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(rejectedWorkflow.submit).toHaveBeenCalledWith("campaign-1", expect.objectContaining({
        request: expect.objectContaining({ storyLengthProfileOverride: "extended" })
      }));
      expect(length.value).toBe("brief");
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("preserves the selected length after a normal enqueue rejection", async () => {
    const workflow = {
      resume: async () => null,
      submit: vi.fn().mockRejectedValue(new Error("queue unavailable"))
    };
    try {
      const { document, window } = await bootLegacyStory({ turns: makeTurns(1, 1), workflow });
      const length = document.getElementById("turnStoryLengthProfileOverride") as HTMLSelectElement;
      const action = document.getElementById("freeAction") as HTMLTextAreaElement;
      selectOption(length, "long");
      document.querySelector<HTMLElement>('[data-turn-input-mode="action"]')
        ?.dispatchEvent(new window.Event("click", { bubbles: true }));
      action.value = "Inspect the ruins";
      document.getElementById("btnTakeAction")?.dispatchEvent(new window.Event("click", { bubbles: true }));
      for (let attempt = 0; attempt < 8 && workflow.submit.mock.calls.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(length.value).toBe("long");
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("submits a retry-dialog override without inferring one from the accepted turn", async () => {
    const workflow = {
      resume: async () => null,
      submit: vi.fn().mockResolvedValue({ jobId: "retry-override", watch: async function* () {} })
    };
    try {
      const { document, window } = await bootLegacyStory({ turns: makeTurns(1, 1), workflow });
      document.getElementById("btnRetry")?.dispatchEvent(new window.Event("click", { bubbles: true }));
      const retryEditor = document.getElementById("retryPromptEditor") as HTMLTextAreaElement;
      retryEditor.select = () => undefined;
      const retryLength = document.getElementById("retryStoryLengthProfileOverride") as HTMLSelectElement;
      expect(retryLength.options[0]?.textContent).toBe("Campaign default — Standard");
      selectOption(retryLength, "brief");
      document.getElementById("btnRetryPromptSubmit")?.dispatchEvent(new window.Event("click", { bubbles: true }));
      for (let attempt = 0; attempt < 8 && workflow.submit.mock.calls.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(workflow.submit).toHaveBeenCalledWith("campaign-1", expect.objectContaining({
        operationKind: "replace_latest",
        request: expect.objectContaining({ storyLengthProfileOverride: "brief" })
      }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps a rejected retry dialog's length selection for the next replacement attempt", async () => {
    const workflow = {
      resume: async () => null,
      submit: vi.fn()
        .mockRejectedValueOnce(new Error("queue unavailable"))
        .mockResolvedValueOnce({ jobId: "retry-after-rejection", watch: async function* () {} })
    };
    try {
      const { document, window } = await bootLegacyStory({ turns: makeTurns(1, 1), workflow });
      const retryEditor = document.getElementById("retryPromptEditor") as HTMLTextAreaElement;
      retryEditor.select = () => undefined;
      document.getElementById("btnRetry")?.dispatchEvent(new window.Event("click", { bubbles: true }));
      const retryDialog = document.getElementById("retryPromptDialog") as HTMLDialogElement;
      const retryLength = document.getElementById("retryStoryLengthProfileOverride") as HTMLSelectElement;
      selectOption(retryLength, "brief");
      document.getElementById("btnRetryPromptSubmit")?.dispatchEvent(new window.Event("click", { bubbles: true }));
      for (let attempt = 0; attempt < 8 && workflow.submit.mock.calls.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(retryDialog.hasAttribute("open")).toBe(true);
      expect(retryLength.value).toBe("brief");
      expect(workflow.submit.mock.calls[0]).toEqual(["campaign-1", expect.objectContaining({
        operationKind: "replace_latest",
        request: expect.objectContaining({ storyLengthProfileOverride: "brief" })
      })]);

      document.getElementById("btnRetryPromptSubmit")?.dispatchEvent(new window.Event("click", { bubbles: true }));
      for (let attempt = 0; attempt < 8 && workflow.submit.mock.calls.length < 2; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(workflow.submit).toHaveBeenLastCalledWith("campaign-1", expect.objectContaining({
        operationKind: "replace_latest",
        request: expect.objectContaining({ storyLengthProfileOverride: "brief" })
      }));
      expect(retryDialog.hasAttribute("open")).toBe(false);
      expect(retryLength.value).toBe("");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("uses the campaign preference and preserves the draft while toggling multiple generated choices", async () => {
    const { document, window } = parseHTML(storyHtml);
    Object.defineProperty(window, "location", { value: { pathname: "/story/campaign-1" }, configurable: true });
    for (const dialog of document.querySelectorAll("dialog")) {
      (dialog as unknown as { showModal: () => void; close: () => void }).showModal = () => dialog.setAttribute("open", "");
      (dialog as unknown as { showModal: () => void; close: () => void }).close = () => dialog.removeAttribute("open");
    }
    vi.stubGlobal("window", window);
    vi.stubGlobal("document", document);
    vi.stubGlobal("Element", window.Element);
    vi.stubGlobal("HTMLElement", window.HTMLElement);
    vi.stubGlobal("localStorage", { getItem: () => null, removeItem: () => undefined, setItem: () => undefined });
    (window.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => undefined;

    try {
      const turns = [{
        id: "turn-1",
        turnNumber: 1,
        action: "Wait",
        narration: "The gate remains closed.",
        choices: ["Open the gate.", "Call for the keeper."]
      }];
      const start = storyModule.startStoryPlayer as (composition: unknown) => void;
      start({
        api: {
          session: { get: async () => ({ user: { settings: { continuousReading: false, autoSubmitTurnChoices: false, defaultTurnControlStyle: "flexible_action" } } }) },
          providers: { list: async () => ({ providers: [{ providerRole: "text" }] }) },
          generation: { syncStatus: async () => ({ campaign: { title: "Choice campaign", activeTurnNumber: 1, turnControlStyle: "flexible_scene" }, world: {}, turns: { turns } }) },
          campaigns: { state: async () => ({ activeTurnNumber: 1 }), turns: async () => ({ turns }) },
          meta: { get: async () => ({}) }
        },
        illustrations: { config: async () => ({ enabled: false, sourcePolicy: "off" }), segments: async () => ({ segments: [] }), imageJobs: async () => ({ jobs: [] }) },
        workflow: { resume: async () => null }
      });
      document.dispatchEvent(new window.Event("DOMContentLoaded"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      for (let attempt = 0; attempt < 8 && !document.querySelector("#choiceArea .choice"); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      const input = document.getElementById("freeAction") as HTMLTextAreaElement;
      const choices = document.querySelectorAll<HTMLButtonElement>("#choiceArea .choice");
      input.value = "Keep watch.";
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
      expect(choices).toHaveLength(2);
      expect(choices[0]?.hasAttribute("disabled")).toBe(false);
      choices[0]?.dispatchEvent(new window.Event("click", { bubbles: true }));
      choices[1]?.dispatchEvent(new window.Event("click", { bubbles: true }));

      expect(document.getElementById("turnInputModeScene")?.getAttribute("aria-checked")).toBe("true");
      expect(input.value).toBe("Keep watch.\nOpen the gate.\nCall for the keeper.");
      expect(choices[0]?.getAttribute("aria-pressed")).toBe("true");
      expect(choices[1]?.getAttribute("aria-pressed")).toBe("true");

      choices[0]?.dispatchEvent(new window.Event("click", { bubbles: true }));
      expect(input.value).toBe("Keep watch.\nCall for the keeper.");
      expect(choices[0]?.getAttribute("aria-pressed")).toBe("false");

      input.value = "A custom combined direction.";
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
      expect(input.value).toBe("A custom combined direction.");
      expect(choices[1]?.getAttribute("aria-pressed")).toBe("false");

      choices[0]?.dispatchEvent(new window.Event("click", { bubbles: true }));
      const clearButton = document.querySelector<HTMLButtonElement>("#btnClearTurnInput");
      if (!clearButton) throw new Error("Clear turn text button is required.");
      expect(clearButton.disabled).toBe(false);
      let focusedAfterClear = false;
      input.focus = () => { focusedAfterClear = true; };
      clearButton.dispatchEvent(new window.Event("click", { bubbles: true }));

      expect(input.value).toBe("");
      expect(document.getElementById("turnInputCount")?.textContent).toBe("0 / 12,000");
      expect(choices[0]?.getAttribute("aria-pressed")).toBe("false");
      expect(clearButton.disabled).toBe(true);
      expect(focusedAfterClear).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("auto-submits a generated choice through Auto classification without treating it as a stale draft", async () => {
    const { document, window } = parseHTML(storyHtml);
    Object.defineProperty(window, "location", { value: { pathname: "/story/campaign-auto" }, configurable: true });
    for (const dialog of document.querySelectorAll("dialog")) {
      (dialog as unknown as { showModal: () => void; close: () => void }).showModal = () => dialog.setAttribute("open", "");
      (dialog as unknown as { showModal: () => void; close: () => void }).close = () => dialog.removeAttribute("open");
    }
    vi.stubGlobal("window", window);
    vi.stubGlobal("document", document);
    vi.stubGlobal("Element", window.Element);
    vi.stubGlobal("HTMLElement", window.HTMLElement);
    vi.stubGlobal("localStorage", { getItem: () => null, removeItem: () => undefined, setItem: () => undefined });
    (window.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => undefined;

    try {
      const turns = [{
        id: "turn-auto",
        turnNumber: 1,
        action: "Wait",
        narration: "The gate remains closed.",
        choices: ["Open the gate."]
      }];
      const classified: string[] = [];
      const submissions: unknown[] = [];
      const start = storyModule.startStoryPlayer as (composition: unknown) => void;
      start({
        api: {
          session: { get: async () => ({ user: { settings: { continuousReading: false, autoSubmitTurnChoices: true, defaultTurnControlStyle: "flexible_scene" } } }) },
          providers: { list: async () => ({ providers: [{ providerRole: "text" }] }) },
          generation: { syncStatus: async () => ({ campaign: { title: "Auto campaign", activeTurnNumber: 1, turnControlStyle: "flexible_auto", storyLengthProfile: "standard" }, world: {}, turns: { turns } }) },
          campaigns: {
            state: async () => ({ activeTurnNumber: 1 }),
            turns: async () => ({ turns }),
            classifyTurnInput: async (_campaignId: string, request: { text: string }) => {
              classified.push(request.text);
              return { classificationId: "classification-1", classification: "action", confidenceBand: "certain", resolvedMode: "action" };
            }
          },
          meta: { get: async () => ({}) }
        },
        illustrations: { config: async () => ({ enabled: false, sourcePolicy: "off" }), segments: async () => ({ segments: [] }), imageJobs: async () => ({ jobs: [] }) },
        workflow: {
          resume: async () => null,
          submit: async (_campaignId: string, submission: unknown) => {
            submissions.push(submission);
            return { jobId: "job-1", watch: async function* () {} };
          }
        },
        pendingSubmissions: { clear: () => undefined },
        idFactory: { create: () => "idempotency-1" },
        clock: { now: () => 1_000 }
      });
      document.dispatchEvent(new window.Event("DOMContentLoaded"));
      for (let attempt = 0; attempt < 10 && !document.querySelector("#choiceArea .choice"); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      selectOption(document.getElementById("turnStoryLengthProfileOverride") as HTMLSelectElement, "extended");
      document.querySelector<HTMLButtonElement>("#choiceArea .choice")?.dispatchEvent(new window.Event("click", { bubbles: true }));
      for (let attempt = 0; attempt < 10 && submissions.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      expect(document.getElementById("turnInputModeAuto")?.getAttribute("aria-checked")).toBe("true");
      expect(classified).toEqual(["Open the gate."]);
      expect(submissions).toHaveLength(1);
      expect(submissions[0]).toMatchObject({
        request: {
          action: "Open the gate.",
          requestedInputMode: "auto",
          resolvedInputMode: "action",
          classificationId: "classification-1",
          storyLengthProfileOverride: "extended"
        }
      });
      expect((document.getElementById("freeAction") as HTMLTextAreaElement).value).toBe("");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("classifies Auto immediately before submission and confirms ambiguous intent inline", () => {
    expect(storyHtml).toContain('id="turnIntentDecision"');
    expect(storyHtml).toContain('id="btnSubmitAsAction"');
    expect(storyHtml).toContain('id="btnSubmitAsScene"');
    expect(storyHtml).toContain('id="btnReturnToTurnEditor"');
    expect(storyScript).toContain('apiClient.campaigns.classifyTurnInput(state.campaignId, {');
    expect(storyScript).toContain('preferredFallback: preferredAutoFallback()');
    expect(storyScript).toContain('classification.confidenceBand === "ambiguous" || classification.classification === "mixed"');
    expect(storyScript).toContain('requestedInputMode: submission.requestedInputMode');
    expect(storyScript).toContain('resolvedInputMode: submission.resolvedInputMode');
    expect(storyScript).toContain('classificationId: submission.classificationId');
  });

  it("orchestrates turn generation through the shared workflow with progress, recovery, and retry", () => {
    expect(storyScript).toContain('async function runGeneration(action, options = {})');
    expect(storyScript).toContain('idempotencyKey: options.idempotencyKey || composition.idFactory.create()');
    expect(storyScript).toContain('const conflict = await resumeActiveGenerationConflict(error, state.campaignId, composition.workflow);');
    expect(storyScript).toContain('toast(conflict.message)');
    expect(storyScript).toContain('run = conflict.run;');
    expect(storyScript).not.toContain('async function enqueueGenerationSubmission(submission)');
    expect(storyScript).toContain('function updateGenerationProgress(job)');
    expect(storyScript).toContain('async function resumePendingGeneration()');
    expect(storyScript).toContain('const run = await composition.workflow.resume(state.campaignId);');
    expect(storyScript).toContain('The original turn was preserved.');
    expect(storyScript).toContain('class="replacement-pending-banner"');
  });

  it("adopts bounded sync windows and requests older pages before exhausting history navigation", () => {
    expect(storyScript).toContain("historyNextCursor: null");
    expect(storyScript).toContain("async function loadOlderTurnPage()");
    expect(storyScript).toContain("apiClient.campaigns.turns(campaignId, { before: requestedCursor }");
    expect(storyScript).toContain("storyTurnWindowIsCurrent(campaignId, epoch, requestedCursor)");
    expect(storyScript).toContain("syncData.turns || await apiClient.campaigns.turns(campaignId)");
  });

  it("delegates monitoring and durable pending submissions to the injected workflow", () => {
    expect(storyScript).toContain("composition.workflow.submit");
    expect(storyScript).toContain("composition.workflow.resume");
    expect(storyScript).toContain("presentGenerationEvents(events");
    expect(storyScript).not.toContain("new EventSource(");
    expect(storyScript).not.toContain("localStorage.setItem(key");
    expect(storyScript).not.toContain("/campaigns/${state.campaignId}/export");
  });

  it("shows the cancellation control only while a durable generation job is active", () => {
    const { document } = parseHTML('<div class="turn-streaming-header"></div>');
    const header = document.querySelector(".turn-streaming-header");
    if (!header) throw new Error("Streaming header is required.");
    const state = { generationDisplayActive: true, generationJobId: null as string | null };

    syncCancelGenerationButton(header, state);
    expect(header.querySelector('[data-action="cancel-generation"]')).toBeNull();

    state.generationJobId = "job-1";
    syncCancelGenerationButton(header, state);
    expect(header.querySelector('[data-action="cancel-generation"]')?.textContent).toBe("Cancel generation");

    state.generationDisplayActive = false;
    syncCancelGenerationButton(header, state);
    expect(header.querySelector('[data-action="cancel-generation"]')).toBeNull();
  });

  it("waits for durable cancellation before aborting monitoring and reloading campaign state", async () => {
    const { document } = parseHTML('<button data-action="cancel-generation">Cancel generation</button>');
    const button = document.querySelector("button") as HTMLButtonElement | null;
    if (!button) throw new Error("Cancellation button is required.");
    const state = {
      campaignId: "campaign-1",
      generationDisplayActive: true,
      generationJobId: "job-1",
      pendingGeneration: { id: "job-1" },
      cancellationConfirmed: false
    };
    const events: string[] = [];

    await cancelGeneration({
      state,
      getCancelButton: () => button,
      requestCancellation: async (jobId: string) => { events.push(`request:${jobId}`); },
      clearPendingSubmission: () => { events.push("clear-pending"); },
      restoreGenerationDisplay: () => { events.push("restore-display"); },
      abortLocalMonitoring: () => { events.push("abort-monitoring"); },
      reloadCampaign: async (campaignId: string) => { events.push(`reload:${campaignId}`); },
      recordActivity: () => { events.push("record"); },
      toast: () => { events.push("toast"); },
      showBusy: () => { events.push("busy"); }
    });

    expect(events).toEqual([
      "busy",
      "request:job-1",
      "clear-pending",
      "abort-monitoring",
      "restore-display",
      "reload:campaign-1",
      "record",
      "toast"
    ]);
    expect(state.pendingGeneration).toBeNull();
    expect(state.cancellationConfirmed).toBe(true);
  });

  it("preserves monitoring and re-enables cancellation after durable cancellation fails", async () => {
    const { document } = parseHTML('<button data-action="cancel-generation">Cancel generation</button>');
    const button = document.querySelector("button") as HTMLButtonElement | null;
    if (!button) throw new Error("Cancellation button is required.");
    const pendingGeneration = { id: "job-1" };
    const state = {
      campaignId: "campaign-1",
      generationDisplayActive: true,
      generationJobId: "job-1",
      pendingGeneration,
      cancellationConfirmed: false
    };
    const events: string[] = [];

    await cancelGeneration({
      state,
      getCancelButton: () => button,
      requestCancellation: async () => { throw new Error("Still generating"); },
      clearPendingSubmission: () => { events.push("clear-pending"); },
      restoreGenerationDisplay: () => { events.push("restore-display"); },
      abortLocalMonitoring: () => { events.push("abort-monitoring"); },
      reloadCampaign: async () => { events.push("reload"); },
      recordActivity: () => { events.push("record"); },
      toast: (message: string) => { events.push(message); },
      showBusy: () => { events.push("busy"); }
    });

    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe("Cancel generation");
    expect(state.pendingGeneration).toBe(pendingGeneration);
    expect(state.generationDisplayActive).toBe(true);
    expect(events).toEqual(["busy", "Could not cancel generation: Still generating"]);
  });

  it("reloads authoritative state when remote monitoring reports cancellation", async () => {
    const state = {
      campaignId: "campaign-1",
      generationDisplayActive: true,
      generationJobId: "job-1",
      pendingGeneration: { id: "job-1" }
    };
    const events: string[] = [];

    const cancellation = await reconcileRemoteGenerationCancellation({
      state,
      clearPendingSubmission: () => { events.push("clear-pending"); },
      restoreGenerationDisplay: () => { events.push("restore-display"); },
      reloadCampaign: async (campaignId: string) => { events.push(`reload:${campaignId}`); },
      toast: (message: string) => { events.push(message); }
    });

    expect(cancellation.name).toBe("AbortError");
    expect(state.pendingGeneration).toBeNull();
    expect(events).toEqual(["clear-pending", "restore-display", "reload:campaign-1"]);
  });

  it("reconciles an accepted generation result without reloading the campaign view", () => {
    const finalizeStart = storyScript.indexOf("async function finalizeCompletedGeneration(result)");
    const finalizeEnd = storyScript.indexOf("\nasync function observeGenerationRun", finalizeStart);
    const finalize = storyScript.slice(finalizeStart, finalizeEnd);
    const reconcileStart = storyScript.indexOf("async function reconcileCompletedGeneration(result)");
    const reconcileEnd = storyScript.indexOf("\nasync function observeGenerationRun", reconcileStart);
    const reconcile = storyScript.slice(reconcileStart, reconcileEnd);

    expect(finalize).toContain("replaceStreamingPreviewWithAcceptedTurn(result, preserveViewport)");
    expect(finalize).toContain("void reconcileCompletedGeneration(result);");
    expect(finalize).toContain("if (!replaceStreamingPreviewWithAcceptedTurn(result, preserveViewport)) {");
    expect(finalize).toContain("await loadCampaign(state.campaignId, { autoScroll: !preserveViewport });");
    expect(reconcile).not.toContain("loadCampaign(");
  });

  it("renders streaming narration full-width in the same scene structure as a completed turn", () => {
    expect(storyScript).toContain('card.className = "scene no-image turn-streaming-preview";');
    expect(storyScript).toContain('<div class="scene-narration">');
    expect(storyScript).toContain('<div class="turn-streaming-header">');
    expect(storyScript).toContain('<div class="turn-meta">');
    expect(storyCss).toContain('.turn-streaming-preview {\n  grid-template-columns: minmax(0, 1fr);');
    expect(storyCss).not.toContain('.turn-streaming-preview {\n  display: flex;');
  });

  it("hides prior turn controls during generation and restores them only after resolution", () => {
    expect(storyScript).toContain("function beginGenerationDisplay(action)");
    expect(storyScript).toContain("function restoreGenerationDisplay()");
    expect(storyScript).toContain("function commitGenerationDisplay(removeStreamingPreview = true)");
    expect(storyScript).toContain("function renderTurnInput()");
    expect(storyScript).toContain('const shouldShowInput = !state.generationDisplayActive && isLatest;');
    expect(storyScript).toContain('inputPanel.classList.toggle("hidden", !shouldShowInput);');
    expect(storyScript).toContain("container.replaceChildren();");
    expect(storyScript).toContain("beginGenerationDisplay(action);");
    expect(storyScript).toContain("restoreGenerationDisplay();");
    expect(storyScript).toContain("commitGenerationDisplay(false);");
    expect(storyScript).toContain("if (!replaceStreamingPreviewWithAcceptedTurn(result, preserveViewport)) {");
    expect(storyScript).toContain("state.generationDisplayActive");
  });

  it("pauses streaming auto-follow after manual scrolling and allows explicit resume", () => {
    expect(storyScript).toContain("streamingAutoFollow: true");
    expect(storyScript).toContain('window.addEventListener("wheel", pauseStreamingAutoFollow');
    expect(storyScript).toContain('window.addEventListener("touchmove", pauseStreamingAutoFollow');
    expect(storyScript).toContain('window.addEventListener("scroll", () => {');
    expect(storyScript).toContain("streamingExpectedScrollY");
    expect(storyScript).toContain('function pauseStreamingAutoFollow()');
    expect(storyScript).toContain('if (state.streamingAutoFollow) {\n    followStreamingPreview();');
    expect(storyScript).toContain('data-action="follow-stream"');
    expect(storyScript).not.toContain("  scrollToView();\n}\n\nfunction clearStreamingPreview");
    expect(storyCss).toContain(".streaming-follow-button {");
  });

  it("preserves a manually positioned viewport when streaming becomes an accepted turn", () => {
    expect(storyScript).toContain("async function loadCampaign(campaignId, options = {})");
    expect(storyScript).toContain("function renderAllScenes(options = {})");
    expect(storyScript).toContain("if (options.autoScroll !== false) scrollToView();");
    expect(storyScript).toContain("async function finalizeCompletedGeneration(result)");
    expect(storyScript).toContain('const preserveViewport = Boolean($("streamingPreviewCard")) && !state.streamingAutoFollow;');
    expect(storyScript).toContain("if (!replaceStreamingPreviewWithAcceptedTurn(result, preserveViewport)) {");
    expect(storyScript).toContain('await loadCampaign(state.campaignId, { autoScroll: !preserveViewport });\n    restoreViewportAfterRender(viewport);');
    expect(storyScript).toContain("function restoreViewportAfterRender(viewport)");
    expect(storyScript).toContain("window.requestAnimationFrame(() => {");
    expect(storyScript).toContain('window.scrollTo({ ...viewport, behavior: "auto" });');
    expect(storyScript).toContain('onCompleted: finalizeCompletedGeneration');
    expect(storyScript).toContain('await finalizeCompletedGeneration(result);');
  });

  it("restores the manually positioned viewport after a completed turn replaces the stream", async () => {
    let completeGeneration!: () => void;
    const completion = new Promise<void>((resolve) => { completeGeneration = resolve; });
    const workflow = {
      resume: async () => null,
      submit: vi.fn().mockResolvedValue({
        jobId: "generation-2",
        async *watch() {
          yield { type: "narration", text: "Streaming narration." };
          await completion;
          yield {
            type: "settled",
            outcome: "completed",
            result: {
              resultTurnId: "turn-2",
              turnNumber: 2,
              action: "Inspect the ruins",
              narration: "The ruins answer with a distant bell."
            }
          };
        }
      })
    };
    try {
      const { document, window } = await bootLegacyStory({
        turns: makeTurns(1, 1),
        workflow
      });
      let scrollLeft = 24;
      let scrollTop = 480;
      const scrollTo = vi.fn(({ left, top }: { left: number; top: number }) => {
        scrollLeft = left;
        scrollTop = top;
      });
      Object.defineProperties(window, {
        scrollX: { configurable: true, get: () => scrollLeft },
        scrollY: { configurable: true, get: () => scrollTop },
        requestAnimationFrame: { configurable: true, value: (callback: FrameRequestCallback) => {
          callback(0);
          return 1;
        } },
        scrollTo: { configurable: true, value: scrollTo }
      });

      document.querySelector<HTMLElement>('[data-turn-input-mode="action"]')
        ?.dispatchEvent(new window.Event("click", { bubbles: true }));
      const action = document.getElementById("freeAction") as HTMLTextAreaElement;
      action.value = "Inspect the ruins";
      document.getElementById("btnTakeAction")?.dispatchEvent(new window.Event("click", { bubbles: true }));
      for (let attempt = 0; attempt < 8 && !document.getElementById("streamingPreviewCard"); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      const preview = document.getElementById("streamingPreviewCard") as HTMLElement | null;
      if (!preview) throw new Error("Streaming preview is required.");
      const replaceWith = preview.replaceWith.bind(preview);
      preview.replaceWith = (...nodes: (string | Node)[]) => {
        scrollTop = 0;
        replaceWith(...nodes);
      };
      window.dispatchEvent(new window.Event("wheel"));
      completeGeneration();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(document.getElementById("scene-2")).not.toBeNull();
      expect(scrollTo).toHaveBeenCalledWith({ left: 24, top: 480, behavior: "auto" });
      expect(scrollLeft).toBe(24);
      expect(scrollTop).toBe(480);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("provides history navigation with view mode toggling, undo, retry, and branch/reset handling", () => {
    expect(storyScript).toContain('function goToPrevious()');
    expect(storyScript).toContain('function goToNext()');
    expect(storyScript).toContain('async function undoLatest()');
    expect(storyScript).toContain('apiClient.campaigns.rewind(state.campaignId');
    expect(storyScript).toContain('import { branchCampaignFromTurn } from "./story-routing.js";');
    expect(storyScript).not.toContain('history-branch-btn');
    expect(storyScript).not.toContain('history-state-btn');
    expect(storyScript).not.toContain('history-jump-btn');
    expect(storyHtml).toContain('Restart / Branch from Here…');
    expect(storyScript).toContain('async function retryLatest()');
    expect(storyScript).toContain('function openRetryPromptDialog(originalPrompt)');
    expect(storyScript).toContain('async function executeRetryWithPrompt(submittedPromptText)');
    expect(storyScript).toContain('expectedCurrentTurnNumber: currentTurnNumber');
    expect(storyScript).toContain('await runGeneration(action, {');
    expect(storyScript).not.toContain('confirm("Retry the last turn? The current outcome will be replaced.")');
    expect(storyScript).toContain('branchDlg.addEventListener("close"');
    expect(storyScript).toContain('await branchCampaignFromTurn(state.campaignId, branchDlg._targetTurnNumber, apiClient.campaigns.branch);');
    expect(storyScript).toContain('function openTurnHistoryModal()');
    expect(storyScript).toContain('el.addEventListener("click", openTurnHistoryModal);');
    expect(storyScript).toContain("await ensureCompleteTurnHistory();");
    expect(storyScript).toContain("async function printStory()");
    expect(storyScript).toContain("loadCompleteStoryHistory({");
    expect(storyHtml).toContain('id="turnHistoryLoadStatus"');
  });

  it("uses authoritative turn numbers for persistent view and History selection", () => {
    expect(storyScript).toContain("viewTurnNumber: null");
    expect(storyScript).toContain("historySelectedTurnNumber: null");
    expect(storyScript).toContain("function viewedTurnIndex()");
    expect(storyScript).toContain("turnIndexForNumber(state.turns, state.viewTurnNumber)");
    expect(storyScript).toContain("function navigateToTurn(turnNumber)");
    expect(storyScript).toContain("promptBranchOrReset(state.historySelectedTurnNumber)");
    expect(storyScript).not.toContain("viewIndex:");
    expect(storyScript).not.toContain("historySelectedIndex:");
  });

  it("never derives a user-visible turn label from an array index", () => {
    expect(storyScript).toContain('sceneDiv.id = `scene-${turn.turnNumber}`;');
    expect(storyScript).toContain("sceneDiv.dataset.turnNumber = turn.turnNumber;");
    expect(storyScript).toContain('<span class="pill">Turn ${turn.turnNumber}</span>');
    expect(storyScript).toContain('turnLabel.textContent = `Turn ${turn.turnNumber}`;');
    expect(storyScript).toContain('<h2>Turn ${turn.turnNumber}${action}</h2>');
    expect(storyScript).not.toMatch(/Turn \$\{(?:index|turnIndex) \+ 1\}/u);
    expect(storyScript).not.toMatch(/turn=\$\{turnIndex \+ 1\}/u);
  });

  it("selects accessible history cards and routes footer actions to the selected turn", () => {
    expect(storyHtml).toContain('id="btnTurnHistoryInspect"');
    expect(storyHtml).toContain('id="btnTurnHistoryJump"');
    expect(storyHtml).toContain('id="btnTurnHistoryBranch"');
    expect(storyHtml).toContain('class="row wrap dialog-actions history-dialog-actions"');
    expect(storyScript).toContain('state.historySelectedTurnNumber = null;');
    expect(storyScript).toContain('const currentTurnNumber = currentViewTurnNumber();');
    expect(storyScript).toContain('const selectedTurnNumber = Number.isInteger(state.historySelectedTurnNumber)');
    expect(storyScript).toContain('selectHistoryTurn(selectedTurnNumber);');
    expect(storyScript).toContain('card.setAttribute("role", "button");');
    expect(storyScript).toContain('card.setAttribute("tabindex", "0");');
    expect(storyScript).toContain('card.setAttribute("aria-pressed", "false");');
    expect(storyScript).toContain('if (event.key === "Enter" || event.key === " ")');
    expect(storyScript).toContain('card.classList.toggle("selected", selected);');
    expect(storyScript).toContain('if (state.historySelectedTurnNumber) inspectTurnState(state.historySelectedTurnNumber);');
    expect(storyScript).toContain('inspectBtn.disabled = !hasSelection;');
    expect(storyScript).toContain('jumpBtn.disabled = !hasSelection;');
    expect(storyScript).toContain('branchBtn.classList.toggle("hidden", !hasSelection || state.historySelectedTurnNumber >= state.campaign?.activeTurnNumber);');
    expect(storyScript).toContain('navigateToTurn(state.historySelectedTurnNumber);');
    expect(storyScript).toContain('promptBranchOrReset(state.historySelectedTurnNumber);');
    expect(storyCss).toContain('.history-card.selected, .history-card[aria-pressed="true"]');
  });

  it("manages the enabled illustration rail, prompt editing, polling, and generation activity", () => {
    expect(storyScript).toContain('function pollImageJobs()');
    expect(storyScript).toContain('function renderSceneImageJob(job)');
    expect(storyScript).toContain('function recordImageJobActivity(job, options = {})');
    expect(storyScript).toContain('recordActivity("success", "Illustration generated"');
    expect(storyScript).toContain('recordActivity("error", "Illustration generation failed"');
    expect(storyScript).toContain('recordActivity("image", "Illustration generation progress"');
    expect(storyScript).toContain('["queued", "generating", "provider_pending", "downloading"]');
    expect(storyScript).toContain('aria-label", `Illustration generation progress');
    expect(storyScript).toContain('illustrationApi.imageJobs(state.campaignId)');
    expect(storyScript).toContain('illustrationApi.config(campaignId)');
    expect(storyScript).toContain('state.illustrationConfig?.sourcePolicy !== "off"');
    expect(storyScript).toContain('function openImagePromptEditor(turnId)');
    expect(storyScript).not.toContain('async function regenerateIllustration(turnId, prompt)');
    expect(storyScript).not.toContain('/turns/${turnId}/illustrations');
    expect(storyScript).toContain('data-action="edit-segment-image-prompt"');
    expect(storyScript).toContain('data-action="regenerate-segment-image"');
    expect(storyScript).toContain('data-action="why-segment-image"');
    expect(storyScript).not.toContain('class="segment-image-more"');
    expect(storyScript).toContain('aria-label="Preview or edit this image prompt"');
    expect(storyScript).toContain('aria-label="Regenerate only this image"');
    expect(storyScript).not.toContain('aria-label="More image controls"');
    expect(storyCss).toContain(".segment-image-icon { width: 34px;");
    expect(storyScript).toContain("function openSegmentImagePromptEditor(segmentId, variantIndex)");
    expect(storyScript).toContain("async function regenerateSegmentImage(segmentId, variantIndex, prompt)");
    expect(storyScript).toContain("function whySegmentImage(segmentId, variantIndex)");
    expect(storyScript).not.toContain("async function removeSegmentImage(segmentId, variantIndex)");
    expect(storyScript).toContain('illustrationApi.regenerateSegmentImage(segmentId');
    expect(storyScript).toContain("const isCurrentTurn = Number(turn.turnNumber) === Number(state.campaign?.activeTurnNumber);");
    expect(storyHtml).toContain('id="imagePromptDialogTitle"');
    expect(storyScript).toContain('async function pollIllustrationResolution(turnId)');
    expect(storyScript).not.toContain("function installIllustrationSegmentObserver()");
    expect(storyScript).toContain("function segmentIllustrationMarkup(turn, turnIndex, segment, segmentCount)");
    expect(storyScript).toContain('class="segment-illustration-sticky"');
    expect(storyScript).toContain('class="segment-illustration-content" data-segment-id=');
    expect(storyScript).toContain('data-action="generate-turn-segments"');
    expect(storyScript).toContain('data-action="rebuild-turn-segments"');
    expect(storyScript).toContain('data-action="previous-segment-image"');
    expect(storyScript).toContain('data-action="next-segment-image"');
    expect(storyCss).toContain(".narration-segment {");
    expect(storyCss).toContain(".segment-illustration-sticky { position: sticky; top: 76px; }");
    expect(storyCss).toContain(".segment-illustration-content .image-wrap { position: relative;");
    expect(storyCss).toContain(".layout.has-segmented-illustrations .story-shell");
    expect(storyCss).toContain("overflow: clip;");
    expect(storyCss).toContain(".illustration-carousel {");
  });

  it("edits authoritative current state while keeping history inspection under the Turn Pill", () => {
    expect(storyScript).toContain('async function openEditState()');
    expect(storyScript).toContain('function switchEditStateTab(tabName)');
    expect(storyScript).toContain('async function saveEditState()');
    expect(storyScript).toContain('apiClient.campaigns.state(state.campaignId, turnNumber)');
    expect(storyScript).toContain('async function inspectTurnState(turnNumber)');
    expect(storyHtml).toContain('id="scratchpadEditor"');
    expect(storyHtml).toContain('id="turnHistoryStatePanel"');
    expect(storyHtml).not.toContain('id="tab-history"');
    expect(storyScript).toContain('const btnSaveEditState = $("btnSaveEditState") || $("btnSaveScratch");');
  });

  it("saves editor DOM values through the campaign-state API before applying the response", async () => {
    const { document } = parseHTML(`
      <dialog open id="editStateDialog"></dialog>
      <textarea id="summary">Corrected summary.</textarea>
      <div id="threads"><div class="state-editor-row"><textarea>Find the keeper.</textarea></div></div>
      <div id="facts"><div class="state-editor-row" data-item-id="00000000-0000-4000-8000-000000000001"><textarea>The lens is moon glass.</textarea></div></div>
      <textarea id="scratchpad">Private continuity.</textarea>
    `);
    const dialog = document.querySelector("#editStateDialog") as unknown as HTMLDialogElement | null;
    const summary = document.querySelector("#summary") as unknown as HTMLTextAreaElement | null;
    const threads = document.querySelector("#threads");
    const facts = document.querySelector("#facts");
    const scratchpad = document.querySelector("#scratchpad") as unknown as HTMLTextAreaElement | null;
    if (!dialog || !summary || !threads || !facts || !scratchpad) throw new Error("Editor controls are required.");
    dialog.close = () => dialog.removeAttribute("open");

    const runtimeState = {
      activeTurnNumber: 4,
      revision: 7,
      rpgStats: [{ id: "resolve", name: "Resolve", value: 61, note: "" }],
      eventTriggers: [],
      pendingEventTriggers: []
    };
    const response = { ...runtimeState, revision: 8 };
    const requests: Array<{ campaignId: string; value: unknown }> = [];
    let appliedState = runtimeState;

    await saveCampaignStateFromEditor(
      async (campaignId: string, value: unknown) => {
        requests.push({ campaignId, value });
        return response;
      },
      "campaign-id",
      runtimeState,
      { summary, threads, facts, scratchpad, trackers: [{ id: "trust", name: "Trust", value: "wary", rules: "" }] },
      (savedState: typeof response) => {
        appliedState = savedState;
        dialog.close();
      }
    );

    expect(requests).toEqual([{
      campaignId: "campaign-id",
      value: {
          expectedTurnNumber: 4,
          expectedRevision: 7,
          effectiveTurnNumber: 4,
          continuitySummary: "Corrected summary.",
          openThreads: ["Find the keeper."],
          canonicalFacts: [{ id: "00000000-0000-4000-8000-000000000001", content: "The lens is moon glass." }],
          scratchpad: "Private continuity.",
          trackers: [{ id: "trust", name: "Trust", value: "wary", rules: "" }],
          rpgStats: runtimeState.rpgStats,
          eventTriggers: [],
          pendingEventTriggers: []
      }
    }]);
    expect(appliedState).toBe(response);
    expect(dialog.hasAttribute("open")).toBe(false);
  });

  it("keeps editor controls and state intact when a campaign-state save is rejected", async () => {
    const { document } = parseHTML(`
      <dialog open id="editStateDialog"></dialog>
      <textarea id="summary">Corrected summary.</textarea>
      <div id="threads"><div class="state-editor-row"><textarea>Find the keeper.</textarea></div></div>
      <div id="facts"><div class="state-editor-row" data-item-id="00000000-0000-4000-8000-000000000001"><textarea>The lens is moon glass.</textarea></div></div>
      <textarea id="scratchpad">Private continuity.</textarea>
    `);
    const dialog = document.querySelector("#editStateDialog") as unknown as HTMLDialogElement | null;
    const summary = document.querySelector("#summary") as unknown as HTMLTextAreaElement | null;
    const threads = document.querySelector("#threads");
    const facts = document.querySelector("#facts");
    const scratchpad = document.querySelector("#scratchpad") as unknown as HTMLTextAreaElement | null;
    if (!dialog || !summary || !threads || !facts || !scratchpad) throw new Error("Editor controls are required.");

    const runtimeState = {
      activeTurnNumber: 4,
      revision: 7,
      rpgStats: [],
      eventTriggers: [],
      pendingEventTriggers: []
    };
    let appliedState = runtimeState;

    await expect(saveCampaignStateFromEditor(
      async () => { throw new Error("Campaign state changed."); },
      "campaign-id",
      runtimeState,
      { summary, threads, facts, scratchpad, trackers: [] },
      (savedState: typeof runtimeState) => { appliedState = savedState; dialog.removeAttribute("open"); }
    )).rejects.toThrow("Campaign state changed.");

    expect(appliedState).toBe(runtimeState);
    expect(dialog.hasAttribute("open")).toBe(true);
    expect(summary.value).toBe("Corrected summary.");
    expect((threads.querySelector("textarea") as unknown as HTMLTextAreaElement | null)?.value)
      .toBe("Find the keeper.");
    expect((facts.querySelector("textarea") as unknown as HTMLTextAreaElement | null)?.value)
      .toBe("The lens is moon glass.");
    expect(scratchpad.value).toBe("Private continuity.");
  });

  it("saves with the state captured at editor hydration after the live runtime state refreshes", async () => {
    const { document } = parseHTML(`
      <textarea id="summary">Corrected summary.</textarea>
      <div id="threads"><div class="state-editor-row"><textarea>Find the keeper.</textarea></div></div>
      <div id="facts"><div class="state-editor-row"><textarea>New fact.</textarea></div></div>
      <textarea id="scratchpad">Private continuity.</textarea>
    `);
    const summary = document.querySelector("#summary") as unknown as HTMLTextAreaElement | null;
    const threads = document.querySelector("#threads");
    const facts = document.querySelector("#facts");
    const scratchpad = document.querySelector("#scratchpad") as unknown as HTMLTextAreaElement | null;
    if (!summary || !threads || !facts || !scratchpad) throw new Error("Editor controls are required.");

    let runtimeState = {
      activeTurnNumber: 4,
      revision: 7,
      rpgStats: [{ id: "resolve", name: "Resolve", value: 61, note: "" }],
      eventTriggers: [{ id: "lens-lit", label: "Lens lit" }],
      pendingEventTriggers: [{ id: "sea-road", name: "Sea road" }]
    };
    const editSession = captureCampaignStateEditSession(runtimeState);
    runtimeState.rpgStats[0]!.value = 62;

    runtimeState = {
      activeTurnNumber: 5,
      revision: 8,
      rpgStats: [{ id: "resolve", name: "Resolve", value: 75, note: "Refreshed" }],
      eventTriggers: [{ id: "gate-open", label: "Gate open" }],
      pendingEventTriggers: []
    };
    const requests: Array<{ campaignId: string; value: unknown }> = [];

    await saveCampaignStateFromEditor(
      async (campaignId: string, value: unknown) => {
        requests.push({ campaignId, value });
        return runtimeState;
      },
      "campaign-id",
      editSession,
      { summary, threads, facts, scratchpad, trackers: [] },
      () => {}
    );

    expect(requests[0]?.value).toEqual({
      expectedTurnNumber: 4,
      expectedRevision: 7,
      effectiveTurnNumber: 4,
      continuitySummary: "Corrected summary.",
      openThreads: ["Find the keeper."],
      canonicalFacts: [{ id: null, content: "New fact." }],
      scratchpad: "Private continuity.",
      trackers: [],
      rpgStats: [{ id: "resolve", name: "Resolve", value: 61, note: "" }],
      eventTriggers: [{ id: "lens-lit", label: "Lens lit" }],
      pendingEventTriggers: [{ id: "sea-road", name: "Sea road" }]
    });
  });

  it("renders historical structured facts as safe read-only content", () => {
    const { document } = parseHTML('<section id="panel"></section>');
    const panel = document.querySelector("#panel");
    if (!panel) throw new Error("History panel is required.");

    renderCampaignStateInspector(panel, {
      isCurrent: false,
      viewedTurnNumber: 3,
      continuitySummary: "Earlier summary.",
      scratchpad: "Private notes.",
      trackers: [{ name: "Trust", value: "Wary" }],
      openThreads: ["Find <the keeper>."],
      canonicalFacts: [
        { id: "00000000-0000-4000-8000-000000000001", content: "The lens is moon glass." },
        { id: "00000000-0000-4000-8000-000000000002", content: '<img src=x onerror="alert(1)">' }
      ]
    });

    expect(panel.textContent).toContain("Historical state after turn 3");
    expect(panel.textContent).toContain("Changes apply only to this saved turn");
    expect(panel.textContent).toContain("The lens is moon glass.");
    expect(panel.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(panel.textContent).not.toContain("[object Object]");
    expect(panel.innerHTML).toContain("&lt;img src=x onerror=\"alert(1)\"&gt;");
    expect(panel.querySelector("img")).toBeNull();
    expect(panel.querySelector("input, textarea, select, button")).toBeNull();
  });

  it("provides editable continuity controls while keeping mechanics read-only", () => {
    const { document } = parseHTML(storyHtml);
    const dialog = document.querySelector("#editStateDialog");

    expect(dialog?.querySelector("textarea#editStateContinuitySummary")).not.toBeNull();
    expect(dialog?.querySelector("button#btnAddOpenThread")?.textContent).toContain("Add thread");
    expect(dialog?.querySelector("#editStateOpenThreads")).not.toBeNull();
    expect(dialog?.querySelector("button#btnAddCanonicalFact")?.textContent).toContain("Add fact");
    expect(dialog?.querySelector("#editStateCanonicalFacts")).not.toBeNull();
    expect(dialog?.querySelector("#editStateRpgStatsEditor")).toBeNull();
    expect(dialog?.querySelector("#tab-mechanics")?.textContent).toContain(
      "Generated mechanics are static for this campaign and are shown for context."
    );
  });

  it("shows the recorded Story Engine prompt interpretation on every turn-history card", () => {
    expect(storyScript).toContain('const inputMode = t.inputMode === "scene" ? "scene" : "action";');
    expect(storyScript).toContain('const inputModeLabel = inputMode === "scene" ? "Scene direction" : "Action";');
    expect(storyScript).toContain('class="turn-input-mode-pill ${inputMode}"');
    expect(storyScript).toContain('aria-label="Prompt interpretation: ${inputModeLabel}"');
    expect(storyCss).toContain('.turn-input-mode-pill {');
    expect(storyCss).toContain('.turn-input-mode-pill.scene {');
  });

  it("renders recorded and Unknown Chronicle retrieval details as escaped, labelled turn-history metadata", () => {
    const markup = (storyModule as Record<string, unknown>).chronicleRetrievalHistoryMarkup;
    expect(typeof markup).toBe("function");
    if (typeof markup !== "function") return;
    const hostileAudit = {
      ...DEDICATED_CHUNKED_AUDIT,
      provider: {
        ...DEDICATED_CHUNKED_AUDIT.provider,
        providerType: '<img data-hostile="provider">',
        model: '<script data-hostile="model"></script>'
      }
    };
    const { document } = parseHTML(`<section>
      <article class="history-card" role="button" tabindex="0">${(markup as (audit: unknown) => string)(TEXT_FALLBACK_LEGACY_AUDIT)}</article>
      <article class="history-card" role="button" tabindex="0">${(markup as (audit: unknown) => string)(null)}</article>
      <article class="history-card" role="button" tabindex="0">${(markup as (audit: unknown) => string)(hostileAudit)}</article>
    </section>`);
    const audits = document.querySelectorAll('dl[aria-label="Chronicle retrieval"]');

    expect(audits).toHaveLength(3);
    expect(audits[0]?.textContent).toContain("Legacy semantic retrieval");
    expect(audits[0]?.textContent).toContain("Text-role provider used for embeddings: openrouter · text-embedding-nomic-embed-text-v1.5");
    expect(audits[0]?.textContent).toContain("chunk index not ready");
    expect(audits[1]?.textContent).toContain("Unknown — this turn predates retrieval auditing or came from an import without audit metadata.");
    expect(audits[1]?.textContent).toContain("ProviderUnknown");
    expect(audits[2]?.textContent).toContain('<img data-hostile="provider">');
    expect(audits[2]?.textContent).toContain('<script data-hostile="model"></script>');
    expect(audits[2]?.querySelector("img, script")).toBeNull();
    expect(document.querySelectorAll('.history-card[role="button"][tabindex="0"]')).toHaveLength(3);
  });

  it("opens the real Turn History modal with recorded and Unknown retrieval details that remain keyboard-selectable", async () => {
    try {
      const turns = [
        { id: "turn-1", turnNumber: 1, action: "Look around", narration: "The harbor waits.", chronicleRetrieval: TEXT_FALLBACK_LEGACY_AUDIT },
        { id: "turn-2", turnNumber: 2, action: "Listen", narration: "A bell rings.", chronicleRetrieval: null }
      ];
      const { document, window } = await bootLegacyStory({ turns });

      document.getElementById("turnPill")?.dispatchEvent(new window.Event("click", { bubbles: true }));
      const dialog = document.getElementById("turnHistoryDialog");
      const cards = document.querySelectorAll<HTMLElement>("#turnHistoryModalList .history-card");
      const audits = document.querySelectorAll('dl[aria-label="Chronicle retrieval"]');

      expect(dialog?.hasAttribute("open")).toBe(true);
      expect(audits).toHaveLength(2);
      expect(audits[0]?.textContent).toContain("Legacy semantic retrieval");
      expect(audits[1]?.textContent).toContain("Unknown — this turn predates retrieval auditing or came from an import without audit metadata.");
      expect(cards).toHaveLength(2);
      expect(cards[1]?.getAttribute("aria-pressed")).toBe("true");
      const enter = new window.Event("keydown", { bubbles: true, cancelable: true });
      Object.defineProperty(enter, "key", { value: "Enter" });
      cards[0]?.dispatchEvent(enter);
      expect(cards[0]?.getAttribute("aria-pressed")).toBe("true");
      expect(cards[1]?.getAttribute("aria-pressed")).toBe("false");
      expect(enter.defaultPrevented).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("routes History Inspect, Jump, and Branch through the selected persisted turn number", async () => {
    const fetchCampaignState = vi.fn().mockResolvedValue({ activeTurnNumber: 100 });
    const rewindCampaign = vi.fn().mockResolvedValue({});
    try {
      const { document, window } = await bootLegacyStory({
        turns: makeTurns(51, 100),
        fetchCampaignState,
        rewindCampaign
      });

      document.getElementById("turnPill")?.dispatchEvent(new window.Event("click", { bubbles: true }));
      const selected = document.querySelector<HTMLElement>('[data-turn-number="75"]');
      selected?.dispatchEvent(new window.Event("click", { bubbles: true }));
      expect(selected?.getAttribute("aria-pressed")).toBe("true");

      fetchCampaignState.mockClear();
      document.getElementById("btnTurnHistoryInspect")?.dispatchEvent(new window.Event("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(fetchCampaignState).toHaveBeenCalledWith("campaign-1", 75);

      document.getElementById("btnTurnHistoryJump")?.dispatchEvent(new window.Event("click", { bubbles: true }));
      expect(document.querySelector<HTMLElement>("#storyArea .scene")?.id).toBe("scene-75");
      expect(document.getElementById("viewPill")?.textContent).toContain("75");

      document.getElementById("turnPill")?.dispatchEvent(new window.Event("click", { bubbles: true }));
      document.querySelector<HTMLElement>('[data-turn-number="75"]')
        ?.dispatchEvent(new window.Event("click", { bubbles: true }));
      document.getElementById("btnTurnHistoryBranch")?.dispatchEvent(new window.Event("click", { bubbles: true }));
      const branchDialog = document.getElementById("branchStoryDialog") as HTMLDialogElement & { _targetTurnNumber?: number };
      expect(branchDialog.hasAttribute("open")).toBe(true);
      expect(document.getElementById("branchStoryMessage")?.textContent).toContain("Turn 75");

      rewindCampaign.mockClear();
      branchDialog.returnValue = "reset";
      branchDialog.dispatchEvent(new window.Event("close"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(rewindCampaign).toHaveBeenCalledWith("campaign-1", { targetTurnNumber: 75 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("loads every older page when Turn History opens and preserves absolute selection", async () => {
    const fetchTurns = vi.fn().mockResolvedValue({
      campaignId: "campaign-1",
      turns: makeTurns(1, 50),
      nextCursor: null
    });
    try {
      const { document, window } = await bootLegacyStory({
        turns: makeTurns(51, 100),
        nextCursor: "before-51",
        fetchTurns
      });
      document.getElementById("turnPill")?.dispatchEvent(new window.Event("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      const cards = document.querySelectorAll<HTMLElement>("#turnHistoryModalList .history-card");
      expect(fetchTurns).toHaveBeenCalledTimes(1);
      expect(fetchTurns).toHaveBeenCalledWith("campaign-1", { before: "before-51", limit: 200 });
      expect(cards).toHaveLength(100);
      expect(cards[0]?.textContent).toContain("Turn 1");
      expect(cards[99]?.textContent).toContain("Turn 100");
      expect(cards[99]?.getAttribute("aria-pressed")).toBe("true");
      expect(document.getElementById("turnHistoryLoadStatus")?.textContent).toContain("All 100 turns loaded");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("loads all pages before rendering continuous reading", async () => {
    const fetchTurns = vi.fn().mockResolvedValue({
      campaignId: "campaign-1",
      turns: makeTurns(1, 50),
      nextCursor: null
    });
    try {
      const { document } = await bootLegacyStory({
        turns: makeTurns(51, 100),
        nextCursor: "before-51",
        continuousReading: true,
        fetchTurns
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(fetchTurns).toHaveBeenCalledTimes(1);
      const scenes = document.querySelectorAll<HTMLElement>("#storyContainer .scene");
      expect(scenes).toHaveLength(100);
      expect(scenes[0]?.id).toBe("scene-1");
      expect(scenes[99]?.id).toBe("scene-100");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("shares an in-flight page walk and preserves the bounded window on failure", async () => {
    let rejectPage!: (reason: Error) => void;
    const fetchTurns = vi.fn(() => new Promise((_resolve, reject) => { rejectPage = reject; }));
    try {
      const { document, window } = await bootLegacyStory({
        turns: makeTurns(51, 100),
        nextCursor: "before-51",
        fetchTurns
      });
      const pill = document.getElementById("turnPill");
      pill?.dispatchEvent(new window.Event("click", { bubbles: true }));
      pill?.dispatchEvent(new window.Event("click", { bubbles: true }));
      expect(fetchTurns).toHaveBeenCalledTimes(1);
      rejectPage(new Error("older page unavailable"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(document.querySelectorAll("#turnHistoryModalList .history-card")).toHaveLength(50);
      expect(document.getElementById("turnHistoryLoadStatus")?.textContent).toContain("older page unavailable");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not publish an older complete-history walk after a same-campaign reload", async () => {
    let resolveOldPage!: (page: Record<string, unknown>) => void;
    let resolveNewPage!: (page: Record<string, unknown>) => void;
    const fetchTurns = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOldPage = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveNewPage = resolve; }));
    const syncStatus = vi.fn()
      .mockResolvedValueOnce({
        campaign: { id: "campaign-1", title: "Long campaign", activeTurnNumber: 100 },
        world: {},
        turns: { campaignId: "campaign-1", turns: makeTurns(51, 100), nextCursor: "before-51" }
      })
      .mockResolvedValueOnce({
        campaign: { id: "campaign-1", title: "Long campaign", activeTurnNumber: 101 },
        world: {},
        turns: { campaignId: "campaign-1", turns: makeTurns(52, 101), nextCursor: "before-52" }
      });
    try {
      const { document, window } = await bootLegacyStory({
        turns: makeTurns(51, 100),
        nextCursor: "before-51",
        fetchTurns,
        syncStatus
      });
      vi.stubGlobal("confirm", () => true);

      document.getElementById("turnPill")?.dispatchEvent(new window.Event("click", { bubbles: true }));
      document.getElementById("btnUndo")?.dispatchEvent(new window.Event("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(document.querySelector<HTMLElement>("#storyArea .scene")?.id).toBe("scene-101");

      resolveOldPage({ campaignId: "campaign-1", turns: makeTurns(1, 50), nextCursor: null });
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      const cards = document.querySelectorAll<HTMLElement>("#turnHistoryModalList .history-card");
      expect(cards).toHaveLength(50);
      expect(cards[0]?.textContent).toContain("Turn 52");
      expect(cards[49]?.textContent).toContain("Turn 101");
      expect(document.querySelector<HTMLElement>("#storyArea .scene")?.id).toBe("scene-101");
      expect(document.getElementById("turnHistoryLoadStatus")?.classList.contains("hidden")).toBe(true);
      expect(document.getElementById("turnHistoryLoadStatus")?.textContent).toBe("");

      document.getElementById("turnPill")?.dispatchEvent(new window.Event("click", { bubbles: true }));
      expect(fetchTurns).toHaveBeenCalledTimes(2);
      expect(fetchTurns).toHaveBeenLastCalledWith("campaign-1", { before: "before-52", limit: 200 });
      resolveNewPage({ campaignId: "campaign-1", turns: makeTurns(1, 51), nextCursor: null });
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      const completeCards = document.querySelectorAll<HTMLElement>("#turnHistoryModalList .history-card");
      expect(completeCards).toHaveLength(101);
      expect(completeCards[0]?.textContent).toContain("Turn 1");
      expect(completeCards[100]?.textContent).toContain("Turn 101");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not let a pending complete-history walk replace a newly accepted turn", async () => {
    let resolveOlderPage!: (page: Record<string, unknown>) => void;
    const fetchTurns = vi.fn(() => new Promise((resolve) => { resolveOlderPage = resolve; }));
    const workflow = {
      resume: async () => null,
      submit: vi.fn().mockResolvedValue({
        jobId: "generation-101",
        async *watch() {
          yield {
            type: "settled",
            outcome: "completed",
            result: {
              resultTurnId: "turn-101",
              turnNumber: 101,
              action: "Action 101",
              narration: "Narration 101"
            }
          };
        }
      })
    };
    try {
      const { document, window } = await bootLegacyStory({
        turns: makeTurns(51, 100),
        nextCursor: "before-51",
        fetchTurns,
        workflow
      });

      document.getElementById("turnPill")?.dispatchEvent(new window.Event("click", { bubbles: true }));
      expect(fetchTurns).toHaveBeenCalledTimes(1);

      document.querySelector<HTMLElement>('[data-turn-input-mode="action"]')
        ?.dispatchEvent(new window.Event("click", { bubbles: true }));
      const action = document.getElementById("freeAction") as HTMLTextAreaElement;
      action.value = "Action 101";
      document.getElementById("btnTakeAction")?.dispatchEvent(new window.Event("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(document.querySelector<HTMLElement>("#storyArea .scene")?.id).toBe("scene-101");

      resolveOlderPage({ campaignId: "campaign-1", turns: makeTurns(1, 50), nextCursor: null });
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      const cards = document.querySelectorAll<HTMLElement>("#turnHistoryModalList .history-card");
      expect(cards).toHaveLength(51);
      expect(cards[50]?.textContent).toContain("Turn 101");
      expect(document.getElementById("turnHistoryLoadStatus")?.classList.contains("hidden")).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not publish History opened during a same-campaign sync over its newer window", async () => {
    let resolveReload!: (data: Record<string, unknown>) => void;
    let resolveOldPage!: (page: Record<string, unknown>) => void;
    let resolveNewPage!: (page: Record<string, unknown>) => void;
    const syncStatus = vi.fn()
      .mockResolvedValueOnce({
        campaign: { id: "campaign-1", title: "Long campaign", activeTurnNumber: 100 },
        world: {},
        turns: { campaignId: "campaign-1", turns: makeTurns(51, 100), nextCursor: "before-51" }
      })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveReload = resolve; }));
    const fetchTurns = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOldPage = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveNewPage = resolve; }));
    try {
      const { document, window } = await bootLegacyStory({
        turns: makeTurns(51, 100),
        nextCursor: "before-51",
        fetchTurns,
        syncStatus
      });
      vi.stubGlobal("confirm", () => true);

      document.getElementById("btnUndo")?.dispatchEvent(new window.Event("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      document.getElementById("turnPill")?.dispatchEvent(new window.Event("click", { bubbles: true }));
      expect(fetchTurns).toHaveBeenCalledTimes(1);

      resolveReload({
        campaign: { id: "campaign-1", title: "Long campaign", activeTurnNumber: 101 },
        world: {},
        turns: { campaignId: "campaign-1", turns: makeTurns(52, 101), nextCursor: "before-52" }
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(document.querySelector<HTMLElement>("#storyArea .scene")?.id).toBe("scene-101");

      resolveOldPage({ campaignId: "campaign-1", turns: makeTurns(1, 50), nextCursor: null });
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      const cards = document.querySelectorAll<HTMLElement>("#turnHistoryModalList .history-card");
      expect(cards).toHaveLength(50);
      expect(cards[0]?.textContent).toContain("Turn 52");
      expect(cards[49]?.textContent).toContain("Turn 101");
      expect(document.getElementById("turnHistoryLoadStatus")?.classList.contains("hidden")).toBe(true);
      expect(document.getElementById("turnHistoryLoadStatus")?.textContent).toBe("");
      expect(document.getElementById("toast")?.textContent).not.toContain("Could not load complete history");

      document.getElementById("turnPill")?.dispatchEvent(new window.Event("click", { bubbles: true }));
      expect(fetchTurns).toHaveBeenCalledTimes(2);
      expect(fetchTurns).toHaveBeenLastCalledWith("campaign-1", { before: "before-52", limit: 200 });
      resolveNewPage({ campaignId: "campaign-1", turns: makeTurns(1, 51), nextCursor: null });
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(document.querySelectorAll("#turnHistoryModalList .history-card")).toHaveLength(101);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not publish an older Previous page after a same-campaign reload installs a newer window", async () => {
    let resolveObsoletePage!: (page: Record<string, unknown>) => void;
    const fetchTurns = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveObsoletePage = resolve; }))
      .mockResolvedValueOnce({ campaignId: "campaign-1", turns: makeTurns(1, 51), nextCursor: null });
    const syncStatus = vi.fn()
      .mockResolvedValueOnce({
        campaign: { id: "campaign-1", title: "Long campaign", activeTurnNumber: 100 },
        world: {},
        turns: { campaignId: "campaign-1", turns: makeTurns(51, 100), nextCursor: "before-51" }
      })
      .mockResolvedValueOnce({
        campaign: { id: "campaign-1", title: "Long campaign", activeTurnNumber: 101 },
        world: {},
        turns: { campaignId: "campaign-1", turns: makeTurns(52, 101), nextCursor: "before-52" }
      });
    try {
      const { document, window } = await bootLegacyStory({
        turns: makeTurns(51, 100),
        nextCursor: "before-51",
        fetchTurns,
        syncStatus
      });

      const previous = document.getElementById("btnPrev");
      for (let index = 0; index < 49; index += 1) {
        previous?.dispatchEvent(new window.Event("click", { bubbles: true }));
      }
      expect(document.querySelector<HTMLElement>("#storyArea .scene")?.id).toBe("scene-51");
      previous?.dispatchEvent(new window.Event("click", { bubbles: true }));
      expect(fetchTurns).toHaveBeenCalledWith("campaign-1", { before: "before-51" });

      const branchDialog = document.getElementById("branchStoryDialog") as HTMLDialogElement & { _targetTurnNumber?: number };
      branchDialog._targetTurnNumber = 75;
      branchDialog.returnValue = "reset";
      branchDialog.dispatchEvent(new window.Event("close"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(document.querySelector<HTMLElement>("#storyArea .scene")?.id).toBe("scene-101");

      resolveObsoletePage({ campaignId: "campaign-1", turns: makeTurns(1, 50), nextCursor: null });
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      document.getElementById("turnPill")?.dispatchEvent(new window.Event("click", { bubbles: true }));
      expect(fetchTurns).toHaveBeenCalledTimes(2);
      expect(fetchTurns).toHaveBeenLastCalledWith("campaign-1", { before: "before-52", limit: 200 });
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      const cards = document.querySelectorAll<HTMLElement>("#turnHistoryModalList .history-card");
      expect(cards).toHaveLength(101);
      expect(cards[0]?.textContent).toContain("Turn 1");
      expect(cards[100]?.textContent).toContain("Turn 101");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("retries complete History after a failed page walk", async () => {
    const fetchTurns = vi.fn()
      .mockRejectedValueOnce(new Error("first page failed"))
      .mockResolvedValueOnce({ campaignId: "campaign-1", turns: makeTurns(1, 50), nextCursor: null });
    try {
      const { document, window } = await bootLegacyStory({
        turns: makeTurns(51, 100),
        nextCursor: "before-51",
        fetchTurns
      });

      document.getElementById("turnPill")?.dispatchEvent(new window.Event("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(document.querySelectorAll("#turnHistoryModalList .history-card")).toHaveLength(50);
      expect(document.getElementById("turnHistoryLoadStatus")?.textContent).toContain("first page failed");

      document.getElementById("turnPill")?.dispatchEvent(new window.Event("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      const cards = document.querySelectorAll<HTMLElement>("#turnHistoryModalList .history-card");
      expect(fetchTurns).toHaveBeenCalledTimes(2);
      expect(cards).toHaveLength(100);
      expect(cards[0]?.textContent).toContain("Turn 1");
      expect(cards[99]?.textContent).toContain("Turn 100");
      expect(document.getElementById("turnHistoryLoadStatus")?.textContent).toContain("All 100 turns loaded");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refreshes enabled continuous reading after History retries an initial load failure", async () => {
    const fetchTurns = vi.fn()
      .mockRejectedValueOnce(new Error("initial continuous history failed"))
      .mockResolvedValueOnce({ campaignId: "campaign-1", turns: makeTurns(1, 50), nextCursor: null });
    try {
      const { document, window } = await bootLegacyStory({
        turns: makeTurns(51, 100),
        nextCursor: "before-51",
        continuousReading: true,
        fetchTurns
      });

      let scenes = document.querySelectorAll<HTMLElement>("#storyContainer .scene");
      expect(scenes).toHaveLength(50);
      expect(scenes[0]?.id).toBe("scene-51");
      expect(scenes[49]?.id).toBe("scene-100");

      document.getElementById("turnPill")?.dispatchEvent(new window.Event("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      scenes = document.querySelectorAll<HTMLElement>("#storyContainer .scene");
      expect(fetchTurns).toHaveBeenCalledTimes(2);
      expect(scenes).toHaveLength(100);
      expect(scenes[0]?.id).toBe("scene-1");
      expect(scenes[99]?.id).toBe("scene-100");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("loads complete history before rendering newly enabled continuous reading", async () => {
    let resolvePage!: (page: Record<string, unknown>) => void;
    const fetchTurns = vi.fn(() => new Promise((resolve) => { resolvePage = resolve; }));
    try {
      const { document, window } = await bootLegacyStory({
        turns: makeTurns(51, 100),
        nextCursor: "before-51",
        fetchTurns
      });
      document.getElementById("btnOpenUserProfile")?.dispatchEvent(new window.Event("click", { bubbles: true }));
      const continuousReading = document.getElementById("userProfileContinuousReading") as HTMLInputElement;
      continuousReading.checked = true;
      document.getElementById("btnSaveUserProfile")?.dispatchEvent(new window.Event("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(document.querySelectorAll("#storyContainer .scene")).toHaveLength(1);
      resolvePage({ campaignId: "campaign-1", turns: makeTurns(1, 50), nextCursor: null });
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      const scenes = document.querySelectorAll<HTMLElement>("#storyContainer .scene");
      expect(scenes).toHaveLength(100);
      expect(scenes[0]?.id).toBe("scene-1");
      expect(scenes[99]?.id).toBe("scene-100");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps newly enabled continuous reading on a coherent bounded window when history fails", async () => {
    const fetchTurns = vi.fn().mockRejectedValue(new Error("profile history failed"));
    try {
      const { document, window } = await bootLegacyStory({
        turns: makeTurns(51, 100),
        nextCursor: "before-51",
        fetchTurns
      });
      document.getElementById("btnOpenUserProfile")?.dispatchEvent(new window.Event("click", { bubbles: true }));
      const continuousReading = document.getElementById("userProfileContinuousReading") as HTMLInputElement;
      continuousReading.checked = true;
      document.getElementById("btnSaveUserProfile")?.dispatchEvent(new window.Event("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      const scenes = document.querySelectorAll<HTMLElement>("#storyContainer .scene");
      expect(continuousReading.checked).toBe(true);
      expect(scenes).toHaveLength(50);
      expect(scenes[0]?.id).toBe("scene-51");
      expect(scenes[49]?.id).toBe("scene-100");
      expect(document.getElementById("toast")?.textContent).toContain("profile history failed");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("opens Print synchronously and writes only complete story markup after history loads", async () => {
    let resolvePage!: (page: Record<string, unknown>) => void;
    const fetchTurns = vi.fn(() => new Promise((resolve) => { resolvePage = resolve; }));
    try {
      const { document, window } = await bootLegacyStory({
        turns: makeTurns(51, 100),
        nextCursor: "before-51",
        fetchTurns
      });
      const { printWindow, writes } = controlledPrintWindow();
      const openWindow = vi.fn(() => printWindow);
      Object.defineProperty(window, "open", { value: openWindow, configurable: true });

      document.getElementById("btnExportPdf")?.dispatchEvent(new window.Event("click", { bubbles: true }));
      expect(openWindow).toHaveBeenCalledTimes(1);
      expect(writes.join("\n")).not.toContain("Turn 51");
      expect(printWindow.print).not.toHaveBeenCalled();

      resolvePage({ campaignId: "campaign-1", turns: makeTurns(1, 50), nextCursor: null });
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      const finalMarkup = writes.join("\n");
      expect(finalMarkup).toContain("Turn 1: Action 1");
      expect(finalMarkup).toContain("Turn 100: Action 100");
      expect(printWindow.print).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("closes a synchronous Print popup without writing partial story markup when history fails", async () => {
    let rejectPage!: (error: Error) => void;
    const fetchTurns = vi.fn(() => new Promise((_resolve, reject) => { rejectPage = reject; }));
    try {
      const { document, window } = await bootLegacyStory({
        turns: makeTurns(51, 100),
        nextCursor: "before-51",
        fetchTurns
      });
      const { printWindow, writes } = controlledPrintWindow();
      Object.defineProperty(window, "open", { value: vi.fn(() => printWindow), configurable: true });

      document.getElementById("btnExportPdf")?.dispatchEvent(new window.Event("click", { bubbles: true }));
      rejectPage(new Error("print history failed"));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(printWindow.close).toHaveBeenCalledTimes(1);
      expect(printWindow.print).not.toHaveBeenCalled();
      expect(writes.join("\n")).not.toContain("Turn 51");
      expect(document.getElementById("toast")?.textContent).toContain("print history failed");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("closes Print without partial markup or failure noise when history is superseded by a reload", async () => {
    let resolvePage!: (page: Record<string, unknown>) => void;
    const fetchTurns = vi.fn(() => new Promise((resolve) => { resolvePage = resolve; }));
    const syncStatus = vi.fn()
      .mockResolvedValueOnce({
        campaign: { id: "campaign-1", title: "Long campaign", activeTurnNumber: 100 },
        world: {},
        turns: { campaignId: "campaign-1", turns: makeTurns(51, 100), nextCursor: "before-51" }
      })
      .mockResolvedValueOnce({
        campaign: { id: "campaign-1", title: "Long campaign", activeTurnNumber: 101 },
        world: {},
        turns: { campaignId: "campaign-1", turns: makeTurns(52, 101), nextCursor: "before-52" }
      });
    try {
      const { document, window } = await bootLegacyStory({
        turns: makeTurns(51, 100),
        nextCursor: "before-51",
        fetchTurns,
        syncStatus
      });
      const { printWindow, writes } = controlledPrintWindow();
      Object.defineProperty(window, "open", { value: vi.fn(() => printWindow), configurable: true });
      vi.stubGlobal("confirm", () => true);

      document.getElementById("btnExportPdf")?.dispatchEvent(new window.Event("click", { bubbles: true }));
      expect(printWindow.print).not.toHaveBeenCalled();
      document.getElementById("btnUndo")?.dispatchEvent(new window.Event("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      resolvePage({ campaignId: "campaign-1", turns: makeTurns(1, 50), nextCursor: null });
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(printWindow.close).toHaveBeenCalledTimes(1);
      expect(printWindow.print).not.toHaveBeenCalled();
      expect(writes.join("\n")).not.toContain("Turn 52");
      expect(document.getElementById("toast")?.textContent).not.toContain("Export failed");
      expect(document.getElementById("toast")?.textContent).not.toContain("superseded");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("renders persisted turn numbers when the loaded window starts at turn 51", async () => {
    try {
      const windowTurns = Array.from({ length: 50 }, (_, offset) => ({
        id: `turn-${offset + 51}`,
        turnNumber: offset + 51,
        action: `Action ${offset + 51}`,
        narration: `Narration ${offset + 51}`
      }));
      const { document } = await bootLegacyStory({ turns: windowTurns });
      const scenes = document.querySelectorAll<HTMLElement>("#storyArea .scene");
      expect(scenes).toHaveLength(1);
      expect(scenes[0]?.id).toBe("scene-100");
      expect(scenes[0]?.dataset.turnNumber).toBe("100");
      expect(scenes[0]?.textContent).toContain("Turn 100");
      expect(document.getElementById("viewPill")?.textContent).toMatch(/latest/iu);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("preserves absolute History selection while Previous prepends and views its predecessor", async () => {
    try {
      const loadedTurns = Array.from({ length: 50 }, (_, offset) => ({
        id: `turn-${offset + 51}`,
        turnNumber: offset + 51,
        action: `Action ${offset + 51}`,
        narration: `Narration ${offset + 51}`
      }));
      const olderTurns = Array.from({ length: 50 }, (_, offset) => ({
        id: `turn-${offset + 1}`,
        turnNumber: offset + 1,
        action: `Action ${offset + 1}`,
        narration: `Narration ${offset + 1}`
      }));
      const fetchTurns = vi.fn().mockResolvedValue({ campaignId: "campaign-1", turns: olderTurns, nextCursor: null });
      const { document, window } = await bootLegacyStory({
        turns: loadedTurns,
        nextCursor: "before-turn-51",
        fetchTurns
      });

      document.getElementById("turnPill")?.dispatchEvent(new window.Event("click", { bubbles: true }));
      const selectedHistoryCard = document.querySelector<HTMLElement>('[data-turn-number="75"]');
      selectedHistoryCard?.dispatchEvent(new window.Event("click", { bubbles: true }));
      expect(selectedHistoryCard?.getAttribute("aria-pressed")).toBe("true");

      const previous = document.getElementById("btnPrev");
      for (let index = 0; index < 49; index += 1) {
        previous?.dispatchEvent(new window.Event("click", { bubbles: true }));
      }
      expect(document.querySelector<HTMLElement>("#storyArea .scene")?.id).toBe("scene-51");

      previous?.dispatchEvent(new window.Event("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(document.querySelector<HTMLElement>("#storyArea .scene")?.id).toBe("scene-50");
      document.getElementById("turnPill")?.dispatchEvent(new window.Event("click", { bubbles: true }));
      expect(document.querySelector<HTMLElement>('[data-turn-number="75"]')?.getAttribute("aria-pressed")).toBe("true");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps older-page loading identity-neutral until Previous chooses the predecessor", () => {
    const loaderStart = storyScript.indexOf("async function loadOlderTurnPage()");
    const loaderEnd = storyScript.indexOf("\nasync function goToPrevious()", loaderStart);
    const loader = storyScript.slice(loaderStart, loaderEnd);

    expect(loader).not.toContain("state.viewTurnNumber =");
  });

  it("manages World Setup fields and RPG percentile stats view as static read-only modal", () => {
    expect(storyScript).toContain('function openWorldSetup()');
    expect(storyHtml).toContain('id="setupCampaignTitle"');
    expect(storyHtml).toContain('id="setupWorldVersion"');
    expect(storyHtml).toContain('id="setupCharacter"');
    expect(storyScript).toContain("pc.characterProfile");
    expect(storyScript).toContain("pc.selectedCharacterName");
    expect(storyScript).toContain('const btnDoneWorldSetup = $("btnDoneWorldSetup");');
  });

  it("uses the shared slim navigation with dashboard and story first, grouped utilities, and the themed brand mark", () => {
    const dashboardIndex = storyHtml.indexOf('id="btnNexusDashboard"');
    const storyIndex = storyHtml.indexOf('id="navStoryLink"');
    const setupIndex = storyHtml.indexOf('aria-controls="storySetupMenu">Setup</button>');
    expect(storyHtml).toContain('class="universal-nav"');
    expect(storyHtml).toContain('class="universal-nav-links"');
    expect(storyHtml).toContain('src="/nexus/nexus-mark.png"');
    expect(storyHtml).toContain('href="/nexus/" aria-label="Infinite Quest Nexus dashboard"');
    expect(dashboardIndex).toBeGreaterThan(-1);
    expect(storyIndex).toBeGreaterThan(dashboardIndex);
    expect(setupIndex).toBeGreaterThan(storyIndex);
    expect(storyHtml).toContain('aria-controls="storyExportMenu">Export</button>');
    expect(storyHtml).toContain('aria-controls="storyAboutMenu">About</button>');
    expect(storyHtml).toContain('class="nav-section-divider"');
    expect(storyHtml).not.toContain('<summary>');
    expect(storyHtml).not.toContain('id="btnMenu"');
    expect(storyHtml).not.toContain('☰ Menu');
    expect(storyCss).toContain("@import url('navigation.css');");
    expect(navigationCss).toContain('position: sticky;');
    expect(navigationCss).toContain('.universal-nav {');
    expect(navigationCss).toContain('.nav-section-divider');
    expect(navigationCss).not.toContain('content: "⌄"');
    expect(storyScript).toContain('function closeNavigationMenus(except = null)');
    expect(storyScript).toContain('function setNavigationMenuState(menu, open)');
    expect(storyScript).toContain('function initializeNavigationMenus()');
    expect(storyScript).toContain('trigger.setAttribute("aria-expanded", String(open))');
    expect(storyScript).toContain('document.addEventListener("pointerdown"');
    expect(storyScript).toContain('document.addEventListener("keydown"');
  });

  it("keeps all Story Player utilities in the universal navigation and disables action buttons when invalid", () => {
    expect(storyHtml).toContain('id="btnProviderSetup"');
    expect(storyHtml).toContain('id="btnWorldManagement"');
    expect(storyHtml).toContain('id="btnCampaignManagement" href="/nexus/#campaigns"');
    expect(storyHtml).toContain('id="btnImportSection" href="/nexus/#imports"');
    expect(storyHtml).toContain('id="btnOpenWorldSetup"');
    expect(storyHtml).toContain('id="btnOpenEditState"');
    expect(storyHtml).toContain('id="btnExportMarkdown"');
    expect(storyHtml).toContain('id="btnExportHtml"');
    expect(storyHtml).toContain('id="btnExportPdf"');
    expect(storyHtml).not.toContain('id="btnExportJson"');
    expect(storyHtml).toContain('id="btnOpenActivityLog"');
    expect(storyHtml).toContain('id="btnAboutNexus"');
    expect(storyHtml).toContain('id="btnOpenUserProfile" class="nav-profile-button"');
    expect(storyHtml).toContain('title="User profile and settings"');
    expect(storyHtml).not.toContain('<button id="btnOpenUserProfile" type="button"><strong>User Profile</strong>');
    expect(storyHtml).toContain('id="btnOpenWorldSetup" type="button"');
    expect(storyHtml).toContain('id="btnOpenEditState" type="button"');
    expect(storyHtml).not.toContain('nav-menu-item-flush');
    expect(navigationCss).toContain('.nav-profile-button {');
    expect(storyScript).toContain('const generationLocked = state.busy || Boolean(state.pendingGeneration);');
    expect(storyScript).toContain('const storyInputLocked = generationLocked || !isLatest;');
    expect(storyScript).toContain('if (btnAction) btnAction.disabled = storyInputLocked;');
    expect(storyScript).not.toContain('inputAction.style.pointerEvents = "none";');
    expect(storyScript).toContain('if (btnPrev) btnPrev.disabled = generationLocked || turnCount === 0 || (curr <= 0 && !state.historyNextCursor);');
    expect(storyScript).toContain('if (btnNext) btnNext.disabled = generationLocked || turnCount === 0 || isLatest;');
    expect(storyScript).toContain('if (btnUndo) btnUndo.disabled = generationLocked || turnCount === 0 || !isLatest;');
    expect(storyScript).toContain('if (btnRetry) btnRetry.disabled = generationLocked || turnCount === 0 || !isLatest || !lastTurnHasAction;');
  });

  it("keeps world and character authoring in World Management", () => {
    expect(storyHtml).toContain('id="btnWorldManagement" href="/nexus/#world-library"');
    expect(storyHtml).not.toContain('id="worldGenDialog"');
    expect(storyHtml).not.toContain('id="characterSelectDialog"');
    expect(storyScript).not.toContain('async function generateCharacterCandidates()');
    expect(storyScript).not.toContain('async function generateWorld()');
    expect(storyScript).not.toContain('/provider-text/generate');
  });

  it("implements backend-complete Markdown and HTML exports plus print-to-PDF with available story illustrations", () => {
    expect(storyScript).toContain('async function exportMarkdown()');
    expect(storyScript).toContain('async function exportStandaloneHtml()');
    expect(storyScript).toContain('async function printStory()');
    expect(storyScript).toContain('/readable-export?format=markdown');
    expect(storyScript).toContain('/readable-export?format=html');
    expect(storyScript).toContain('turn.imageAssetUrl || turn.imageUrl');
    expect(storyScript).toContain('printWindow.print()');
    expect(storyScript).toContain('function downloadBlob(blob, filename)');
    expect(storyScript).not.toContain('async function exportJson()');
  });

  it("provides toast notifications, activity logging, and onboarding verification", () => {
    expect(storyScript).toContain('function toast(msg, duration)');
    expect(storyScript).toContain('function recordActivity(category, title, detail)');
    expect(storyScript).toContain('function copyActivityDiagnostics()');
    expect(storyScript).toContain('async function checkOnboarding()');
    expect(storyScript).toContain('const btnCopyDiagnostics = $("btnCopyDiagnostics") || $("btnCopyActivityLog");');
  });

  it("styles the Story Player with dark fantasy tokens, responsive rules, and animations", () => {
    expect(tokensCss).toContain('--bg: #0d1018;');
    expect(tokensCss).toContain('--accent: var(--purple);');
    expect(storyCss).toContain("@import url('tokens.css');");
    expect(storyCss).toContain('.story-shell {');
    expect(storyCss).toContain('.scene {');
    expect(storyCss).toContain('@media (max-width:');
    expect(storyCss).toContain('@keyframes spin {');
    expect(storyCss).toContain('@keyframes shimmer {');
  });
});
