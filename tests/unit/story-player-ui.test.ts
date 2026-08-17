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
  fetchTurns = vi.fn()
}: {
  turns: Array<Record<string, unknown>>;
  nextCursor?: string | null;
  continuousReading?: boolean;
  fetchTurns?: ReturnType<typeof vi.fn>;
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
  vi.stubGlobal("localStorage", { getItem: () => null, removeItem: () => undefined, setItem: () => undefined });
  Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", { value: () => undefined, configurable: true });

  (storyModule.startStoryPlayer as (composition: unknown) => void)({
    api: {
      session: { get: async () => ({ user: { settings: { continuousReading, autoSubmitTurnChoices: false, defaultTurnControlStyle: "flexible_auto" } } }) },
      providers: { list: async () => ({ providers: [{ providerRole: "text" }] }) },
      generation: { syncStatus: async () => ({ campaign: { id: "campaign-1", title: "Long campaign", activeTurnNumber: 100 }, world: {}, turns: { campaignId: "campaign-1", turns, nextCursor } }) },
      campaigns: { state: async () => ({ activeTurnNumber: 100 }), turns: fetchTurns },
      meta: { get: async () => ({}) }
    },
    illustrations: { config: async () => ({ enabled: false, sourcePolicy: "off" }), segments: async () => ({ segments: [] }), imageJobs: async () => ({ jobs: [] }) },
    workflow: { resume: async () => null }
  });
  document.dispatchEvent(new window.Event("DOMContentLoaded"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { document, window, fetchTurns };
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
    expect(storyScript).toContain('function renderChoices(choices, customSuggestion)');
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
    expect(storyScript).toContain('setTurnInputMode("action", { refreshPlaceholder: true });');
    expect(storyScript).toContain('state.nextTurnInputModeSource = "generated_choice"');
    expect(storyScript).toContain('inputModeSource: "opening_action"');
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
    expect(storyScript).toContain("apiClient.campaigns.turns(state.campaignId, { before: state.historyNextCursor }");
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
    expect(storyScript).toContain("window.requestAnimationFrame(() => {");
    expect(storyScript).toContain('window.scrollTo({ ...viewport, behavior: "auto" });');
    expect(storyScript).toContain('onCompleted: finalizeCompletedGeneration');
    expect(storyScript).toContain('await finalizeCompletedGeneration(result);');
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
      const fetchTurns = vi.fn().mockResolvedValue({ turns: olderTurns, nextCursor: null });
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
    expect(storyScript).toContain('async function exportPdfWithImages()');
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
