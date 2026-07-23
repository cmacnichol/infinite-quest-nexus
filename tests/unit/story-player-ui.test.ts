import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const storyHtml = readFileSync("apps/web/public/story.html", "utf8");
const storyScript = readFileSync("apps/web/public/story.js", "utf8");
const storyCss = readFileSync("apps/web/public/story.css", "utf8");
const tokensCss = readFileSync("apps/web/public/tokens.css", "utf8");
const navigationCss = readFileSync("apps/web/public/navigation.css", "utf8");

describe("story-player: new Story Player UI contracts & gameplay logic", () => {
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
    expect(storyHtml).toContain('id="assetLibraryDialog"');
    expect(storyHtml).toContain('id="assetLibraryFilters"');
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

  it("renders scenes with formatted narration, inline illustrations, choices taken, and RPG roll cards", () => {
    expect(storyScript).toContain('function renderScene(turn, index)');
    expect(storyScript).toContain('sceneDiv.className = `scene${hasImage ? "" : " no-image"}`;');
    expect(storyScript).toContain('class="narration"');
    expect(storyScript).toContain('class="action-tag"');
    expect(storyScript).toContain('class="roll-disclosure"');
    expect(storyScript).toContain('class="roll-card ${passed ? "success" : "failure"}"');
    expect(storyScript).toContain('class="image-wrap"');
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
    expect(storyScript).toContain('/campaigns/${state.campaignId}/turn-input/classify');
    expect(storyScript).toContain('body: JSON.stringify({ text: action, preferredFallback: preferredAutoFallback() })');
    expect(storyScript).toContain('classification.confidenceBand === "ambiguous" || classification.classification === "mixed"');
    expect(storyScript).toContain('requestedInputMode: submission.requestedInputMode');
    expect(storyScript).toContain('resolvedInputMode: submission.resolvedInputMode');
    expect(storyScript).toContain('classificationId: submission.classificationId');
  });

  it("orchestrates turn generation via Nexus API polling with progress updates, crash recovery, and retry", () => {
    expect(storyScript).toContain('async function runGeneration(action, options = {})');
    expect(storyScript).toContain('/campaigns/${state.campaignId}/generations');
    expect(storyScript).toContain('/campaigns/${state.campaignId}/generations/retry-latest');
    expect(storyScript).toContain('/generation-jobs/${jobId}');
    expect(storyScript).toContain('idempotencyKey: options.idempotencyKey || crypto.randomUUID()');
    expect(storyScript).toContain('async function enqueueGenerationSubmission(submission)');
    expect(storyScript).toContain('pendingGenerationMatches(syncData.pendingGeneration, submission)');
    expect(storyScript).toContain('function updateGenerationProgress(job)');
    expect(storyScript).toContain('async function resumePendingGeneration()');
    expect(storyScript).toContain('const pending = syncData.pendingGeneration;');
    expect(storyScript).toContain('if (job.status === "recoverable") {');
    expect(storyScript).toContain('The original turn was preserved.');
    expect(storyScript).toContain('class="replacement-pending-banner"');
  });

  it("reloads authoritative campaign state without reusing a stale pre-generation response", () => {
    expect(storyScript).toContain('fetch(url, { ...options, cache: "no-store", headers })');
    expect(storyScript).toContain('result.resultTurnId && !state.turns.some((turn) => turn.id === result.resultTurnId)');
    expect(storyScript).toContain('const completedTurn = { ...result, id: result.resultTurnId };');
    expect(storyScript).toContain('renderChoices(completedTurn.choices || [], completedTurn.customActionSuggestion || "");');
  });

  it("renders streaming narration full-width in the same scene structure as a completed turn", () => {
    expect(storyScript).toContain('card.className = "scene no-image turn-streaming-preview";');
    expect(storyScript).toContain('<div class="scene-narration">');
    expect(storyScript).toContain('<div class="turn-streaming-header">');
    expect(storyScript).toContain('<div class="turn-meta">');
    expect(storyCss).toContain('.turn-streaming-preview {\n  grid-template-columns: minmax(0, 1fr);');
    expect(storyCss).not.toContain('.turn-streaming-preview {\n  display: flex;');
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
    expect(storyScript).toContain("await loadCampaign(state.campaignId, { autoScroll: !preserveViewport });");
    expect(storyScript).toContain("window.requestAnimationFrame(() => {");
    expect(storyScript).toContain('window.scrollTo({ ...viewport, behavior: "auto" });');
    expect(storyScript.match(/await finalizeCompletedGeneration\(result\);/g)).toHaveLength(2);
  });

  it("provides history navigation with view mode toggling, undo, retry, and branch/reset handling", () => {
    expect(storyScript).toContain('function goToPrevious()');
    expect(storyScript).toContain('function goToNext()');
    expect(storyScript).toContain('async function undoLatest()');
    expect(storyScript).toContain('/campaigns/${state.campaignId}/rewind');
    expect(storyScript).toContain('/campaigns/${state.campaignId}/branch');
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
    expect(storyScript).toContain('body: JSON.stringify({ targetTurnNumber: branchDlg._turnIndex + 1 })');
    expect(storyScript).toContain('function openTurnHistoryModal()');
    expect(storyScript).toContain('el.addEventListener("click", openTurnHistoryModal);');
  });

  it("selects accessible history cards and routes footer actions to the selected turn", () => {
    expect(storyHtml).toContain('id="btnTurnHistoryInspect"');
    expect(storyHtml).toContain('id="btnTurnHistoryJump"');
    expect(storyHtml).toContain('id="btnTurnHistoryBranch"');
    expect(storyHtml).toContain('class="row wrap dialog-actions history-dialog-actions"');
    expect(storyScript).toContain('state.historySelectedIndex = null;');
    expect(storyScript).toContain('const currentIdx = state.viewIndex === -1 ? state.turns.length - 1 : state.viewIndex;');
    expect(storyScript).toContain('selectHistoryTurn(currentIdx);');
    expect(storyScript).toContain('card.setAttribute("role", "button");');
    expect(storyScript).toContain('card.setAttribute("tabindex", "0");');
    expect(storyScript).toContain('card.setAttribute("aria-pressed", "false");');
    expect(storyScript).toContain('if (event.key === "Enter" || event.key === " ")');
    expect(storyScript).toContain('card.classList.toggle("selected", selected);');
    expect(storyScript).toContain('inspectTurnState(turnIndex + 1);');
    expect(storyScript).toContain('inspectBtn.disabled = !hasSelection;');
    expect(storyScript).toContain('jumpBtn.disabled = !hasSelection;');
    expect(storyScript).toContain('branchBtn.classList.toggle("hidden", !hasSelection || state.historySelectedIndex >= state.turns.length - 1);');
    expect(storyScript).toContain('navigateTo(state.historySelectedIndex);');
    expect(storyScript).toContain('promptBranchOrReset(turnIndex);');
    expect(storyCss).toContain('.history-card.selected, .history-card[aria-pressed="true"]');
  });

  it("manages inline illustrations, prompt editing, polling, and per-scene regeneration", () => {
    expect(storyScript).toContain('function pollImageJobs()');
    expect(storyScript).toContain('function renderSceneImageJob(job)');
    expect(storyScript).toContain('["queued", "generating", "provider_pending", "downloading"]');
    expect(storyScript).toContain('aria-label", `Illustration generation progress');
    expect(storyScript).toContain('/campaigns/${state.campaignId}/image-jobs');
    expect(storyScript).toContain('function openImagePromptEditor(turnId)');
    expect(storyScript).toContain('async function regenerateIllustration(turnId, prompt)');
    expect(storyScript).toContain('/turns/${turnId}/illustrations');
    expect(storyScript).toContain('data-action="regenerate-image"');
    expect(storyScript).toContain('data-action="find-library-match"');
    expect(storyScript).toContain('data-action="why-image"');
    expect(storyScript).toContain('data-action="remove-image"');
    expect(storyScript).toContain('async function pollIllustrationResolution(turnId)');
  });

  it("edits authoritative current state while keeping history inspection under the Turn Pill", () => {
    expect(storyScript).toContain('async function openEditState()');
    expect(storyScript).toContain('function switchEditStateTab(tabName)');
    expect(storyScript).toContain('async function saveEditState()');
    expect(storyScript).toContain('/campaigns/${state.campaignId}/state');
    expect(storyScript).toContain('async function inspectTurnState(turnNumber)');
    expect(storyScript).toContain('expectedRevision: state.runtimeState.revision');
    expect(storyHtml).toContain('id="scratchpadEditor"');
    expect(storyHtml).toContain('id="turnHistoryStatePanel"');
    expect(storyHtml).not.toContain('id="tab-history"');
    expect(storyScript).toContain('const btnSaveEditState = $("btnSaveEditState") || $("btnSaveScratch");');
  });

  it("shows the recorded Story Engine prompt interpretation on every turn-history card", () => {
    expect(storyScript).toContain('const inputMode = t.inputMode === "scene" ? "scene" : "action";');
    expect(storyScript).toContain('const inputModeLabel = inputMode === "scene" ? "Scene direction" : "Action";');
    expect(storyScript).toContain('class="turn-input-mode-pill ${inputMode}"');
    expect(storyScript).toContain('aria-label="Prompt interpretation: ${inputModeLabel}"');
    expect(storyCss).toContain('.turn-input-mode-pill {');
    expect(storyCss).toContain('.turn-input-mode-pill.scene {');
  });

  it("manages World Setup fields and RPG percentile stats view as static read-only modal", () => {
    expect(storyScript).toContain('function openWorldSetup()');
    expect(storyHtml).toContain('id="setupCampaignTitle"');
    expect(storyHtml).toContain('id="setupWorldVersion"');
    expect(storyHtml).toContain('id="setupCharacter"');
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
    expect(storyHtml).toContain('id="btnExportPdf"');
    expect(storyHtml).not.toContain('id="btnExportJson"');
    expect(storyHtml).not.toContain('id="btnExportHtml"');
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
    expect(storyScript).toContain('if (btnPrev) btnPrev.disabled = generationLocked || turnCount === 0 || curr <= 0;');
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

  it("implements Markdown and print-to-PDF exports with available story illustrations", () => {
    expect(storyScript).toContain('async function exportMarkdown()');
    expect(storyScript).toContain('async function exportPdfWithImages()');
    expect(storyScript).toContain('/campaigns/${state.campaignId}/export');
    expect(storyScript).toContain('t.imageAssetUrl || t.imageUrl');
    expect(storyScript).toContain('turn.imageAssetUrl || turn.imageUrl');
    expect(storyScript).toContain('printWindow.print()');
    expect(storyScript).toContain('function downloadBlob(blob, filename)');
    expect(storyScript).not.toContain('async function exportJson()');
    expect(storyScript).not.toContain('async function exportHtml()');
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
