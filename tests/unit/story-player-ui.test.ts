import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const storyHtml = readFileSync("apps/web/public/story.html", "utf8");
const storyScript = readFileSync("apps/web/public/story.js", "utf8");
const storyCss = readFileSync("apps/web/public/story.css", "utf8");
const tokensCss = readFileSync("apps/web/public/tokens.css", "utf8");

describe("story-player: new Story Player UI contracts & gameplay logic", () => {
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
    expect(storyHtml).toContain('id="worldGenDialog"');
    expect(storyHtml).toContain('id="characterSelectDialog"');
    expect(storyHtml).toContain('id="imagePromptDialog"');
    expect(storyHtml).toContain('id="editResponseDialog"');
    expect(storyHtml).toContain('id="retryPromptDialog"');
    expect(storyHtml).toContain('id="branchStoryDialog"');
    expect(storyHtml).toContain('id="activityLogDialog"');
    expect(storyHtml).toContain('id="messagePopupDialog"');
    expect(storyHtml).toContain('id="gettingStartedDialog"');
    expect(storyHtml).toContain('id="turnHistoryDialog"');
  });

  it("implements clean URL loading from /story/:campaignId without requiring sessionStorage", () => {
    expect(storyScript).toContain('const match = window.location.pathname.match(/\\/story\\/([^/]+)/);');
    expect(storyScript).toContain('state.campaignId = decodeURIComponent(match[1]);');
    expect(storyScript).toContain('window.location.href = "/nexus/#campaigns";');
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
    expect(storyScript).toContain('async function submitAction(actionText)');
    expect(storyScript).toContain('if (state.busy) return;');
    expect(storyScript).toContain('if (!action) { toast("Enter an action first."); return; }');
    expect(storyScript).toContain('function renderChoices(choices, customSuggestion)');
    expect(storyScript).toContain('submitAction(text)');
    expect(storyScript).toContain('freeAction.addEventListener("keydown", (e) => {');
    expect(storyScript).toContain('if (e.key === "Enter" && !e.shiftKey)');
  });

  it("orchestrates turn generation via Nexus API polling with progress updates, crash recovery, and retry", () => {
    expect(storyScript).toContain('async function runGeneration(action)');
    expect(storyScript).toContain('/campaigns/${state.campaignId}/generations');
    expect(storyScript).toContain('/generation-jobs/${jobId}');
    expect(storyScript).toContain('const idempotencyKey = crypto.randomUUID();');
    expect(storyScript).toContain('function updateGenerationProgress(job)');
    expect(storyScript).toContain('async function resumePendingGeneration()');
    expect(storyScript).toContain('if (job.status === "recoverable") {');
  });

  it("renders streaming narration full-width in the same scene structure as a completed turn", () => {
    expect(storyScript).toContain('card.className = "scene no-image turn-streaming-preview";');
    expect(storyScript).toContain('<div class="scene-narration">');
    expect(storyScript).toContain('<div class="turn-streaming-header">');
    expect(storyScript).toContain('<div class="turn-meta">');
    expect(storyCss).toContain('.turn-streaming-preview {\n  grid-template-columns: minmax(0, 1fr);');
    expect(storyCss).not.toContain('.turn-streaming-preview {\n  display: flex;');
  });

  it("provides history navigation with view mode toggling, undo, retry, and branch/reset handling", () => {
    expect(storyScript).toContain('function goToPrevious()');
    expect(storyScript).toContain('function goToNext()');
    expect(storyScript).toContain('async function undoLatest()');
    expect(storyScript).toContain('/campaigns/${state.campaignId}/rewind');
    expect(storyScript).toContain('/campaigns/${state.campaignId}/branch');
    expect(storyScript).toContain('history-branch-btn');
    expect(storyScript).toContain('Restart / Branch from Here…');
    expect(storyScript).toContain('async function retryLatest()');
    expect(storyScript).toContain('branchDlg.addEventListener("close"');
    expect(storyScript).toContain('body: JSON.stringify({ targetTurnNumber: branchDlg._turnIndex + 1 })');
    expect(storyScript).toContain('function openTurnHistoryModal()');
    expect(storyScript).toContain('el.addEventListener("click", openTurnHistoryModal);');
  });

  it("manages inline illustrations, prompt editing, polling, and per-scene regeneration", () => {
    expect(storyScript).toContain('function pollImageJobs()');
    expect(storyScript).toContain('/campaigns/${state.campaignId}/image-jobs');
    expect(storyScript).toContain('function openImagePromptEditor(turnId)');
    expect(storyScript).toContain('async function regenerateIllustration(turnId, prompt)');
    expect(storyScript).toContain('/turns/${turnId}/illustrations');
    expect(storyScript).toContain('data-action="regenerate-image"');
  });

  it("handles Edit State tabs for continuity scratchpad, JSON trackers, and turn history", () => {
    expect(storyScript).toContain('function openEditState()');
    expect(storyScript).toContain('function switchEditStateTab(tabName)');
    expect(storyScript).toContain('async function saveEditState()');
    expect(storyScript).toContain('/campaigns/${state.campaignId}/player-config');
    expect(storyScript).toContain('const btnSaveEditState = $("btnSaveEditState") || $("btnSaveScratch");');
  });

  it("manages World Setup fields and RPG percentile stats view as static read-only modal", () => {
    expect(storyScript).toContain('function openWorldSetup()');
    expect(storyHtml).toContain('id="setupCampaignTitle"');
    expect(storyHtml).toContain('id="setupWorldVersion"');
    expect(storyHtml).toContain('id="setupCharacter"');
    expect(storyScript).toContain('const btnDoneWorldSetup = $("btnDoneWorldSetup");');
  });

  it("includes menu navigation links for Provider Setup and World Management, and disables action buttons when invalid", () => {
    expect(storyHtml).toContain('id="btnProviderSetup"');
    expect(storyHtml).toContain('id="btnWorldManagement"');
    expect(storyScript).toContain('if (btnPrev) btnPrev.disabled = state.busy || turnCount === 0 || curr <= 0;');
    expect(storyScript).toContain('if (btnNext) btnNext.disabled = state.busy || turnCount === 0 || isLatest;');
    expect(storyScript).toContain('if (btnUndo) btnUndo.disabled = state.busy || turnCount === 0 || !isLatest;');
    expect(storyScript).toContain('if (btnRetry) btnRetry.disabled = state.busy || turnCount === 0 || !isLatest || !lastTurnHasAction;');
  });

  it("supports character selection and ad-hoc world generation from prompt via API", () => {
    expect(storyScript).toContain('async function openCharacterSelect()');
    expect(storyScript).toContain('/world-versions/${state.campaign.worldVersionId}/playable-characters');
    expect(storyScript).toContain('async function generateCharacterCandidates()');
    expect(storyScript).toContain('function openWorldGen()');
    expect(storyScript).toContain('async function generateWorld()');
    expect(storyScript).toContain('/provider-text/generate');
    expect(storyScript).toContain('const btnWorldGenSubmit = $("btnWorldGenSubmit") || $("btnWorldGenRun");');
  });

  it("implements JSON, HTML, and Markdown exports directly from gameplay", () => {
    expect(storyScript).toContain('async function exportJson()');
    expect(storyScript).toContain('async function exportHtml()');
    expect(storyScript).toContain('async function exportMarkdown()');
    expect(storyScript).toContain('/campaigns/${state.campaignId}/export');
    expect(storyScript).toContain('function downloadBlob(blob, filename)');
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
