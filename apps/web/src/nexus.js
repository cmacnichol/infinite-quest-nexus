import { MAX_PLAYABLE_CHARACTERS } from "@infinite-quest/contracts";
import { openCastSuggestions } from "./character-editor/suggest-cast.js";
import { createLegacyCastPanel } from "./campaign-cast-panel.js";
import { renderCharacterEditor } from "./character-editor/renderer.js";
import { buildCampaignProfileUpdate, createCampaignMainController } from "./character-editor/campaign-main-form.js";
import { settingsBookmarkDestination } from "./settings-bookmark.js";
import { createCampaignCastApi, createStoryMemoryApi, createNexusApiClient, createNoopSessionPort, writeCampaignSettings, browserDeviceStorage } from "@infinite-quest/client-web";
import { mountLegacyDeviceProfile } from "../../shared-ui/profile/legacy-device-profile.js";
import { mountReaderPreferenceFields } from "../../shared-ui/profile/profile-controls.js";
import {
  previewEntityConversions,
  WORLD_PROFILE_FIELDS,
  castNarratorNotice,
  createEditorDraft,
  setEditorDraftField,
  projectEditorProfile,
  stageEditorOrganize,
  reapplyEditorDraft,
  markEditorConflict,
  buildCampaignCreateRequest,
  createCampaignCreationDraft,
  createEditSession,
  filterSortCampaigns,
  filterSortWorlds,
  resolveResumeCampaign,
} from "@infinite-quest/client-core";
import { bindEditDialogDismissal, requestEditDismissal } from "./legacy-edit-session.js";
import { createLegacySectionLoader } from "./legacy-section-loader.js";
import { bindLegacyTabGroup } from "./legacy-tabs.js";
const ownerDevice = browserDeviceStorage(window);
const campaignMemoryApi = createStoryMemoryApi();
const characterApi = createNexusApiClient({ basePath: "/api/v1", session: createNoopSessionPort() });

renderCharacterEditor(document.getElementById("characterDialog"), null, {
  save: saveCharacterFromModal,
  close: () => dismissEditDialog(elements.characterDialog),
  generate: generateCharacterFromPrompt,
  organize: organizeCharacterProfile,
  delete: deleteCharacterFromModal,
  addStat: () => addCharacterEditorRow("stat"),
  addTracker: () => addCharacterEditorRow("tracker"),
  change: (path, value) => {
    if (characterEditorDraft) characterEditorDraft = setEditorDraftField(characterEditorDraft, path, value);
  }
});

const elements = Object.fromEntries([...document.querySelectorAll("[id]")].map((element) => [element.id, element]));
const campaignSectionLoader = createLegacySectionLoader({
  loadSection: (request) => loadCampaignSettingsSectionData(request)
});
let assetLibraryBrowserPromise = null;
let assetLibraryImportRetryNonce = 0;
const MAX_ASSET_LIBRARY_RETRY_NONCE = 0x7fffffff;
let selectedFile = null;
let selectedImportSource = null;
let selectedImport = null;
let campaignArchivePreviewSequence = 0;
let campaignArchivePreviewAbortController = null;
let campaignImportRefreshSequence = 0;
let selectedCampaign = null;
let campaignSelectionRequest = 0;
let campaignStoryMemorySettings = null;
const CAMPAIGN_SETTINGS_PANEL_IDS = Object.freeze(["overview", "story", "illustrations", "chronicle", "usage"]);
const campaignSettingsSectionLoadEpochs = new Map();
let campaignSaveInProgress = false;
let campaignLeavePromptOpen = false;
let campaignLeavePrompt = null;

function campaignSettingsSnapshot() {
  return {
    title: elements.campaignTitle.value,
    status: elements.campaignStatus.value
  };
}

function createCampaignEditGuard(createEditSession, equal) {
  let campaignId = null;
  let loadEpoch = null;
  let session = null;
  const isCurrent = (getCurrentCampaignId, getCurrentEpoch) => getCurrentCampaignId() === campaignId && getCurrentEpoch() === loadEpoch;

  return {
    reset(nextCampaignId, nextLoadEpoch, initialSnapshot) {
      campaignId = nextCampaignId;
      loadEpoch = nextLoadEpoch;
      session = createEditSession(initialSnapshot, equal);
    },
    isDirty(snapshot) {
      return Boolean(session?.isDirty(snapshot));
    },
    markSaved(nextCampaignId, nextLoadEpoch, snapshot) {
      if (!session || campaignId !== nextCampaignId || loadEpoch !== nextLoadEpoch) return false;
      session.markSaved(snapshot);
      return true;
    },
    async canLeave(nextCampaignId, { getCurrentCampaignId, getCurrentEpoch, getSnapshot, confirm, save, discard = () => {} }) {
      if (!session) return true;
      const dirty = session.isDirty(getSnapshot());
      if (nextCampaignId === campaignId) return !dirty;
      if (!dirty) return true;
      const capturedCampaignId = campaignId;
      const capturedEpoch = loadEpoch;
      const stillCurrent = () => capturedCampaignId === campaignId && capturedEpoch === loadEpoch
        && isCurrent(getCurrentCampaignId, getCurrentEpoch);
      const decision = await confirm();
      if (!stillCurrent() || decision === "stay") return false;
      if (decision === "discard") {
        await discard();
        session.markSaved(getSnapshot());
        return true;
      }
      if (decision !== "save") return false;
      const snapshot = getSnapshot();
      if (!(await save(snapshot)) || !stillCurrent()) return false;
      return !session.isDirty(getSnapshot());
    }
  };
}

const campaignEditGuard = createCampaignEditGuard(
  createEditSession,
  (left, right) => JSON.stringify(left) === JSON.stringify(right)
);
let activeCampaignSettingsPanel = "overview";
const CAMPAIGN_SETTINGS_SECTIONS = Object.freeze({
  overview: null,
  story: "story",
  illustrations: "illustrations",
  chronicle: "chronicle",
  usage: "usage"
});
const CAMPAIGN_SETTINGS_SECTION_LABELS = Object.freeze({
  story: "Story behavior",
  illustrations: "Illustrations",
  chronicle: "Chronicle",
  usage: "Usage"
});
const CAMPAIGN_SETTINGS_SECTION_CONTROLS = Object.freeze({
  illustrations: [
    "illustrationSourcePolicy", "campaignImageProvider", "illustrationModel", "illustrationSize", "illustrationAspectRatio",
    "illustrationQuality", "illustrationOutputFormat", "illustrationMaxAttempts", "illustrationMatchingScope",
    "illustrationConfidenceProfile", "illustrationRepetitionWindow", "illustrationSegmentWordCount", "illustrationImagesPerSegment",
    "illustrationSegmentPromptMode", "openIllustrationPromptEditor", "previewIllustrationBackfill", "previewIllustrationRebuild",
    "illustrationArtStyle", "illustrationNegativePrompt", "saveIllustrationConfig", "discoverIllustrationModels"
  ],
  chronicle: [
    "embeddingEnabled", "embeddingRetrievalImplementation", "embeddingRetrievalShadowEnabled", "embeddingProvider",
    "discoverEmbeddingModels", "embeddingModel", "embeddingDocumentPrefix", "embeddingQueryPrefix", "embeddingBatchSize",
    "saveEmbeddingConfig", "reindexEmbeddings", "reindexMemory"
  ]
});
const CAMPAIGN_SETTINGS_SELECTION_CONTROLS = Object.freeze([
  "campaignTitle", "campaignStatus", "campaignWorldVersion", "campaignTextProvider", "campaignTurnControlStyle", "campaignStoryLengthProfile",
  "campaignStoryContextBudgetTokens", "saveCampaign", "transferCampaign", "editCampaignCharacter", "loadCampaign", "exportCampaign", "deleteCampaign",
  "illustrationSourcePolicy", "campaignImageProvider", "illustrationModel", "illustrationSize", "illustrationAspectRatio", "illustrationQuality",
  "illustrationOutputFormat", "illustrationMaxAttempts", "illustrationMatchingScope", "illustrationConfidenceProfile", "illustrationRepetitionWindow",
  "illustrationSegmentWordCount", "illustrationImagesPerSegment", "illustrationSegmentPromptMode", "openIllustrationPromptEditor",
  "illustrationArtStyle", "illustrationNegativePrompt", "embeddingEnabled",
  "embeddingRetrievalImplementation", "embeddingRetrievalShadowEnabled", "embeddingProvider", "discoverEmbeddingModels", "embeddingModel",
  "embeddingDocumentPrefix", "embeddingQueryPrefix", "embeddingBatchSize", "budgetTokens", "compression", "memoryQuery"
]);
let campaignCoreReady = false;

function normalizedTurnControlStyle(value) {
  return value === "flexible_scene" ? "flexible_scene" : "flexible_action";
}

function savedTurnControlStyle(value, existingStyle) {
  if (value === "flexible_scene") return "flexible_scene";
  return existingStyle === "action_only" ? "action_only" : "flexible_action";
}
let worlds = [];
let campaigns = [];
let campaignsLoaded = false;
let campaignsLoadError = false;
const dashboardWorkflowErrors = new Map();
let selectedCampaignIsExplicit = false;
let selectedWorld = null;
let worldSelectionId = "";
let worldSelectionEpoch = 0;
let worldSelectionIntentEpoch = 0;
let managementWorldFilter = "all";
let managementCampaignStatus = "active";
let managementCampaignSort = "updated-desc";
let managementWorldSort = "updated-desc";
let dashboardWorldSearchTimer = 0;
let managementCampaignSearchTimer = 0;
let managementWorldSearchTimer = 0;
let worldAuthorMode = "create";
let worldAuthorWorkingContent = null;
let worldAuthorSelectedCover = null;
let worldAuthorBusy = false;
let worldAuthorActiveStep = "basics";
let worldAuthorBusyControlSnapshot = null;
let worldAuthorTabBinding = null;
let worldVersionReadiness = null;
let worldVersionReadinessError = "";
let worldVersionReadinessCheckedId = "";
let worldVersionReadinessLoading = false;
const editDialogSessions = new WeakMap();
const editDialogBindingDisposers = new WeakMap();
let dashboardWorld = null;
const dashboardWorldDetails = new Map();
const dashboardWorldDetailRequests = new Map();
const dashboardWorldDetailRequestEpochs = new Map();
const dashboardInitialStatsSources = new Set(["worlds", "campaigns"]);
let dashboardInitialStatsPromise = null;
let dashboardWorldDetailsSelectionEpoch = 0;
let worldVersionCharacters = [];
let worldVersionCampaignReady = false;
let createCampaignSubmitting = false;
let createCampaignCommitted = false;
let campaignCreationSessionEpoch = 0;
let campaignCreationDialogSession = null;
let campaignCreationEntryPoint = "management";
let playableCharacterLoadSequence = 0;
let editingCharacterId = "";
let characterModalWorkingCharacter = null;
let characterEditorDraft = null;
let characterModalBusy = false;
let characterModalScope = "world";
let campaignCharacterProfileRevision = 0;
let campaignCharacterController = null;
let campaignCharacterPoll = null;
let campaignCharacterLocked = false;
let campaignCharacterOpenEpoch = 0;
let campaignCharacterLockEpoch = 0;
let characterProfileOrganizationResult = null;
const characterRowOriginals = new WeakMap();
const legacyStorageKey = "infiniteQuestNexusClientState.v1";
let detectedBrowserStory = null;
let providers = [];
let selectedProvider = null;
let embeddingConfig = null;
let illustrationConfig = null;
let contextPreviewSequence = 0;
let discoveredProviderModels = [];
let pendingDeleteTitle = "";
let pendingDeleteResolve = null;
let discoveredEmbeddingModels = [];
const embeddingJobMonitors = new Map();
let worldCoverJobPollSequence = 0;
let illustrationRefinementPromptValue = "";
let defaultIllustrationRefinementPrompt = "";
let sessionUser = null;
let transferPreviewSequence = 0;
let transferTargetVersionsRequestEpoch = 0;
let transferPreview = null;
let transferIdempotencyKey = "";
let systemArchiveEnabled = false;
let systemArchiveSelectedFile = null;
let systemArchiveUpload = null;
let systemArchiveUploadSessionKey = null;
let systemArchivePreview = null;
const systemArchiveJobs = { export: null, import: null };
let systemArchiveExportOperation = null;
let systemArchiveImportOperation = null;
let systemArchiveBusy = false;
let systemArchiveCancellationPending = false;
let systemArchiveOperationController = null;
let systemArchiveOperationKind = null;
let systemArchiveOwnerId = null;
let systemArchiveRecoveryStarted = false;
const systemArchiveOperationGenerations = { export: 0, import: 0 };
const systemArchiveOperationFences = { export: null, import: null };
const systemArchiveRecoveryControllers = { export: null, import: null };

function campaignSettingsPanelIndexForKey(key, currentIndex, count) {
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "ArrowRight" || key === "ArrowDown") return (currentIndex + 1) % count;
  if (key === "ArrowLeft" || key === "ArrowUp") return (currentIndex - 1 + count) % count;
  return currentIndex;
}

function setCampaignSettingsPanel(panelId, { focus = false } = {}) {
  if (!CAMPAIGN_SETTINGS_PANEL_IDS.includes(panelId)) return;
  activeCampaignSettingsPanel = panelId;
  const tabs = [...elements.campaignSettingsRail.querySelectorAll("[role=tab]")];
  for (const tab of tabs) {
    const selected = tab.dataset.campaignSettingsPanel === panelId;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected && focus) tab.focus();
  }
  document.querySelectorAll("[data-campaign-settings-content]").forEach((panel) => {
    panel.hidden = panel.dataset.campaignSettingsContent !== panelId;
  });
  if (window.matchMedia("(max-width: 820px)").matches) {
    const activeTab = elements.campaignSettingsRail.querySelector('[aria-selected="true"]');
    activeTab?.scrollIntoView({ block: "nearest", inline: "center" });
  }
  void loadCampaignSettingsSectionForPanel(panelId);
}

function campaignSettingsSectionFeedback(panelId) {
  const panel = document.querySelector(`[data-campaign-settings-content="${panelId}"]`);
  if (!panel) return null;
  let feedback = panel.querySelector("[data-campaign-section-feedback]");
  if (!feedback) {
    feedback = document.createElement("div");
    feedback.className = "status hidden";
    feedback.dataset.campaignSectionFeedback = panelId;
    feedback.setAttribute("role", "status");
    feedback.setAttribute("aria-live", "polite");
    panel.prepend(feedback);
  }
  return feedback;
}

function setCampaignSettingsSectionFeedback(panelId, status, message, selectionRequest, campaignId) {
  if (selectionRequest !== campaignSelectionRequest || selectedCampaign?.id !== campaignId) return;
  const feedback = campaignSettingsSectionFeedback(panelId);
  if (!feedback) return;
  feedback.replaceChildren();
  feedback.className = status === "error" ? "status error" : status === "loading" ? "status" : "status hidden";
  if (!message) return;
  const text = document.createElement("span");
  text.textContent = message;
  feedback.append(text);
  if (status === "error") {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "button secondary inline-action";
    retry.dataset.action = "retry-campaign-section";
    retry.textContent = `Retry ${CAMPAIGN_SETTINGS_SECTION_LABELS[panelId]}`;
    retry.addEventListener("click", () => { void loadCampaignSettingsSectionForPanel(panelId); });
    feedback.append(retry);
  }
}

function setCampaignSettingsSectionContentVisibility(panelId, visible) {
  const bodies = document.querySelectorAll(`[data-campaign-section-body="${panelId}"]`);
  for (const body of bodies) {
    if (visible) {
      if (body.dataset.selectionHidden !== "true") continue;
      body.classList.remove("hidden");
      delete body.dataset.selectionHidden;
    } else if (!body.classList.contains("hidden")) {
      body.dataset.selectionHidden = "true";
      body.classList.add("hidden");
    }
  }
}

function updateCampaignMigrationAvailability() {
  const targetVersion = Number(elements.campaignWorldVersion.selectedOptions[0]?.dataset.versionNumber);
  const currentVersionIsAvailable = Boolean(selectedCampaign
    && [...elements.campaignWorldVersion.options].some((option) => option.value === selectedCampaign.worldVersionId));
  elements.migrateCampaign.disabled = !selectedCampaign
    || elements.campaignWorldVersion.disabled
    || !currentVersionIsAvailable
    || elements.campaignWorldVersion.value === selectedCampaign.worldVersionId
    || !Number.isSafeInteger(targetVersion)
    || targetVersion <= selectedCampaign.worldVersionNumber;
}

function setCampaignSettingsSectionControls(section, disabled) {
  const availabilityManaged = section === "illustrations"
    ? new Set(["campaignImageProvider", "discoverIllustrationModels", "illustrationSegmentWordCount", "illustrationImagesPerSegment", "illustrationSegmentPromptMode", "openIllustrationPromptEditor", "previewIllustrationBackfill", "previewIllustrationRebuild"])
    : section === "chronicle"
      ? new Set(["discoverEmbeddingModels", "embeddingModel", "reindexEmbeddings"])
      : new Set();
  for (const id of CAMPAIGN_SETTINGS_SECTION_CONTROLS[section] || []) {
    if (!disabled && availabilityManaged.has(id)) continue;
    const control = elements[id];
    if (control) control.disabled = disabled;
  }
}

function loadCampaignSettingsSectionForPanel(panelId) {
  const section = CAMPAIGN_SETTINGS_SECTIONS[panelId];
  const campaignId = selectedCampaign?.id;
  const selectionRequest = campaignSelectionRequest;
  if (!section || !campaignId || !campaignCoreReady) return;
  const sectionLoadEpoch = (campaignSettingsSectionLoadEpochs.get(panelId) || 0) + 1;
  campaignSettingsSectionLoadEpochs.set(panelId, sectionLoadEpoch);
  if (section === "chronicle") {
    elements.budgetTokens.disabled = false;
    elements.compression.disabled = false;
    elements.memoryQuery.disabled = false;
    elements.previewContext.disabled = false;
  }
  setCampaignSettingsSectionFeedback(panelId, "loading", `Loading ${CAMPAIGN_SETTINGS_SECTION_LABELS[section]}…`, selectionRequest, campaignId);
  void campaignSectionLoader.loadSection(section).then(() => {
    if (selectionRequest !== campaignSelectionRequest || selectedCampaign?.id !== campaignId
      || campaignSettingsSectionLoadEpochs.get(panelId) !== sectionLoadEpoch) return;
    setCampaignSettingsSectionContentVisibility(panelId, true);
    setCampaignSettingsSectionFeedback(panelId, "success", "", selectionRequest, campaignId);
  }).catch((error) => {
    if (error?.name === "AbortError" || selectionRequest !== campaignSelectionRequest || selectedCampaign?.id !== campaignId
      || campaignSettingsSectionLoadEpochs.get(panelId) !== sectionLoadEpoch) return;
    setCampaignSettingsSectionFeedback(
      panelId,
      "error",
      safeWorkflowFailure(`${CAMPAIGN_SETTINGS_SECTION_LABELS[section]} could not be loaded.`, error),
      selectionRequest,
      campaignId
    );
  });
}

function handleCampaignSettingsRailKeydown(event) {
  const tabs = [...elements.campaignSettingsRail.querySelectorAll("[role=tab]:not(:disabled)")];
  const currentIndex = tabs.indexOf(event.target);
  if (currentIndex < 0) return;
  const nextIndex = campaignSettingsPanelIndexForKey(event.key, currentIndex, tabs.length);
  if (nextIndex === currentIndex && !["Home", "End"].includes(event.key)) return;
  event.preventDefault();
  setCampaignSettingsPanel(tabs[nextIndex].dataset.campaignSettingsPanel, { focus: true });
}

function setCampaignSettingsAvailability(available) {
  const settings = document.getElementById("openCampaignSettings");
  if (settings) {
    const params = new URLSearchParams({section:"campaign",returnTo:"/nexus/#campaigns"});
    if (available && selectedCampaign) params.set("campaignId",selectedCampaign.id);
    settings.href = "/app/settings?" + params;
    for (const link of document.querySelectorAll("[data-campaign-settings-group]")) {
      link.href = settings.href + "#" + link.dataset.campaignSettingsGroup;
    }
  }
  elements.campaignSettingsRail.querySelectorAll("[role=tab]").forEach((tab) => {
    tab.disabled = !available;
  });
  if (!available) setCampaignSettingsPanel("overview");
}

const STORY_MEMORY_LEVELS = Object.freeze(["off", "standard", "enhanced", "max"]);

function readCampaignStoryMemorySettings(value) {
  if (!value || typeof value !== "object" || !STORY_MEMORY_LEVELS.includes(value.level)
    || !["off", "observe", "enforce"].includes(value.reviewMode) || !Array.isArray(value.availableLevels)
    || value.availableLevels.some((level) => !STORY_MEMORY_LEVELS.includes(level))) {
    throw new Error("Story Memory settings response is invalid.");
  }
  return value;
}

function campaignStoryMemoryDescription(settings) {
  if (settings.level === "max" && settings.reviewMode === "enforce") {
    return "Max reviews continuity before accepting each future turn, repairs eligible issues, and blocks unresolved conflicts. Story context budget remains separate.";
  }
  if (settings.level === "max") return `Max continuity review is currently in ${settings.reviewMode} mode. It applies to future turns; Story context budget remains separate.`;
  return `Saved level: ${settings.level}. It applies to future turns; Story context budget remains separate.`;
}

function renderCampaignStoryMemorySettings(settings, { draftLevel = null, message = null, disabled = false } = {}) {
  const selector = elements.campaignStoryMemoryLevel;
  const status = elements.campaignStoryMemoryStatus;
  const checkbox = elements.campaignContinuityReviewEnabled;
  if (!settings) {
    selector.disabled = true;
    checkbox.disabled = true;
    status.textContent = message || "Story Memory controls are unavailable for this campaign.";
    status.className = "field-note";
    return;
  }
  const available = new Set(settings.availableLevels);
  for (const option of selector.options) {
    option.disabled = !available.has(option.value);
    option.toggleAttribute("disabled", !available.has(option.value));
  }
  selector.value = draftLevel || settings.level;
  selector.disabled = disabled || !selectedCampaign;
  checkbox.checked = selector.value === "max" && settings.reviewMode !== "off";
  checkbox.disabled = selector.disabled || selector.value !== "max";
  status.textContent = message || campaignStoryMemoryDescription(settings);
  status.className = "field-note";
}

async function loadCampaignStoryMemory(campaignId, selectionRequest, signal) {
  if (selectionRequest !== campaignSelectionRequest || selectedCampaign?.id !== campaignId) return null;
  campaignStoryMemorySettings = null;
  renderCampaignStoryMemorySettings(null, { message: "Loading the saved Story Memory level for this campaign." });
  try {
    const settings = readCampaignStoryMemorySettings(await api(`/api/v1/campaigns/${campaignId}/story-memory`, { signal }));
    if (signal?.aborted || selectionRequest !== campaignSelectionRequest || selectedCampaign?.id !== campaignId) return;
    campaignStoryMemorySettings = settings;
    renderCampaignStoryMemorySettings(settings);
    return settings;
  } catch (error) {
    if (signal?.aborted || selectionRequest !== campaignSelectionRequest || selectedCampaign?.id !== campaignId) return;
    renderCampaignStoryMemorySettings(null, { message: safeWorkflowFailure("Story Memory settings are unavailable.", error) });
    throw error;
  }
}

function campaignSectionRequestIsCurrent(request) {
  return campaignCoreReady
    && !request.signal.aborted
    && request.selectionEpoch === campaignSelectionRequest
    && selectedCampaign?.id === request.campaignId;
}

async function loadCampaignSettingsSectionData(request) {
  if (!campaignSectionRequestIsCurrent(request)) throw new DOMException("The campaign selection changed.", "AbortError");
  const { campaignId, selectionEpoch, section, signal } = request;
  if (section === "story") {
    const settings = await loadCampaignStoryMemory(campaignId, selectionEpoch, signal);
    if (!campaignSectionRequestIsCurrent(request)) throw new DOMException("The campaign selection changed.", "AbortError");
    return settings;
  }
  if (section === "illustrations") {
    await Promise.all([
      loadIllustrationConfig(selectionEpoch, signal),
      loadLatestImageJob(false, selectionEpoch, signal)
    ]);
    if (!campaignSectionRequestIsCurrent(request)) throw new DOMException("The campaign selection changed.", "AbortError");
    setCampaignSettingsSectionControls(section, false);
    return true;
  }
  if (section === "chronicle") {
    const [metrics] = await Promise.all([
      refreshCampaignMemoryMetrics(selectionEpoch, signal),
      loadEmbeddingConfig(selectionEpoch, signal)
    ]);
    if (!campaignSectionRequestIsCurrent(request)) throw new DOMException("The campaign selection changed.", "AbortError");
    setCampaignSettingsSectionControls(section, false);
    if (["queued", "running"].includes(metrics?.semanticHealth?.jobStatus) && metrics.semanticHealth.jobId) {
      void resumeEmbeddingJobProgress(metrics.semanticHealth.jobId, campaignId, selectionEpoch);
    }
    return metrics;
  }
  if (section === "usage") {
    const summary = await refreshCampaignCostSummary(selectionEpoch, signal);
    if (!campaignSectionRequestIsCurrent(request)) throw new DOMException("The campaign selection changed.", "AbortError");
    return summary;
  }
  throw new Error(`Unknown campaign settings section: ${section}`);
}

async function saveCampaignStoryMemory() {
  const campaignId = selectedCampaign?.id;
  const level = elements.campaignStoryMemoryLevel.value;
  const selectionRequest = campaignSelectionRequest;
  if (!campaignId || !campaignStoryMemorySettings || !STORY_MEMORY_LEVELS.includes(level)) return;
  const continuityReviewEnabled = level === "max" && elements.campaignContinuityReviewEnabled.checked;
  renderCampaignStoryMemorySettings({ ...campaignStoryMemorySettings, reviewMode: continuityReviewEnabled ? "enforce" : "off" }, { draftLevel: level, disabled: true, message: "Saving Story Memory level…" });
  try {
    const settings = readCampaignStoryMemorySettings(await campaignMemoryApi.update(campaignId, { level, continuityReviewEnabled }));
    if (selectionRequest !== campaignSelectionRequest || selectedCampaign?.id !== campaignId) return;
    campaignStoryMemorySettings = settings;
    renderCampaignStoryMemorySettings(settings);
    campaignSectionLoader.invalidate("story");
    setCampaignSettingsSectionFeedback("story", "success", "", selectionRequest, campaignId);
    campaignMessage("Story Memory level saved for future turns. Existing and in-flight turns keep their frozen policy.", "success");
  } catch (error) {
    if (selectionRequest !== campaignSelectionRequest || selectedCampaign?.id !== campaignId) return;
    renderCampaignStoryMemorySettings(campaignStoryMemorySettings, {
      draftLevel: level,
      message: `Story Memory level was not saved: ${error.message || String(error)}`
    });
  }
}

function syncCampaignSettingsRailOrientation(mediaQuery) {
  elements.campaignSettingsRail.setAttribute("aria-orientation", mediaQuery.matches ? "horizontal" : "vertical");
}

function clearContextPreviewPresentation() {
  contextPreviewSequence += 1;
  elements.contextSummary.className = "status hidden";
  elements.contextSummary.textContent = "";
  elements.contextPreview.textContent = "The preview deliberately excludes rolls, mechanics records, private scratchpad content, rejected output, and credentials.";
}

function clearCampaignEditorSelection({ focus = false } = {}) {
  campaignCoreReady = false;
  campaignSectionLoader.setSelection("", campaignSelectionRequest);
  clearContextPreviewPresentation();
  for (const panelId of CAMPAIGN_SETTINGS_PANEL_IDS) {
    if (panelId !== "overview") setCampaignSettingsSectionContentVisibility(panelId, false);
  }
  campaignEditGuard.reset(null, campaignSelectionRequest, campaignSettingsSnapshot());
  renderCampaignSaveFeedback("saved");
  setCampaignSettingsAvailability(false);
  campaignStoryMemorySettings = null;
  elements.memoryTitle.textContent = "Select a campaign";
  elements.campaignEditorSummary.textContent = "";
  elements.campaignWorldLink.hidden = true;
  if (!managementSelectionErrorIsCurrent("campaigns")) elements.campaignStatusMessage.textContent = "";
  if (!managementSelectionErrorIsCurrent("campaigns")) elements.campaignStatusMessage.className = "status hidden";
  renderCampaignStoryMemorySettings(null, { message: "Select a campaign to load its saved Story Memory level." });
  [elements.campaignTitle, elements.campaignStatus, elements.campaignWorldVersion, elements.campaignTextProvider, elements.campaignTurnControlStyle, elements.campaignStoryLengthProfile, elements.campaignStoryContextBudgetTokens, elements.saveCampaign, elements.migrateCampaign, elements.transferCampaign, elements.editCampaignCharacter, elements.loadCampaign, elements.exportCampaign, elements.deleteCampaign, elements.illustrationSourcePolicy, elements.campaignImageProvider, elements.illustrationModel, elements.illustrationSize, elements.illustrationAspectRatio, elements.illustrationQuality, elements.illustrationOutputFormat, elements.illustrationMaxAttempts, elements.illustrationMatchingScope, elements.illustrationConfidenceProfile, elements.illustrationRepetitionWindow, elements.illustrationSegmentWordCount, elements.illustrationImagesPerSegment, elements.illustrationSegmentPromptMode, elements.openIllustrationPromptEditor, elements.illustrationArtStyle, elements.illustrationNegativePrompt, elements.previewIllustrationBackfill, elements.previewIllustrationRebuild, elements.saveIllustrationConfig, elements.discoverIllustrationModels, elements.reindexMemory, elements.previewContext, elements.saveEmbeddingConfig, elements.reindexEmbeddings, elements.embeddingEnabled, elements.embeddingRetrievalImplementation, elements.embeddingRetrievalShadowEnabled, elements.embeddingProvider, elements.discoverEmbeddingModels, elements.embeddingModel, elements.embeddingDocumentPrefix, elements.embeddingQueryPrefix, elements.embeddingBatchSize, elements.budgetTokens, elements.compression, elements.memoryQuery].forEach((element) => { element.disabled = true; });
  elements.campaignCostSection.classList.add("hidden");
  if (focus) elements.refreshCampaigns.focus();
}

const MIN_MEMORY_CONTEXT_BUDGET_TOKENS = 512;
const MAX_MEMORY_CONTEXT_BUDGET_TOKENS = 1_000_000;
const DEFAULT_MEMORY_CONTEXT_BUDGET_TOKENS = 32_000;
const SOGNI_DEFAULT_CONFIGURATION = Object.freeze({
  defaultWidth: 1280,
  defaultHeight: 720,
  defaultAspectRatio: "16:9",
  defaultImageCount: 1,
  defaultOutputFormat: "png",
  defaultQuality: "auto",
  pollIntervalMs: 2000,
  maximumPollIntervalMs: 10000,
  generationTimeoutMs: 180000,
  maximumAttempts: 3,
  modelDiscoveryEnabled: true
});
const SOGNI_SDK_DEFAULT_CONFIGURATION = Object.freeze({
  ...SOGNI_DEFAULT_CONFIGURATION,
  network: "fast",
  tokenType: "auto",
  contentFilter: "enabled",
  defaultSizePreset: "custom",
  defaultSteps: "",
  defaultGuidance: "",
  defaultSeed: "",
  defaultSampler: "",
  defaultScheduler: "",
  defaultPreviewCount: 0,
  generationTimeoutMs: 600000
});

const modalBaselines = new WeakMap();
let discardModalTarget = null;

function modalFormSnapshot(dialog) {
  return [...dialog.querySelectorAll("input, select, textarea")].map((control) => {
    if (control instanceof HTMLInputElement && ["checkbox", "radio"].includes(control.type)) {
      return `${control.id}:${control.checked}`;
    }
    if (control instanceof HTMLInputElement && control.type === "password") {
      return `${control.id}:${Boolean(control.value)}`;
    }
    return `${control.id}:${control.value}`;
  }).join("\u001f");
}

function beginEditDialogSession(dialog, returnFocusTo) {
  const previous = editDialogSessions.get(dialog);
  const state = {
    epoch: (previous?.epoch || 0) + 1,
    returnFocusTo: returnFocusTo || (document.activeElement instanceof HTMLElement ? document.activeElement : undefined),
    editSession: createEditSession(modalFormSnapshot(dialog), (left, right) => left === right)
  };
  editDialogSessions.set(dialog, state);
  const dispose = bindEditDialogDismissal(dialog, () => ({
    isDirty: () => dialog === elements.characterDialog && characterModalScope === "campaign" && campaignCharacterController ? campaignCharacterController.draft.changedPaths.length > 0 : state.editSession.isDirty(modalFormSnapshot(dialog)),
    isBusy: () => (dialog === elements.worldAuthorDialog && worldAuthorBusy)
      || (dialog === elements.characterDialog && characterModalBusy),
    confirm: () => {
      if (dialog === elements.characterDialog && characterModalScope === "campaign" && campaignCharacterController) {
        campaignCharacterController.requestClose();
        return Promise.resolve("stay");
      }
      return requestStagedEditDecision(false);
    },
    ...(dialog === elements.characterDialog && characterModalScope === "campaign"
      ? { save: () => saveCharacterFromModal({ preventDefault() {} }) }
      : {}),
    discard: () => {
      state.editSession.markSaved(modalFormSnapshot(dialog));
    },
    returnFocusTo: state.returnFocusTo,
    isCurrent: () => editDialogSessions.get(dialog) === state
  }));
  editDialogBindingDisposers.set(dialog, dispose);
}

function openEditDialog(dialog, returnFocusTo) {
  beginEditDialogSession(dialog, returnFocusTo);
  openManagedModal(dialog);
}

async function requestStagedEditDecision(allowSave = false) {
  elements.discardChangesTitle.textContent = "Discard unsaved changes?";
  elements.discardChangesMessage.textContent = "Your edits have not been saved. Keep editing or discard them and close this window.";
  elements.discardChangesDialog.querySelector('button[value="keep"]').textContent = "Keep editing";
  setCampaignSaveDecisionVisible(allowSave);
  elements.saveCampaignEditsDecision.textContent = "Save changes";
  elements.discardChangesDialog.returnValue = "";
  openManagedModal(elements.discardChangesDialog);
  return new Promise((resolve) => {
    elements.discardChangesDialog.addEventListener("close", () => {
      const value = elements.discardChangesDialog.returnValue;
      setCampaignSaveDecisionVisible(false);
      resolve(value === "discard" ? "discard" : value === "save" && allowSave ? "save" : "stay");
    }, { once: true });
  });
}

function setCampaignSaveDecisionVisible(visible) {
  elements.saveCampaignEditsDecision.hidden = !visible;
  elements.saveCampaignEditsDecision.style.display = visible ? "" : "none";
}

function dismissEditDialog(dialog) {
  if (dialog === elements.characterDialog && characterModalScope === "campaign" && campaignCharacterController) {
    campaignCharacterController.requestClose();
    return Promise.resolve("pending");
  }
  const state = editDialogSessions.get(dialog);
  if (!state) {
    dialog.close();
    return Promise.resolve("dismissed");
  }
  return requestEditDismissal({
    dialog,
    isDirty: () => state.editSession.isDirty(modalFormSnapshot(dialog)),
    isBusy: () => (dialog === elements.worldAuthorDialog && worldAuthorBusy)
      || (dialog === elements.characterDialog && characterModalBusy),
    confirm: () => requestStagedEditDecision(dialog === elements.characterDialog && characterModalScope === "campaign"),
    ...(dialog === elements.characterDialog && characterModalScope === "campaign"
      ? { save: () => saveCharacterFromModal({ preventDefault() {} }) }
      : {}),
    discard: () => {
      state.editSession.markSaved(modalFormSnapshot(dialog));
    },
    returnFocusTo: state.returnFocusTo,
    isCurrent: () => editDialogSessions.get(dialog) === state
  });
}

function openManagedModal(dialog) {
  if (!dialog || dialog.open) return;
  refreshModalBaseline(dialog);
  dialog.showModal();
}

function refreshModalBaseline(dialog) {
  modalBaselines.set(dialog, modalFormSnapshot(dialog));
}

function clickedDialogBackdrop(dialog, event) {
  if (event.target !== dialog) return false;
  const bounds = dialog.getBoundingClientRect();
  return event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
}

function requestModalDismissal(dialog) {
  if (dialog === elements.createCampaignDialog && createCampaignSubmitting) return;
  if ([elements.worldAuthorDialog, elements.characterDialog].includes(dialog)) {
    dismissEditDialog(dialog);
    return;
  }
  if (dialog === elements.characterDialog && characterModalBusy) return;
  if (dialog === elements.worldAuthorDialog && worldAuthorBusy) return;
  if (dialog.dataset.dismissMode === "cancel") {
    dialog.close("cancel");
    return;
  }
  if (modalBaselines.get(dialog) !== modalFormSnapshot(dialog)) {
    discardModalTarget = dialog;
    openManagedModal(elements.discardChangesDialog);
    return;
  }
  dialog.close();
}

function installClickAwayModalDismissal() {
  document.querySelectorAll("dialog").forEach((dialog) => {
    dialog.addEventListener("click", (event) => {
      if (dialog.open && clickedDialogBackdrop(dialog, event)) requestModalDismissal(dialog);
    });
    dialog.addEventListener("close", () => {
      modalBaselines.delete(dialog);
      editDialogBindingDisposers.get(dialog)?.();
      editDialogSessions.delete(dialog);
    });
  });
  elements.discardChangesDialog.addEventListener("close", () => {
    if (elements.discardChangesDialog.returnValue === "discard" && discardModalTarget?.open) discardModalTarget.close();
    discardModalTarget = null;
  });
  elements.worldForm.querySelectorAll("details > summary").forEach((summary) => {
    summary.addEventListener("click", (event) => {
      if (worldAuthorBusy) event.preventDefault();
    });
  });
  elements.characterDialog.addEventListener("click", (event) => {
    if (characterModalBusy && event.target.closest("details > summary")) event.preventDefault();
  });
}

installClickAwayModalDismissal();

let castContextAvailable = false;
let castPresetsAvailable = false;
let castRosterAvailable = false;

async function loadApplicationMetadata() {
  try {
    const response = await fetch("/api/v1/meta");
    if (!response.ok) {


      setSystemArchiveCapability(false, "System Archive availability could not be confirmed. Specialized formats remain available.");
      return;
    }
    const metadata = await response.json();


    const version = metadata?.application?.version;
    if (version && elements.nexusVersion) {
      elements.nexusVersion.textContent = `v${version}`;
      elements.nexusVersion.classList.remove("hidden");
    }
    castRosterAvailable = Boolean(metadata?.capabilities && Object.hasOwn(metadata.capabilities, "castEditing"));
    castContextAvailable = metadata?.capabilities?.castContext === true;
    castPresetsAvailable = metadata?.capabilities?.castPresets === true;
    elements.worldCharacterPresetsUnavailable.hidden = castPresetsAvailable;
    if (campaignCreationDialogSession) renderStartingCast(campaignCreationDialogSession);
    setSystemArchiveCapability(metadata?.capabilities?.systemArchive === true);
  } catch {


    setSystemArchiveCapability(false, "System Archive availability could not be confirmed. Specialized formats remain available.");
  }
}

void loadApplicationMetadata();

function clampedMemoryContextBudget(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_MEMORY_CONTEXT_BUDGET_TOKENS;
  return Math.min(MAX_MEMORY_CONTEXT_BUDGET_TOKENS, Math.max(MIN_MEMORY_CONTEXT_BUDGET_TOKENS, Math.trunc(numeric)));
}

function applyStoryProviderContextBudget() {
  const textProvider = effectiveCampaignProvider("text");
  const storyInputCapacity = Number(textProvider?.contextWindowTokens || 0)
    - Number(textProvider?.maxOutputTokens || 0)
    - 1024;
  if (!textProvider || storyInputCapacity < MIN_MEMORY_CONTEXT_BUDGET_TOKENS) {
    elements.budgetTokensSource.textContent = "Enter a memory context budget; the Story Engine will enforce the text provider's input limit.";
    elements.budgetTokensSource.className = "field-note manual-entry";
    return;
  }
  const safeBudget = clampedMemoryContextBudget(storyInputCapacity);
  elements.budgetTokens.value = String(safeBudget);
  elements.budgetTokensSource.textContent = `Automatically set to ${number(safeBudget)} tokens from the ${textProvider.name} story provider after reserving output and protocol space.`;
  elements.budgetTokensSource.className = "field-note api-supplied";
}

function updateStoryViewLink() {
  const resumeCampaign = campaignsLoaded
    ? resolveResumeCampaign(
      campaigns,
      ownerDevice.getItem("infiniteQuestLastCampaignId"),
      selectedCampaignIsExplicit ? selectedCampaign?.id : null
    )
    : null;
  const hasResumeTarget = Boolean(resumeCampaign);
  const storyHref = hasResumeTarget ? `/story/${encodeURIComponent(resumeCampaign.id)}` : "/nexus/#campaigns";
  if (elements.readingStoryExportLink) {
    elements.readingStoryExportLink.href = storyHref;
    elements.readingStoryExportLink.textContent = hasResumeTarget
      ? `Open ${resumeCampaign.title} Story exports`
      : "Choose a campaign to open its Story exports";
    elements.readingStoryExportLink.setAttribute("aria-disabled", String(!hasResumeTarget));
  }
  const label = hasResumeTarget
    ? "Continue latest story "
    : campaignsLoadError
      ? "Retry campaign list "
      : campaignsLoaded
        ? "No active stories "
        : "Loading campaigns ";
  [elements.storyViewLink, elements.dashboardStoryLink].filter(Boolean).forEach((link) => {
    link.href = storyHref;
    link.setAttribute("aria-disabled", String(!hasResumeTarget));
    link.tabIndex = hasResumeTarget ? 0 : -1;
  });
  if (elements.dashboardStoryLink?.firstChild?.nodeType === Node.TEXT_NODE) {
    elements.dashboardStoryLink.firstChild.textContent = label;
  }
}

const MANAGEMENT_HISTORY_STATE_KEY = "__infiniteQuestNexusManagement";
const MANAGEMENT_ROUTE_NAMES = new Set(["#dashboard", "#world-library", "#campaigns", "#providers", "#prompt-library", "#data-transfer", "#imports"]);
const UUID_ROUTE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
let managementNavigationIntent = 0;
let managementSelectionErrorIntent = null;
let managementSelectionErrorMessage = "";
let managementSelectionActionErrorMessage = "";
let managementSelectionActionErrorTargetId = "";
let acceptedManagementHash = window.location.hash || "#dashboard";
let acceptedManagementRoute = null;
let acceptedManagementHistoryIndex = Number.NaN;
let managementRollback = null;
let ignoredManagementHashChange = "";
let acceptedManagementHistoryLength = window.history.length;
let acceptedManagementNativeEntryIndex = window.navigation?.currentEntry?.index ?? null;
let managementPendingHashEntries = 0;
let initialWorldListReady = false;
let initialCampaignListReady = false;

function parseManagementRoute(hash) {
  const question = hash.indexOf("?");
  const routeName = (question < 0 ? hash : hash.slice(0, question)) || "#dashboard";
  const view = routeName === "#dashboard" ? "dashboard"
    : routeName === "#world-library" ? "worlds"
      : routeName === "#campaigns" ? "campaigns"
        : routeName === "#providers" ? "providers"
          : routeName === "#prompt-library" ? "prompt-library"
            : routeName === "#data-transfer" || routeName === "#imports" ? "data-transfer"
              : "worlds";
  const parameters = new URLSearchParams(question < 0 ? "" : hash.slice(question + 1));
  const worldIds = parameters.getAll("worldId");
  const campaignIds = parameters.getAll("campaignId");
  let selection = null;
  let selectionError = "";
  if (worldIds.length || campaignIds.length) {
    const worldSelection = worldIds.length === 1 && UUID_ROUTE_PATTERN.test(worldIds[0] || "");
    const campaignSelection = campaignIds.length === 1 && UUID_ROUTE_PATTERN.test(campaignIds[0] || "");
    if (worldIds.length && campaignIds.length) selectionError = "Choose one world or campaign link at a time.";
    else if (worldIds.length && view !== "worlds") selectionError = "This link asks for a world, but it does not open the Worlds workspace.";
    else if (campaignIds.length && view !== "campaigns") selectionError = "This link asks for a campaign, but it does not open the Campaigns workspace.";
    else if (worldIds.length && !worldSelection) selectionError = "This world link does not contain a valid world ID.";
    else if (campaignIds.length && !campaignSelection) selectionError = "This campaign link does not contain a valid campaign ID.";
    else if (worldSelection) selection = { kind: "world", id: worldIds[0].toLowerCase() };
    else if (campaignSelection) selection = { kind: "campaign", id: campaignIds[0].toLowerCase() };
  }
  return { view, routeName, selection, selectionError };
}

function managementHistoryState(index) {
  const current = window.history.state;
  const preserved = current && typeof current === "object" && !Array.isArray(current)
    ? current
    : current == null ? {} : { __infiniteQuestPreviousHistoryState: current };
  return { ...preserved, [MANAGEMENT_HISTORY_STATE_KEY]: { index } };
}

function managementHistoryIndex(state = window.history.state) {
  const index = state?.[MANAGEMENT_HISTORY_STATE_KEY]?.index;
  return Number.isSafeInteger(index) && index >= 0 ? index : null;
}

function replaceManagementHistoryIndex(index) {
  window.history.replaceState(managementHistoryState(index), "", window.location.href);
}

function managementRouteHref(hash) {
  return `${window.location.pathname}${window.location.search}${hash}`;
}

function managementSelectionHash(view, kind, id) {
  if (!UUID_ROUTE_PATTERN.test(String(id || ""))) return view === "worlds" ? "#world-library" : "#campaigns";
  const parameter = kind === "world" ? "worldId" : "campaignId";
  return `${view === "worlds" ? "#world-library" : "#campaigns"}?${parameter}=${encodeURIComponent(String(id).toLowerCase())}`;
}

function managementSelectionError(route, message) {
  if (managementSelectionErrorIntent !== managementNavigationIntent) {
    managementSelectionActionErrorMessage = "";
    managementSelectionActionErrorTargetId = "";
  }
  managementSelectionErrorIntent = managementNavigationIntent;
  managementSelectionErrorMessage = message;
  const visibleMessage = [managementSelectionActionErrorMessage, message].filter(Boolean).join(" ");
  if (route.view === "worlds") {
    elements.worldStatus.textContent = visibleMessage;
    elements.worldStatus.className = "status error";
    const pendingReadFailure = dashboardWorkflowErrors.get("worlds");
    if (pendingReadFailure) showManagementSelectionReadFailure("worlds", pendingReadFailure.message);
    else addWorkflowRetry(elements.worldStatus, "workflowRetryWorlds", "Retry world list", () => retryWorldWorkflowRead());
  } else if (route.view === "campaigns") {
    elements.campaignStatusMessage.textContent = visibleMessage;
    elements.campaignStatusMessage.className = "status error";
    elements.campaignStatusMessage.classList.remove("hidden");
    const pendingReadFailure = dashboardWorkflowErrors.get("campaigns");
    if (pendingReadFailure) showManagementSelectionReadFailure("campaigns", pendingReadFailure.message);
    else addWorkflowRetry(elements.campaignStatusMessage, "workflowRetryCampaigns", "Retry campaign list", () => retryCampaignWorkflowRead());
  }
}

function managementSelectionErrorIsCurrent(view) {
  return managementSelectionErrorIntent === managementNavigationIntent
    && acceptedManagementRoute?.view === view;
}

function clearResolvedManagementSelectionError(view) {
  if (!managementSelectionErrorIsCurrent(view)) return;
  const host = view === "worlds" ? elements.worldStatus : elements.campaignStatusMessage;
  const selectedId = view === "worlds" ? selectedWorld?.id : selectedCampaign?.id;
  const message = managementSelectionActionErrorTargetId === selectedId ? managementSelectionActionErrorMessage : "";
  managementSelectionErrorIntent = null;
  managementSelectionErrorMessage = "";
  managementSelectionActionErrorMessage = "";
  managementSelectionActionErrorTargetId = "";
  const readFailure = host.querySelector(".workflow-read-failure");
  for (const retry of host.querySelectorAll("#workflowRetryWorlds, #workflowRetryCampaigns")) {
    if (!readFailure?.contains(retry)) retry.remove();
  }
  for (const feedback of host.querySelectorAll(".workflow-retry-feedback")) {
    if (!readFailure?.contains(feedback)) feedback.remove();
  }
  host.replaceChildren();
  if (message) host.append(document.createTextNode(message));
  else if (view === "worlds" && !readFailure) host.append(document.createTextNode("World content is stored in PostgreSQL, never embedded in this client."));
  if (readFailure) host.append(readFailure);
  host.className = message ? "status error" : "status";
  if (view === "campaigns" && !message && !readFailure) host.classList.add("hidden");
}

function showManagementSelectionReadFailure(view, message) {
  const host = view === "worlds" ? elements.worldStatus : elements.campaignStatusMessage;
  const isWorld = view === "worlds";
  const retryId = isWorld ? "workflowRetryWorlds" : "workflowRetryCampaigns";
  const label = isWorld ? "Retry world list" : "Retry campaign list";
  const retry = isWorld ? () => retryWorldWorkflowRead() : () => retryCampaignWorkflowRead();
  setWorkflowReadFailure(host, view, message, retryId, label, retry);
}

async function applyExplicitManagementSelection(route, intent, selectionOptions = {}) {
  if (intent !== managementNavigationIntent || acceptedManagementRoute !== route) return;
  if (route.selectionError) {
    managementSelectionError(route, route.selectionError);
    return;
  }
  if (!route.selection) return;
  if (route.selection.kind === "world") {
    if (!initialWorldListReady) return;
    const target = worlds.find((world) => world.id === route.selection.id);
    if (!target) {
      managementSelectionError(route, `World ${route.selection.id} is not available in this library. Select an available world or check the link.`);
      return;
    }
    const selectionIntentEpoch = selectionOptions.selectionIntentEpoch ?? ++worldSelectionIntentEpoch;
    await selectWorld(target.id, { selectionIntentEpoch, preserveWorkflowFeedbackForWorldId: selectionOptions.preserveWorkflowFeedbackForWorldId });
    if (intent === managementNavigationIntent && acceptedManagementRoute === route && selectedWorld?.id === target.id) clearResolvedManagementSelectionError("worlds");
    return;
  }
  if (!initialCampaignListReady) return;
  const target = campaigns.find((campaign) => campaign.id === route.selection.id);
  if (!target) {
    managementSelectionError(route, `Campaign ${route.selection.id} is not available in this library. Select an available campaign or check the link.`);
    return;
  }
  if (selectedCampaign?.id !== target.id) await selectCampaign(target, { preserveWorkflowFeedbackForCampaignId: selectionOptions.preserveWorkflowFeedbackForCampaignId });
  if (intent === managementNavigationIntent && acceptedManagementRoute === route && selectedCampaign?.id === target.id) clearResolvedManagementSelectionError("campaigns");
}

function managementHeading(route) {
  const headingId = route.view === "dashboard" ? "dashboardTitle"
    : route.view === "worlds" ? "world-library-title"
      : route.view === "campaigns" ? "memoryTitle"
        : route.view === "providers" ? "provider-title"
          : route.view === "prompt-library" ? "promptLibraryTitle"
            : "dataTransferTitle";
  const heading = document.getElementById(headingId);
  if (heading && !heading.hasAttribute("tabindex")) heading.tabIndex = -1;
  return heading;
}

function applyManagementView(hash, { focus = false } = {}) {
  const route = parseManagementRoute(hash || "#dashboard");
  const dashboardView = route.view === "dashboard";
  if (route.view === "providers" || route.view === "prompt-library") {
    location.assign(settingsBookmarkDestination(hash));
    return route;
  }
  const dataTransferView = route.view === "data-transfer";
  const campaignView = route.view === "campaigns";
  document.body.dataset.managementView = route.view;
  elements.managementHeader.hidden = dashboardView;
  elements.dashboard.hidden = !dashboardView;
  elements["world-library"].hidden = route.view !== "worlds";
  elements.campaigns.hidden = !campaignView;
  document.querySelectorAll(".data-transfer-management").forEach((section) => { section.hidden = !dataTransferView; });
  elements.managementTitle.textContent = dataTransferView ? "Data Transfer" : campaignView ? "Campaign Management" : "World Management";
  elements.managementDescription.textContent = dataTransferView
        ? "Move an owner library, world, campaign, external import, or readable story through its supported portable format."
        : campaignView
          ? "Configure campaigns, Chronicle memory, provider selection, illustrations, and world-version migrations."
          : "Author reusable versioned worlds and keep each campaign pinned to its chosen immutable world version.";
  document.title = dashboardView ? "Infinite Quest Nexus" : `${elements.managementTitle.textContent} · Infinite Quest Nexus`;

  [elements.navDashboard, elements.navProviders, elements.navPromptLibrary, elements.navWorlds, elements.navCampaigns, elements.navDataTransfer].forEach((link) => link?.classList.remove("active"));
  if (dashboardView) elements.navDashboard?.classList.add("active");
  if (route.routeName === "#world-library") elements.navWorlds?.classList.add("active");
  if (campaignView) elements.navCampaigns?.classList.add("active");
  if (dataTransferView) elements.navDataTransfer?.classList.add("active");
  elements.navSetup?.classList.toggle("active", !dashboardView);
  updateStoryViewLink();
  projectDashboardWorkflowErrorToRoute(route);
  if (focus && ![...document.querySelectorAll("dialog[open]")].length) managementHeading(route)?.focus({ preventScroll: true });
  return route;
}

function isManagementRouteHash(hash) {
  const routeName = ((hash || "#dashboard").split("?", 1)[0]) || "#dashboard";
  return MANAGEMENT_ROUTE_NAMES.has(routeName);
}

async function canLeaveManagementRoute(nextRoute) {
  for (const dialog of [elements.worldAuthorDialog, elements.characterDialog]) {
    if (!dialog?.open) continue;
    if (worldAuthorBusy || characterModalBusy) return false;
    await dismissEditDialog(dialog);
    if (dialog.open) return false;
  }
  if (elements.createCampaignDialog?.open && (createCampaignSubmitting || createCampaignCommitted)) return false;
  if (acceptedManagementRoute?.view === "campaigns"
    && (nextRoute.view !== "campaigns" || (nextRoute.selection?.kind === "campaign" && nextRoute.selection.id !== selectedCampaign?.id))) {
    if (!(await canLeaveCampaignEditor(nextRoute.view === "campaigns" ? nextRoute.selection?.id ?? null : null))) return false;
  }
  return true;
}

function rollbackManagementHistory(destinationIndex, fallbackDelta = 1) {
  if (managementRollback) return;
  const currentIndex = acceptedManagementHistoryIndex;
  const delta = destinationIndex == null || destinationIndex === currentIndex
    ? fallbackDelta
    : currentIndex - destinationIndex;
  if (!delta) return;
  managementRollback = { hash: acceptedManagementHash, index: currentIndex, candidateHash: window.location.hash || "#dashboard" };
  window.history.go(delta);
}

function finishManagementHistoryRollback() {
  if (!managementRollback) return false;
  const rollback = managementRollback;
  managementRollback = null;
  acceptedManagementHash = window.location.hash || "#dashboard";
  acceptedManagementHistoryIndex = managementHistoryIndex() ?? rollback.index;
  acceptedManagementHistoryLength = window.history.length;
  acceptedManagementNativeEntryIndex = window.navigation?.currentEntry?.index ?? null;
  managementPendingHashEntries = 0;
  ignoredManagementHashChange = acceptedManagementHash === rollback.candidateHash ? "" : acceptedManagementHash;
  acceptedManagementRoute = applyManagementView(acceptedManagementHash);
  return true;
}

function restoreAcceptedManagementRouteInCurrentEntry() {
  window.history.replaceState(managementHistoryState(acceptedManagementHistoryIndex), "", managementRouteHref(acceptedManagementHash));
  acceptedManagementHistoryLength = window.history.length;
  managementPendingHashEntries = 0;
  acceptedManagementRoute = applyManagementView(acceptedManagementHash);
}

async function acceptManagementRoute(hash, { source = "link", focus = true, destinationIndex = null } = {}) {
  if (!isManagementRouteHash(hash)) return false;
  const intent = ++managementNavigationIntent;
  const nextRoute = parseManagementRoute(hash);
  const previousHash = acceptedManagementHash;
  const previousIndex = acceptedManagementHistoryIndex;
  const previousRoute = acceptedManagementRoute;
  if (!(await canLeaveManagementRoute(nextRoute))) {
    if (intent === managementNavigationIntent && source === "popstate") rollbackManagementHistory(destinationIndex);
    else if (intent === managementNavigationIntent && source === "hashchange") rollbackManagementHistory(destinationIndex, -1);
    else if (intent === managementNavigationIntent && source === "unindexed") restoreAcceptedManagementRouteInCurrentEntry();
    return false;
  }
  if (intent !== managementNavigationIntent || acceptedManagementRoute !== previousRoute || acceptedManagementHash !== previousHash) return false;

  managementSelectionErrorIntent = null;
  managementSelectionErrorMessage = "";
  if (source === "link") {
    if (hash !== previousHash) {
      acceptedManagementHistoryIndex = previousIndex + 1;
      window.history.pushState(managementHistoryState(acceptedManagementHistoryIndex), "", managementRouteHref(hash));
      acceptedManagementHistoryLength = window.history.length;
    }
  } else if (source === "hashchange") {
    acceptedManagementHistoryIndex = destinationIndex ?? previousIndex + 1;
    if (managementHistoryIndex() !== acceptedManagementHistoryIndex) replaceManagementHistoryIndex(acceptedManagementHistoryIndex);
    acceptedManagementHistoryLength = window.history.length;
  } else if (source === "popstate") {
    const poppedIndex = destinationIndex;
    acceptedManagementHistoryIndex = poppedIndex == null ? Math.max(0, previousIndex - 1) : poppedIndex;
    if (poppedIndex == null) replaceManagementHistoryIndex(acceptedManagementHistoryIndex);
    acceptedManagementHistoryLength = window.history.length;
  } else if (source === "unindexed") {
    acceptedManagementHistoryIndex = previousIndex + 1;
    replaceManagementHistoryIndex(acceptedManagementHistoryIndex);
    acceptedManagementHistoryLength = window.history.length;
  }

  acceptedManagementHash = hash || "#dashboard";
  acceptedManagementRoute = applyManagementView(acceptedManagementHash, { focus });
  acceptedManagementNativeEntryIndex = window.navigation?.currentEntry?.index ?? null;
  managementPendingHashEntries = 0;
  closeNavigationMenus();
  if (elements.worldDetailsDialog?.open) elements.worldDetailsDialog.close();
  await applyExplicitManagementSelection(acceptedManagementRoute, intent);
  return true;
}

function initializeManagementHistory() {
  const existingIndex = managementHistoryIndex();
  acceptedManagementHistoryIndex = existingIndex ?? 0;
  if (existingIndex == null) replaceManagementHistoryIndex(acceptedManagementHistoryIndex);
  acceptedManagementHistoryLength = window.history.length;
  acceptedManagementNativeEntryIndex = window.navigation?.currentEntry?.index ?? null;
  acceptedManagementRoute = applyManagementView(acceptedManagementHash);
}

initializeManagementHistory();
document.addEventListener("click", (event) => {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
  if (!(anchor instanceof HTMLAnchorElement) || anchor.target || anchor.hasAttribute("download")) return;
  const target = new URL(anchor.href, window.location.href);
  if (target.origin !== window.location.origin || target.pathname !== window.location.pathname || target.search !== window.location.search || !isManagementRouteHash(target.hash)) return;
  event.preventDefault();
  event.stopPropagation();
  void acceptManagementRoute(target.hash, { source: "link", focus: true });
}, true);

window.addEventListener("popstate", (event) => {
  if (finishManagementHistoryRollback()) return;
  const hash = window.location.hash || "#dashboard";
  const destinationIndex = managementHistoryIndex(event.state);
  if (!isManagementRouteHash(hash)) return;
  ignoredManagementHashChange = hash;
  setTimeout(() => { if (ignoredManagementHashChange === hash) ignoredManagementHashChange = ""; }, 0);
  const historyLength = window.history.length;
  const previousHistoryLength = acceptedManagementHistoryLength;
  const nativeEntryIndex = window.navigation?.currentEntry?.index ?? null;
  const hasNativeHistoryIndex = nativeEntryIndex != null && acceptedManagementNativeEntryIndex != null;
  const nativeEntryDelta = hasNativeHistoryIndex
    ? nativeEntryIndex - acceptedManagementNativeEntryIndex
    : null;
  const directHashEntry = destinationIndex == null && (hasNativeHistoryIndex
    ? nativeEntryDelta > 0
    : historyLength > previousHistoryLength && event.state != null);
  const unindexedRouteEntry = destinationIndex == null && !directHashEntry && !hasNativeHistoryIndex && hash !== acceptedManagementHash;
  if (directHashEntry) {
    managementPendingHashEntries = nativeEntryDelta != null
      ? Math.max(1, nativeEntryDelta)
      : Math.max(1, managementPendingHashEntries + Math.max(0, historyLength - previousHistoryLength));
  } else managementPendingHashEntries = 0;
  const observedIndex = directHashEntry ? acceptedManagementHistoryIndex + managementPendingHashEntries : destinationIndex;
  if (directHashEntry) replaceManagementHistoryIndex(observedIndex);
  acceptedManagementHistoryLength = historyLength;
  void acceptManagementRoute(hash, {
    source: directHashEntry ? "hashchange" : unindexedRouteEntry ? "unindexed" : "popstate",
    focus: true,
    destinationIndex: observedIndex
  });
});

window.addEventListener("hashchange", () => {
  const hash = window.location.hash || "#dashboard";
  if (ignoredManagementHashChange === hash) {
    ignoredManagementHashChange = "";
    return;
  }
  if (!isManagementRouteHash(hash)) return;
  const nativeEntryIndex = window.navigation?.currentEntry?.index ?? null;
  const nativeEntryDelta = nativeEntryIndex != null && acceptedManagementNativeEntryIndex != null
    ? nativeEntryIndex - acceptedManagementNativeEntryIndex
    : null;
  const source = nativeEntryDelta != null
    ? nativeEntryDelta > 0 ? "hashchange" : "unindexed"
    : window.history.length > acceptedManagementHistoryLength ? "hashchange" : "unindexed";
  void acceptManagementRoute(hash, { source, focus: true });
});

async function api(path, options = {}) {
  const hasBody = options.body !== undefined && options.body !== null;
  const response = await fetch(path, {
    ...options,
    headers: { ...(hasBody ? { "content-type": "application/json" } : {}), ...(options.headers || {}) }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.message || `Request failed with HTTP ${response.status}.`);
    error.name = payload.error || "ApiError";
    error.statusCode = response.status;
    error.correlationId = payload.correlationId || response.headers.get("x-correlation-id") || "";
    error.details = payload.details || payload.issues || (payload.blockers ? { blockers: payload.blockers } : null);
    throw error;
  }
  return payload;
}

const SYSTEM_ARCHIVE_CHUNK_BYTES = 4 * 1024 * 1024;
const SYSTEM_ARCHIVE_TERMINAL_STATUSES = new Set(["published", "completed", "cancelled", "rolled_back", "failed", "expired"]);
const SYSTEM_ARCHIVE_EXPORT_CANCELLABLE = new Set(["queued", "capturing", "writing", "verifying", "cancelling"]);
const SYSTEM_ARCHIVE_IMPORT_CANCELLABLE = new Set(["queued", "uploading", "validating", "previewed", "revalidating", "waiting_for_gate", "cancelling"]);
const SYSTEM_ARCHIVE_ACKNOWLEDGEMENT_IDS = Object.freeze([
  "acknowledgeSensitiveArchive",
  "acknowledgeEmptyDestination",
  "acknowledgeInvalidatedAccess",
  "acknowledgeProviderReentry",
  "acknowledgeNonCancellableBoundary"
]);
const SYSTEM_ARCHIVE_OPERATION_STORAGE_PREFIX = "infiniteQuest.systemArchiveOperation.v1";
const SYSTEM_ARCHIVE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SYSTEM_SHA256_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

function rotateSystemArchiveHash(value, amount) {
  return (value >>> amount) | (value << (32 - amount));
}

class SystemArchiveSha256 {
  constructor() {
    this.state = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    this.buffer = new Uint8Array(64);
    this.bufferLength = 0;
    this.bytesHashed = 0;
  }

  update(bytes) {
    this.bytesHashed += bytes.byteLength;
    let offset = 0;
    if (this.bufferLength > 0) {
      const copied = Math.min(64 - this.bufferLength, bytes.byteLength);
      this.buffer.set(bytes.subarray(0, copied), this.bufferLength);
      this.bufferLength += copied;
      offset += copied;
      if (this.bufferLength === 64) {
        this.process(this.buffer);
        this.bufferLength = 0;
      }
    }
    while (offset + 64 <= bytes.byteLength) {
      this.process(bytes.subarray(offset, offset + 64));
      offset += 64;
    }
    if (offset < bytes.byteLength) {
      this.buffer.set(bytes.subarray(offset), 0);
      this.bufferLength = bytes.byteLength - offset;
    }
  }

  process(block) {
    const words = new Uint32Array(64);
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(index * 4, false);
    for (let index = 16; index < 64; index += 1) {
      const left = words[index - 15];
      const right = words[index - 2];
      const sigma0 = rotateSystemArchiveHash(left, 7) ^ rotateSystemArchiveHash(left, 18) ^ (left >>> 3);
      const sigma1 = rotateSystemArchiveHash(right, 17) ^ rotateSystemArchiveHash(right, 19) ^ (right >>> 10);
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = this.state;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateSystemArchiveHash(e, 6) ^ rotateSystemArchiveHash(e, 11) ^ rotateSystemArchiveHash(e, 25);
      const choice = (e & f) ^ (~e & g);
      const first = (h + sum1 + choice + SYSTEM_SHA256_CONSTANTS[index] + words[index]) >>> 0;
      const sum0 = rotateSystemArchiveHash(a, 2) ^ rotateSystemArchiveHash(a, 13) ^ rotateSystemArchiveHash(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const second = (sum0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + first) >>> 0; d = c; c = b; b = a; a = (first + second) >>> 0;
    }
    this.state[0] = (this.state[0] + a) >>> 0;
    this.state[1] = (this.state[1] + b) >>> 0;
    this.state[2] = (this.state[2] + c) >>> 0;
    this.state[3] = (this.state[3] + d) >>> 0;
    this.state[4] = (this.state[4] + e) >>> 0;
    this.state[5] = (this.state[5] + f) >>> 0;
    this.state[6] = (this.state[6] + g) >>> 0;
    this.state[7] = (this.state[7] + h) >>> 0;
  }

  digestHex() {
    const final = new Uint8Array(this.bufferLength < 56 ? 64 : 128);
    final.set(this.buffer.subarray(0, this.bufferLength));
    final[this.bufferLength] = 0x80;
    const view = new DataView(final.buffer);
    const lengthOffset = final.byteLength - 8;
    view.setUint32(lengthOffset, Math.floor(this.bytesHashed / 0x20000000), false);
    view.setUint32(lengthOffset + 4, (this.bytesHashed * 8) >>> 0, false);
    for (let offset = 0; offset < final.byteLength; offset += 64) this.process(final.subarray(offset, offset + 64));
    return [...this.state].map((value) => value.toString(16).padStart(8, "0")).join("");
  }
}

function systemArchiveBytesSha256(bytes) {
  const hash = new SystemArchiveSha256();
  hash.update(bytes);
  return hash.digestHex();
}

async function systemArchiveFileSha256(file, signal, onProgress) {
  const hash = new SystemArchiveSha256();
  for (let offset = 0; offset < file.size; offset += SYSTEM_ARCHIVE_CHUNK_BYTES) {
    if (signal.aborted) throw signal.reason || new DOMException("Transfer cancelled", "AbortError");
    const end = Math.min(file.size, offset + SYSTEM_ARCHIVE_CHUNK_BYTES);
    hash.update(new Uint8Array(await file.slice(offset, end).arrayBuffer()));
    onProgress(end);
  }
  return hash.digestHex();
}

function systemArchiveFormatBytes(value) {
  if (value < 1024) return `${value} bytes`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let size = value;
  let index = -1;
  do { size /= 1024; index += 1; } while (size >= 1024 && index < units.length - 1);
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[index]}`;
}

function systemArchiveOwnerMappingText(mapping) {
  return `Source owner ${mapping.sourceOwnerId}. Destination owner ${mapping.destinationOwnerId}.`;
}

function systemArchiveVersionsText(versions) {
  return `Archive format ${versions.archiveFormat}. Source application ${versions.sourceApplication}. Source migration ${versions.sourceMigration}. `
    + `Destination application ${versions.destinationApplication}. Destination migration ${versions.destinationMigration}.`;
}

function systemArchiveCapacityText(label, capacity) {
  const available = capacity.availableBytes === null ? "unknown available" : `${systemArchiveFormatBytes(capacity.availableBytes)} available`;
  return `${label} capacity: ${systemArchiveFormatBytes(capacity.requiredBytes)} required · ${available} · ${capacity.verified ? "verified" : "not verified"} · `
    + `${capacity.sufficient ? "sufficient" : "insufficient"} · ${capacity.overrideUsed ? "operator override used" : "no capacity override"}.`;
}

function systemArchiveOperationalOmissionsText(omissions) {
  return Object.entries(omissions).map(([category, count]) => `${category} ${number(count)}`).join(" · ");
}

function systemArchiveIdempotencyKey(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function systemArchiveUploadStorageKey(byteLength, sha256) {
  return `infiniteQuest.systemArchiveUpload.v1:${byteLength}:${sha256}`;
}

function systemArchiveOperationStorageKey(kind) {
  return systemArchiveOwnerId ? `${SYSTEM_ARCHIVE_OPERATION_STORAGE_PREFIX}:${systemArchiveOwnerId}:${kind}` : null;
}

function readSystemArchiveOperation(kind) {
  const key = systemArchiveOperationStorageKey(kind);
  if (!key) return null;
  try {
    const value = JSON.parse(sessionStorage.getItem(key) || "null");
    if (!value || typeof value !== "object" || Array.isArray(value) || value.kind !== kind) return null;
    if (typeof value.idempotencyKey !== "string" || !value.idempotencyKey || value.idempotencyKey.length > 200) return null;
    if (value.jobId !== null && (typeof value.jobId !== "string" || !SYSTEM_ARCHIVE_UUID_PATTERN.test(value.jobId))) return null;
    if (value.previewHandle !== undefined && (typeof value.previewHandle !== "string" || !value.previewHandle || value.previewHandle.length > 200)) return null;
    return {
      kind,
      idempotencyKey: value.idempotencyKey,
      jobId: value.jobId,
      ...(typeof value.previewHandle === "string" ? { previewHandle: value.previewHandle } : {})
    };
  } catch {
    return null;
  }
}

function writeSystemArchiveOperation(operation) {
  const key = systemArchiveOperationStorageKey(operation.kind);
  if (!key) return;
  try {
    sessionStorage.setItem(key, JSON.stringify(operation));
  } catch {
    // The operation remains usable on this page when browser session storage is blocked.
  }
}

function readSystemArchiveUploadSession(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "null");
    return value && typeof value.id === "string" && value.byteLength >= 0 && typeof value.sha256 === "string"
      ? value : null;
  } catch {
    return null;
  }
}

function saveSystemArchiveUploadSession(key, upload, sha256) {
  try {
    localStorage.setItem(key, JSON.stringify({ id: upload.id, byteLength: upload.byteLength, sha256, chunkBytes: SYSTEM_ARCHIVE_CHUNK_BYTES }));
  } catch {
    // Durable server upload remains usable for this page even when browser storage is blocked.
  }
}

function clearSystemArchiveUploadSession() {
  if (!systemArchiveUploadSessionKey) return;
  try {
    localStorage.removeItem(systemArchiveUploadSessionKey);
  } catch {
    // The cancelled server upload is still forgotten on this page when browser storage is blocked.
  }
  systemArchiveUploadSessionKey = null;
}

function setSystemArchiveCapability(enabled, message = "") {
  systemArchiveEnabled = enabled;
  if (!elements.systemArchiveTransfer) return;
  elements.systemArchiveTransfer.dataset.systemArchiveState = enabled ? "available" : "disabled";
  elements.systemArchiveCapability.textContent = enabled ? "Available" : "Disabled by operator";
  elements.systemArchiveCapabilityMessage.textContent = message || (enabled
    ? "System Archive is available. Transfers are durable and can resume after a disconnected browser session."
    : "System Archive is not enabled on this instance. World, Campaign, legacy, external, and readable formats remain available.");
  elements.systemArchiveStatus.textContent = enabled ? "Choose an owner-wide export or a System Archive file." : "Specialized Data Transfer tools remain available.";
  beginSystemArchiveRecoveryWhenReady();
}

function systemArchiveJobCancellable(job) {
  return job?.kind === "export" ? SYSTEM_ARCHIVE_EXPORT_CANCELLABLE.has(job.status) : SYSTEM_ARCHIVE_IMPORT_CANCELLABLE.has(job?.status);
}

function updateSystemArchiveControls() {
  if (!elements.systemArchiveTransfer) return;
  const activeExport = systemArchiveJobs.export && !SYSTEM_ARCHIVE_TERMINAL_STATUSES.has(systemArchiveJobs.export.status);
  const jobCancellable = Object.values(systemArchiveJobs).some((job) => systemArchiveJobCancellable(job));
  const sessionReady = Boolean(systemArchiveOwnerId);
  elements.createSystemArchive.disabled = !systemArchiveEnabled || !sessionReady || systemArchiveBusy || activeExport;
  elements.systemArchiveFile.disabled = !systemArchiveEnabled || !sessionReady || systemArchiveBusy;
  elements.uploadSystemArchive.disabled = !systemArchiveEnabled || !sessionReady || systemArchiveBusy || !systemArchiveSelectedFile;
  elements.cancelSystemArchive.disabled = !systemArchiveEnabled || !sessionReady || systemArchiveCancellationPending
    || (!systemArchiveOperationController && !jobCancellable && !systemArchiveUpload);
  elements.commitSystemImport.disabled = !systemArchiveEnabled || !sessionReady || systemArchiveBusy || !systemArchivePreview?.valid;
}

function setSystemArchiveBusy(busy) {
  systemArchiveBusy = busy;
  elements.systemArchiveTransfer?.setAttribute("aria-busy", String(busy));
  updateSystemArchiveControls();
}

function setSystemArchiveStatus(message, type = "") {
  elements.systemArchiveStatus.textContent = message;
  elements.systemArchiveStatus.className = `status ${type}`.trim();
}

function clearSystemArchiveError() {
  elements.systemArchiveError.textContent = "";
  elements.systemArchiveError.classList.add("hidden");
}

function showSystemArchiveError(error) {
  elements.systemArchiveError.textContent = error?.message || String(error);
  elements.systemArchiveError.classList.remove("hidden");
  setSystemArchiveStatus("Data Transfer needs attention.", "error");
}

function renderSystemArchiveProgress(phase, receivedBytes, byteLength) {
  const percent = byteLength > 0 ? Math.min(100, Math.round(receivedBytes / byteLength * 100)) : 0;
  elements.systemArchiveProgress.classList.remove("hidden");
  elements.systemArchiveProgressBar.value = percent;
  elements.systemArchiveProgressPercent.textContent = `${percent}%`;
  elements.systemArchiveProgressLabel.textContent = phase === "hashing"
    ? "Checking archive integrity…"
    : phase === "uploading"
      ? `Uploading resumable chunks · ${systemArchiveFormatBytes(receivedBytes)} of ${systemArchiveFormatBytes(byteLength)}`
      : "Verifying the completed server upload…";
}

function systemArchiveSummaryItem(label, value) {
  const item = document.createElement("div");
  const term = document.createElement("span");
  const detail = document.createElement("strong");
  term.textContent = label;
  detail.textContent = value;
  item.append(term, detail);
  return item;
}

function renderSystemImportPreview(preview) {
  systemArchivePreview = preview;
  elements.systemImportPreview.classList.remove("hidden");
  elements.systemImportPreview.dataset.systemPreview = preview.valid ? "ready" : "invalid";
  const recordCount = Object.values(preview.recordsByDomain || {}).reduce((total, value) => total + Number(value || 0), 0);
  elements.systemImportPreviewSummary.replaceChildren(
    systemArchiveSummaryItem("Destination", preview.destinationEmpty ? "Empty and eligible" : "Not empty"),
    systemArchiveSummaryItem("Portable records", number(recordCount)),
    systemArchiveSummaryItem("Original images", `${number(preview.assets.originalCount)} · ${systemArchiveFormatBytes(preview.assets.totalBytes)}`),
    systemArchiveSummaryItem("Source owners", String(preview.sourceOwnerCount))
  );
  elements.systemImportPreviewExpiry.textContent = preview.expiresAt ? `Preview expires ${new Date(preview.expiresAt).toLocaleString()}` : "No commit authority issued";
  elements.systemImportOwnerMapping.textContent = systemArchiveOwnerMappingText(preview.ownerMapping);
  elements.systemImportVersionSummary.textContent = systemArchiveVersionsText(preview.versions);
  elements.systemImportFingerprint.textContent = preview.archiveFingerprint
    ? `Archive fingerprint ${preview.archiveFingerprint}.`
    : "Archive fingerprint unavailable.";
  elements.systemImportNormalization.textContent = `Normalization ${preview.normalization.join(" · ") || "none"}.`;
  elements.systemImportStagingCapacity.textContent = systemArchiveCapacityText("Staging", preview.space.staging);
  elements.systemImportAssetCapacity.textContent = systemArchiveCapacityText("Asset-root", preview.space.assetRoot);
  elements.systemImportProviderSummary.textContent = `${number(preview.disabledProviders)} disabled providers. Credentials are excluded and must be entered again.`;
  elements.systemImportAccessSummary.textContent = preview.invalidatedAccess?.length
    ? `External access will be invalidated: ${preview.invalidatedAccess.join(", ")}.` : "No external access categories were reported.";
  elements.systemImportRebuildSummary.textContent = `Chronicle index: ${number(preview.rebuilds.chronicleIndex.itemCount)} campaigns. Asset thumbnails: ${number(preview.rebuilds.assetThumbnails.itemCount)} originals.`;
  elements.systemImportOmissionSummary.textContent = `${number(preview.omittedOperationalRows)} rows excluded · ${systemArchiveOperationalOmissionsText(preview.operationalOmissions)}.`;
  const diagnostics = [...(preview.warnings || []), ...(preview.errors || [])];
  elements.systemImportPreviewWarnings.textContent = diagnostics.join(" ");
  elements.systemImportPreviewWarnings.classList.toggle("hidden", diagnostics.length === 0);
  elements.systemImportAcknowledgements.disabled = !preview.valid;
  SYSTEM_ARCHIVE_ACKNOWLEDGEMENT_IDS.forEach((id) => {
    elements[id].checked = false;
    elements[id].removeAttribute("aria-invalid");
  });
  updateSystemArchiveControls();
}

function invalidateSystemImportPreviewAuthority() {
  systemArchivePreview = null;
  elements.systemImportPreview.classList.add("hidden");
  elements.systemImportPreview.dataset.systemPreview = "empty";
  elements.systemImportAcknowledgements.disabled = true;
  SYSTEM_ARCHIVE_ACKNOWLEDGEMENT_IDS.forEach((id) => {
    elements[id].checked = false;
    elements[id].removeAttribute("aria-invalid");
  });
  updateSystemArchiveControls();
}

function renderSystemImportReport(job) {
  if (job.kind !== "import" || !job.report) return;
  const report = job.report;
  const recordCount = Object.values(report.recordsByDomain || {}).reduce((total, value) => total + Number(value || 0), 0);
  elements.systemImportReport.classList.remove("hidden");
  elements.systemImportReport.dataset.systemImportState = job.status;
  elements.systemImportReportStatus.textContent = job.status === "completed" ? "Integrity verified" : job.status.replaceAll("_", " ");
  elements.systemImportReportSummary.replaceChildren(
    systemArchiveSummaryItem("Records restored", number(recordCount)),
    systemArchiveSummaryItem("Original images", `${number(report.assetCount)} · ${systemArchiveFormatBytes(report.assetBytes)}`),
    systemArchiveSummaryItem("Providers disabled", number(report.disabledProviders)),
    systemArchiveSummaryItem("Access categories invalidated", number(report.invalidatedAccess.length))
  );
  elements.systemImportReportOwnerMapping.textContent = systemArchiveOwnerMappingText(report.ownerMapping);
  elements.systemImportReportVersionSummary.textContent = systemArchiveVersionsText(report.versions);
  elements.systemImportReportFingerprint.textContent = `Archive fingerprint ${report.archiveFingerprint}.`;
  elements.systemImportReportNormalization.textContent = `Normalization ${report.normalization.join(" · ")}.`;
  elements.systemImportReportAccess.textContent = `Invalidated access ${report.invalidatedAccess.join(" · ")}.`;
  elements.systemImportReportIntegrity.textContent = "Fingerprint verified · Records matched · Original assets matched.";
  elements.systemImportReportOmissions.textContent = `${number(report.omittedOperationalRows)} rows excluded · ${systemArchiveOperationalOmissionsText(report.operationalOmissions)}.`;
  const diagnostics = [
    ...(report.warnings || []).map((warning) => `Warning ${warning}`),
    ...(report.errors || []).map((code) => `Error ${code}`)
  ];
  elements.systemImportReportDiagnostics.textContent = diagnostics.length ? diagnostics.join(" · ") : "No terminal warnings or errors.";
  elements.systemImportReportRebuilds.textContent = `Chronicle index: ${report.rebuildState.chronicleIndex.status} for ${number(report.rebuildState.chronicleIndex.itemCount)} campaigns. Asset thumbnails: ${report.rebuildState.assetThumbnails.status} for ${number(report.rebuildState.assetThumbnails.itemCount)} originals.`;
}

function systemArchiveOperationFor(kind) {
  return kind === "export" ? systemArchiveExportOperation : systemArchiveImportOperation;
}

function setSystemArchiveOperation(kind, operation) {
  if (kind === "export") systemArchiveExportOperation = operation;
  else systemArchiveImportOperation = operation;
}

function systemArchiveFenceCurrent(fence) {
  const operation = systemArchiveOperationFor(fence.kind);
  return systemArchiveOperationFences[fence.kind] === fence
    && systemArchiveOperationGenerations[fence.kind] === fence.generation
    && operation?.kind === fence.kind
    && operation.idempotencyKey === fence.idempotencyKey
    && operation.jobId === fence.jobId;
}

function beginSystemArchiveOperation(kind, operation) {
  systemArchiveRecoveryControllers[kind]?.abort(new DOMException("Superseded by newer transfer", "AbortError"));
  systemArchiveOperationGenerations[kind] += 1;
  const fence = {
    kind,
    generation: systemArchiveOperationGenerations[kind],
    idempotencyKey: operation.idempotencyKey,
    jobId: operation.jobId
  };
  systemArchiveOperationFences[kind] = fence;
  setSystemArchiveOperation(kind, operation);
  systemArchiveJobs[kind] = null;
  return fence;
}

function systemArchiveFenceForOperation(kind, operation) {
  const existing = systemArchiveOperationFences[kind];
  if (existing
    && existing.idempotencyKey === operation.idempotencyKey
    && existing.jobId === operation.jobId
    && systemArchiveFenceCurrent(existing)) return existing;
  return beginSystemArchiveOperation(kind, operation);
}

function renderSystemArchiveJob(job, fence = null) {
  if (fence && (!systemArchiveFenceCurrent(fence) || fence.kind !== job.kind || fence.jobId !== job.id)) return false;
  systemArchiveJobs[job.kind] = job;
  setSystemArchiveStatus(`${job.kind === "export" ? "System Export" : "System Import"}: ${job.status.replaceAll("_", " ")}.`);
  if (job.kind === "export" && job.status === "published") {
    elements.systemArchiveDownload.href = `/api/v1/system-exports/${encodeURIComponent(job.id)}/download`;
    elements.systemArchiveDownload.classList.remove("hidden");
  }
  renderSystemImportReport(job);
  updateSystemArchiveControls();
  return true;
}

async function monitorSystemArchiveJob(job, signal, fence) {
  let latest = job;
  if (!renderSystemArchiveJob(latest, fence)) return latest;
  while (systemArchiveFenceCurrent(fence) && !SYSTEM_ARCHIVE_TERMINAL_STATUSES.has(latest.status)) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (signal.aborted) throw signal.reason || new DOMException("Transfer cancelled", "AbortError");
    if (!systemArchiveFenceCurrent(fence)) return latest;
    const segment = latest.kind === "export" ? "system-exports" : "system-imports";
    const polled = await api(`/api/v1/${segment}/${encodeURIComponent(latest.id)}`, { signal });
    if (!systemArchiveFenceCurrent(fence)) return latest;
    if (polled.kind !== fence.kind || polled.id !== fence.jobId) {
      throw new Error("System Archive job identity changed while it was being monitored.");
    }
    latest = polled;
    if (!renderSystemArchiveJob(latest, fence)) return latest;
  }
  return latest;
}

async function runSystemArchiveAction(kind, work) {
  clearSystemArchiveError();
  const controller = new AbortController();
  systemArchiveOperationController = controller;
  systemArchiveOperationKind = kind;
  setSystemArchiveBusy(true);
  try {
    await work(controller.signal);
  } catch (error) {
    if (error?.name !== "AbortError") showSystemArchiveError(error);
  } finally {
    if (systemArchiveOperationController === controller) {
      systemArchiveOperationController = null;
      systemArchiveOperationKind = null;
    }
    setSystemArchiveBusy(false);
  }
}

async function systemArchiveChunkRequest(upload, index, offset, bytes, fileSize, signal) {
  const response = await fetch(`/api/v1/system-imports/uploads/${encodeURIComponent(upload.id)}/chunks/${index}`, {
    method: "PUT",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/octet-stream",
      "Content-Length": String(bytes.byteLength),
      "Content-Range": `bytes ${offset}-${offset + bytes.byteLength - 1}/${fileSize}`,
      "X-Chunk-SHA256": systemArchiveBytesSha256(bytes)
    },
    body: bytes,
    signal
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.message || `Request failed with HTTP ${response.status}.`);
    error.name = payload.error || "ApiError";
    error.statusCode = response.status;
    throw error;
  }
  return payload;
}

async function createOrResumeSystemArchiveUpload(file, sha256, signal) {
  const storageKey = systemArchiveUploadStorageKey(file.size, sha256);
  systemArchiveUploadSessionKey = storageKey;
  const saved = readSystemArchiveUploadSession(storageKey);
  let upload = null;
  if (saved?.byteLength === file.size && saved.sha256 === sha256) {
    try {
      upload = await api(`/api/v1/system-imports/uploads/${encodeURIComponent(saved.id)}`, { signal });
      if (!["created", "uploading", "completed"].includes(upload.status) || upload.byteLength !== file.size) upload = null;
    } catch (error) {
      if (![404, 410].includes(error?.statusCode)) throw error;
    }
  }
  if (!upload) {
    upload = await api("/api/v1/system-imports/uploads", {
      method: "POST",
      body: JSON.stringify({ byteLength: file.size, sha256 }),
      signal
    });
    saveSystemArchiveUploadSession(storageKey, upload, sha256);
  }
  return upload;
}

async function uploadAndPreviewSystemArchive() {
  if (!systemArchiveSelectedFile) return;
  await runSystemArchiveAction("upload", async (signal) => {
    const file = systemArchiveSelectedFile;
    if (!file.size) throw new Error("System Archive file must not be empty.");
    renderSystemArchiveProgress("hashing", 0, file.size);
    const sha256 = await systemArchiveFileSha256(file, signal, (received) => renderSystemArchiveProgress("hashing", received, file.size));
    systemArchiveUpload = await createOrResumeSystemArchiveUpload(file, sha256, signal);
    renderSystemArchiveProgress("uploading", systemArchiveUpload.receivedBytes, file.size);
    if (systemArchiveUpload.status !== "completed") {
      let offset = systemArchiveUpload.receivedBytes;
      if (systemArchiveUpload.nextChunkIndex === undefined && offset % SYSTEM_ARCHIVE_CHUNK_BYTES !== 0 && offset !== file.size) throw new Error("Durable upload progress does not align with this browser's chunk boundary.");
      let index = systemArchiveUpload.nextChunkIndex ?? Math.floor(offset / SYSTEM_ARCHIVE_CHUNK_BYTES);
      while (offset < file.size) {
        const chunkBytes = Math.min(SYSTEM_ARCHIVE_CHUNK_BYTES, systemArchiveUpload.chunkBytes ?? SYSTEM_ARCHIVE_CHUNK_BYTES);
        if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1) throw new Error("System Archive server chunk limit is invalid.");
        const end = Math.min(file.size, offset + chunkBytes);
        const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
        systemArchiveUpload = await systemArchiveChunkRequest(systemArchiveUpload, index, offset, bytes, file.size, signal);
        offset = systemArchiveUpload.receivedBytes;
        index = systemArchiveUpload.nextChunkIndex ?? index + 1;
        renderSystemArchiveProgress("uploading", offset, file.size);
      }
      renderSystemArchiveProgress("completing", offset, file.size);
      systemArchiveUpload = await api(`/api/v1/system-imports/uploads/${encodeURIComponent(systemArchiveUpload.id)}/complete`, { method: "POST", signal });
    }
    const preview = await api("/api/v1/system-imports/preview", {
      method: "POST",
      body: JSON.stringify({ uploadId: systemArchiveUpload.id }),
      signal
    });
    renderSystemImportPreview(preview);
    setSystemArchiveStatus(preview.valid ? "System Archive preview is ready for review." : "System Archive cannot be imported into this destination.", preview.valid ? "success" : "error");
  });
}

async function createSystemArchiveExport() {
  await runSystemArchiveAction("export", async (signal) => {
    elements.systemArchiveDownload.classList.add("hidden");
    systemArchiveJobs.export = null;
    const idempotencyKey = systemArchiveIdempotencyKey("legacy-export");
    const exportOperation = { kind: "export", idempotencyKey, jobId: null };
    const fence = beginSystemArchiveOperation("export", exportOperation);
    writeSystemArchiveOperation(exportOperation);
    const job = await resolveStoredSystemExport(exportOperation, signal, fence);
    if (systemArchiveFenceCurrent(fence)) await monitorSystemArchiveJob(job, signal, fence);
  });
}

async function resolveStoredSystemExport(stored, signal, fence) {
  const job = stored.jobId
    ? await api(`/api/v1/system-exports/${encodeURIComponent(stored.jobId)}`, { signal })
    : await api("/api/v1/system-exports", {
        method: "POST",
        body: JSON.stringify({ idempotencyKey: stored.idempotencyKey }),
        signal
      });
  if (!systemArchiveFenceCurrent(fence)) return job;
  if (job.kind !== "export" || (stored.jobId !== null && stored.jobId !== job.id)) {
    throw new Error("Recovered System Export identity did not match its stored operation.");
  }
  fence.jobId = job.id;
  const resolved = { ...stored, jobId: job.id };
  setSystemArchiveOperation("export", resolved);
  if (systemArchiveFenceCurrent(fence)) writeSystemArchiveOperation(resolved);
  return job;
}

async function recoverSystemArchiveExport() {
  const stored = readSystemArchiveOperation("export");
  if (!stored) return;
  const controller = new AbortController();
  const fence = beginSystemArchiveOperation("export", stored);
  systemArchiveRecoveryControllers.export = controller;
  try {
    const job = await resolveStoredSystemExport(stored, controller.signal, fence);
    if (!controller.signal.aborted && systemArchiveFenceCurrent(fence)) {
      await monitorSystemArchiveJob(job, controller.signal, fence);
    }
  } catch (error) {
    if (error?.name !== "AbortError") throw error;
  } finally {
    if (systemArchiveRecoveryControllers.export === controller) systemArchiveRecoveryControllers.export = null;
  }
}

async function resolveStoredSystemImport(stored, signal, fence) {
  const job = stored.jobId
    ? await api(`/api/v1/system-imports/${encodeURIComponent(stored.jobId)}`, { signal })
    : await api("/api/v1/system-imports", {
        method: "POST",
        body: JSON.stringify({
          previewHandle: stored.previewHandle,
          idempotencyKey: stored.idempotencyKey,
          acknowledgeSensitiveArchive: true,
          acknowledgeEmptyDestination: true,
          acknowledgeInvalidatedAccess: true,
          acknowledgeProviderReentry: true,
          acknowledgeNonCancellableBoundary: true
        }),
        signal
      });
  if (!systemArchiveFenceCurrent(fence)) return job;
  if (job.kind !== "import" || (stored.jobId !== null && stored.jobId !== job.id)) {
    throw new Error("Recovered System Import identity did not match its stored operation.");
  }
  fence.jobId = job.id;
  const resolved = { ...stored, jobId: job.id };
  setSystemArchiveOperation("import", resolved);
  if (systemArchiveFenceCurrent(fence)) writeSystemArchiveOperation(resolved);
  return job;
}

async function recoverSystemArchiveImport() {
  const stored = readSystemArchiveOperation("import");
  if (!stored || (!stored.jobId && !stored.previewHandle)) return;
  invalidateSystemImportPreviewAuthority();
  const controller = new AbortController();
  const fence = beginSystemArchiveOperation("import", stored);
  systemArchiveRecoveryControllers.import = controller;
  try {
    const job = await resolveStoredSystemImport(stored, controller.signal, fence);
    if (controller.signal.aborted || !systemArchiveFenceCurrent(fence)) return;
    systemArchiveUpload = null;
    await monitorSystemArchiveJob(job, controller.signal, fence);
  } catch (error) {
    if (error?.name !== "AbortError") throw error;
  } finally {
    if (systemArchiveRecoveryControllers.import === controller) systemArchiveRecoveryControllers.import = null;
  }
}

function recoverSystemArchiveOperations() {
  if (!systemArchiveEnabled || !systemArchiveOwnerId || systemArchiveRecoveryStarted) return;
  systemArchiveRecoveryStarted = true;
  void recoverSystemArchiveExport().catch(showSystemArchiveError);
  void recoverSystemArchiveImport().catch(showSystemArchiveError);
}

function beginSystemArchiveRecoveryWhenReady() {
  updateSystemArchiveControls();
  if (systemArchiveEnabled && systemArchiveOwnerId) void recoverSystemArchiveOperations();
}

async function cancelSystemArchiveOperation() {
  if (systemArchiveCancellationPending) return;
  systemArchiveCancellationPending = true;
  updateSystemArchiveControls();
  const controller = systemArchiveOperationController;
  const cancellingKind = systemArchiveOperationKind;
  controller?.abort(new DOMException("Transfer cancelled", "AbortError"));
  try {
    const storedImport = readSystemArchiveOperation("import");
    const activeImportOperation = systemArchiveImportOperation || storedImport;
    const storedExport = readSystemArchiveOperation("export");
    const activeExportOperation = systemArchiveExportOperation || storedExport;

    async function cancelImportOperation(operation) {
      const fence = systemArchiveFenceForOperation("import", operation);
      invalidateSystemImportPreviewAuthority();
      systemArchiveUpload = null;
      if (operation.jobId) {
        renderSystemArchiveJob(
          await api(`/api/v1/system-imports/${encodeURIComponent(operation.jobId)}`, { method: "DELETE" }),
          fence
        );
        return;
      }
      const recovered = await resolveStoredSystemImport(operation, undefined, fence);
      renderSystemArchiveJob(recovered, fence);
      if (systemArchiveFenceCurrent(fence) && systemArchiveJobCancellable(recovered)) {
        renderSystemArchiveJob(
          await api(`/api/v1/system-imports/${encodeURIComponent(recovered.id)}`, { method: "DELETE" }),
          fence
        );
      }
    }

    async function cancelExportOperation(operation) {
      const fence = systemArchiveFenceForOperation("export", operation);
      if (operation.jobId) {
        renderSystemArchiveJob(
          await api(`/api/v1/system-exports/${encodeURIComponent(operation.jobId)}`, { method: "DELETE" }),
          fence
        );
        return;
      }
      const recovered = await resolveStoredSystemExport(operation, undefined, fence);
      renderSystemArchiveJob(recovered, fence);
      if (systemArchiveFenceCurrent(fence) && systemArchiveJobCancellable(recovered)) {
        renderSystemArchiveJob(
          await api(`/api/v1/system-exports/${encodeURIComponent(recovered.id)}`, { method: "DELETE" }),
          fence
        );
      }
    }

    async function cancelUpload() {
      invalidateSystemImportPreviewAuthority();
      const uploadId = systemArchiveUpload.id;
      await api(`/api/v1/system-imports/uploads/${encodeURIComponent(uploadId)}`, { method: "DELETE" });
      if (systemArchiveUpload?.id === uploadId) systemArchiveUpload = null;
      clearSystemArchiveUploadSession();
      setSystemArchiveStatus("System Archive upload cancelled.");
    }

    const activeJob = cancellingKind === "import"
      ? systemArchiveJobs.import
      : cancellingKind === "export"
        ? systemArchiveJobs.export
        : null;
    if (systemArchiveJobCancellable(activeJob)) {
      if (activeJob.kind === "import") invalidateSystemImportPreviewAuthority();
      const segment = activeJob.kind === "export" ? "system-exports" : "system-imports";
      const cancelled = await api(`/api/v1/${segment}/${encodeURIComponent(activeJob.id)}`, { method: "DELETE" });
      const fence = systemArchiveOperationFences[activeJob.kind];
      renderSystemArchiveJob(cancelled, fence || null);
      return;
    }
    if (cancellingKind === "upload" && systemArchiveUpload) {
      await cancelUpload();
      return;
    }
    if (cancellingKind === "import" && activeImportOperation) {
      await cancelImportOperation(activeImportOperation);
      return;
    }
    if (cancellingKind === "export" && activeExportOperation) {
      await cancelExportOperation(activeExportOperation);
      return;
    }

    const jobToCancel = [systemArchiveJobs.import, systemArchiveJobs.export].find((job) => systemArchiveJobCancellable(job));
    if (jobToCancel) {
      if (jobToCancel.kind === "import") invalidateSystemImportPreviewAuthority();
      const segment = jobToCancel.kind === "export" ? "system-exports" : "system-imports";
      const cancelled = await api(`/api/v1/${segment}/${encodeURIComponent(jobToCancel.id)}`, { method: "DELETE" });
      const fence = systemArchiveOperationFences[jobToCancel.kind];
      renderSystemArchiveJob(cancelled, fence || null);
      return;
    }
    if (activeImportOperation?.jobId === null) {
      await cancelImportOperation(activeImportOperation);
      return;
    }
    if (systemArchiveUpload) {
      await cancelUpload();
      return;
    }
    if (activeExportOperation?.jobId === null) {
      await cancelExportOperation(activeExportOperation);
      return;
    }
    if (activeImportOperation) {
      await cancelImportOperation(activeImportOperation);
      return;
    }
    if (activeExportOperation) {
      await cancelExportOperation(activeExportOperation);
      return;
    }
    invalidateSystemImportPreviewAuthority();
    setSystemArchiveStatus("Local System Archive work cancelled.");
  } catch (error) {
    showSystemArchiveError(error);
  } finally {
    systemArchiveCancellationPending = false;
    updateSystemArchiveControls();
  }
}

async function commitSystemArchiveImport() {
  if (!systemArchivePreview?.valid || !systemArchivePreview.previewHandle) return;
  let firstInvalid = null;
  SYSTEM_ARCHIVE_ACKNOWLEDGEMENT_IDS.forEach((id) => {
    elements[id].removeAttribute("aria-invalid");
    if (!elements[id].checked) {
      elements[id].setAttribute("aria-invalid", "true");
      firstInvalid ||= elements[id];
    }
  });
  if (firstInvalid) {
    showSystemArchiveError(new Error("Review every acknowledgement before importing this System Archive."));
    firstInvalid.focus();
    return;
  }
  const previewHandle = systemArchivePreview.previewHandle;
  const idempotencyKey = systemArchiveIdempotencyKey("legacy-import");
  const importOperation = { kind: "import", idempotencyKey, jobId: null, previewHandle };
  const fence = beginSystemArchiveOperation("import", importOperation);
  writeSystemArchiveOperation(importOperation);
  invalidateSystemImportPreviewAuthority();
  await runSystemArchiveAction("import", async (signal) => {
    const job = await api("/api/v1/system-imports", {
      method: "POST",
      body: JSON.stringify({
        previewHandle,
        idempotencyKey,
        acknowledgeSensitiveArchive: true,
        acknowledgeEmptyDestination: true,
        acknowledgeInvalidatedAccess: true,
        acknowledgeProviderReentry: true,
        acknowledgeNonCancellableBoundary: true
      }),
      signal
    });
    if (!systemArchiveFenceCurrent(fence)) return;
    if (job.kind !== "import") throw new Error("System Import returned the wrong job kind.");
    fence.jobId = job.id;
    const resolved = { ...importOperation, jobId: job.id };
    setSystemArchiveOperation("import", resolved);
    if (systemArchiveFenceCurrent(fence)) writeSystemArchiveOperation(resolved);
    if (!systemArchiveFenceCurrent(fence)) return;
    systemArchiveUpload = null;
    await monitorSystemArchiveJob(job, signal, fence);
  });
}

function worldGenerationFailureMessage(error) {
  if (error?.details?.code !== "incomplete_generated_world") {
    return error?.message || String(error);
  }
  const issues = Array.isArray(error.details?.issues) ? error.details.issues : [];
  const missing = issues
    .slice(0, 4)
    .map((issue) => {
      const path = typeof issue?.path === "string" && issue.path ? issue.path : "generated world";
      const message = typeof issue?.message === "string" && issue.message
        ? issue.message
        : "Generated content is incomplete.";
      return `${path}: ${message}`;
    })
    .join(" ");
  const base = error?.message || "The text provider did not return a complete world.";
  return missing ? `${base} ${missing}` : base;
}

function setStatus(message, type = "") {
  elements.importStatus.textContent = message;
  elements.importStatus.className = `status ${type}`.trim();
}

function number(value) {
  return Number(value || 0).toLocaleString();
}

function money(value, currency) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || !/^[A-Z]{3}$/.test(String(currency || ""))) return "";
  if (amount > 0 && amount < 0.0001) {
    return `<${new Intl.NumberFormat(undefined, { style: "currency", currency, minimumFractionDigits: 4, maximumFractionDigits: 4 }).format(0.0001)}`;
  }
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    minimumFractionDigits: amount < 0.01 ? 4 : 2,
    maximumFractionDigits: amount < 0.01 ? 6 : 2
  }).format(amount);
}

function modelPricingLabel(model) {
  const pricing = model?.pricing;
  if (!pricing || !Array.isArray(pricing.entries) || !pricing.entries.length) return "";
  if (pricing.category === "image") {
    const byUnit = new Map();
    for (const entry of pricing.entries) {
      const key = `${entry.unit || "unit"}:${entry.provider || ""}`;
      const current = byUnit.get(key);
      if (!current || Number(entry.costUsd) < Number(current.costUsd)) byUnit.set(key, entry);
    }
    return [...byUnit.values()].slice(0, 3).map((entry) => {
      const provider = entry.provider ? ` via ${entry.provider}` : "";
      return `${money(entry.costUsd, "USD")} / ${entry.unit}${provider}`;
    }).join(" · ");
  }
  return pricing.entries.map((entry) => {
    const perMillion = Number(entry.costUsd) * 1_000_000;
    const direction = entry.billable === "input_token" ? "input" : entry.billable === "output_token" ? "output" : entry.billable;
    return `${money(perMillion, "USD")} / 1M ${direction}`;
  }).join(" · ");
}

function artworkUrl(record) {
  const candidate = String(record?.imageUrl || record?.artworkUrl || record?.coverImageUrl || "").trim();
  if (!candidate) return "";
  try {
    const url = new URL(candidate, window.location.origin);
    return ["http:", "https:"].includes(url.protocol) || url.origin === window.location.origin ? url.href : "";
  } catch {
    return "";
  }
}

function applyArtwork(element, record) {
  const url = artworkUrl(record);
  if (!url) return;
  element.style.backgroundImage = `linear-gradient(180deg, transparent, rgba(7,9,15,.78)), url("${url.replaceAll('"', '%22')}")`;
  element.classList.add("has-image");
}

function reconcileKeyedCollection(container, records, keyAttribute, createNode, updateNode) {
  const selector = `:scope > [data-${keyAttribute}]`;
  const existing = new Map([...container.querySelectorAll(selector)].map((node) => [node.dataset[keyAttribute.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())], node]));
  const retained = new Set();
  const nodes = records.map((record) => {
    const key = String(record.id);
    const current = existing.get(key);
    if (!current) return createNode(record);
    retained.add(current);
    updateNode(current, record);
    return current;
  });
  const desired = new Set(nodes);
  for (const node of existing.values()) if (!retained.has(node)) node.remove();
  for (const child of [...container.children]) if (!desired.has(child)) child.remove();
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    const current = container.children[index];
    if (current !== node) container.insertBefore(node, current || null);
  }
}

function collectionClearButton(label, clear) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "button secondary compact-button collection-clear";
  button.textContent = "Clear filters";
  button.setAttribute("aria-label", `Clear ${label} search and filters`);
  button.addEventListener("click", clear);
  return button;
}

function collectionEmptyState(message, label, clear) {
  const state = document.createElement("div");
  state.className = "collection-empty-state";
  const description = document.createElement("p");
  description.className = "muted collection-empty";
  description.textContent = message;
  state.append(description, collectionClearButton(label, clear));
  return state;
}

function worldPreview(world, detail = dashboardWorldDetails.get(world.id)) {
  const content = world?.latestPreview || detail?.latestPreview || detail?.draftContent?.world || {};
  return {
    genre: String(content.genre || "Uncharted genre"),
    tone: String(content.tone || "Open-ended"),
    description: String(content.premise || content.backgroundStory || "A published world ready for a new campaign."),
    firstAction: String(content.firstAction || "Begin the adventure."),
    imageUrl: detail?.imageUrl || world?.imageUrl || content.imageUrl || content.artworkUrl || ""
  };
}

function createDashboardWorldCard(world, card = null) {
  const preview = worldPreview(world);
  const isNew = !card;
  card ||= document.createElement("button");
  card.type = "button";
  card.className = "dashboard-card world-card";
  card.dataset.worldId = world.id;
  card.setAttribute("aria-label", `View details for ${world.title}`);

  const art = document.createElement("div");
  art.className = "card-art";
  applyArtwork(art, preview);
  const badge = document.createElement("span");
  badge.className = "card-badge";
  badge.textContent = `World · v${world.latestVersionNumber}`;
  art.append(badge);

  const body = document.createElement("div");
  body.className = "card-body";
  const title = document.createElement("h3");
  title.textContent = world.title;
  const description = document.createElement("p");
  description.textContent = preview.description;
  const meta = document.createElement("div");
  meta.className = "card-meta";
  const genre = document.createElement("span");
  genre.textContent = preview.genre;
  const campaignsCount = document.createElement("span");
  campaignsCount.textContent = `${number(world.campaignCount)} campaign${Number(world.campaignCount) === 1 ? "" : "s"}`;
  meta.append(genre, campaignsCount);
  const cta = document.createElement("div");
  cta.className = "card-cta";
  const ctaLabel = document.createElement("span");
  ctaLabel.textContent = "Explore world";
  const ctaArrow = document.createElement("span");
  ctaArrow.setAttribute("aria-hidden", "true");
  ctaArrow.textContent = "→";
  cta.append(ctaLabel, ctaArrow);
  body.append(title, description, meta, cta);
  card.replaceChildren(art, body);
  if (isNew) card.addEventListener("click", () => openWorldDetails(world.id));
  return card;
}

function renderDashboardWorlds() {
  if (!elements.dashboardWorlds) return;
  const available = filterSortWorlds(worlds.filter((world) => world.status !== "archived" && world.latestVersionId), {
    query: elements.worldSearch?.value ?? "",
    status: "all",
    sort: "updated-desc"
  });
  if (!available.length) {
    elements.dashboardWorlds.replaceChildren();
    const empty = document.createElement("p");
    empty.className = "carousel-empty";
    empty.textContent = elements.worldSearch?.value.trim() ? "No worlds match that search." : "No published worlds are available yet. Open World Management to prepare one.";
    elements.dashboardWorlds.append(empty);
    return;
  }
  reconcileKeyedCollection(elements.dashboardWorlds, available, "world-id", createDashboardWorldCard, (card, world) => createDashboardWorldCard(world, card));
}

async function getDashboardWorldDetails(worldId) {
  if (dashboardWorldDetails.has(worldId)) return dashboardWorldDetails.get(worldId);
  const pending = dashboardWorldDetailRequests.get(worldId);
  if (pending) return pending;

  const requestEpoch = beginDashboardWorldDetailRequest(worldId);
  const request = Promise.resolve()
    .then(() => api(`/api/v1/worlds/${encodeURIComponent(worldId)}`))
    .then((detail) => {
      if (isDashboardWorldDetailRequestCurrent(worldId, requestEpoch) && worlds.some((world) => world.id === worldId)) {
        dashboardWorldDetails.set(worldId, detail);
      }
      return detail;
    })
    .finally(() => {
      if (dashboardWorldDetailRequests.get(worldId) === request) dashboardWorldDetailRequests.delete(worldId);
    });
  dashboardWorldDetailRequests.set(worldId, request);
  return request;
}

function beginDashboardWorldDetailRequest(worldId) {
  const requestEpoch = (dashboardWorldDetailRequestEpochs.get(worldId) || 0) + 1;
  dashboardWorldDetailRequestEpochs.set(worldId, requestEpoch);
  return requestEpoch;
}

function isDashboardWorldDetailRequestCurrent(worldId, requestEpoch) {
  return dashboardWorldDetailRequestEpochs.get(worldId) === requestEpoch;
}

function invalidateDashboardWorldDetails(worldId) {
  if (!worldId) return;
  dashboardWorldDetails.delete(worldId);
  if (typeof dashboardWorldDetailRequests !== "undefined") dashboardWorldDetailRequests.delete(worldId);
  dashboardWorldDetailRequestEpochs.set(worldId, (dashboardWorldDetailRequestEpochs.get(worldId) || 0) + 1);
}

function createDashboardCampaignCard(campaign, card = null) {
  const isNew = !card;
  card ||= document.createElement("button");
  card.type = "button";
  card.className = "dashboard-card campaign-card";
  card.dataset.campaignId = campaign.id;
  card.dataset.status = campaign.status;
  card.setAttribute("aria-label", `Resume ${campaign.title}`);

  const art = document.createElement("div");
  art.className = "card-art";
  applyArtwork(art, campaign);
  const badge = document.createElement("span");
  badge.className = "card-badge";
  badge.textContent = campaign.status === "archived" ? "Archived campaign" : "Campaign in progress";
  art.append(badge);

  const body = document.createElement("div");
  body.className = "card-body";
  const title = document.createElement("h3");
  title.textContent = campaign.title;
  const description = document.createElement("p");
  description.textContent = `${campaign.worldTitle} · World version ${campaign.worldVersionNumber}${campaign.selectedCharacterName ? ` · Playing as ${campaign.selectedCharacterName}` : ""}`;
  const meta = document.createElement("div");
  meta.className = "card-meta";
  const turns = document.createElement("span");
  turns.textContent = `${number(campaign.activeTurnNumber)} accepted turn${Number(campaign.activeTurnNumber) === 1 ? "" : "s"}`;
  const updated = document.createElement("span");
  const updatedAt = new Date(campaign.updatedAt);
  updated.textContent = Number.isNaN(updatedAt.valueOf()) ? "Ready to resume" : `Updated ${updatedAt.toLocaleDateString()}`;
  meta.append(turns, updated);
  const cta = document.createElement("div");
  cta.className = "card-cta";
  const ctaLabel = document.createElement("span");
  ctaLabel.textContent = campaign.status === "archived" ? "Open story" : "Resume story";
  const ctaArrow = document.createElement("span");
  ctaArrow.setAttribute("aria-hidden", "true");
  ctaArrow.textContent = "→";
  cta.append(ctaLabel, ctaArrow);
  body.append(title, description, meta, cta);
  card.replaceChildren(art, body);
  if (isNew) card.addEventListener("click", () => {
    window.location.assign(`/story/${encodeURIComponent(campaign.id)}`);
  });
  return card;
}

function renderCampaignListLoadState() {
  if (!elements.dashboardCampaigns) return;
  elements.dashboardCampaigns.replaceChildren();
  const message = document.createElement("p");
  message.className = "carousel-empty";
  message.textContent = campaignsLoadError
    ? "Your campaigns could not be loaded. Check your connection and try again."
    : "Loading your campaigns…";
  elements.dashboardCampaigns.append(message);
  if (!campaignsLoadError) return;
  const retry = document.createElement("button");
  retry.id = "campaignLoadRetry";
  retry.type = "button";
  retry.textContent = "Retry campaign list";
  retry.addEventListener("click", () => { void loadCampaigns().catch((error) => setStatus(error.message || String(error), "error")); });
  elements.dashboardCampaigns.append(retry);
}

function renderDashboardCampaigns() {
  if (!elements.dashboardCampaigns) return;
  if (!campaignsLoaded) {
    renderCampaignListLoadState();
    return;
  }
  const matches = filterSortCampaigns(campaigns, { status: "active", sort: "updated-desc" }).slice(0, 5);
  if (!matches.length) {
    elements.dashboardCampaigns.replaceChildren();
    const empty = document.createElement("p");
    empty.className = "carousel-empty";
    empty.textContent = campaigns.some((campaign) => campaign.status === "archived")
      ? "No active campaigns. Archived campaigns remain available in Campaign Management."
      : "No campaigns yet. Choose an available world to begin one.";
    elements.dashboardCampaigns.append(empty);
    return;
  }
  reconcileKeyedCollection(elements.dashboardCampaigns, matches, "campaign-id", createDashboardCampaignCard, (card, campaign) => createDashboardCampaignCard(campaign, card));
}

function createManagementCampaignButton(campaign, button = null) {
  const isNew = !button;
  button ||= document.createElement("button");
  button.className = `campaign-button${selectedCampaign?.id === campaign.id ? " active" : ""}`;
  button.type = "button";
  button.dataset.campaignId = campaign.id;
  button.setAttribute("aria-pressed", String(selectedCampaign?.id === campaign.id));
  const title = document.createElement("strong");
  title.textContent = campaign.title;
  const details = document.createElement("span");
  details.textContent = `${campaign.activeTurnNumber} accepted turns · ${campaign.worldTitle} v${campaign.worldVersionNumber}${campaign.selectedCharacterName ? ` · ${campaign.selectedCharacterName}` : ""}${campaign.worldUpdateAvailable ? " · update available" : ""}${campaign.status === "archived" ? " · archived" : ""}`;
  button.replaceChildren(title, details);
  if (isNew) button.addEventListener("click", () => {
    const currentCampaign = campaigns.find((item) => item.id === button.dataset.campaignId);
    if (!currentCampaign) return;
    if (UUID_ROUTE_PATTERN.test(String(currentCampaign.id || ""))) {
      void acceptManagementRoute(managementSelectionHash("campaigns", "campaign", currentCampaign.id), { source: "link", focus: true });
    } else void selectCampaign(currentCampaign);
  });
  return button;
}

function clearCampaignCollectionFilters() {
  window.clearTimeout(managementCampaignSearchTimer);
  elements.managementCampaignSearch.value = "";
  elements.managementCampaignStatus.value = "active";
  elements.managementCampaignSort.value = "updated-desc";
  managementCampaignStatus = "active";
  managementCampaignSort = "updated-desc";
  renderManagementCampaigns();
  elements.managementCampaignSearch.focus();
}

function renderManagementCampaigns() {
  if (!campaignsLoaded) return;
  const query = elements.managementCampaignSearch?.value ?? "";
  const matches = filterSortCampaigns(campaigns, { query, status: managementCampaignStatus, sort: managementCampaignSort });
  const resultCount = elements.managementCampaignResults;
  if (resultCount) resultCount.textContent = `Showing ${matches.length} of ${campaigns.length} campaign${campaigns.length === 1 ? "" : "s"}`;
  if (!matches.length) {
    elements.campaignList.replaceChildren();
    const message = campaigns.length ? "No campaigns match this search and filter." : "No database-backed campaigns yet.";
    elements.campaignList.append(collectionEmptyState(message, "campaign", clearCampaignCollectionFilters));
    return;
  }
  reconcileKeyedCollection(elements.campaignList, matches, "campaign-id", createManagementCampaignButton, (button, campaign) => createManagementCampaignButton(campaign, button));
}

function dashboardReportedCost(costs) {
  if (!costs?.hasReportedCosts || !Array.isArray(costs.totals) || !costs.totals.length) {
    return { total: "Not reported", providers: "Local and unsupported fees are not estimated" };
  }
  const currencies = [...new Set(costs.totals.map((cost) => cost.currency))];
  const total = currencies.length === 1
    ? money(costs.totals.reduce((sum, cost) => sum + Number(cost.amount || 0), 0), currencies[0])
    : `${currencies.length} currencies`;
  const providers = costs.totals.map((cost) => {
    const label = cost.providerName || cost.providerType || "Provider";
    const category = cost.category === "image" ? "Image" : cost.category === "story" ? "Text" : cost.category === "memory" ? "Memory" : "Provider";
    return `${category} · ${label}: ${money(cost.amount, cost.currency) || `${cost.amount} ${cost.currency}`}`;
  });
  return { total, providers: [...new Set(providers)].join(" · ") || "Reported by configured providers" };
}

function loadDashboardStats(source = "") {
  if (!elements.dashboardStatsGrid) return Promise.resolve();
  const initialSource = dashboardInitialStatsSources.delete(source);
  if (!initialSource) dashboardInitialStatsPromise = null;
  let request = initialSource ? dashboardInitialStatsPromise : null;
  if (!request) {
    request = readAndRenderDashboardStats();
    if (initialSource) dashboardInitialStatsPromise = request;
    void request.then((succeeded) => {
      if ((!succeeded || dashboardInitialStatsSources.size === 0) && dashboardInitialStatsPromise === request) {
        dashboardInitialStatsPromise = null;
      }
    });
  }
  if (initialSource && dashboardInitialStatsSources.size === 0) {
    void request.then(() => {
      if (dashboardInitialStatsPromise === request) dashboardInitialStatsPromise = null;
    });
  }
  return request;
}

async function readAndRenderDashboardStats() {
  try {
    const stats = await api("/api/v1/dashboard/stats");
    const reportedCost = dashboardReportedCost(stats.providerCosts);
    elements.statWorlds.textContent = number(stats.worlds?.available);
    elements.statCampaigns.textContent = number(stats.campaigns?.open);
    elements.statTurns.textContent = number(stats.turns?.accepted);
    elements.statActiveWorlds.textContent = number(stats.worlds?.published);
    elements.statCost.textContent = reportedCost.total;
    elements.statCostProviders.textContent = reportedCost.providers;
    elements.statCostProviders.title = reportedCost.providers;
    elements.dashboardStatsStatus.textContent = `${number(stats.worlds?.total)} worlds · ${number(stats.campaigns?.total)} campaigns total`;
    return true;
  } catch (error) {
    elements.statWorlds.textContent = number(worlds.filter((world) => world.status !== "archived" && world.latestVersionId).length);
    elements.statCampaigns.textContent = number(campaigns.filter((campaign) => campaign.status === "active").length);
    elements.statTurns.textContent = number(campaigns.reduce((total, campaign) => total + Number(campaign.activeTurnNumber || 0), 0));
    elements.statActiveWorlds.textContent = number(worlds.filter((world) => world.latestVersionId).length);
    elements.statCost.textContent = "Unavailable";
    elements.statCostProviders.textContent = "Refresh to retry provider totals";
    elements.dashboardStatsStatus.textContent = error.message || "Dashboard statistics are temporarily unavailable.";
    return false;
  }
}

async function openWorldDetails(worldId) {
  const selectionEpoch = ++dashboardWorldDetailsSelectionEpoch;
  const summary = worlds.find((world) => world.id === worldId);
  if (!summary) return;
  let detail;
  const detailRequest = getDashboardWorldDetails(worldId);
  const requestEpoch = dashboardWorldDetailRequestEpochs.get(worldId);
  try {
    detail = await detailRequest;
  } catch (error) {
    if (selectionEpoch !== dashboardWorldDetailsSelectionEpoch || !isDashboardWorldDetailRequestCurrent(worldId, requestEpoch)) return;
    elements.dashboardStatsStatus.textContent = error.message || String(error);
    return;
  }
  if (selectionEpoch !== dashboardWorldDetailsSelectionEpoch || !isDashboardWorldDetailRequestCurrent(worldId, requestEpoch) || !worlds.some((world) => world.id === worldId)) return;
  dashboardWorld = { ...summary, ...detail, latestVersionId: summary.latestVersionId, latestVersionNumber: summary.latestVersionNumber };
  const preview = worldPreview(summary, detail);
  elements.worldDetailsTitle.textContent = summary.title;
  elements.worldDetailsEyebrow.textContent = `${preview.genre} · Published version ${summary.latestVersionNumber}`;
  elements.worldDetailsSummary.textContent = preview.description;
  elements.worldDetailsMeta.replaceChildren();
  for (const [label, value] of [["Tone", preview.tone], ["Campaigns", number(summary.campaignCount)], ["Opening", preview.firstAction], ["Updated", new Date(summary.updatedAt).toLocaleDateString()]]) {
    const group = document.createElement("div");
    const term = document.createElement("dt");
    term.textContent = label;
    const description = document.createElement("dd");
    description.textContent = value;
    group.append(term, description);
    elements.worldDetailsMeta.append(group);
  }
  elements.worldDetailsMedia.className = "world-details-media";
  elements.worldDetailsMedia.style.backgroundImage = "";
  applyArtwork(elements.worldDetailsMedia, preview);
  elements.beginCampaignFromWorld.disabled = !summary.latestVersionId;
  elements.editWorldDetails.href = managementSelectionHash("worlds", "world", summary.id);
  openManagedModal(elements.worldDetailsDialog);
}

async function openWorldManagement(worldId) {
  if (!worldId) return;
  await acceptManagementRoute(managementSelectionHash("worlds", "world", worldId), { source: "link", focus: true });
}

async function openQuickCampaign() {
  const world = dashboardWorld ? { ...dashboardWorld } : null;
  if (!world?.latestVersionId) return;
  elements.worldDetailsDialog.close();
  campaignCreationEntryPoint = "dashboard";
  openCampaignCreation({
    worldId: world.id,
    worldVersionId: world.latestVersionId,
    initialDraft: { title: `${world.title} Adventure` }
  });
}

function scrollCarousel(element, direction) {
  element.scrollBy({
    left: direction * Math.max(280, element.clientWidth * .82),
    behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"
  });
}

function worldMessage(message, type = "") {
  if (managementSelectionErrorIsCurrent("worlds")) {
    if (type === "error") {
      managementSelectionActionErrorMessage = message;
      managementSelectionActionErrorTargetId = selectedWorld?.id || "";
      elements.worldStatus.textContent = `${message} ${managementSelectionErrorMessage}`;
      elements.worldStatus.className = "status error";
      const pendingReadFailure = dashboardWorkflowErrors.get("worlds");
      if (pendingReadFailure) showManagementSelectionReadFailure("worlds", pendingReadFailure.message);
      else addWorkflowRetry(elements.worldStatus, "workflowRetryWorlds", "Retry world list", () => retryWorldWorkflowRead());
    }
    return;
  }
  const pendingReadFailure = dashboardWorkflowErrors.get("worlds");
  delete elements.worldStatus.dataset.workflowReadFailure;
  elements.worldStatus.querySelector("#workflowRetryWorlds")?.remove();
  elements.worldStatus.textContent = message;
  elements.worldStatus.className = `status ${type}`.trim();
  if (pendingReadFailure) setWorkflowReadFailure(elements.worldStatus, "worlds", pendingReadFailure.message, "workflowRetryWorlds", "Retry world list", () => retryWorldWorkflowRead());
}

function campaignMessage(message, type = "") {
  if (managementSelectionErrorIsCurrent("campaigns")) {
    if (type === "error") {
      managementSelectionActionErrorMessage = message;
      managementSelectionActionErrorTargetId = selectedCampaign?.id || "";
      elements.campaignStatusMessage.textContent = `${message} ${managementSelectionErrorMessage}`;
      elements.campaignStatusMessage.className = "status error";
      elements.campaignStatusMessage.classList.remove("hidden");
      const pendingReadFailure = dashboardWorkflowErrors.get("campaigns");
      if (pendingReadFailure) showManagementSelectionReadFailure("campaigns", pendingReadFailure.message);
      else addWorkflowRetry(elements.campaignStatusMessage, "workflowRetryCampaigns", "Retry campaign list", () => retryCampaignWorkflowRead());
    }
    return;
  }
  const pendingReadFailure = dashboardWorkflowErrors.get("campaigns");
  delete elements.campaignStatusMessage.dataset.workflowReadFailure;
  elements.campaignStatusMessage.querySelector("#workflowRetryCampaigns")?.remove();
  elements.campaignStatusMessage.textContent = message;
  elements.campaignStatusMessage.className = `status ${type}`.trim();
  elements.campaignStatusMessage.classList.remove("hidden");
  if (pendingReadFailure) setWorkflowReadFailure(elements.campaignStatusMessage, "campaigns", pendingReadFailure.message, "workflowRetryCampaigns", "Retry campaign list", () => retryCampaignWorkflowRead());
}

function setWorkflowReadFailure(host, key, message, retryId, label, retry) {
  host.dataset.workflowReadFailure = key;
  host.classList.remove("hidden");
  let feedback = host.querySelector(".workflow-read-failure");
  if (!feedback) {
    feedback = document.createElement("div");
    feedback.className = "workflow-read-failure status error";
    host.append(feedback);
  }
  feedback.replaceChildren();
  const readMessage = document.createElement("span");
  readMessage.className = "workflow-read-message";
  readMessage.textContent = message;
  feedback.append(readMessage);
  const previousRetry = host.querySelector(`#${retryId}`);
  if (previousRetry && !feedback.contains(previousRetry)) previousRetry.remove();
  addWorkflowRetry(feedback, retryId, label, retry);
}

function clearWorkflowReadFailure(host, key, retryId, message = "") {
  if (host.dataset.workflowReadFailure !== key) return;
  delete host.dataset.workflowReadFailure;
  const feedback = host.querySelector(".workflow-read-failure");
  feedback?.remove();
  if ((key === "worlds" || key === "campaigns") && managementSelectionErrorIsCurrent(key)) {
    managementSelectionError(acceptedManagementRoute, managementSelectionErrorMessage);
  } else if (!host.textContent.trim()) host.classList.add("hidden");
}

function projectDashboardWorkflowErrorToRoute(route) {
  const target = route.view === "worlds"
    ? { key: "worlds", host: elements.worldStatus, retryId: "workflowRetryWorlds", label: "Retry world list", retry: () => retryWorldWorkflowRead() }
    : route.view === "campaigns"
      ? { key: "campaigns", host: elements.campaignStatusMessage, retryId: "workflowRetryCampaigns", label: "Retry campaign list", retry: () => retryCampaignWorkflowRead() }
      : route.view === "providers"
        ? { key: "providers", host: elements.providerStatus, retryId: "workflowRetryProviders", label: "Retry provider profiles", retry: () => retryProviderWorkflowRead() }
        : null;
  if (!target) return;
  const failure = dashboardWorkflowErrors.get(target.key);
  if (failure) setWorkflowReadFailure(target.host, target.key, failure.message, target.retryId, target.label, target.retry);
}

function reportWorldListReadFailure(message) {
  if (acceptedManagementRoute?.view === "worlds") {
    if (managementSelectionErrorIsCurrent("worlds")) showManagementSelectionReadFailure("worlds", message);
    else setWorkflowReadFailure(elements.worldStatus, "worlds", message, "workflowRetryWorlds", "Retry world list", () => retryWorldWorkflowRead());
  }
  reportDashboardWorkflowError("worlds", message, () => retryWorldWorkflowRead());
}

function reportCampaignListReadFailure(message) {
  if (acceptedManagementRoute?.view === "campaigns") {
    if (managementSelectionErrorIsCurrent("campaigns")) showManagementSelectionReadFailure("campaigns", message);
    else setWorkflowReadFailure(elements.campaignStatusMessage, "campaigns", message, "workflowRetryCampaigns", "Retry campaign list", () => retryCampaignWorkflowRead());
  }
  reportDashboardWorkflowError("campaigns", message, () => retryCampaignWorkflowRead());
}

function reportProviderListReadFailure(message) {
  if (acceptedManagementRoute?.view === "providers") {
    setWorkflowReadFailure(elements.providerStatus, "providers", message, "workflowRetryProviders", "Retry provider profiles", () => retryProviderWorkflowRead());
  }
  reportDashboardWorkflowError("providers", message, () => retryProviderWorkflowRead());
}

function addWorkflowRetry(host, id, label, retry) {
  host.querySelector(`#${id}`)?.remove();
  host.querySelector(".workflow-retry-feedback")?.remove();
  const button = document.createElement("button");
  button.id = id;
  button.className = "button secondary";
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", async () => {
    host.querySelector(".workflow-retry-feedback")?.remove();
    button.disabled = true;
    button.textContent = "Retrying…";
    try {
      await retry();
      host.querySelector(".workflow-retry-feedback")?.remove();
    } catch (error) {
      if (!host.isConnected || !button.isConnected || !host.contains(button)) return;
      const feedback = document.createElement("span");
      feedback.className = "workflow-retry-feedback";
      feedback.setAttribute("role", "status");
      feedback.textContent = safeWorkflowFailure("Retry failed. You can try again.", error);
      host.insertBefore(feedback, button);
    } finally {
      if (!button.isConnected) return;
      button.disabled = false;
      button.textContent = label;
    }
  });
  host.append(document.createTextNode(" "), button);
}

async function retryWorldWorkflowRead() {
  const route = acceptedManagementRoute;
  const intent = managementNavigationIntent;
  const selectionIntentEpoch = worldSelectionIntentEpoch;
  const preserveWorkflowFeedbackForWorldId = selectedWorld?.id || route?.selection?.kind === "world" && route.selection.id || "";
  const requestedWorldId = route?.selection?.kind === "world" ? route.selection.id : "";
  await loadWorlds(requestedWorldId, { selectionIntentEpoch, preserveWorkflowFeedbackForWorldId, preferRequestedWorld: Boolean(requestedWorldId) });
  if (route === acceptedManagementRoute && intent === managementNavigationIntent) {
    await applyExplicitManagementSelection(route, intent, { selectionIntentEpoch, preserveWorkflowFeedbackForWorldId });
  }
}

async function retryCampaignWorkflowRead() {
  const route = acceptedManagementRoute;
  const intent = managementNavigationIntent;
  const preserveWorkflowFeedbackForCampaignId = selectedCampaign?.id || route?.selection?.kind === "campaign" && route.selection.id || "";
  const selectionRequest = campaignSelectionRequest;
  const requestedCampaignId = route?.selection?.kind === "campaign" ? route.selection.id : selectedCampaign?.id || "";
  await loadCampaigns(requestedCampaignId, { focusNoSelection: true, preserveWorkflowFeedbackForCampaignId, selectionRequest, navigationIntent: intent });
  if (route === acceptedManagementRoute && intent === managementNavigationIntent) {
    await applyExplicitManagementSelection(route, intent, { preserveWorkflowFeedbackForCampaignId });
  }
}

async function retryProviderWorkflowRead() {
  await loadProviders("", { preserveWorkflowFeedback: true });
}

function safeWorkflowFailure(label, error) {
  const correlationId = typeof error?.correlationId === "string" && /^[a-z0-9-]{1,80}$/iu.test(error.correlationId)
    ? ` Reference: ${error.correlationId}.`
    : "";
  return `${label}${correlationId}`;
}

function renderDashboardWorkflowErrors() {
  const host = elements.dashboardWorkflowStatus;
  if (!host) return;
  host.replaceChildren();
  for (const [key, entry] of dashboardWorkflowErrors) {
    const item = document.createElement("div");
    item.dataset.workflow = key;
    item.append(document.createTextNode(entry.message));
    addWorkflowRetry(item, `workflowDashboardRetry${key[0].toUpperCase()}${key.slice(1)}`, `Retry ${key}`, entry.retry);
    host.append(item);
  }
  host.classList.toggle("hidden", dashboardWorkflowErrors.size === 0);
}

function reportDashboardWorkflowError(key, message, retry) {
  dashboardWorkflowErrors.set(key, { message, retry });
  renderDashboardWorkflowErrors();
}

function clearDashboardWorkflowError(key) {
  dashboardWorkflowErrors.delete(key);
  renderDashboardWorkflowErrors();
}

function requestTypedDelete(title, message, details = []) {
  if (pendingDeleteResolve) pendingDeleteResolve(false);
  pendingDeleteTitle = title;
  elements.deleteDialogMessage.textContent = message;
  elements.deleteDialogDetails.replaceChildren(...details.map((detail) => {
    const item = document.createElement("li");
    item.textContent = detail;
    return item;
  }));
  elements.deleteDialogDetails.classList.toggle("hidden", !details.length);
  elements.deleteExpectedTitle.textContent = title;
  elements.deleteConfirmationInput.value = "";
  elements.confirmDelete.disabled = true;
  openManagedModal(elements.deleteDialog);
  elements.deleteConfirmationInput.focus();
  return new Promise((resolve) => { pendingDeleteResolve = resolve; });
}

function setWorldEditorDisabled(disabled) {
  [
    elements.editWorldDraft,
    elements.worldReleaseNotes,
    elements.forkWorldTitle,
    elements.newCampaignTitle,
    elements.newCampaignCharacter,
    elements.newCampaignTurnControlStyle,
    elements.publishWorld,
    elements.forkWorldModalBtn,
    elements.confirmForkWorld,
    elements.createCampaignModalBtn,
    elements.confirmCreateCampaign,
    elements.exportWorld,
    elements.createWorldShare,
    elements.revokeWorldShare,
    elements.deleteWorldVersion,
    elements.archiveWorld,
    elements.deleteWorld
  ].forEach((element) => { element.disabled = disabled; });
}

function worldOverviewWithoutLegacyCharacter(world = {}) {
  const overview = world && typeof world === "object" && !Array.isArray(world) ? { ...world } : {};
  delete overview.character;
  return overview;
}

function worldContentFromForm() {
  const current = worldAuthorWorkingContent || selectedWorld?.draftContent || {};
  const currentOverview = worldOverviewWithoutLegacyCharacter(current.world);
  return {
    ...current,
    schemaVersion: 5,
    world: {
      ...currentOverview,
      title: elements.worldTitle.value,
      genre: elements.worldGenre.value,
      tone: elements.worldTone.value,
      premise: elements.worldPremise.value,
      backgroundStory: elements.worldBackground.value,
      firstAction: elements.worldFirstAction.value,
      rules: elements.worldRules.value
    },
    playableCharacters: Array.isArray(current.playableCharacters) ? current.playableCharacters : [],
    entities: Array.isArray(current.entities) ? current.entities : [],
    relationships: Array.isArray(current.relationships) ? current.relationships : [],
    rpgStats: Array.isArray(current.rpgStats) ? current.rpgStats : [],
    defaultTriggers: Array.isArray(current.defaultTriggers) ? current.defaultTriggers : [],
    eventTriggers: Array.isArray(current.eventTriggers) ? current.eventTriggers : [],
    assets: Array.isArray(current.assets) ? current.assets : [],
    defaults: current.defaults && typeof current.defaults === "object" ? current.defaults : {}
  };
}

function playableCharactersFromContent(content = {}) {
  return Array.isArray(content.playableCharacters) ? content.playableCharacters : [];
}

function copyJsonValue(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function opaqueCharacterId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

function configuredDefaultTextProvider() {
  const provider = defaultProvider("text");
  return provider && String(provider.defaultModel || "").trim() ? provider : null;
}

function updateCharacterGeneratorAvailability() {
  const available = characterModalScope === "world"
    && !suggestionApply
    && Boolean(configuredDefaultTextProvider())
    && Boolean(worldAuthorWorkingContent)
    && (worldAuthorMode === "create" || selectedWorld?.status !== "archived");
  elements.characterGenerator.classList.toggle("hidden", !available);
  elements.characterGeneratorUnavailable.classList.toggle("hidden", available || characterModalScope !== "world" || Boolean(suggestionApply));
  if (!available) elements.characterGenerator.open = false;
  elements.generateCharacter.disabled = !available || characterModalBusy;
  return available;
}

function setCharacterStatus(message = "", type = "") {
  elements.characterStatus.textContent = message;
  elements.characterStatus.className = `status ${type}${message ? "" : " hidden"}`.trim();
}

function setCharacterProfileOrganizationProgress(active) {
  elements.organizeCharacterProfileProgress.classList.toggle("hidden", !active);
}

function addCharacterEditorRow(kind, row = {}, readOnly = false) {
  const isStat = kind === "stat";
  const container = isStat ? elements.characterStats : elements.characterTrackers;
  const editor = document.createElement("div");
  editor.className = `character-edit-row${isStat ? "" : " tracker-row"}`;
  characterRowOriginals.set(editor, copyJsonValue(row));

  const fields = isStat
    ? [
      { key: "name", label: "Name", title: "The name of this RPG statistic.", placeholder: "e.g., Resolve", value: row.name ?? row.skill ?? row.stat ?? "", maxlength: 200 },
      { key: "value", label: "Value (1–99)", title: "The current numeric value for this statistic.", placeholder: "e.g., 12", value: row.value ?? row.score ?? row.rating ?? "", type: "number", min: 1, max: 99 },
      { key: "note", label: "Note", title: "What this statistic represents or covers. It is mechanics-only guidance.", placeholder: "e.g., Resists fear and mental strain", value: row.note ?? row.covers ?? "", maxlength: 2000 }
    ]
    : [
      { key: "name", label: "Name", title: "The name shown for this campaign tracker.", placeholder: "e.g., Lantern oil", value: row.name ?? row.label ?? row.title ?? "", maxlength: 300 },
      { key: "value", label: "Starting value", title: "The value assigned to this tracker when the campaign begins.", placeholder: "e.g., 3 uses", value: row.value ?? row.initialValue ?? "", maxlength: 6000 },
      { key: "rules", label: "Update rules", title: "How the tracker changes during play. These rules are not copied into the character profile.", placeholder: "e.g., Reduce by one after each night of travel", value: row.rules ?? row.updateRules ?? row.description ?? "", maxlength: 4000 }
    ];
  for (const field of fields) {
    const label = document.createElement("label");
    label.textContent = field.label;
    label.title = field.title;
    const input = document.createElement("input");
    input.dataset.characterField = field.key;
    input.type = field.type || "text";
    input.value = String(field.value);
    input.placeholder = field.placeholder;
    if (field.maxlength) input.maxLength = field.maxlength;
    if (field.min) input.min = String(field.min);
    if (field.max) input.max = String(field.max);
    input.disabled = readOnly;
    label.append(input);
    editor.append(label);
  }
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "button secondary character-row-remove";
  remove.textContent = "×";
  remove.setAttribute("aria-label", `Remove ${isStat ? "statistic" : "tracker"}`);
  remove.disabled = readOnly;
  remove.addEventListener("click", () => editor.remove());
  editor.append(remove);
  container.append(editor);
}

function emptyCharacterProfile() {
  return {
    identity: { aliases: [], pronouns: "" },
    story: {
      role: "", background: "", personality: "", motivations: "", goals: "",
      fearsAndConflicts: "", keyRelationships: "", narrativeHooks: "",
      voiceAndMannerisms: "", otherGuidance: ""
    },
    appearance: {
      ancestryOrSpecies: "", apparentAge: "", genderPresentation: "", build: "",
      skinOrComplexion: "", face: "", eyes: "", hair: "", distinguishingFeatures: [],
      clothing: "", equipmentAndAccessories: "", otherVisualDetails: ""
    },
    unclassifiedNotes: ""
  };
}

function profileValue(profile, path) {
  return path.split(".").reduce((value, key) => value?.[key], profile);
}

function profileFromForm() {
  for (const { path, world: { id } } of WORLD_PROFILE_FIELDS) {
    const raw = elements[id].value.trim();
    const value = path === "identity.aliases" || path === "appearance.distinguishingFeatures"
      ? raw.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)
      : raw;
    if (JSON.stringify(characterEditorDraft.values[path]) !== JSON.stringify(value)) {
      characterEditorDraft = setEditorDraftField(characterEditorDraft, path, value);
    }
  }
  return projectEditorProfile(characterEditorDraft);
}

function profileHasGuidance(profile) {
  return WORLD_PROFILE_FIELDS.map((field) => field.path).filter((path) => path.startsWith("story.")).some((path) => {
    const value = profileValue(profile, path);
    return Array.isArray(value) ? value.length > 0 : Boolean(String(value || "").trim());
  });
}

function populateCharacterForm(character, readOnly = false) {
  characterModalWorkingCharacter = copyJsonValue(character);
  characterEditorDraft = createEditorDraft(characterModalScope === "campaign" ? "campaign-main" : "world-draft", character);
  elements.characterDialog.querySelectorAll(".character-advanced-disclosure").forEach((disclosure) => { disclosure.open = false; });
  elements.characterName.value = String(character.name || "");
  elements.characterGuidance.value = String(character.characterText || "");
  elements.characterGuidanceSource.classList.toggle("hidden", !elements.characterGuidance.value.trim());
  const profile = character.profile || emptyCharacterProfile();
  for (const { path, world: { id } } of WORLD_PROFILE_FIELDS) {
    const value = profileValue(profile, path);
    elements[id].value = Array.isArray(value)
      ? value.join("\n")
      : String(value || "");
  }
  elements.characterStats.replaceChildren();
  elements.characterTrackers.replaceChildren();
  for (const stat of Array.isArray(character.rpgStats) ? character.rpgStats : []) addCharacterEditorRow("stat", stat, readOnly);
  for (const tracker of Array.isArray(character.defaultTriggers) ? character.defaultTriggers : []) addCharacterEditorRow("tracker", tracker, readOnly);
}

function setCharacterModalControls(readOnly, busy = false) {
  characterModalBusy = busy;
  elements.characterDialog.dataset.readOnly = String(readOnly);
  for (const control of [elements.characterName, elements.addCharacterStat, elements.addCharacterTracker, elements.characterCampaignUse, elements.characterStartingCastDefault, elements.characterAlwaysInContext]) {
    control.disabled = readOnly || busy;
  }
  const organizationAvailable = !suggestionApply && (characterModalScope === "campaign" || worldAuthorMode === "edit");
  elements.organizeCharacterProfile.disabled = readOnly || busy || !organizationAvailable;
  elements.organizeCharacterProfile.classList.toggle("hidden", characterModalScope === "world" && !organizationAvailable);
  elements.characterDialog.querySelectorAll(".character-profile-section input, .character-profile-section textarea").forEach((control) => {
    control.disabled = readOnly || busy;
  });
  elements.characterDialog.querySelectorAll(".character-edit-row input, .character-row-remove").forEach((control) => {
    control.disabled = readOnly || busy;
  });
  elements.characterDialog.querySelectorAll("details > summary").forEach((summary) => {
    summary.setAttribute("aria-disabled", String(busy));
    summary.tabIndex = busy ? -1 : 0;
  });
  elements.characterGeneratorPrompt.disabled = busy || characterModalScope === "campaign";
  elements.saveCharacter.disabled = readOnly || busy;
  elements.deleteCharacter.disabled = readOnly || busy;
  elements.cancelCharacter.disabled = busy;
  updateCharacterGeneratorAvailability();
}

function updateWorldCharacterDuplicateWarning() {
  const warning = elements.characterDuplicateWarning;
  if (!warning) return;
  const name = elements.characterName.value.trim().toLocaleLowerCase();
  const duplicate = characterModalScope === "world" && name && worldAuthorWorkingContent
    && playableCharactersFromContent(worldAuthorWorkingContent).some((character) => {
      if (character.id === editingCharacterId) return false;
      return [character.name, ...(character.profile?.identity?.aliases || [])]
        .some((candidate) => typeof candidate === "string" && candidate.trim().toLocaleLowerCase() === name);
    });
  warning.textContent = duplicate ? "Another character uses this name or alias. Matching by name may be less reliable." : "";
  warning.classList.toggle("hidden", !duplicate);
}

function updateWorldAuthorCharacters(characters) {
  worldAuthorWorkingContent = {
    ...(worldAuthorWorkingContent || {}),
    playableCharacters: characters.map((character) => copyJsonValue(character))
  };
  elements.worldCharacterRevision.value = String(Number(elements.worldCharacterRevision.value || 0) + 1);
  renderPlayableCharacterRoster(worldAuthorWorkingContent.playableCharacters);
  renderWorldAuthorChecklist();
}

let suggestionApply = null;
function openCharacterDialog(characterId = "", preview = null, apply = null) {
  if (worldAuthorBusy || !elements.worldAuthorDialog.open || !worldAuthorWorkingContent) return;
  const readOnly = false;
  suggestionApply = apply;
  const character = preview || (characterId
    ? playableCharactersFromContent(worldAuthorWorkingContent).find((item) => item.id === characterId)
    : null);
  if (characterId && !character) {
    worldMessage("That character is no longer present in this world draft.", "error");
    return;
  }
  editingCharacterId = character?.id || "";
  characterModalScope = "world";
  setCampaignCharacterReviewLock();
  elements.characterPlayableContext.hidden = false;
  elements.characterWorldGuidanceHint.hidden = false;
  characterProfileOrganizationResult = null;
  const initial = character || { id: "", name: "", characterText: "", rpgStats: [], defaultTriggers: [], source: { type: "world-library-editor" } };
  populateCharacterForm(initial, readOnly);
  elements.characterUseLabel.hidden = Boolean(preview);
  elements.characterCampaignUse.value = initial.campaignUse || "playable";
  elements.characterStartingCastDefault.checked = initial.startingCastDefault !== false;
  elements.characterAlwaysInContext.checked = initial.alwaysInContext === true;
  updateCharacterUseControls();
  updateWorldCharacterDuplicateWarning();
  elements.characterGeneratorPrompt.value = "";
  elements.characterGenerator.open = false;
  elements.characterDialogTitle.textContent = character ? "Edit character" : "Add character";
  elements.characterDialogDescription.textContent = character
    ? "Update this character in the world authoring form."
    : "Create a character for this world authoring form.";
  elements.saveCharacter.textContent = preview ? "Apply to suggestion" : "Apply to world draft";
  if (preview) elements.characterSupportingOptions.hidden = true;
  elements.saveCharacter.classList.toggle("hidden", readOnly);
  elements.deleteCharacter.classList.toggle("hidden", !character || readOnly || Boolean(preview));
  elements.cancelCharacter.textContent = readOnly ? "Close" : "Cancel";
  elements.characterMechanicsFields.classList.remove("hidden");
  elements.characterMechanics.classList.toggle("hidden", elements.characterCampaignUse.value === "supporting");
  elements.characterDialog.querySelector(".eyebrow").textContent = "World Library";
  setCharacterStatus();
  setCharacterModalControls(readOnly);
  elements.characterGenerator.open = !character && updateCharacterGeneratorAvailability();
  openEditDialog(elements.characterDialog);
  if (elements.characterGenerator.open) elements.characterGeneratorPrompt.focus();
  else if (!readOnly) elements.characterName.focus();
}

function updateCharacterUseControls() {
  const supporting = elements.characterCampaignUse.value === "supporting";
  elements.characterSupportingOptions.hidden = elements.characterCampaignUse.value === "playable";
  elements.characterPlayableContext.textContent = supporting ? "Supporting character · Available as a campaign companion." : elements.characterCampaignUse.value === "both" ? "Both · Available as a main character or companion." : "Playable character · Available as a main character.";
  elements.characterMechanics.classList.toggle("hidden", supporting);
  elements.characterWorldGuidanceHint.textContent = supporting ? "A name is required. Story details are optional." : "Start with a name and at least one story detail. Everything else is optional.";
  updateCharacterGeneratorAvailability();
}

function characterRowsFromForm(kind, characterId) {
  const isStat = kind === "stat";
  const container = isStat ? elements.characterStats : elements.characterTrackers;
  const result = [];
  for (const editor of container.querySelectorAll(".character-edit-row")) {
    const values = Object.fromEntries([...editor.querySelectorAll("[data-character-field]")].map((input) => [input.dataset.characterField, input.value.trim()]));
    const hasContent = Object.values(values).some(Boolean);
    if (!hasContent) continue;
    if (!values.name) {
      const error = new Error(`${isStat ? "Every statistic" : "Every tracker"} with content needs a name.`);
      error.control = editor.querySelector('[data-character-field="name"]');
      throw error;
    }
    const original = characterRowOriginals.get(editor) || {};
    const id = String(original.id || opaqueCharacterId());
    if (isStat) {
      const numeric = values.value === "" ? 50 : Number(values.value);
      if (!Number.isInteger(numeric) || numeric < 1 || numeric > 99) {
        const error = new Error(`The value for “${values.name}” must be a whole number from 1 to 99.`);
        error.control = editor.querySelector('[data-character-field="value"]');
        throw error;
      }
      result.push({ ...original, id, name: values.name, value: numeric, note: values.note || "" });
    } else {
      result.push({
        ...original,
        id,
        name: values.name,
        value: values.value || "Not yet established.",
        rules: values.rules || `Track ${values.name} whenever it changes.`
      });
    }
  }
  return result;
}

function characterFromForm({ forOrganization = false } = {}) {
  const name = elements.characterName.value.trim();
  const characterText = elements.characterGuidance.value.trim();
  const profile = profileFromForm();
  if (!name) {
    const error = new Error("Enter a character name. Saving also needs at least one story detail, such as a role or background.");
    error.control = elements.characterName;
    throw error;
  }
  if ((forOrganization || characterModalScope !== "campaign" && elements.characterCampaignUse.value !== "supporting") && !profileHasGuidance(profile) && !characterText && !(forOrganization && String(profile.unclassifiedNotes || "").trim())) {
    const error = new Error(forOrganization
      ? "Add notes, imported source guidance, or story details to organize."
      : "Add at least one story detail, such as a role or background, before saving.");
    error.control = forOrganization ? elements.characterUnclassifiedNotes : elements.characterRole;
    throw error;
  }
  const base = characterModalWorkingCharacter || {};
  const id = String(base.id || opaqueCharacterId());
  return {
    ...base,
    id,
    name,
    characterText,
    profile,
    ...(!editingCharacterId || base.campaignUse !== undefined || elements.characterCampaignUse.value !== "playable"
      ? { campaignUse: elements.characterCampaignUse.value } : {}),
    ...(!editingCharacterId || base.startingCastDefault !== undefined || !elements.characterStartingCastDefault.checked
      ? { startingCastDefault: elements.characterStartingCastDefault.checked } : {}),
    ...(!editingCharacterId || base.alwaysInContext !== undefined || elements.characterAlwaysInContext.checked
      ? { alwaysInContext: elements.characterAlwaysInContext.checked } : {}),
    rpgStats: elements.characterCampaignUse.value === "supporting" ? copyJsonValue(base.rpgStats || []) : characterRowsFromForm("stat", id),
    defaultTriggers: elements.characterCampaignUse.value === "supporting" ? copyJsonValue(base.defaultTriggers || []) : characterRowsFromForm("tracker", id),
    source: base.source && typeof base.source === "object" ? base.source : {}
  };
}

function renderPlayableCharacterRoster(characters = []) {
  const roster = Array.isArray(characters) ? characters : [];
  elements.playableCharacterRoster.replaceChildren();
  if (!roster.length) {
    const empty = document.createElement("span");
    empty.className = "muted";
    empty.textContent = "No playable characters yet. This draft can be saved, but it is not campaign-ready.";
    elements.playableCharacterRoster.append(empty);
    return;
  }
  for (const [index, character] of roster.entries()) {
    const wrapper = document.createElement("div");
    const card = document.createElement("button");
    card.type = "button";
    card.className = "character-roster-card";
    card.setAttribute("aria-label", `Edit ${String(character.name || "unnamed character")}`);
    const name = document.createElement("strong");
    name.textContent = String(character.name || "Unnamed character");
    const detail = document.createElement("span");
    const stats = Array.isArray(character.rpgStats) ? character.rpgStats.length : 0;
    const trackers = Array.isArray(character.defaultTriggers) ? character.defaultTriggers.length : 0;
    const use = character.campaignUse || "playable";
    const complete = Boolean(character.characterText || profileHasGuidance(character.profile || {}));
    detail.textContent = `${use[0].toUpperCase() + use.slice(1)} · ${character.profile?.role || "No role"} · ${complete ? "Story details added" : "Needs story details"} · ${stats} RPG stat${stats === 1 ? "" : "s"} · ${trackers} starting tracker${trackers === 1 ? "" : "s"}`;
    const description = document.createElement("span");
    description.textContent = String(character.characterText || "").slice(0, 260) || "No character description.";
    card.append(name, detail, description);
    card.addEventListener("click", () => openCharacterDialog(character.id));
    wrapper.append(card);
    for (const [label, action, disabled] of [
      ["Duplicate", "duplicate", false], ["Move up", "up", index === 0], ["Move down", "down", index === roster.length - 1]
    ]) {
      const button = document.createElement("button"); button.type = "button"; button.textContent = label; button.disabled = disabled;
      button.setAttribute("aria-label", `${label} ${character.name || "character"}`);
      button.addEventListener("click", () => {
        const next = roster.map((item) => copyJsonValue(item));
        if (action === "duplicate") next.splice(index + 1, 0, { ...copyJsonValue(character), id: opaqueCharacterId(), name: `${character.name} copy` });
        else { const target = index + (action === "up" ? -1 : 1); [next[index], next[target]] = [next[target], next[index]]; }
        updateWorldAuthorCharacters(next);
      });
      wrapper.append(button);
    }
    elements.playableCharacterRoster.append(wrapper);
  }
}

function managementWorldPreview(world) {
  return world?.draftPreview || world?.latestPreview || {};
}

function createManagementWorldCard(world, card = null) {
  const preview = managementWorldPreview(world);
  const isNew = !card;
  card ||= document.createElement("button");
  card.type = "button";
  card.className = `dashboard-card world-card management-world-card${selectedWorld?.id === world.id ? " selected" : ""}`;
  card.dataset.worldId = world.id;
  card.dataset.status = world.status;
  card.setAttribute("aria-pressed", String(selectedWorld?.id === world.id));
  card.setAttribute("aria-label", `Select ${world.title}`);
  const art = document.createElement("div");
  art.className = "card-art";
  applyArtwork(art, world);
  const version = document.createElement("span");
  version.className = "card-badge";
  version.textContent = world.latestVersionNumber ? `Published · v${world.latestVersionNumber}` : "Unpublished draft";
  const status = document.createElement("span");
  status.className = "card-badge secondary";
  status.textContent = world.status;
  art.append(version, status);
  const body = document.createElement("div");
  body.className = "card-body";
  const title = document.createElement("h3");
  title.textContent = world.title;
  const description = document.createElement("p");
  description.textContent = String(preview.premise || preview.backgroundStory || "No premise has been authored yet.");
  const meta = document.createElement("div");
  meta.className = "card-meta";
  const genre = document.createElement("span");
  genre.textContent = String(preview.genre || "Uncharted genre");
  const campaignsCount = document.createElement("span");
  campaignsCount.textContent = `${number(world.campaignCount)} campaign${Number(world.campaignCount) === 1 ? "" : "s"}`;
  meta.append(genre, campaignsCount);
  const cta = document.createElement("div");
  cta.className = "card-cta";
  const updated = new Date(world.draftUpdatedAt || world.updatedAt);
  const ctaLabel = document.createElement("span");
  ctaLabel.textContent = Number.isNaN(updated.valueOf()) ? "Select world" : `Updated ${updated.toLocaleDateString()}`;
  const ctaArrow = document.createElement("span");
  ctaArrow.setAttribute("aria-hidden", "true");
  ctaArrow.textContent = "→";
  cta.append(ctaLabel, ctaArrow);
  body.append(title, description, meta, cta);
  card.replaceChildren(art, body);
  if (isNew) card.addEventListener("click", () => {
    if (UUID_ROUTE_PATTERN.test(String(world.id || ""))) {
      void acceptManagementRoute(managementSelectionHash("worlds", "world", world.id), { source: "link", focus: true });
    } else void selectWorld(world.id);
  });
  return card;
}

function clearWorldCollectionFilters() {
  window.clearTimeout(managementWorldSearchTimer);
  elements.managementWorldSearch.value = "";
  elements.managementWorldSort.value = "updated-desc";
  managementWorldFilter = "all";
  managementWorldSort = "updated-desc";
  elements.managementWorldFilters.querySelectorAll("[data-world-filter]").forEach((button) => {
    const active = button.dataset.worldFilter === "all";
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  renderManagementWorlds();
  elements.managementWorldSearch.focus();
}

function renderManagementWorlds() {
  const query = elements.managementWorldSearch?.value ?? "";
  const matches = filterSortWorlds(worlds, { query, status: managementWorldFilter, sort: managementWorldSort });
  if (elements.managementWorldResults) elements.managementWorldResults.textContent = `Showing ${matches.length} of ${worlds.length} world${worlds.length === 1 ? "" : "s"}`;
  if (!matches.length) {
    elements.worldManagementCarousel.replaceChildren();
    const message = worlds.length ? "No worlds match this search and filter." : "No worlds are available yet.";
    elements.worldManagementCarousel.append(collectionEmptyState(message, "world", clearWorldCollectionFilters));
    return;
  }
  reconcileKeyedCollection(elements.worldManagementCarousel, matches, "world-id", createManagementWorldCard, (card, world) => createManagementWorldCard(world, card));
}

async function loadWorlds(preselectId = "", selectionOptions = {}) {
  const selectionIntentEpoch = selectionOptions.selectionIntentEpoch ?? worldSelectionIntentEpoch;
  ({ worlds } = await api("/api/v1/worlds"));
  clearDashboardWorkflowError("worlds");
  clearWorkflowReadFailure(elements.worldStatus, "worlds", "workflowRetryWorlds", "World content is stored in PostgreSQL, never embedded in this client.");
  renderDashboardWorlds();
  renderManagementWorlds();
  void loadDashboardStats("worlds");
  if (selectionIntentEpoch !== worldSelectionIntentEpoch) return;
  if (!worlds.length) {
    const missingWorldId = selectedWorld?.id;
    worldSelectionId = "";
    worldSelectionEpoch += 1;
    selectedWorld = null;
    worldVersionCharacters = [];
    worldVersionCampaignReady = false;
    playableCharacterLoadSequence += 1;
    elements.worldSelectionPanel.classList.add("hidden");
    setWorldEditorDisabled(true);
    elements.worldCampaignReadiness.textContent = "Create a world before checking campaign readiness.";
    if (missingWorldId && selectionOptions.preserveWorkflowFeedbackForWorldId === missingWorldId && !managementSelectionErrorIsCurrent("worlds")) {
      elements.worldStatus.replaceChildren();
      elements.worldStatus.className = "status";
    }
    return;
  }
  const targetId = selectionOptions.preferRequestedWorld && preselectId
    ? preselectId
    : worldSelectionId || preselectId || selectedWorld?.id;
  if (targetId && worlds.some((world) => world.id === targetId)) await selectWorld(targetId, { ...selectionOptions, selectionIntentEpoch });
  else if (selectedWorld && !worlds.some((world) => world.id === selectedWorld.id)) {
    const missingWorldId = selectedWorld.id;
    worldSelectionId = "";
    worldSelectionEpoch += 1;
    selectedWorld = null;
    elements.worldSelectionPanel.classList.add("hidden");
    setWorldEditorDisabled(true);
    renderManagementWorlds();
    if (selectionOptions.preserveWorkflowFeedbackForWorldId === missingWorldId && !managementSelectionErrorIsCurrent("worlds")) {
      elements.worldStatus.replaceChildren();
      elements.worldStatus.className = "status";
    }
  } else if (!selectedWorld) {
    elements.worldSelectionPanel.classList.add("hidden");
    setWorldEditorDisabled(true);
  }
}

async function loadWorldResult(worldId, selectionIntentEpoch, selectionOptions = {}) {
  invalidateDashboardWorldDetails(worldId);
  await loadWorlds(worldId, { ...selectionOptions, selectionIntentEpoch, preferRequestedWorld: true });
}

async function selectWorld(worldId, selectionOptions = {}) {
  const selectionIntentEpoch = selectionOptions.selectionIntentEpoch ?? ++worldSelectionIntentEpoch;
  if (selectionIntentEpoch !== worldSelectionIntentEpoch) return;
  const committedAuthorRefresh = selectionOptions.committedAuthorSession
    && editDialogSessions.get(elements.worldAuthorDialog) === selectionOptions.committedAuthorSession
    && worldAuthorBusy;
  if (elements.worldAuthorDialog.open && !committedAuthorRefresh) {
    const dismissal = await dismissEditDialog(elements.worldAuthorDialog);
    if (dismissal !== "dismissed" || elements.worldAuthorDialog.open) return;
  }
  if (selectionIntentEpoch !== worldSelectionIntentEpoch) return;
  const selectionEpoch = ++worldSelectionEpoch;
  worldSelectionId = worldId;
  const coverPollSequence = ++worldCoverJobPollSequence;
  elements.worldSelectionPanel.classList.remove("hidden");
  setWorldEditorDisabled(true);
  elements.worldVersionSelect.disabled = true;
  elements.newCampaignCharacter.disabled = true;
  const preserveWorkflowFeedback = selectionOptions.preserveWorkflowFeedbackForWorldId === worldId;
  if (!preserveWorkflowFeedback) worldMessage("Loading selected world…");
  const detailRetryCount = selectionOptions.detailRetryCount ?? 0;
  const detailRequest = getDashboardWorldDetails(worldId);
  const detailRequestEpoch = dashboardWorldDetailRequestEpochs.get(worldId);
  try {
    const world = await detailRequest;
    if (!isCurrentWorldSelection(worldId, selectionEpoch)) return;
    if (!isDashboardWorldDetailRequestCurrent(worldId, detailRequestEpoch)) {
      if (detailRetryCount < 1) {
        return selectWorld(worldId, { ...selectionOptions, selectionIntentEpoch, detailRetryCount: detailRetryCount + 1 });
      }
      worldMessage("World details changed while loading. Select this world again to retry.", "error");
      return;
    }
    if (world?.id !== worldId) throw new Error("The selected world response did not match the requested world.");
    selectedWorld = world;
    renderManagementWorlds();
    elements.worldEditorTitle.textContent = selectedWorld.title;
    elements.worldEditorMeta.textContent = `${selectedWorld.status} · draft revision ${selectedWorld.draftRevision} · ${selectedWorld.versions.length} published version${selectedWorld.versions.length === 1 ? "" : "s"} · ${number(selectedWorld.campaigns?.length || 0)} campaign${Number(selectedWorld.campaigns?.length || 0) === 1 ? "" : "s"}`;
    elements.worldReleaseNotes.value = "";
    elements.worldVersionSelect.replaceChildren(new Option(selectedWorld.versions.length ? "Latest published version" : "No published versions", ""));
    for (const version of selectedWorld.versions) {
      elements.worldVersionSelect.append(new Option(`Version ${version.versionNumber}${version.releaseNotes ? ` · ${version.releaseNotes}` : ""}`, version.id));
    }
    elements.worldVersionSelect.disabled = !selectedWorld.versions.length;
    setWorldEditorDisabled(false);
    const archived = selectedWorld.status === "archived";
    elements.archiveWorld.textContent = archived ? "Restore" : "Archive";
    elements.editWorldDraft.disabled = archived;
    elements.worldReleaseNotes.disabled = archived;
    elements.publishWorld.disabled = archived;
    elements.createCampaignModalBtn.disabled = true;
    elements.confirmCreateCampaign.disabled = true;
    elements.exportWorld.disabled = !selectedWorld.versions.length;
    elements.createWorldShare.disabled = !selectedWorld.versions.length;
    elements.revokeWorldShare.disabled = !selectedWorld.versions.length;
    elements.forkWorldModalBtn.disabled = !selectedWorld.versions.length;
    updateWorldVersionDeleteAvailability();
    elements.deleteWorld.disabled = false;
    updateCharacterGeneratorAvailability();
    await loadWorldVersionPlayableCharacters({ worldId, selectionEpoch });
    if (!isCurrentWorldSelection(worldId, selectionEpoch)) return;
    if (!preserveWorkflowFeedback) worldMessage(archived ? "This world is archived. Restore it before editing or publishing." : "World selected. Draft editing opens in the authoring modal.");
    void resumeWorldCoverJob(worldId, coverPollSequence);
  } catch (error) {
    if (!isCurrentWorldSelection(worldId, selectionEpoch)) return;
    if (!isDashboardWorldDetailRequestCurrent(worldId, detailRequestEpoch)) {
      if (detailRetryCount < 1) {
        return selectWorld(worldId, { ...selectionOptions, selectionIntentEpoch, detailRetryCount: detailRetryCount + 1 });
      }
      worldMessage("World details changed while loading. Select this world again to retry.", "error");
      return;
    }
    worldMessage(safeWorkflowFailure("The selected world could not be loaded.", error), "error");
  }
}

function isCurrentWorldSelection(worldId, selectionEpoch) {
  return worldSelectionEpoch === selectionEpoch && worldSelectionId === worldId;
}

function emptyWorldContent() {
  return {
    schemaVersion: 5,
    world: { title: "", genre: "", tone: "", premise: "", backgroundStory: "", firstAction: "", rules: "" },
    playableCharacters: [],
    entities: [],
    relationships: [],
    rpgStats: [],
    defaultTriggers: [],
    eventTriggers: [],
    assets: [],
    defaults: {}
  };
}

function setWorldAuthorStatus(message = "", type = "") {
  elements.worldAuthorStatus.textContent = message;
  elements.worldAuthorStatus.className = `status ${type}`.trim();
}

const WORLD_AUTHOR_STEPS = Object.freeze([
  { id: "basics", panel: "world-author-overview", next: "lore", nextLabel: "Continue to Lore" },
  { id: "lore", panel: "world-author-lore", next: "character", nextLabel: "Continue to Characters" },
  { id: "character", panel: "world-author-mechanics", next: "review", nextLabel: "Continue to Review" },
  { id: "review", panel: "world-author-review", next: "basics", nextLabel: "Back to Basics" }
]);
const WORLD_CHARACTER_READINESS_ISSUES = new Set([
  "no-playable-characters",
  "missing-character-id",
  "duplicate-character-id",
  "missing-character-name",
  "missing-character-text"
]);

function worldAuthorStep(id) {
  return WORLD_AUTHOR_STEPS.find((step) => step.id === id) || WORLD_AUTHOR_STEPS[0];
}

function setWorldAuthorStep(id) {
  if (worldAuthorBusy) return;
  const step = worldAuthorStep(id);
  worldAuthorActiveStep = step.id;
  for (const button of elements.worldAuthorSteps.querySelectorAll("[data-world-author-step]")) {
    const active = button.dataset.worldAuthorStep === step.id;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "step");
    else button.removeAttribute("aria-current");
  }
  for (const panel of elements.worldAuthorDialog.querySelectorAll('.tab-content[data-tab-group="world-author"]')) {
    panel.classList.toggle("active", panel.id === step.panel);
  }
  worldAuthorTabBinding?.sync();
  renderWorldAuthorChecklist();
}

if (elements.worldAuthorSteps) {
  const worldAuthorTabs = [...elements.worldAuthorSteps.querySelectorAll("[data-world-author-step]")].flatMap((tab) => {
    const key = tab.dataset.worldAuthorStep;
    const panel = document.getElementById(tab.dataset.tabTarget || "");
    return key && panel ? [{ key, tab, panel }] : [];
  });
  worldAuthorTabBinding = bindLegacyTabGroup({
    root: elements.worldAuthorSteps,
    tabs: worldAuthorTabs,
    getSelectedKey: () => worldAuthorActiveStep,
    onActivate: setWorldAuthorStep
  });
}

function renderWorldAuthorChecklist() {
  if (!elements.worldAuthorBasicsStatus) return;
  const titleReady = Boolean(elements.worldTitle.value.trim());
  const loreReady = [elements.worldPremise.value, elements.worldBackground.value, elements.worldFirstAction.value]
    .some((value) => value.trim());
  const characters = playableCharactersFromContent(worldAuthorWorkingContent || {});
  const selectableCharacters = characters.filter((character) => character.campaignUse !== "supporting");
  const basicsStatus = titleReady ? "Title added" : "Title required before saving";
  const loreStatus = loreReady ? "Author guidance added (optional)" : "Optional author guidance";
  const characterStatus = selectableCharacters.length
    ? `${selectableCharacters.length} playable character${selectableCharacters.length === 1 ? "" : "s"} in this draft`
    : "Add at least one playable character for a campaign-ready published version. Draft saving is still available.";
  elements.worldAuthorBasicsStatus.textContent = basicsStatus;
  elements.worldAuthorLoreStatus.textContent = loreStatus;
  elements.worldAuthorCharacterStatus.textContent = characterStatus;
  elements.worldAuthorBasicsStatus.parentElement.dataset.stepState = titleReady ? "complete" : "incomplete";
  elements.worldAuthorLoreStatus.parentElement.dataset.stepState = loreReady ? "complete" : "optional";
  elements.worldAuthorCharacterStatus.parentElement.dataset.stepState = selectableCharacters.length ? "complete" : "incomplete";
  for (const button of elements.worldAuthorSteps.querySelectorAll("[data-world-author-step]")) {
    const stepId = button.dataset.worldAuthorStep;
    const ready = stepId === "basics" ? titleReady : stepId === "lore" ? loreReady : stepId === "character" ? selectableCharacters.length > 0 : titleReady && selectableCharacters.length > 0;
    button.dataset.stepState = ready ? "complete" : "incomplete";
    button.setAttribute("aria-label", `${button.textContent.trim()}${stepId === "lore" ? ", optional" : ready ? ", guidance complete" : ", guidance incomplete"}`);
  }
  const step = worldAuthorStep(worldAuthorActiveStep);
  elements.worldAuthorStepGuidance.textContent = step.id === "basics"
    ? titleReady ? "Title added. Genre and tone remain optional author guidance." : "Add the required title. Genre and tone are optional author guidance."
    : step.id === "lore"
      ? "Lore fields are optional guidance. Save this draft whenever you are ready."
      : step.id === "character"
        ? "A published version needs a complete playable character before a campaign can start. This checklist is guidance, not server validation."
        : "Review the current draft guidance and the separate server assessment for its published version.";
  elements.worldAuthorNextStep.textContent = step.nextLabel;
  renderWorldAuthorPublishedReadiness();
}

function renderWorldAuthorPublishedReadiness() {
  const container = elements.worldAuthorPublishedReadiness;
  if (!container) return;
  container.replaceChildren();
  if (worldAuthorMode === "create") {
    container.className = "status world-author-published-readiness";
    container.textContent = "No published version is available for this new world. The current draft has not been assessed.";
    return;
  }
  const versionId = selectedWorldVersionId();
  const version = selectedWorld?.versions?.find((candidate) => candidate.id === versionId);
  if (!versionId || !version) {
    container.className = "status world-author-published-readiness";
    container.textContent = "No published version is available for assessment. The current draft has not been assessed.";
    return;
  }
  const label = `${selectedWorld?.title || "Selected world"}, published version ${version.versionNumber}`;
  const message = document.createElement("p");
  message.className = "world-author-readiness-summary";
  if (worldVersionReadinessLoading && worldVersionReadinessCheckedId === versionId) {
    message.textContent = `Checking server readiness for ${label}… The current draft has not been assessed.`;
    container.className = "status world-author-published-readiness";
    container.append(message);
    return;
  }
  if (worldVersionReadinessError && worldVersionReadinessCheckedId === versionId) {
    container.className = "status error world-author-published-readiness";
    message.textContent = `Server readiness for ${label} could not be checked. This is unknown, not campaign-ready; the current draft has not been assessed. ${worldVersionReadinessError}`;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "button secondary compact-button";
    retry.textContent = "Retry server assessment";
    retry.disabled = worldAuthorBusy || worldVersionReadinessLoading;
    retry.addEventListener("click", () => {
      if (worldAuthorBusy || worldVersionReadinessLoading) return;
      void loadWorldVersionPlayableCharacters({ worldId: selectedWorld?.id || "", selectionEpoch: worldSelectionEpoch });
    });
    container.append(message, retry);
    return;
  }
  if (!worldVersionReadiness || worldVersionReadiness.worldVersionId !== versionId) {
    container.className = "status world-author-published-readiness";
    message.textContent = `No server assessment is available for ${label}. The current draft has not been assessed.`;
    container.append(message);
    return;
  }
  container.className = `status ${worldVersionReadiness.ready ? "success" : "error"} world-author-published-readiness`;
  message.textContent = `Server assessment for ${label}: ${worldVersionReadiness.ready ? "Campaign-ready" : "Not campaign-ready"}. This assessment applies to this immutable version only; current draft changes have not been assessed.`;
  container.append(message);
  const issues = Array.isArray(worldVersionReadiness.issues) ? worldVersionReadiness.issues : [];
  if (!issues.length) return;
  const list = document.createElement("ul");
  list.className = "world-author-readiness-issues";
  for (const issue of issues) {
    const item = document.createElement("li");
    const text = document.createElement("span");
    text.textContent = typeof issue === "string" ? issue : String(issue?.message || "The server reported a readiness issue.");
    item.append(text);
    if (issue && typeof issue === "object" && WORLD_CHARACTER_READINESS_ISSUES.has(String(issue.code || ""))) {
      const characterId = String(issue.characterId || "");
      const character = playableCharactersFromContent(worldAuthorWorkingContent || {}).find((candidate) => candidate.id === characterId);
      const action = document.createElement("button");
      action.type = "button";
      action.className = "button secondary compact-button";
      action.textContent = character ? `Open character editor for ${character.name}` : "Open playable character editor";
      action.disabled = worldAuthorBusy;
      action.addEventListener("click", () => {
        if (worldAuthorBusy) return;
        setWorldAuthorStep("character");
        if (character) openCharacterDialog(character.id);
        else elements.addPlayableCharacter.focus();
      });
      item.append(action);
    }
    list.append(item);
  }
  container.append(list);
}

function setWorldAuthorSaveControlsBusy(session, busy) {
  if (busy) {
    if (!session || editDialogSessions.get(elements.worldAuthorDialog) !== session || !elements.worldAuthorDialog.open) return null;
    const controls = [...elements.worldForm.querySelectorAll("input, select, textarea, button")];
    const disclosureStates = [...elements.worldForm.querySelectorAll("details")].map((details) => [details, details.open]);
    const summaryStates = [...elements.worldForm.querySelectorAll("details > summary")].map((summary) => [summary, summary.getAttribute("aria-disabled"), summary.tabIndex]);
    const snapshot = {
      session,
      controls: controls.map((control) => [control, control.disabled]),
      disclosureStates,
      summaryStates,
      focusTarget: document.activeElement instanceof HTMLElement ? document.activeElement : null
    };
    for (const control of controls) control.disabled = true;
    for (const [summary] of summaryStates) {
      summary.setAttribute("aria-disabled", "true");
      summary.tabIndex = -1;
    }
    elements.worldAuthorDialog.setAttribute("aria-busy", "true");
    elements.worldAuthorStatus.focus();
    return snapshot;
  }
  const snapshot = worldAuthorBusyControlSnapshot;
  if (!snapshot || snapshot.session !== session || editDialogSessions.get(elements.worldAuthorDialog) !== session) return;
  for (const [control, disabled] of snapshot.controls) {
    if (control.isConnected) control.disabled = disabled;
  }
  for (const [disclosure, open] of snapshot.disclosureStates) {
    if (disclosure.isConnected) disclosure.open = open;
  }
  for (const [summary, ariaDisabled, tabIndex] of snapshot.summaryStates) {
    if (!summary.isConnected) continue;
    if (ariaDisabled === null) summary.removeAttribute("aria-disabled");
    else summary.setAttribute("aria-disabled", ariaDisabled);
    summary.tabIndex = tabIndex;
  }
  elements.worldAuthorDialog.removeAttribute("aria-busy");
  if (elements.worldAuthorDialog.open && snapshot.focusTarget?.isConnected && !snapshot.focusTarget.disabled) snapshot.focusTarget.focus();
}

function populateWorldAuthorForm(content) {
  worldAuthorWorkingContent = copyJsonValue(content || emptyWorldContent());
  elements.worldGenreToneDisclosure.open = false;
  const overview = worldAuthorWorkingContent.world || {};
  elements.worldTitle.value = overview.title || "";
  elements.worldGenre.value = overview.genre || "";
  elements.worldTone.value = overview.tone || "";
  elements.worldPremise.value = overview.premise || "";
  elements.worldBackground.value = overview.backgroundStory || "";
  elements.worldFirstAction.value = overview.firstAction || "";
  elements.worldRules.value = overview.rules || "";
  elements.worldCharacterRevision.value = "0";
  renderPlayableCharacterRoster(playableCharactersFromContent(worldAuthorWorkingContent));
  elements.convertEntities.hidden = previewEntityConversions(worldAuthorWorkingContent.entities).length === 0;
  renderWorldAuthorChecklist();
}

function resetWorldCoverAuthoring() {
  worldAuthorSelectedCover = null;
  elements.worldCoverAssetId.value = "";
  elements.worldCoverPrompt.value = "";
  elements.worldCoverKeep.checked = true;
  const coverUrl = worldAuthorMode === "edit" ? artworkUrl(selectedWorld) : "";
  elements.worldCoverPreview.src = coverUrl;
  elements.worldCoverPreview.classList.toggle("hidden", !coverUrl);
  elements.worldCoverKeepLabel.textContent = coverUrl ? "Keep current cover" : "No cover";
  elements.worldCoverRemoveOption.classList.toggle("hidden", !coverUrl);
  elements.worldCoverOptions.open = false;
  updateWorldCoverChoice();
}

function openWorldAuthor(mode) {
  if (mode === "edit" && (!selectedWorld || selectedWorld.status === "archived")) return;
  worldAuthorMode = mode;
  elements.worldCharacterPresetsUnavailable.hidden = castPresetsAvailable;
  let showExistingCharacterNote = mode === "edit";
  try {
    showExistingCharacterNote = showExistingCharacterNote && ownerDevice.getItem("infiniteQuestCharacterUseNoteSeen") !== "1";
    if (showExistingCharacterNote) ownerDevice.setItem("infiniteQuestCharacterUseNoteSeen", "1");
  } catch { /* The note remains available when device storage is unavailable. */ }
  elements.worldCharacterExistingNote.hidden = !showExistingCharacterNote;
  worldAuthorBusy = false;
  elements.worldAuthorDialogTitle.textContent = mode === "create" ? "Create world" : `Edit ${selectedWorld.title}`;
  elements.worldAuthorDialogDescription.textContent = mode === "create"
    ? "Author a reusable world draft. Nothing is published until you choose Publish version."
    : `Update draft revision ${selectedWorld.draftRevision}. Published versions and existing campaigns remain unchanged.`;
  elements.saveWorldDraft.textContent = mode === "create" ? "Create world" : "Save changes";
  elements.worldGenerator.classList.toggle("hidden", mode !== "create");
  elements.worldGenerator.open = false;
  elements.worldGeneratorPrompt.value = "";
  elements.worldGeneratorProgressContainer.classList.add("hidden");
  elements.generateWorldPreview.textContent = "Generate world";
  const textAvailable = Boolean(configuredDefaultTextProvider());
  elements.generateWorldPreview.disabled = !textAvailable;
  elements.worldGeneratorAvailability.innerHTML = textAvailable
    ? "Generation uses the configured default text provider."
    : 'Configure a default text provider in <a href="/app/settings?section=providers">Provider Setup</a> to enable generation.';
  elements.worldAuthorDialog.removeAttribute("aria-busy");
  worldAuthorBusyControlSnapshot = null;
  populateWorldAuthorForm(mode === "create" ? emptyWorldContent() : selectedWorld.draftContent);
  setWorldAuthorStep("basics");
  resetWorldCoverAuthoring();
  setWorldAuthorStatus(mode === "create" ? "Enter a title manually or generate a complete world from a concept." : "Review your changes before saving this draft.");
  openEditDialog(elements.worldAuthorDialog);
  elements.worldTitle.focus();
}

function newWorld() {
  openWorldAuthor("create");
}

async function generateWorldFromPrompt() {
  if (worldAuthorMode !== "create" || worldAuthorBusy) return;
  const prompt = elements.worldGeneratorPrompt.value.trim();
  if (!prompt) {
    setWorldAuthorStatus("Describe the world you want the default text model to create.", "error");
    elements.worldGeneratorPrompt.focus();
    return;
  }
  const current = worldContentFromForm();
  const hasAuthoredContent = [
    current.world.title,
    current.world.genre,
    current.world.tone,
    current.world.premise,
    current.world.backgroundStory,
    current.world.firstAction,
    current.world.rules,
    ...current.playableCharacters
  ].some((value) => typeof value === "object" || String(value || "").trim());
  if (hasAuthoredContent && !window.confirm("Replace the current world fields and playable-character roster with generated content?")) return;
  worldAuthorBusy = true;
  elements.generateWorldPreview.disabled = true;
  elements.saveWorldDraft.disabled = true;
  const originalButtonText = elements.generateWorldPreview.textContent;
  elements.generateWorldPreview.textContent = "Generating world…";

  const progressKey = "world-gen:" + Date.now() + ":" + Math.random().toString(36).slice(2);
  elements.worldGeneratorProgressContainer.classList.remove("hidden");
  elements.worldGeneratorProgressBar.value = 5;
  elements.worldGeneratorProgressPercent.textContent = "5%";
  elements.worldGeneratorProgressLabel.textContent = "Generating world structure and character seeds…";
  setWorldAuthorStatus("Generating the world, then building each playable character…");

  let progressTimer = setInterval(async () => {
    try {
      const progress = await api(`/api/v1/worlds/generate-progress?key=${encodeURIComponent(progressKey)}`);
      if (progress && progress.progressPercent) {
        elements.worldGeneratorProgressBar.value = progress.progressPercent;
        elements.worldGeneratorProgressPercent.textContent = `${progress.progressPercent}%`;
        if (progress.message) {
          elements.worldGeneratorProgressLabel.textContent = progress.message;
          setWorldAuthorStatus(progress.message);
        }
      }
    } catch { /* ignore polling errors */ }
  }, 300);

  try {
    const generated = await api("/api/v1/worlds/generate-preview", {
      method: "POST",
      body: JSON.stringify({ title: elements.worldTitle.value.trim(), prompt, progressKey })
    });
    if (progressTimer) clearInterval(progressTimer);
    elements.worldGeneratorProgressBar.value = 100;
    elements.worldGeneratorProgressPercent.textContent = "100%";
    elements.worldGeneratorProgressLabel.textContent = "World and character generation completed.";
    populateWorldAuthorForm(generated.content);
    setWorldAuthorStatus("World generated. Review every field and character before creating the draft.", "success");
  } catch (error) {
    if (progressTimer) clearInterval(progressTimer);
    elements.worldGeneratorProgressContainer.classList.add("hidden");
    setWorldAuthorStatus(worldGenerationFailureMessage(error), "error");
  } finally {
    if (progressTimer) clearInterval(progressTimer);
    worldAuthorBusy = false;
    elements.generateWorldPreview.textContent = originalButtonText;
    elements.generateWorldPreview.disabled = !configuredDefaultTextProvider();
    elements.saveWorldDraft.disabled = false;
    setTimeout(() => {
      elements.worldGeneratorProgressContainer.classList.add("hidden");
    }, 4000);
  }
}

function imageJobDelay(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function monitorWorldCoverJob(jobId, worldId) {
  const sequence = ++worldCoverJobPollSequence;
  return monitorWorldCoverJobWithSequence(jobId, worldId, sequence);
}

function renderWorldCoverJobStatus(job) {
  const unsuccessful = ["failed", "recoverable", "cancelled", "expired"].includes(job.status);
  if (job.status === "completed") {
    elements.worldCoverStatus.className = "status success";
    elements.worldCoverStatus.textContent = "World cover generated and stored in the retained Nexus image library.";
    return;
  }
  if (unsuccessful) {
    elements.worldCoverStatus.className = "status error";
    elements.worldCoverStatus.textContent = job.errorMessage || "World cover generation did not complete.";
    return;
  }
  const progressValue = Number(job.providerProgress);
  const hasProgress = Number.isFinite(progressValue) && progressValue > 0;
  const progress = hasProgress ? ` · ${number(progressValue)}%` : "";
  const queue = Number.isInteger(job.providerQueuePosition) ? ` · queue ${job.providerQueuePosition}` : "";
  const etaAt = job.providerEtaAt ? new Date(job.providerEtaAt).getTime() : Number.NaN;
  const eta = Number.isFinite(etaAt) ? ` · about ${Math.max(0, Math.ceil((etaAt - Date.now()) / 1000))}s remaining` : "";
  const retry = job.status === "queued" && job.providerStatus === "retrying" ? " after a provider timeout" : "";
  elements.worldCoverStatus.className = "status";
  elements.worldCoverStatus.replaceChildren();
  const label = document.createElement("span");
  label.textContent = `World cover ${String(job.providerStatus || job.status).replaceAll("_", " ")}${retry}${progress}${queue}${eta}. You can continue editing while it runs.`;
  elements.worldCoverStatus.append(label);
  const meter = document.createElement("progress");
  meter.max = 100;
  if (hasProgress) meter.value = Math.max(0, Math.min(100, progressValue));
  meter.setAttribute("aria-label", "World cover generation progress");
  elements.worldCoverStatus.append(meter);
}

async function monitorWorldCoverJobWithSequence(jobId, worldId, sequence) {
  for (let poll = 0; poll < 1200; poll += 1) {
    if (selectedWorld?.id !== worldId || sequence !== worldCoverJobPollSequence) return null;
    const job = await api(`/api/v1/image-jobs/${jobId}`);
    if (job.status === "completed") {
      invalidateDashboardWorldDetails(worldId);
      if (selectedWorld?.id !== worldId || sequence !== worldCoverJobPollSequence) return job;
      renderWorldCoverJobStatus(job);
      selectedWorld.imageUrl = job.assetUrl;
      const cached = worlds.find((world) => world.id === worldId);
      if (cached) cached.imageUrl = job.assetUrl;
      renderDashboardWorlds();
      renderManagementWorlds();
      return job;
    }
    if (selectedWorld?.id !== worldId || sequence !== worldCoverJobPollSequence) return null;
    if (["failed", "recoverable", "cancelled", "expired"].includes(job.status)) {
      throw new Error(job.errorMessage || "World cover generation did not complete.");
    }
    renderWorldCoverJobStatus(job);
    await imageJobDelay(1000);
  }
  throw new Error("World cover generation is still running. Refresh the world to check it again.");
}

async function resumeWorldCoverJob(worldId, sequence) {
  try {
    const job = await api(`/api/v1/worlds/${worldId}/cover-job`);
    if (!job || selectedWorld?.id !== worldId || sequence !== worldCoverJobPollSequence) return;
    if (job.status === "completed") return;
    renderWorldCoverJobStatus(job);
    if (["failed", "recoverable", "cancelled", "expired"].includes(job.status)) {
      worldMessage(job.errorMessage || "World cover generation did not complete. Open Edit draft to retry.", "error");
      return;
    }
    if (["queued", "generating", "provider_pending", "downloading"].includes(job.status)) {
      await monitorWorldCoverJobWithSequence(job.id, worldId, sequence);
    }
  } catch (error) {
    if (selectedWorld?.id !== worldId || sequence !== worldCoverJobPollSequence) return;
    elements.worldCoverStatus.className = "status error";
    elements.worldCoverStatus.textContent = error.message || String(error);
    worldMessage(`${error.message || String(error)} Open Edit draft to retry the cover.`, "error");
  }
}

function updateWorldCoverChoice() {
  const mode = document.querySelector('input[name="worldCoverMode"]:checked')?.value || "keep";
  elements.worldCoverPromptField.classList.toggle("hidden", mode !== "generate");
  elements.chooseWorldCover.classList.toggle("hidden", mode !== "library");
  if (mode === "generate") {
    if (defaultProvider("image")) {
      elements.worldCoverStatus.textContent = "A new cover will be queued after the world draft is saved.";
    } else {
      elements.worldCoverStatus.innerHTML = 'Configure a default image provider in <a href="/app/settings?section=providers">Provider Setup</a>. The world can still be saved without a cover.';
    }
  }
  else if (mode === "library") {
    elements.worldCoverStatus.textContent = worldAuthorSelectedCover
      ? `Selected retained image: ${worldAuthorSelectedCover.title || "Untitled image"}.`
      : "Choose an authorized retained image from the library.";
  } else if (mode === "remove") elements.worldCoverStatus.textContent = "The current cover will be removed after the draft is saved.";
  else elements.worldCoverStatus.textContent = worldAuthorMode === "edit" && artworkUrl(selectedWorld) ? "The current cover will be kept." : "No cover will be applied.";
}

function loadAssetLibraryBrowser() {
  if (!assetLibraryBrowserPromise) {
    const imageLibraryModuleUrl = "/nexus/image-library-browser.js";
    const retryQuery = assetLibraryImportRetryNonce > 0
      ? `?retry=${assetLibraryImportRetryNonce}`
      : "";
    assetLibraryBrowserPromise = import(/* @vite-ignore */ `${imageLibraryModuleUrl}${retryQuery}`)
      .then(({ createImageLibraryBrowser }) => createImageLibraryBrowser({
        dialog: elements.assetLibraryDialog,
        grid: elements.assetLibraryGrid,
        status: elements.assetLibraryStatus,
        filterContainer: elements.assetLibraryFilters,
        loadMore: elements.assetLibraryLoadMore,
        closeButton: elements.closeAssetLibrary
      }))
      .catch((error) => {
        assetLibraryBrowserPromise = null;
        assetLibraryImportRetryNonce = assetLibraryImportRetryNonce >= MAX_ASSET_LIBRARY_RETRY_NONCE
          ? 1
          : assetLibraryImportRetryNonce + 1;
        throw error;
      });
  }
  return assetLibraryBrowserPromise;
}

async function openAssetLibrary(onSelect, context = {}) {
  let browser;
  try {
    browser = await loadAssetLibraryBrowser();
  } catch (error) {
    elements.worldCoverStatus.className = "status error";
    elements.worldCoverStatus.textContent = safeWorkflowFailure("The image library could not be loaded. Try again.", error);
    return;
  }
  await browser.open({ mode: onSelect ? "picker" : "browse", onSelect, context });
}

async function chooseWorldCoverFromLibrary() {
  await openAssetLibrary(async (asset) => {
    worldAuthorSelectedCover = asset;
    elements.worldCoverAssetId.value = asset.id;
    elements.worldCoverLibraryMode.checked = true;
    elements.worldCoverPreview.src = asset.url;
    elements.worldCoverPreview.classList.remove("hidden");
    elements.worldCoverStatus.className = "status success";
    elements.worldCoverStatus.textContent = `Selected retained image: ${asset.title || "Untitled image"}.`;
  }, worldAuthorMode === "edit" && selectedWorld ? { worldId: selectedWorld.id } : {});
}

async function applyWorldCoverChoice(worldId, selectionIntentEpoch) {
  const mode = document.querySelector('input[name="worldCoverMode"]:checked')?.value || "keep";
  if (mode === "keep") return "";
  if (mode === "library") {
    const assetId = elements.worldCoverAssetId.value;
    if (!assetId) throw new Error("Choose a retained image before saving the world.");
    await api(`/api/v1/worlds/${worldId}/cover-asset`, { method: "PUT", body: JSON.stringify({ assetId }) });
    invalidateDashboardWorldDetails(worldId);
    await loadWorlds(worldId, { selectionIntentEpoch });
    return " Retained cover attached.";
  }
  if (mode === "remove") {
    await api(`/api/v1/worlds/${worldId}/cover-asset`, { method: "PUT", body: JSON.stringify({ assetId: null }) });
    invalidateDashboardWorldDetails(worldId);
    await loadWorlds(worldId, { selectionIntentEpoch });
    return " Cover removed.";
  }
  const job = await api(`/api/v1/worlds/${worldId}/cover`, {
    method: "POST",
    body: JSON.stringify({
      prompt: elements.worldCoverPrompt.value.trim(),
      size: "1024x1536",
      aspectRatio: "2:3",
      quality: "auto",
      outputFormat: "png",
      replace: Boolean(selectedWorld?.imageUrl)
    })
  });
  invalidateDashboardWorldDetails(worldId);
  void monitorWorldCoverJob(job.id, worldId).catch((error) => worldMessage(`World saved, but cover generation failed: ${error.message || String(error)}`, "error"));
  return " Cover generation queued.";
}

async function saveWorldDraft(event) {
  event.preventDefault();
  if (worldAuthorBusy) return;
  const title = elements.worldTitle.value.trim();
  if (!title) {
    setWorldAuthorStatus("Enter a title for the world.", "error");
    elements.worldTitle.focus();
    return;
  }
  worldAuthorBusy = true;
  const mode = worldAuthorMode;
  const selectionIntentEpoch = mode === "create" ? ++worldSelectionIntentEpoch : worldSelectionIntentEpoch;
  const committedAuthorSession = editDialogSessions.get(elements.worldAuthorDialog);
  worldAuthorBusyControlSnapshot = setWorldAuthorSaveControlsBusy(committedAuthorSession, true);
  const expectedRevision = selectedWorld?.draftRevision;
  const content = worldContentFromForm();
  setWorldAuthorStatus(mode === "create" ? "Creating authoritative world draft…" : "Saving world draft…");
  let worldId = selectedWorld?.id || "";
  let authoritativeCreateCompleted = false;
  try {
    if (mode === "create") {
      const created = await api("/api/v1/worlds", { method: "POST", body: JSON.stringify({ title, content }) });
      worldId = created.id;
      authoritativeCreateCompleted = true;
    } else {
      await api(`/api/v1/worlds/${worldId}/draft`, {
        method: "PUT",
        body: JSON.stringify({ expectedRevision, title, content })
      });
    }
    if (mode === "create") {
      await loadWorldResult(worldId, selectionIntentEpoch, { committedAuthorSession });
    } else {
      invalidateDashboardWorldDetails(worldId);
      await loadWorlds(worldId, { committedAuthorSession, selectionIntentEpoch });
    }
    if (worldAuthorBusyControlSnapshot?.session === committedAuthorSession) {
      setWorldAuthorSaveControlsBusy(committedAuthorSession, false);
      worldAuthorBusyControlSnapshot = null;
    }
    worldAuthorBusy = false;
    elements.worldAuthorDialog.close("saved");
    let coverMessage = "";
    try {
      coverMessage = await applyWorldCoverChoice(worldId, selectionIntentEpoch);
    } catch (coverError) {
      worldMessage(`World ${mode === "create" ? "created" : "saved"}, but its cover could not be updated: ${coverError.message || String(coverError)}`, "error");
      return;
    }
    worldMessage(
      mode === "create"
        ? `World draft created.${coverMessage} Publish a version when it is ready for campaigns.`
        : `Draft saved.${coverMessage} Published versions and existing campaigns remain unchanged.`,
      "success"
    );
  } catch (error) {
    if (mode === "create" && authoritativeCreateCompleted) {
      if (worldAuthorBusyControlSnapshot?.session === committedAuthorSession) {
        setWorldAuthorSaveControlsBusy(committedAuthorSession, false);
        worldAuthorBusyControlSnapshot = null;
      }
      worldAuthorBusy = false;
      elements.worldAuthorDialog.close("saved");
      worldMessage(`World created, but the management library could not reload it: ${error.message || String(error)} Refresh worlds before trying again.`, "error");
      return;
    }
    setWorldAuthorStatus(error.statusCode === 409
      ? "The world draft changed while this modal was open. Your entries are still here; close and reload the world before saving."
      : error.message || String(error), "error");
  } finally {
    if (worldAuthorBusyControlSnapshot?.session === committedAuthorSession
      && editDialogSessions.get(elements.worldAuthorDialog) === committedAuthorSession) {
      setWorldAuthorSaveControlsBusy(committedAuthorSession, false);
      worldAuthorBusyControlSnapshot = null;
    }
    if (editDialogSessions.get(elements.worldAuthorDialog) === committedAuthorSession) {
      worldAuthorBusy = false;
      if (elements.worldAuthorDialog.open) renderWorldAuthorChecklist();
    }
  }
}

function characterAdmissionError(error) {
  const message = error.message || String(error);
  const reference = typeof error.correlationId === "string" && /^[a-z0-9-]{1,80}$/iu.test(error.correlationId)
    ? ` Reference: ${error.correlationId}.` : "";
  return `${message}${reference}`;
}

async function generateCharacterFromPrompt() {
  if ((worldAuthorBusy && characterModalScope === "world") || !worldAuthorWorkingContent || characterModalBusy) return;
  const prompt = elements.characterGeneratorPrompt.value.trim();
  if (!prompt) {
    setCharacterStatus("Describe the character you want the default text model to create.", "error");
    elements.characterGeneratorPrompt.focus();
    return;
  }
  if (!configuredDefaultTextProvider()) {
    updateCharacterGeneratorAvailability();
    setCharacterStatus("Configure an enabled default text provider and model before generating a character.", "error");
    return;
  }
  const hasAuthoredContent = [...elements.characterDialog.querySelectorAll("input:not([type=checkbox]):not([type=hidden]), textarea")]
    .some((control) => control !== elements.characterGeneratorPrompt && String(control.value || "").trim());
  if (hasAuthoredContent && !window.confirm("Replace the current character fields with an AI draft? Your current entries will be replaced. Nothing is saved until you apply the draft.")) return;
  const previousName = elements.characterName.value;
  const previousGuidance = elements.characterGuidance.value;
  const previousProfile = profileFromForm();
  setCharacterModalControls(false, true);
  setCharacterStatus("Generating a complete character from the current world draft…");
  try {
    const result = await characterApi.worlds.generateCharacterPreview({
      content: worldContentFromForm(), prompt, ...(elements.characterCampaignUse.value === "supporting" ? { campaignUse: "supporting" } : {}),
      ...(editingCharacterId ? { characterId: editingCharacterId } : {})
    });
    const candidate = result?.character;
    if (!candidate || typeof candidate !== "object" || !String(candidate.name || "").trim() || !candidate.profile) {
      throw new Error("The text model did not return a complete character.");
    }
    const base = characterModalWorkingCharacter || {};
    const merged = {
      ...base,
      ...candidate,
      ...(elements.characterCampaignUse.value === "supporting" ? { rpgStats: base.rpgStats || [], defaultTriggers: base.defaultTriggers || [] } : {}),
      id: editingCharacterId || String(candidate.id || base.id || opaqueCharacterId()),
      ...(editingCharacterId ? { source: base.source, campaignUse: base.campaignUse, startingCastDefault: base.startingCastDefault, alwaysInContext: base.alwaysInContext } : {})
    };
    populateCharacterForm(merged, false);
    setCharacterStatus("Character generated. Review every field, then add it to the world form.", "success");
  } catch (error) {
    // Fields are populated only after a complete response has passed the client boundary checks.
    elements.characterName.value = previousName;
    elements.characterGuidance.value = previousGuidance;
    for (const { path, world: { id } } of WORLD_PROFILE_FIELDS) {
      const value = profileValue(previousProfile, path);
      elements[id].value = Array.isArray(value) ? value.join("\n") : String(value || "");
    }
    setCharacterStatus(characterAdmissionError(error), "error");
  } finally {
    setCharacterModalControls(false, false);
  }
}

function renderCharacterProfileReview(result) {
  characterProfileOrganizationResult = result;
  elements.characterProfileReviewList.replaceChildren();
  const existingProfile = profileFromForm();
  for (const { path } of WORLD_PROFILE_FIELDS) {
    const value = profileValue(result.candidate, path);
    const existingValue = profileValue(existingProfile, path);
    const hasProposed = Array.isArray(value) ? value.length > 0 : Boolean(String(value || "").trim());
    const hasExisting = Array.isArray(existingValue) ? existingValue.length > 0 : Boolean(String(existingValue || "").trim());
    if (!hasProposed && !hasExisting) continue;
    const evidence = (result.evidence || []).filter((entry) => entry.path === path);
    const row = document.createElement("div");
    row.className = "character-profile-review-row";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = hasProposed;
    checkbox.dataset.profilePath = path;
    const label = document.createElement("label");
    const heading = document.createElement("strong");
    heading.textContent = path;
    const existing = document.createElement("code");
    existing.textContent = `Existing: ${Array.isArray(existingValue) ? existingValue.join("; ") : String(existingValue || "(empty)")}`;
    const proposed = document.createElement("code");
    proposed.textContent = `Proposed: ${Array.isArray(value) ? value.join("; ") : String(value || "(empty)")}`;
    const sources = document.createElement("span");
    sources.className = "character-profile-review-evidence";
    sources.textContent = evidence.map((entry) => `${entry.source}: “${entry.quote}”`).join(" · ");
    label.append(heading, existing, proposed, sources);
    row.append(checkbox, label);
    elements.characterProfileReviewList.append(row);
  }
  const notices = [...(result.conflicts || []), ...(result.warnings || []),
    ...(result.unassignedText || []).map((text) => `Unassigned: ${text}`)];
  elements.characterProfileReviewWarnings.textContent = notices.join("\n");
  elements.characterProfileReviewWarnings.classList.toggle("hidden", notices.length === 0);
  openManagedModal(elements.characterProfileReviewDialog);
}

async function organizeCharacterProfile() {
  if ((worldAuthorBusy && characterModalScope === "world") || characterModalBusy) return;
  let character;
  try {
    character = characterFromForm({ forOrganization: true });
  } catch (error) {
    setCharacterStatus(characterAdmissionError(error), "error");
    const control = error.control;
    if (control instanceof HTMLElement) {
      const disclosure = control.closest("details");
      if (disclosure) disclosure.open = true;
      control.focus();
      if (control.willValidate && !control.validity.valid) control.reportValidity();
    }
    return;
  }
  const campaignScope = characterModalScope === "campaign";
  if (campaignScope ? !selectedCampaign : !selectedWorld) return;
  const expectedRevision = campaignScope ? campaignCharacterProfileRevision : selectedWorld.draftRevision;
  const campaignId = campaignScope ? selectedCampaign.id : null;
  const controller = campaignScope ? campaignCharacterController : null;
  if (campaignScope) setCampaignCharacterReviewLock(true);
  setCharacterModalControls(false, true);
  setCharacterProfileOrganizationProgress(true);
  setCharacterStatus("Organizing supplied facts into targeted profile fields…");
  try {
    const result = await (campaignScope
      ? characterApi.campaigns.organizeCharacter(selectedCampaign.id, { expectedRevision, character })
      : characterApi.worlds.organizeCharacter(selectedWorld.id, { expectedRevision, character }));
    renderCharacterProfileReview(result);
    setCharacterStatus("Review the evidence-backed proposals before applying them.", "success");
  } catch (error) {
    setCharacterStatus(characterAdmissionError(error), "error");
  } finally {
    setCharacterProfileOrganizationProgress(false);
    if (campaignScope && controller && campaignCharacterController === controller && selectedCampaign?.id === campaignId && elements.characterDialog.open) {
      characterModalBusy = false;
      campaignCharacterLocked = true;
      controller.setLocked(true);
      setCampaignCharacterReviewLock();
      await refreshCampaignCharacterLock(campaignId, controller);
    } else if (!campaignScope) {
      setCharacterModalControls(false, false);
    }
  }
}

async function applyCharacterProfileReview() {
  if ((worldAuthorBusy && characterModalScope === "world") || !characterProfileOrganizationResult
    || (characterModalScope === "campaign" && (campaignCharacterLocked || characterModalBusy || campaignCharacterController?.draft.conflict))) return;
  if (characterModalScope === "campaign") {
    const controller = campaignCharacterController;
    const campaignId = selectedCampaign?.id;
    const proposal = characterProfileOrganizationResult;
    if (!controller || !campaignId) return;
    setCampaignCharacterReviewLock(true);
    const checked = await refreshCampaignCharacterLock(campaignId, controller);
    if (!checked || controller !== campaignCharacterController || campaignId !== selectedCampaign?.id
      || !elements.characterProfileReviewDialog.open || proposal !== characterProfileOrganizationResult
      || campaignCharacterLocked || controller.draft.conflict) return;
  }
  const stagedValues = {};
  for (const checkbox of elements.characterProfileReviewList.querySelectorAll("[data-profile-path]:checked")) {
    const path = checkbox.dataset.profilePath;
    const value = profileValue(characterProfileOrganizationResult.candidate, path);
    stagedValues[path] = value;
  }
  try {
    characterEditorDraft = stageEditorOrganize(characterEditorDraft, stagedValues, characterProfileOrganizationResult.protocolVersion);
  } catch (error) {
    elements.characterProfileReviewWarnings.textContent = error.message;
    elements.characterProfileReviewWarnings.classList.remove("hidden");
    return;
  }
  for (const [path, value] of Object.entries(stagedValues)) {
    elements[WORLD_PROFILE_FIELDS.find((field) => field.path === path).world.id].value = Array.isArray(value) ? value.join("\n") : String(value || "");
  }
  elements.characterProfileReviewDialog.close();
  setCharacterStatus("Selected proposals applied to the unsaved form. Save the character to persist them.", "success");
}

function campaignProfileEditorRecord(result) {
  return { ...result, id: result.characterId || "", characterText: result.legacyCharacterText || "", profile: result.profile || emptyCharacterProfile() };
}

function syncCampaignCharacterDraft() {
  elements.characterName.value = characterEditorDraft.values.name || "";
  for (const { path, world: { id } } of WORLD_PROFILE_FIELDS) {
    const value = characterEditorDraft.values[path];
    elements[id].value = Array.isArray(value) ? value.join("\n") : String(value || "");
  }
}

function campaignCharacterGenerationLocked(status) {
  return Boolean(status.pendingGeneration || status.generationRecovery?.status === "recoverable");
}

function setCampaignCharacterReviewLock(force = false) {
  if (!elements.applyCharacterProfileReview) return;
  const locked = force || (characterModalScope === "campaign" && (campaignCharacterLocked || Boolean(campaignCharacterController?.draft.conflict)));
  elements.applyCharacterProfileReview.disabled = locked;
  elements.applyCharacterProfileReview.title = locked ? "Finish or resolve generation and profile conflicts before applying proposals." : "";
  if (elements.characterReviewLockNotice) elements.characterReviewLockNotice.textContent = locked
    ? "Proposals are retained. Finish or resolve generation and profile conflicts before applying them."
    : "";
}

async function refreshCampaignCharacterLock(campaignId, controller) {
  if (characterModalBusy || controller.saving) return;
  const epoch = ++campaignCharacterLockEpoch;
  try {
    const status = await characterApi.generation.syncStatus(campaignId);
    if (epoch !== campaignCharacterLockEpoch || campaignCharacterController !== controller || selectedCampaign?.id !== campaignId || !elements.characterDialog.open || characterModalBusy || controller.saving) return;
    const wasLocked = campaignCharacterLocked;
    campaignCharacterLocked = campaignCharacterGenerationLocked(status);
    controller.setLocked(campaignCharacterLocked);
    setCampaignCharacterReviewLock();
    if (campaignCharacterLocked) setCharacterStatus("Finish or resolve generation before saving the character profile.");
    else if (wasLocked) setCharacterStatus();
    return true;
  } catch (error) {
    if (epoch !== campaignCharacterLockEpoch || campaignCharacterController !== controller || selectedCampaign?.id !== campaignId || !elements.characterDialog.open) return;
    campaignCharacterLocked = true;
    controller.setLocked(true);
    setCampaignCharacterReviewLock();
    setCharacterStatus(`Generation status could not be checked: ${error.message || String(error)}`, "error");
  }
}

async function openCampaignCharacterDialog() {
  if (!selectedCampaign) return;
  const campaignId = selectedCampaign.id;
  const openEpoch = ++campaignCharacterOpenEpoch;
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  try {
    const [result, status] = await Promise.all([
      characterApi.campaigns.getCharacterProfile(campaignId),
      characterApi.generation.syncStatus(campaignId)
    ]);
    if (openEpoch !== campaignCharacterOpenEpoch || selectedCampaign?.id !== campaignId || elements.characterDialog.open) return;
    characterModalScope = "campaign";
    campaignCharacterProfileRevision = result.revision;
    editingCharacterId = result.characterId || "";
    characterProfileOrganizationResult = null;
    populateCharacterForm(campaignProfileEditorRecord(result));
    elements.characterPlayableContext.hidden = true;
    elements.characterWorldGuidanceHint.hidden = true;
    elements.characterDuplicateWarning?.classList.add("hidden");
    elements.characterDialog.querySelector(".eyebrow").textContent = "Campaign";
    elements.characterDialogTitle.textContent = "Edit campaign character profile";
    elements.characterDialogDescription.textContent = "Changes apply to this campaign.";
    elements.characterGenerator.classList.add("hidden");
    elements.characterUseLabel.hidden = true;
    elements.characterSupportingOptions.hidden = true;
    elements.characterMechanicsFields.classList.add("hidden");
    elements.characterMechanics.classList.add("hidden");
    elements.deleteCharacter.classList.add("hidden");
    elements.saveCharacter.classList.remove("hidden");
    elements.saveCharacter.textContent = "Save campaign profile";
    elements.cancelCharacter.textContent = "Cancel";
    setCharacterStatus();
    setCharacterModalControls(false);
    openEditDialog(elements.characterDialog);
    const form = {
      update() {
        return buildCampaignProfileUpdate(characterEditorDraft, campaignCharacterProfileRevision);
      },
      get dirty() { return characterEditorDraft.changedPaths.length > 0; },
      get draft() { return characterEditorDraft; },
      reapply(latest) { characterEditorDraft = reapplyEditorDraft(characterEditorDraft, campaignProfileEditorRecord(latest)); campaignCharacterProfileRevision = latest.revision; syncCampaignCharacterDraft(); },
      load(latest) { characterEditorDraft = createEditorDraft("campaign-main", campaignProfileEditorRecord(latest)); campaignCharacterProfileRevision = latest.revision; syncCampaignCharacterDraft(); },
      markConflict() { characterEditorDraft = markEditorConflict(characterEditorDraft); },
      setLocked(locked) { setCharacterModalControls(locked); },
      focus() { elements.characterName.focus(); },
      fieldControl(path) {
        return elements[WORLD_PROFILE_FIELDS.find((field) => field.path === path)?.world.id] ?? elements.characterName;
      }
    };
    const controller = createCampaignMainController(form, {
      host: elements.campaignCharacterFeedback,
      saveButton: elements.saveCharacter,
      load: () => characterApi.campaigns.getCharacterProfile(campaignId),
      save: async (payload) => {
        ++campaignCharacterLockEpoch;
        let currentStatus;
        try {
          currentStatus = await characterApi.generation.syncStatus(campaignId);
        } catch (error) {
          campaignCharacterLocked = true;
          controller.setLocked(true);
          throw new Error(`Generation status could not be checked: ${error.message || String(error)}`);
        }
        if (campaignCharacterGenerationLocked(currentStatus)) {
          campaignCharacterLocked = true;
          controller.setLocked(true);
          throw new Error("Finish or resolve generation before saving the character profile.");
        }
        return characterApi.campaigns.updateCharacterProfile(campaignId, payload);
      },
      isCurrent: () => campaignCharacterController === controller && elements.characterDialog.open && selectedCampaign?.id === campaignId,
      isLocked: () => campaignCharacterLocked,
      onSaved: (saved) => {
        elements.characterDialog.close("saved");
        void loadCampaigns(campaignId).then(() => {
          (elements.editCampaignCharacter || opener)?.focus();
          campaignMessage(`Campaign character profile saved at revision ${saved.revision}.`, "success");
        }, (error) => {
          (elements.editCampaignCharacter || opener)?.focus();
          campaignMessage(`Profile saved, but campaigns could not be refreshed: ${error.message || String(error)}`, "error");
        });
      },
      onDiscard: () => { elements.characterDialog.close(); opener?.focus(); }
    });
    campaignCharacterController = controller;
    campaignCharacterLocked = campaignCharacterGenerationLocked(status);
    controller.setLocked(campaignCharacterLocked);
    setCampaignCharacterReviewLock();
    if (campaignCharacterLocked) setCharacterStatus("Finish or resolve generation before saving the character profile.");
    campaignCharacterPoll = window.setInterval(() => void refreshCampaignCharacterLock(campaignId, controller), 2000);
    elements.characterName.focus();
  } catch (error) {
    if (openEpoch !== campaignCharacterOpenEpoch || selectedCampaign?.id !== campaignId) return;
    campaignMessage(`Character profile could not be opened: ${error.message || String(error)}`, "error");
  }
}

async function saveCharacterFromModal(event) {
  event.preventDefault();
  if ((worldAuthorBusy && characterModalScope === "world") || characterModalBusy) return;
  if (characterModalScope === "campaign") { await campaignCharacterController?.save(); return; }
  let character;
  try {
    character = characterFromForm();
  } catch (error) {
    setCharacterStatus(error.message || String(error), "error");
    const control = error.control;
    if (control instanceof HTMLElement) {
      const disclosure = control.closest("details");
      if (disclosure) disclosure.open = true;
      control.focus();
      if (control.willValidate && !control.validity.valid) control.reportValidity();
    }
    return;
  }
  if (!worldAuthorWorkingContent || (worldAuthorMode === "edit" && selectedWorld?.status === "archived")) return;
  if (suggestionApply) {
    suggestionApply(character);
    elements.characterDialog.close("saved");
    return;
  }
  const roster = playableCharactersFromContent(worldAuthorWorkingContent).map((item) => copyJsonValue(item));
  if (editingCharacterId) {
    const index = roster.findIndex((item) => item.id === editingCharacterId);
    if (index < 0) {
      setCharacterStatus("This character is no longer present in the selected draft.", "error");
      return;
    }
    character.id = editingCharacterId;
    roster[index] = character;
  } else {
    if (roster.some((item) => item.id === character.id)) {
      setCharacterStatus("The generated character ID conflicts with an existing character. Generate again or reopen the modal.", "error");
      return;
    }
    roster.push(character);
  }
  updateWorldAuthorCharacters(roster);
  elements.characterDialog.close("saved");
  setWorldAuthorStatus(`${character.name} ${editingCharacterId ? "updated" : "added"}. Save the world form to persist this change.`, "success");
}

async function deleteCharacterFromModal() {
  if ((worldAuthorBusy && characterModalScope === "world") || !worldAuthorWorkingContent || !editingCharacterId || characterModalBusy) return;
  const name = elements.characterName.value.trim() || "this character";
  if (!window.confirm(`Delete “${name}” from the current draft? Published versions and existing campaigns remain unchanged. Removing the last character makes this world unavailable for new campaigns until another character is added and published.`)) return;
  const roster = playableCharactersFromContent(worldAuthorWorkingContent).filter((item) => item.id !== editingCharacterId);
  if (roster.length === playableCharactersFromContent(worldAuthorWorkingContent).length) {
    setCharacterStatus("This character is no longer present in the selected draft.", "error");
    return;
  }
  worldAuthorWorkingContent.entities = (worldAuthorWorkingContent.entities || []).map((entity) => {
    if (!entity || typeof entity !== "object" || entity.linkedCharacterId !== editingCharacterId) return entity;
    const { linkedCharacterId, ...unlinked } = entity;
    return unlinked;
  });
  updateWorldAuthorCharacters(roster);
  elements.convertEntities.hidden = previewEntityConversions(worldAuthorWorkingContent.entities).length === 0;
  elements.characterDialog.close("deleted");
  setWorldAuthorStatus(`${name} removed. Save the world form to persist this change.`, "success");
}

async function publishSelectedWorld() {
  if (!selectedWorld) return;
  const worldId = selectedWorld.id;
  const selectionIntentEpoch = worldSelectionIntentEpoch;
  const expectedRevision = selectedWorld.draftRevision;
  elements.publishWorld.disabled = true;
  worldMessage("Publishing immutable world version…");
  try {
    const published = await api(`/api/v1/worlds/${worldId}/publish`, {
      method: "POST",
      body: JSON.stringify({ expectedRevision, releaseNotes: elements.worldReleaseNotes.value })
    });
    invalidateDashboardWorldDetails(worldId);
    await loadWorlds(worldId, { selectionIntentEpoch });
    await loadCampaigns();
    worldMessage(`Version ${published.versionNumber} published. Existing campaigns remain pinned to their current versions.`, "success");
  } catch (error) {
    worldMessage(error.message || String(error), "error");
  } finally {
    elements.publishWorld.disabled = selectedWorld?.status === "archived";
  }
}

function selectedWorldVersionId() {
  return elements.worldVersionSelect.value || selectedWorld?.versions?.[0]?.id || "";
}

function explicitlySelectedWorldVersion() {
  const versionId = elements.worldVersionSelect.value;
  return versionId ? selectedWorld?.versions?.find((version) => version.id === versionId) || null : null;
}

function worldVersionDeletionMetadata(version) {
  const metadata = version?.deletion && typeof version.deletion === "object"
    ? version.deletion
    : version?.deletionStatus && typeof version.deletionStatus === "object"
      ? version.deletionStatus
      : version || {};
  return {
    deletable: typeof metadata.deletable === "boolean" ? metadata.deletable : null,
    blockers: metadata.deletionBlockers || metadata.blockers || version?.deletionBlockers || {},
    detachments: metadata.detachments || version?.detachments || {}
  };
}

function dependencyCount(value) {
  if (Array.isArray(value)) return value.length;
  const count = Number(value);
  return Number.isFinite(count) ? count : value ? 1 : 0;
}

function namedDependencyCounts(values = {}) {
  const labels = {
    currentCampaigns: "current campaign",
    campaigns: "campaign",
    historicalCampaignLinks: "historical campaign link",
    campaignMigrations: "campaign migration record",
    campaignTransfers: "campaign transfer record",
    chronicleMemories: "Chronicle memory",
    memories: "Chronicle memory",
    modelChains: "model chain",
    generationJobs: "generation job",
    imageJobs: "illustration job",
    drafts: "draft base reference",
    forks: "fork reference",
    imports: "import record"
  };
  return Object.entries(values || {}).flatMap(([key, value]) => {
    const count = dependencyCount(value);
    if (!count) return [];
    const label = labels[key] || key.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
    return [`${count} ${label}${count === 1 ? "" : "s"}`];
  });
}

function updateWorldVersionDeleteAvailability() {
  const version = explicitlySelectedWorldVersion();
  const metadata = worldVersionDeletionMetadata(version);
  elements.deleteWorldVersion.disabled = !version || metadata.deletable === false;
  if (!version) {
    elements.deleteWorldVersion.title = "Choose a specific published version first.";
    return;
  }
  const blockers = namedDependencyCounts(metadata.blockers);
  elements.deleteWorldVersion.title = metadata.deletable === false
    ? `Version ${version.versionNumber} cannot be deleted${blockers.length ? ` because it is linked to ${blockers.join(", ")}` : " because it has dependent campaign history"}.`
    : `Permanently delete version ${version.versionNumber}.`;
}

function updateCampaignCreationAvailability() {
  const session = campaignCreationDialogSession;
  const hasPublishedVersion = Boolean(selectedWorldVersionId());
  const hasRequiredSelection = worldVersionCharacters.length === 1 || Boolean(elements.newCampaignCharacter.value);
  elements.createCampaignModalBtn.disabled = !hasPublishedVersion || !worldVersionCampaignReady;
  const dialogReady = Boolean(session?.ready && session.characters?.some((character) => character.id === elements.newCampaignCharacter.value));
  const scopeIsCurrent = Boolean(session && campaignCreationScopeIsCurrent(session));
  const canSubmit = Boolean(session && scopeIsCurrent && dialogReady && elements.newCampaignTitle.value.trim() && !createCampaignSubmitting && !createCampaignCommitted);
  elements.confirmCreateCampaign.disabled = !canSubmit;
  elements.createAndStartCampaign.disabled = !canSubmit;
  if (session && !scopeIsCurrent && !createCampaignCommitted) {
    setCreateCampaignStatus("The selected world or version changed. Close this dialog and open campaign creation again.");
  }
  if (!session) elements.confirmCreateCampaign.disabled = !hasPublishedVersion || !worldVersionCampaignReady || !hasRequiredSelection;
}

function setCreateCampaignStatus(message = "", committed = false) {
  elements.createCampaignStatus.classList.toggle("error", !committed);
  elements.createCampaignStatus.classList.toggle("success", committed);
  elements.createCampaignStatus.setAttribute("role", committed ? "status" : "alert");
  elements.createCampaignStatus.textContent = message;
  elements.createCampaignStatus.hidden = !message;
}

function setWorldCampaignReadiness(message, type = "") {
  elements.worldCampaignReadiness.textContent = message;
  elements.worldCampaignReadiness.className = `status ${type}`.trim();
}

async function loadWorldVersionPlayableCharacters(selection = {}) {
  const sequence = ++playableCharacterLoadSequence;
  const worldId = selection.worldId || selectedWorld?.id || "";
  const selectionEpoch = selection.selectionEpoch ?? worldSelectionEpoch;
  const worldVersionId = selectedWorldVersionId();
  if (elements.worldAuthorDialog.open && worldVersionId) {
    worldVersionReadinessCheckedId = worldVersionId;
    worldVersionReadinessLoading = true;
    worldVersionReadinessError = "";
    worldVersionReadiness = null;
    renderWorldAuthorPublishedReadiness();
  }
  const isCurrent = () => sequence === playableCharacterLoadSequence
    && isCurrentWorldSelection(worldId, selectionEpoch)
    && selectedWorld?.id === worldId
    && worldVersionId === selectedWorldVersionId();
  worldVersionCharacters = [];
  worldVersionCampaignReady = false;
  if (!elements.createCampaignDialog.open) {
    elements.newCampaignCharacter.replaceChildren(new Option(worldVersionId ? "Loading characters…" : "Publish a world version first", ""));
    elements.newCampaignCharacter.disabled = true;
  }
  updateCampaignCreationAvailability();
  if (!worldVersionId) {
    setWorldCampaignReadiness("Publish a world version with at least one playable character before creating a campaign.");
    return;
  }
  setWorldCampaignReadiness("Checking whether the selected world version is campaign-ready…");
  try {
    const response = await characterApi.worlds.playableCharacters(worldVersionId);
    if (!isCurrent()) return;
    worldVersionCharacters = Array.isArray(response.characters) ? response.characters : [];
    const hasReadinessAssessment = response.readiness && typeof response.readiness.ready === "boolean";
    worldVersionCampaignReady = hasReadinessAssessment ? response.readiness.ready : worldVersionCharacters.length > 0;
    worldVersionReadiness = hasReadinessAssessment ? { worldVersionId, ready: response.readiness.ready, issues: Array.isArray(response.readiness.issues) ? response.readiness.issues : [] } : null;
    worldVersionReadinessCheckedId = worldVersionId;
    worldVersionReadinessError = hasReadinessAssessment ? "" : "The server did not return a readiness assessment.";
    worldVersionReadinessLoading = false;
    renderWorldAuthorPublishedReadiness();
    const firstReadinessIssue = Array.isArray(response.readiness?.issues) ? response.readiness.issues[0] : null;
    const firstReadinessIssueMessage = typeof firstReadinessIssue === "string"
      ? firstReadinessIssue
      : String(firstReadinessIssue?.message || "").trim();
    if (!elements.createCampaignDialog.open) {
      const options = [];
      if (!worldVersionCharacters.length) options.push(new Option("No playable characters available", ""));
      else if (worldVersionCharacters.length > 1) options.push(new Option("Choose a player character", ""));
      for (const character of worldVersionCharacters) {
        options.push(new Option(`${character.name} · ${character.rpgStatCount} stats · ${character.defaultTriggerCount} trackers`, character.id));
      }
      elements.newCampaignCharacter.replaceChildren(...options);
      if (worldVersionCharacters.length === 1) elements.newCampaignCharacter.value = worldVersionCharacters[0].id;
      elements.newCampaignCharacter.disabled = worldVersionCharacters.length < 2;
      if (!worldVersionCampaignReady) {
        const issue = firstReadinessIssueMessage || "Add at least one complete playable character.";
        const message = `${issue} This world version is not campaign-ready; update the draft and publish a new version before creating a campaign.`;
        elements.newCampaignCharacterNote.textContent = message;
        setWorldCampaignReadiness(message, "error");
      } else if (worldVersionCharacters.length > 1) {
        elements.newCampaignCharacterNote.textContent = `Choose one of ${worldVersionCharacters.length} playable characters. The choice is snapshotted into the campaign.`;
        setWorldCampaignReadiness(`Campaign-ready with ${worldVersionCharacters.length} playable characters. Choose one when creating a campaign.`, "success");
      } else {
        elements.newCampaignCharacterNote.textContent = "This world version has one playable character, which will be snapshotted automatically.";
        setWorldCampaignReadiness("Campaign-ready with one playable character.", "success");
      }
    }
    updateCampaignCreationAvailability();
  } catch (error) {
    if (!isCurrent()) return;
    worldVersionReadinessCheckedId = worldVersionId;
    worldVersionReadinessLoading = false;
    worldVersionReadiness = null;
    worldVersionReadinessError = error.message || String(error);
    renderWorldAuthorPublishedReadiness();
    worldVersionCharacters = [];
    worldVersionCampaignReady = false;
    if (!elements.createCampaignDialog.open) {
      elements.newCampaignCharacter.replaceChildren(new Option("Characters unavailable", ""));
      elements.newCampaignCharacterNote.textContent = error.message || String(error);
    }
    setWorldCampaignReadiness(`Campaign readiness could not be checked: ${elements.newCampaignCharacterNote.textContent}`, "error");
    updateCampaignCreationAvailability();
    worldMessage(elements.newCampaignCharacterNote.textContent, "error");
  }
}

async function forkSelectedWorld() {
  if (!selectedWorld || !selectedWorldVersionId()) return;
  const title = elements.forkWorldTitle.value.trim();
  if (!title) {
    worldMessage("Enter a title for the independent fork.", "error");
    elements.forkWorldTitle.focus();
    return;
  }
  const selectionIntentEpoch = ++worldSelectionIntentEpoch;
  try {
    const fork = await api(`/api/v1/worlds/${selectedWorld.id}/fork`, {
      method: "POST",
      body: JSON.stringify({ title, sourceWorldVersionId: selectedWorldVersionId() })
    });
    elements.forkWorldTitle.value = "";
    await loadWorldResult(fork.worldId, selectionIntentEpoch);
    worldMessage("Fork created as an unpublished independent draft.", "success");
    if (elements.forkWorldDialog) elements.forkWorldDialog.close();
  } catch (error) {
    worldMessage(error.message || String(error), "error");
  }
}

async function toggleWorldArchive() {
  if (!selectedWorld) return;
  const worldId = selectedWorld.id;
  const selectionIntentEpoch = worldSelectionIntentEpoch;
  const nextStatus = selectedWorld.status === "archived"
    ? (selectedWorld.versions.length ? "active" : "draft")
    : "archived";
  try {
    await api(`/api/v1/worlds/${worldId}`, { method: "PATCH", body: JSON.stringify({ status: nextStatus }) });
    invalidateDashboardWorldDetails(worldId);
    await loadWorlds(worldId, { selectionIntentEpoch });
    worldMessage(nextStatus === "archived" ? "World archived. Existing campaigns remain available." : "World restored.", "success");
  } catch (error) {
    worldMessage(safeWorkflowFailure("World archive status could not be changed.", error), "error");
  }
}

async function deleteSelectedWorld() {
  if (!selectedWorld) return;
  if (Number(selectedWorld.campaignCount || worlds.find((world) => world.id === selectedWorld.id)?.campaignCount || 0)) {
    worldMessage("Delete every campaign using this world before deleting the world.", "error");
    return;
  }
  const worldId = selectedWorld.id;
  const expectedTitle = selectedWorld.title;
  const confirmed = await requestTypedDelete(expectedTitle, `This permanently deletes “${expectedTitle}”, its draft, and all published versions. This cannot be undone.`);
  if (!confirmed) return;
  const selectionIntentEpoch = worldSelectionIntentEpoch;
  elements.deleteWorld.disabled = true;
  try {
    await api(`/api/v1/worlds/${worldId}`, {
      method: "DELETE",
      body: JSON.stringify({ confirmation: "DELETE", expectedTitle })
    });
    invalidateDashboardWorldDetails(worldId);
    if (selectedWorld?.id === worldId) selectedWorld = null;
    await loadWorlds("", { selectionIntentEpoch });
    worldMessage(`World “${expectedTitle}” was permanently deleted.`, "success");
  } catch (error) {
    worldMessage(error.message || String(error), "error");
    elements.deleteWorld.disabled = !selectedWorld;
  }
}

async function deleteSelectedWorldVersion() {
  if (!selectedWorld) return;
  const version = explicitlySelectedWorldVersion();
  if (!version) {
    worldMessage("Choose a specific published version before deleting it.", "error");
    elements.worldVersionSelect.focus();
    return;
  }

  const metadata = worldVersionDeletionMetadata(version);
  const blockers = namedDependencyCounts(metadata.blockers);
  if (metadata.deletable === false) {
    worldMessage(
      `Version ${version.versionNumber} cannot be deleted${blockers.length ? ` because it is linked to ${blockers.join(", ")}` : " because it has dependent campaign history"}.`,
      "error"
    );
    return;
  }

  const publishedValue = version.publishedAt || version.createdAt;
  const publishedDate = publishedValue ? new Date(publishedValue) : null;
  const details = [
    `Published: ${publishedDate && !Number.isNaN(publishedDate.valueOf()) ? publishedDate.toLocaleString() : "date unavailable"}.`,
    `Release notes: ${String(version.releaseNotes || "No release notes.")}`,
    "The immutable version snapshot will be permanently deleted. This cannot be undone.",
    "Remaining versions keep their existing numbers; gaps are not renumbered or reused."
  ];
  const detachments = namedDependencyCounts(metadata.detachments);
  if (detachments.length) details.push(`Deletion will preserve and detach ${detachments.join(", ")}.`);
  if (metadata.deletable === true && !blockers.length) details.push("No campaign dependency was found when this World was loaded.");

  const expectedTitle = `Version ${version.versionNumber}`;
  const confirmed = await requestTypedDelete(
    expectedTitle,
    `Permanently delete ${expectedTitle} from “${selectedWorld.title}”?`,
    details
  );
  if (!confirmed) return;

  const worldId = selectedWorld.id;
  const selectionIntentEpoch = worldSelectionIntentEpoch;
  const selectedCampaignId = selectedCampaign?.id || "";
  elements.deleteWorldVersion.disabled = true;
  worldMessage(`Deleting world version ${version.versionNumber}…`);
  try {
    await api(`/api/v1/worlds/${worldId}/versions/${version.id}`, {
      method: "DELETE",
      body: JSON.stringify({ confirmation: "DELETE", expectedVersionNumber: version.versionNumber })
    });
    invalidateDashboardWorldDetails(worldId);
    await loadWorlds(worldId, { selectionIntentEpoch });
    await loadCampaigns(selectedCampaignId);
    worldMessage(`World version ${version.versionNumber} was permanently deleted. Remaining version numbers were unchanged.`, "success");
  } catch (error) {
    const conflictBlockers = namedDependencyCounts(error.details?.blockers || error.details?.deletionBlockers || {});
    const message = error.statusCode === 409 && conflictBlockers.length
      ? `Version ${version.versionNumber} cannot be deleted because it is linked to ${conflictBlockers.join(", ")}. Refresh the World to see its current dependency status.`
      : error.statusCode === 409
        ? `${error.message || `Version ${version.versionNumber} is still in use.`} Refresh the World to see its current dependency status.`
        : error.message || String(error);
    worldMessage(message, "error");
    updateWorldVersionDeleteAvailability();
  }
}

async function downloadJson(path, filename) {
  const response = await fetch(path, { headers: { accept: "application/json, application/zip" } });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.message || `Export failed with HTTP ${response.status}.`);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function exportSelectedWorld() {
  if (!selectedWorld || !selectedWorldVersionId()) return;
  try {
    await downloadJson(`/api/v1/worlds/${selectedWorld.id}/export?worldVersionId=${encodeURIComponent(selectedWorldVersionId())}`, "infinite-quest-world.json");
    worldMessage("Published world version exported without campaign or provider data.", "success");
  } catch (error) {
    worldMessage(error.message || String(error), "error");
  }
}

async function createSelectedWorldShare() {
  if (!selectedWorld || !selectedWorldVersionId()) return;
  try {
    const response = await fetch(`/api/v1/worlds/${selectedWorld.id}/share-links`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ worldVersionId: selectedWorldVersionId(), expiresInSeconds: 604800 })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Share creation failed with HTTP ${response.status}.`);
    const url = `${location.origin}/api/v1/world-shares/${payload.token}`;
    await navigator.clipboard.writeText(url);
    worldMessage(`World share link copied. It expires ${new Date(payload.expiresAt).toLocaleString()}.`, "success");
  } catch (error) {
    worldMessage(error.message || String(error), "error");
  }
}

async function revokeSelectedWorldShare() {
  if (!selectedWorld) return;
  try {
    const response = await fetch(`/api/v1/worlds/${selectedWorld.id}/share-links`);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Share lookup failed with HTTP ${response.status}.`);
    const active = (payload.shares || []).filter((share) => !share.revokedAt && new Date(share.expiresAt) > new Date());
    if (!active.length) return worldMessage("This world has no active share links.");
    const selected = prompt(`Paste the share ID to revoke:\n${active.map((share) => `${share.id} · expires ${new Date(share.expiresAt).toLocaleString()}`).join("\n")}`, active[0].id);
    if (!selected) return;
    const revoked = await fetch(`/api/v1/worlds/${selectedWorld.id}/share-links/${encodeURIComponent(selected.trim())}`, { method: "DELETE" });
    if (!revoked.ok) {
      const detail = await revoked.json().catch(() => ({}));
      throw new Error(detail.error || `Revoke failed with HTTP ${revoked.status}.`);
    }
    worldMessage("World share link revoked.", "success");
  } catch (error) {
    worldMessage(error.message || String(error), "error");
  }
}

function campaignCreationScopeIsCurrent(session) {
  if (session.entryPoint === "dashboard") {
    return dashboardWorld?.id === session.worldId && dashboardWorld?.latestVersionId === session.worldVersionId;
  }
  return selectedWorld?.id === session.worldId && selectedWorldVersionId() === session.worldVersionId;
}

function campaignCreationSessionIsCurrent(session) {
  return campaignCreationDialogSession === session
    && session.epoch === campaignCreationSessionEpoch
    && elements.createCampaignDialog.open
    && campaignCreationScopeIsCurrent(session);
}

function renderCampaignCreationVersion(session, versionNumber = null) {
  const worldTitle = session.worldTitle || "Selected world";
  const numberLabel = versionNumber || session.versionNumber;
  elements.createCampaignWorldVersion.textContent = `${worldTitle} · Version ${numberLabel || "selected"} · Immutable version`;
}

function updateCampaignCreationDialogAvailability() {
  const session = campaignCreationDialogSession;
  const selectedCharacterId = elements.newCampaignCharacter.value;
  const characterIsAvailable = Boolean(session?.characters?.some((character) => character.id === selectedCharacterId));
  const canSubmit = Boolean(session && campaignCreationScopeIsCurrent(session) && session.ready && characterIsAvailable && elements.newCampaignTitle.value.trim()
    && !createCampaignSubmitting && !createCampaignCommitted);
  elements.confirmCreateCampaign.disabled = !canSubmit;
  elements.createAndStartCampaign.disabled = !canSubmit;
}

function setCampaignCreationFieldsDisabled(disabled) {
  elements.newCampaignTitle.disabled = disabled;
  elements.newCampaignCharacter.disabled = disabled || !campaignCreationDialogSession?.ready;
  elements.newCampaignTurnControlStyle.disabled = disabled;
  elements.cancelCreateCampaign.disabled = disabled;
  elements.createCampaignAdvanced.querySelector("summary").setAttribute("aria-disabled", String(disabled));
  elements.startingCastSection.querySelectorAll("input, button").forEach((control) => { control.disabled = disabled; });
  if (!disabled && campaignCreationDialogSession?.castSelections) renderStartingCast(campaignCreationDialogSession);
}

function renderStartingCast(session) {
  const list = elements.startingCastList;
  list.replaceChildren();
  elements.startingCastSearchLabel.hidden = true;
  if (!castPresetsAvailable) {
    elements.startingCastNotice.textContent = "Character presets are unavailable on this installation.";
    return;
  }
  if (!session.ready) {
    elements.startingCastNotice.textContent = "Starting cast will be available when characters load.";
    return;
  }
  const candidates = session.castCandidates.filter((item) => item.campaignUse !== "playable" && item.id !== elements.newCampaignCharacter.value);
  const selected = candidates.filter((item) => session.castSelections.get(item.id)?.selected);
  for (const extra of selected.splice(30)) { session.castSelections.get(extra.id).selected = false; session.castOverCap = true; }
  const totalSelected = selected.length;
  const pins = selected.filter((item) => session.castSelections.get(item.id)?.alwaysInContext).length;
  const contextNotice = castContextAvailable ? "Story Memory is set on the campaign after you create it." : castNarratorNotice("installation_disabled", "").text;
  elements.startingCastNotice.textContent = `${selected.length} of 30 selected.${totalSelected >= 30 ? " Remove a selection to choose another." : ""}${session.castOverCap ? " Some characters were left unticked at the 30 limit." : ""}${pins > 5 ? " Always-included characters take up narrator context in every turn." : ""}${session.staleCast ? " Some unavailable selections were removed." : ""} ${contextNotice}`;
  if (!candidates.length) {
    const empty = document.createElement("p"); empty.textContent = "No Supporting characters available. Add NPCs in the world editor."; list.append(empty); return;
  }
  elements.startingCastSearchLabel.hidden = candidates.length <= 10;
  const query = elements.startingCastSearch.value.trim().toLocaleLowerCase();
  for (const item of candidates.filter((entry) => `${entry.name} ${entry.role}`.toLocaleLowerCase().includes(query))) {
    const state = session.castSelections.get(item.id);
    const row = document.createElement("div"); row.className = "starting-cast-row";
    const label = document.createElement("label");
    const tick = document.createElement("input"); tick.type = "checkbox"; tick.checked = state.selected; tick.disabled = createCampaignSubmitting || createCampaignCommitted || (!state.selected && totalSelected >= 30);
    tick.addEventListener("change", () => { state.selected = tick.checked; renderStartingCast(session); });
    label.append(tick, document.createTextNode(` ${item.name}${item.role ? ` · ${item.role}` : ""}`)); row.append(label);
    const pinLabel = document.createElement("label"); const pin = document.createElement("input"); pin.type = "checkbox"; pin.checked = state.alwaysInContext; pin.disabled = createCampaignSubmitting || createCampaignCommitted || !state.selected;
    pin.addEventListener("change", () => { state.alwaysInContext = pin.checked; renderStartingCast(session); });
    pinLabel.append(pin, document.createTextNode(" Always include")); row.append(pinLabel);
    if (item.summary) { const details = document.createElement("details"); const summary = document.createElement("summary"); summary.textContent = "Summary"; const text = document.createElement("p"); text.textContent = item.summary; details.append(summary, text); row.append(details); }
    list.append(row);
  }
}

async function loadCampaignCreationCharacters(session) {
  try {
    const result = await characterApi.worlds.playableCharacters(session.worldVersionId);
    if (!campaignCreationSessionIsCurrent(session)) return;
    const characters = Array.isArray(result.characters) ? result.characters.filter((character) =>
      typeof character?.id === "string" && character.id.trim().length > 0 && character.id.trim().length <= 200
      && typeof character?.name === "string") : [];
    if (!result.readiness?.ready || !characters.length) {
      const issue = result.readiness?.issues?.[0]?.message || "Publish this world version with a playable character before creating a campaign.";
      setCreateCampaignStatus(issue);
      session.ready = false;
      updateCampaignCreationDialogAvailability();
      return;
    }
    const draft = createCampaignCreationDraft({
      world: { id: session.worldId, worldVersionId: session.worldVersionId, title: session.worldTitle, playableCharacters: characters },
      userSettings: sessionUser?.settings
    });
    session.characters = characters;
    const candidates = Array.isArray(result.startingCastCandidates) ? result.startingCastCandidates : [];
    const candidateIds = new Set(candidates.map((item) => item.id));
    session.staleCast = [...session.castSelections.keys()].some((id) => !candidateIds.has(id));
    for (const id of session.castSelections.keys()) if (!candidateIds.has(id)) session.castSelections.delete(id);
    let selectedCount = [...session.castSelections.values()].filter((item) => item.selected).length;
    for (const item of candidates) if (!session.castSelections.has(item.id)) {
      const selected = item.campaignUse !== "playable" && item.id !== (session.initialDraft?.selectedCharacterId || (characters.length === 1 ? characters[0].id : "")) && item.startingCastDefault && selectedCount < 30;
      if (selected) selectedCount++;
      else if (item.startingCastDefault && item.campaignUse !== "playable" && selectedCount >= 30) session.castOverCap = true;
      session.castSelections.set(item.id, { selected, alwaysInContext: item.alwaysInContext === true });
    }
    session.castCandidates = candidates;
    elements.retryCampaignCharacters.hidden = true;
    session.draft = draft;
    session.ready = true;
    const options = characters.map((character) => new Option(character.name, character.id));
    if (characters.length > 1) options.unshift(new Option("Choose a character", ""));
    elements.newCampaignCharacter.replaceChildren(...options);
    elements.newCampaignCharacter.disabled = createCampaignSubmitting || createCampaignCommitted;
    const requestedCharacterId = session.initialDraft?.selectedCharacterId;
    elements.newCampaignCharacter.value = characters.some((character) => character.id === requestedCharacterId)
      ? requestedCharacterId
      : characters.length === 1 ? characters[0].id : "";
    draft.selectedCharacterId = elements.newCampaignCharacter.value || null;
    elements.newCampaignCharacterNote.textContent = characters.length === 1
      ? `${characters[0].name} will be snapshotted into the campaign.`
      : `Choose one of ${characters.length} published playable characters. The selected character is snapshotted into this campaign.`;
    if (elements.newCampaignTitle.value === session.initialTitle
      && normalizedTurnControlStyle(elements.newCampaignTurnControlStyle.value) === session.initialTurnControlStyle) {
      refreshModalBaseline(elements.createCampaignDialog);
    }
    renderStartingCast(session);
    updateCampaignCreationDialogAvailability();
  } catch (error) {
    if (!campaignCreationSessionIsCurrent(session)) return;
    elements.retryCampaignCharacters.hidden = false;
    setCreateCampaignStatus(error.message || String(error));
    elements.newCampaignCharacter.disabled = true;
    session.ready = false;
    updateCampaignCreationDialogAvailability();
  }
}

function openCampaignCreation({ worldId, worldVersionId, initialDraft = null }) {
  const entryPoint = campaignCreationEntryPoint;
  const world = worlds.find((candidate) => candidate.id === worldId);
  const detailTitle = selectedWorld?.id === worldId ? selectedWorld.title : dashboardWorld?.id === worldId ? dashboardWorld.title : world?.title;
  const version = selectedWorld?.id === worldId ? selectedWorld.versions?.find((candidate) => candidate.id === worldVersionId)
    : dashboardWorld?.id === worldId && dashboardWorld.latestVersionId === worldVersionId ? { versionNumber: dashboardWorld.latestVersionNumber } : null;
  const title = typeof initialDraft?.title === "string" ? initialDraft.title : "";
  const initialTurnControlStyle = normalizedTurnControlStyle(initialDraft?.turnControlStyle || sessionUser?.settings?.defaultTurnControlStyle);
  const session = {
    epoch: ++campaignCreationSessionEpoch,
    worldId,
    worldVersionId,
    worldTitle: detailTitle || "Selected world",
    versionNumber: version?.versionNumber || null,
    entryPoint,
    initialDraft,
    initialTitle: title,
    initialTurnControlStyle,
    characters: [],
    castCandidates: [], castSelections: new Map(), staleCast: false,
    draft: null,
    ready: false,
    committedCampaignId: null
  };
  campaignCreationDialogSession = session;
  createCampaignSubmitting = false;
  createCampaignCommitted = false;
  elements.createCampaignDialog.dataset.dismissMode = "confirm";
  elements.startingCastSearch.value = "";
  elements.retryCampaignCharacters.hidden = true;
  renderStartingCast(session);
  elements.newCampaignTitle.value = title;
  setCampaignCreationFieldsDisabled(false);
  elements.newCampaignCharacter.disabled = true;
  elements.newCampaignCharacter.replaceChildren(new Option("Loading playable characters…", ""));
  elements.newCampaignCharacter.value = "";
  elements.newCampaignTurnControlStyle.value = initialTurnControlStyle;
  elements.createCampaignAdvanced.open = false;
  elements.openCommittedCampaign.hidden = true;
  elements.openCommittedCampaign.disabled = false;
  document.getElementById("openCreatedCampaignMemory")?.remove();
  elements.cancelCreateCampaign.textContent = "Cancel";
  setCreateCampaignStatus();
  renderCampaignCreationVersion(session);
  updateCampaignCreationDialogAvailability();
  openManagedModal(elements.createCampaignDialog);
  elements.newCampaignTitle.focus();
  void loadCampaignCreationCharacters(session);
}

async function createCampaignFromWorld(event) {
  if (createCampaignSubmitting || createCampaignCommitted) return;
  const session = campaignCreationDialogSession;
  if (!session || !campaignCreationSessionIsCurrent(session) || !session.ready) return;
  const title = elements.newCampaignTitle.value.trim();
  if (!title) {
    setCreateCampaignStatus("Enter a title for the new campaign.");
    elements.newCampaignTitle.focus();
    return;
  }
  const selectedCharacterId = elements.newCampaignCharacter.value;
  if (!session.characters.some((character) => character.id === selectedCharacterId)) {
    setCreateCampaignStatus("Choose a playable character from this published version.");
    elements.newCampaignCharacter.focus();
    return;
  }
  const startAfterCreate = event?.submitter?.value === "start";
  const draft = {
    ...session.draft,
    title,
    selectedCharacterId,
    startingCast: castPresetsAvailable ? (session.castCandidates || []).filter((item) => item.id !== selectedCharacterId && session.castSelections?.get(item.id)?.selected).map((item) => ({ characterId: item.id, alwaysInContext: session.castSelections.get(item.id).alwaysInContext })) : [],
    turnControlStyle: normalizedTurnControlStyle(elements.newCampaignTurnControlStyle.value),
    startAfterCreate
  };
  let request;
  try {
    request = buildCampaignCreateRequest(draft);
  } catch (error) {
    setCreateCampaignStatus(error.message || String(error));
    return;
  }
  createCampaignSubmitting = true;
  setCampaignCreationFieldsDisabled(true);
  updateCampaignCreationDialogAvailability();
  setCreateCampaignStatus("Creating campaign…");
  try {
    let campaign;
    try {
      campaign = await characterApi.campaigns.create(request);
    } catch (error) {
      if (campaignCreationDialogSession === session) setCreateCampaignStatus(error.message || String(error));
      return;
    }
    session.committedCampaignId = campaign.id;
    createCampaignCommitted = true;
    setCampaignCreationFieldsDisabled(true);
    elements.cancelCreateCampaign.disabled = false;
    refreshModalBaseline(elements.createCampaignDialog);
    let persistenceWarning = "";
    try {
      ownerDevice.setItem("infiniteQuestLastCampaignId", campaign.id);
    } catch (error) {
      persistenceWarning = ` The campaign is committed, but the remembered campaign could not be saved: ${error.message || String(error)}`;
    }
    const skipped = campaign.skippedStartingCast || [];
    const seededCount = (request.startingCast || []).length - skipped.filter((item) => item.reason === "invalid_name").length;
    let notice = null;
    if (seededCount > 0) {
      try {
        const status = await campaignCastApi.workspaceStatus(campaign.id);
        notice = castNarratorNotice(status.narratorState, campaign.id);
      } catch {
        notice = { text: "Character context status could not be checked.", href: "/app/settings?section=campaign&campaignId=" + encodeURIComponent(campaign.id), label: "Campaign settings" };
      }
    }
    if (skipped.length) {
      const messages = skipped.map((item) => item.reason === "invalid_name"
        ? `${item.name}: character was skipped because its name is invalid.`
        : `${item.name}: invalid aliases were omitted: ${item.aliases.join(", ")}.`);
      if (notice) messages.push(notice.text);
      setCreateCampaignStatus(`Campaign created. ${messages.join(" ")}${persistenceWarning}`, true);
      elements.openCommittedCampaign.hidden = false;
      elements.cancelCreateCampaign.textContent = "Close";
      if (notice?.href) {
        const link = document.createElement("a");
        link.href = notice.href;
        link.className = "button secondary";
        link.id = "openCreatedCampaignMemory";
        link.textContent = notice.label;
        elements.openCommittedCampaign.after(link);
      }
      return;
    }
    if (startAfterCreate) {
      try {
        window.location.assign(`/story/${encodeURIComponent(session.committedCampaignId)}`);
        elements.createCampaignDialog.close();
      } catch (error) {
        setCreateCampaignStatus(`Campaign was created, but the story could not be opened: ${error.message || String(error)}.${persistenceWarning}`);
        elements.openCommittedCampaign.hidden = false;
      }
      return;
    }
    try {
      await loadCampaigns(session.committedCampaignId, { explicitPreselect: true });
      if (campaignCreationDialogSession === session) {
        elements.createCampaignDialog.close();
        worldMessage(`Campaign created for ${campaign.selectedCharacterName || "the selected character"} from the selected immutable world version.${persistenceWarning}`, "success");
      }
    } catch (error) {
      if (campaignCreationDialogSession === session) {
        setCreateCampaignStatus(`Campaign was created, but the campaign list could not refresh: ${error.message || String(error)}.${persistenceWarning} Open the story or return to Campaigns and refresh the list.`);
        elements.openCommittedCampaign.hidden = false;
      }
    }
  } finally {
    if (campaignCreationDialogSession === session) {
      createCampaignSubmitting = false;
      setCampaignCreationFieldsDisabled(createCampaignCommitted);
      if (createCampaignCommitted) elements.cancelCreateCampaign.disabled = false;
      updateCampaignCreationDialogAvailability();
    }
  }
}

function openCreateCampaignDialog() {
  if (!worldVersionCampaignReady) {
    worldMessage(elements.worldCampaignReadiness.textContent || "This world version is not campaign-ready.", "error");
    return;
  }
  campaignCreationEntryPoint = "management";
  openCampaignCreation({ worldId: selectedWorld.id, worldVersionId: selectedWorldVersionId() });
}

function openCommittedCampaignStory() {
  const campaignId = campaignCreationDialogSession?.committedCampaignId;
  if (!campaignId) return;
  try { ownerDevice.setItem("infiniteQuestLastCampaignId", campaignId); } catch { /* The committed campaign remains openable by its ID. */ }
  try {
    window.location.assign(`/story/${encodeURIComponent(campaignId)}`);
  } catch (error) {
    setCreateCampaignStatus(`Campaign was created, but the story could not be opened: ${error.message || String(error)}`);
  }
}

async function loadCampaigns(preselectId = "", { focusNoSelection = false, explicitPreselect = false, preserveWorkflowFeedbackForCampaignId = "", selectionRequest = null, navigationIntent = null } = {}) {
  try {
    ({ campaigns } = await api("/api/v1/campaigns"));
  } catch (error) {
    campaignsLoadError = !campaignsLoaded;
    if (!campaignsLoaded) {
      renderCampaignListLoadState();
      updateStoryViewLink();
    }
    throw error;
  }
  clearDashboardWorkflowError("campaigns");
  clearWorkflowReadFailure(elements.campaignStatusMessage, "campaigns", "workflowRetryCampaigns");
  campaignsLoaded = true;
  campaignsLoadError = false;
  const rememberedCampaignId = ownerDevice.getItem("infiniteQuestLastCampaignId");
  if (rememberedCampaignId && !campaigns.some((campaign) => campaign.id === rememberedCampaignId && campaign.status === "active")) {
    ownerDevice.removeItem("infiniteQuestLastCampaignId");
  }
  renderDashboardCampaigns();
  updateStoryViewLink();
  void loadDashboardStats("campaigns");
  if ((selectionRequest !== null && selectionRequest !== campaignSelectionRequest)
    || (navigationIntent !== null && navigationIntent !== managementNavigationIntent)) return;
  renderManagementCampaigns();
  if (!campaigns.length) {
    if (!(await canLeaveCampaignEditor(null))) return;
    campaignSelectionRequest += 1;
    selectedCampaign = null;
    selectedCampaignIsExplicit = false;
    updateStoryViewLink();
    clearCampaignEditorSelection({ focus: focusNoSelection });
    elements.illustrationSourcePolicy.value = "off";
    renderIllustrationSettingsVisibility();
    elements.campaignCostSection.classList.add("hidden");
    return;
  }
  const target = campaigns.find((campaign) => campaign.id === preselectId)
    || (!explicitPreselect && selectedCampaign && campaigns.find((campaign) => campaign.id === selectedCampaign.id));
  if (target) {
    const preservesExplicitSelection = selectedCampaignIsExplicit && selectedCampaign?.id === target.id;
    await selectCampaign(target, {
      explicit: explicitPreselect || preservesExplicitSelection,
      preserveWorkflowFeedbackForCampaignId
    });
  }
  else {
    if (!(await canLeaveCampaignEditor(null))) return;
    campaignSelectionRequest += 1;
    selectedCampaign = null;
    selectedCampaignIsExplicit = false;
    updateStoryViewLink();
    clearCampaignEditorSelection({ focus: focusNoSelection });
  }
}

async function selectCampaign(campaign, { explicit = true, preserveWorkflowFeedbackForCampaignId = "" } = {}) {
  if (!(await canLeaveCampaignEditor(campaign.id))) return;
  const previousCampaignId = selectedCampaign?.id;
  elements.embeddingProgress.classList.add("hidden");
  const selectionRequest = ++campaignSelectionRequest;
  const previousPanel = activeCampaignSettingsPanel;
  campaignCoreReady = false;
  elements.migrateCampaign.disabled = true;
  elements.campaignSettingsRail.querySelectorAll("[role=tab]").forEach((tab) => { tab.disabled = true; });
  CAMPAIGN_SETTINGS_SELECTION_CONTROLS.forEach((id) => { if (elements[id]) elements[id].disabled = true; });
  setCampaignSettingsSectionControls("illustrations", true);
  setCampaignSettingsSectionControls("chronicle", true);
  elements.budgetTokens.disabled = true;
  elements.compression.disabled = true;
  elements.memoryQuery.disabled = true;
  elements.previewContext.disabled = true;
  document.querySelectorAll("[data-campaign-section-feedback]").forEach((feedback) => {
    feedback.replaceChildren();
    feedback.className = "status hidden";
  });
  campaignSectionLoader.setSelection(campaign.id, selectionRequest);
  let runtimeState;
  try {
    runtimeState = await api(`/api/v1/campaigns/${campaign.id}/state`);
  } catch (error) {
    if (selectionRequest === campaignSelectionRequest && selectedCampaign) {
      campaignSectionLoader.setSelection(selectedCampaign.id, selectionRequest);
      CAMPAIGN_SETTINGS_SELECTION_CONTROLS.forEach((id) => { if (elements[id]) elements[id].disabled = false; });
      updateCampaignMigrationAvailability();
      setCampaignSettingsSectionControls("illustrations", true);
      setCampaignSettingsSectionControls("chronicle", true);
      elements.budgetTokens.disabled = true;
      elements.compression.disabled = true;
      elements.memoryQuery.disabled = true;
      campaignCoreReady = true;
      setCampaignSettingsAvailability(true);
      setCampaignSettingsPanel(previousPanel);
    }
    throw error;
  }
  if (selectionRequest !== campaignSelectionRequest) return;
  selectedCampaign = {
    ...campaign,
    activeTurnNumber: runtimeState.activeTurnNumber,
    stateRevision: runtimeState.revision
  };
  selectedCampaignIsExplicit = explicit;
  campaign = selectedCampaign;
  if (previousCampaignId !== campaign.id) clearContextPreviewPresentation();
  if (previousCampaignId && previousCampaignId !== campaign.id) {
    for (const panelId of CAMPAIGN_SETTINGS_PANEL_IDS) {
      if (panelId !== "overview") setCampaignSettingsSectionContentVisibility(panelId, false);
    }
  }
  campaignStoryMemorySettings = null;
  renderCampaignStoryMemorySettings(null, { message: "Open Story Behavior to load the saved Story Memory level for this campaign." });
  updateStoryViewLink();
  elements.campaignList.querySelectorAll(".campaign-button").forEach((button) => {
    const active = button.dataset.campaignId === campaign.id;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  elements.memoryTitle.textContent = campaign.title;
  elements.campaignEditorSummary.textContent = `${campaign.status} · ${campaign.worldTitle} v${campaign.worldVersionNumber}${campaign.selectedCharacterName ? ` · ${campaign.selectedCharacterName}` : ""}`;
  elements.campaignWorldLink.hidden = !UUID_ROUTE_PATTERN.test(String(campaign.worldId || ""));
  if (!elements.campaignWorldLink.hidden) elements.campaignWorldLink.href = managementSelectionHash("worlds", "world", campaign.worldId);
  elements.campaignCostSection.classList.add("hidden");
  elements.saveEmbeddingConfig.disabled = true;
  elements.reindexMemory.disabled = true;
  elements.previewContext.disabled = true;
  elements.reindexEmbeddings.disabled = true;
  elements.saveIllustrationConfig.disabled = true;
  elements.campaignTitle.value = campaign.title;
  elements.campaignStatus.value = campaign.status;
  elements.campaignTextProvider.value = campaign.textProviderProfileId || "";
  elements.campaignImageProvider.value = "";
  elements.campaignTurnControlStyle.value = normalizedTurnControlStyle(campaign.turnControlStyle);
  elements.campaignStoryLengthProfile.value = campaign.storyLengthProfile || "standard";
  elements.campaignStoryContextBudgetTokens.value = String(campaign.storyContextBudgetTokens || 32_000);
  campaignEditGuard.reset(campaign.id, selectionRequest, campaignSettingsSnapshot());
  renderCampaignSaveFeedback("saved");
  applyStoryProviderContextBudget();
  populateEmbeddingProviderSelect();
  if (selectionRequest !== campaignSelectionRequest) return;
  CAMPAIGN_SETTINGS_SELECTION_CONTROLS.forEach((id) => { if (elements[id]) elements[id].disabled = false; });
  setCampaignSettingsSectionControls("illustrations", true);
  setCampaignSettingsSectionControls("chronicle", true);
  elements.budgetTokens.disabled = true;
  elements.compression.disabled = true;
  elements.memoryQuery.disabled = true;
  elements.campaignWorldVersion.replaceChildren();
  elements.campaignWorldVersion.disabled = true;
  let world = null;
  let worldDetailsError = null;
  try {
    world = await api(`/api/v1/worlds/${campaign.worldId}`);
  } catch (error) {
    worldDetailsError = error;
  }
  if (selectionRequest !== campaignSelectionRequest) return;
  if (world) {
    for (const version of [...world.versions].reverse()) {
      const option = new Option(`Version ${version.versionNumber}`, version.id);
      option.dataset.versionNumber = String(version.versionNumber);
      elements.campaignWorldVersion.append(option);
    }
    elements.campaignWorldVersion.value = campaign.worldVersionId;
    elements.campaignWorldVersion.disabled = false;
  } else {
    elements.campaignWorldVersion.append(new Option("World details unavailable", ""));
    elements.campaignWorldVersion.disabled = true;
  }
  updateCampaignMigrationAvailability();
  if (!managementSelectionErrorIsCurrent("campaigns") && preserveWorkflowFeedbackForCampaignId !== campaign.id) {
    if (worldDetailsError) campaignMessage(safeWorkflowFailure("Campaign selected, but its world details could not be loaded.", worldDetailsError), "error");
    else if (campaign.worldUpdateAvailable) campaignMessage(`This campaign is pinned to version ${campaign.worldVersionNumber}; version ${campaign.latestWorldVersionNumber} is available. Migration is explicit and does not rewrite accepted turns.`);
    else {
      const hasPendingListReadFailure = dashboardWorkflowErrors.has("campaigns");
      campaignMessage("");
      if (!hasPendingListReadFailure) elements.campaignStatusMessage.classList.add("hidden");
    }
  }
  campaignSectionLoader.setSelection(campaign.id, selectionRequest);
  campaignCoreReady = true;
  setCampaignSettingsAvailability(true);
  setCampaignSettingsPanel(previousPanel);
}

async function saveSelectedCampaign(event = null, { snapshot = campaignSettingsSnapshot() } = {}) {
  event?.preventDefault();
  if (!selectedCampaign || campaignSaveInProgress) return false;
  const campaignId = selectedCampaign.id;
  const selectionRequest = campaignSelectionRequest;
  const campaign = selectedCampaign;
  campaignSaveInProgress = true;
  elements.saveCampaign.disabled = true;
  renderCampaignSaveFeedback("saving");
  try {
    const updatedCampaign = await writeCampaignSettings(api, campaignId, "behavior", {title:snapshot.title,status:snapshot.status});
    if (selectionRequest !== campaignSelectionRequest || selectedCampaign?.id !== campaignId) return false;
    selectedCampaign = { ...campaign, ...updatedCampaign };
    campaigns = campaigns.map((item) => item.id === campaignId ? selectedCampaign : item);
    renderManagementCampaigns();
    elements.memoryTitle.textContent = selectedCampaign.title;
    elements.campaignEditorSummary.textContent = `${selectedCampaign.status} · ${selectedCampaign.worldTitle} v${selectedCampaign.worldVersionNumber}${selectedCampaign.selectedCharacterName ? ` · ${selectedCampaign.selectedCharacterName}` : ""}`;
    const campaignButton = elements.campaignList.querySelector(`[data-campaign-id="${campaignId}"]`);
    if (campaignButton) {
      campaignButton.querySelector("strong").textContent = selectedCampaign.title;
      const details = campaignButton.querySelector("span");
      if (details) details.textContent = `${selectedCampaign.activeTurnNumber} accepted turns · ${selectedCampaign.worldTitle} v${selectedCampaign.worldVersionNumber}${selectedCampaign.selectedCharacterName ? ` · ${selectedCampaign.selectedCharacterName}` : ""}${selectedCampaign.worldUpdateAvailable ? " · update available" : ""}${selectedCampaign.status === "archived" ? " · archived" : ""}`;
    }
    renderDashboardCampaigns();
    campaignEditGuard.markSaved(campaignId, selectionRequest, snapshot);
    const editsRemain = campaignEditGuard.isDirty(campaignSettingsSnapshot());
    renderCampaignSaveFeedback(editsRemain ? "unsaved" : "saved");
    campaignMessage(editsRemain
      ? "Submitted campaign settings saved. Newer edits remain unsaved. Story Memory, illustrations, and Semantic Retrieval save independently."
      : "Campaign settings saved. Story Memory, illustrations, and Semantic Retrieval save independently.", "success");
    return true;
  } catch (error) {
    if (selectionRequest === campaignSelectionRequest && selectedCampaign?.id === campaignId) {
      renderCampaignSaveFeedback("error");
      const message = error?.statusCode === 409 && error?.details?.code === "active_turn_changed"
        ? "Campaign changed. Your edits are still here. Reload the campaign before saving again."
        : "Campaign settings could not be saved.";
      campaignMessage(safeWorkflowFailure(message, error), "error");
    }
    return false;
  } finally {
    campaignSaveInProgress = false;
    elements.saveCampaign.disabled = !selectedCampaign;
  }
}

function renderCampaignSaveFeedback(state) {
  const labels = {
    saved: "Campaign settings saved",
    unsaved: "Campaign settings unsaved",
    saving: "Saving campaign settings…",
    error: "Campaign settings were not saved"
  };
  elements.campaignSaveStatus.dataset.state = state;
  elements.campaignSaveStatus.textContent = labels[state] || labels.unsaved;
}

async function canLeaveCampaignEditor(nextCampaignId) {
  const allowed = await campaignEditGuard.canLeave(nextCampaignId, {
    getCurrentCampaignId: () => selectedCampaign?.id ?? null,
    getCurrentEpoch: () => campaignSelectionRequest,
    getSnapshot: campaignSettingsSnapshot,
    confirm: confirmCampaignEditDisposition,
    save: (snapshot) => saveSelectedCampaign(null, { snapshot }),
    discard: restoreCampaignSettings
  });
  if (allowed && !campaignEditGuard.isDirty(campaignSettingsSnapshot())) renderCampaignSaveFeedback("saved");
  return allowed;
}

function restoreCampaignSettings() {
  if (!selectedCampaign) return;
  elements.campaignTitle.value = selectedCampaign.title;
  elements.campaignStatus.value = selectedCampaign.status;
  elements.campaignTextProvider.value = selectedCampaign.textProviderProfileId || "";
  elements.campaignTurnControlStyle.value = normalizedTurnControlStyle(selectedCampaign.turnControlStyle);
  elements.campaignStoryLengthProfile.value = selectedCampaign.storyLengthProfile || "standard";
  elements.campaignStoryContextBudgetTokens.value = String(selectedCampaign.storyContextBudgetTokens || 32_000);
}

function confirmCampaignEditDisposition() {
  if (campaignLeavePromptOpen) return campaignLeavePrompt;
  campaignLeavePromptOpen = true;
  elements.discardChangesTitle.textContent = "Campaign settings have changed";
  elements.discardChangesDialog.querySelector('button[value="keep"]').textContent = "Stay";
  elements.discardChangesMessage.textContent = "Save these settings before leaving, discard the edits, or stay here and keep editing.";
  setCampaignSaveDecisionVisible(true);
  elements.discardChangesDialog.returnValue = "";
  openManagedModal(elements.discardChangesDialog);
  campaignLeavePrompt = new Promise((resolve) => {
    elements.discardChangesDialog.addEventListener("close", () => {
      setCampaignSaveDecisionVisible(false);
      campaignLeavePromptOpen = false;
      campaignLeavePrompt = null;
      resolve(elements.discardChangesDialog.returnValue === "save" ? "save" : elements.discardChangesDialog.returnValue === "discard" ? "discard" : "stay");
elements.discardChangesTitle.textContent = "Discard unsaved changes?";
      elements.discardChangesDialog.querySelector('button[value="keep"]').textContent = "Keep editing";
      elements.discardChangesMessage.textContent = "Your edits have not been saved. Keep editing or discard them and close this window.";
    }, { once: true });
  });
  return campaignLeavePrompt;
}

async function migrateSelectedCampaign() {
  if (!selectedCampaign) return;
  const campaign = selectedCampaign;
  const campaignId = campaign.id;
  const worldId = campaign.worldId;
  const selectionRequest = campaignSelectionRequest;
  const campaignWorldVersionId = campaign.worldVersionId;
  const campaignWorldVersionNumber = campaign.worldVersionNumber;
  const targetId = elements.campaignWorldVersion.value;
  const detailRequest = getDashboardWorldDetails(worldId);
  const requestEpoch = dashboardWorldDetailRequestEpochs.get(worldId);
  const isCurrentCampaign = () => selectionRequest === campaignSelectionRequest
    && selectedCampaign?.id === campaignId
    && selectedCampaign?.worldId === worldId
    && selectedCampaign?.worldVersionId === campaignWorldVersionId
    && selectedCampaign?.worldVersionNumber === campaignWorldVersionNumber;
  const isCurrentIntent = () => isCurrentCampaign()
    && elements.campaignWorldVersion.value === targetId
    && isDashboardWorldDetailRequestCurrent(worldId, requestEpoch);
  const world = await detailRequest;
  if (!isCurrentIntent()) return;
  const target = world.versions.find((version) => version.id === targetId);
  if (!target || target.versionNumber <= campaignWorldVersionNumber) {
    campaignMessage("Select a newer published version before migrating.", "error");
    return;
  }
  if (!window.confirm(`Migrate this campaign from world version ${campaignWorldVersionNumber} to version ${target.versionNumber}? Accepted turns will remain append-only.`)) return;
  if (!isCurrentIntent()) return;
  elements.migrateCampaign.disabled = true;
  try {
    await api(`/api/v1/campaigns/${campaignId}/migrate-world`, {
      method: "POST",
      body: JSON.stringify({ worldVersionId: target.id, note: "Explicit migration from the World Library interface." })
    });
    if (!isCurrentCampaign()) return;
    await loadCampaigns(campaignId, { selectionRequest });
    if (selectedCampaign?.id !== campaignId || selectedCampaign?.worldId !== worldId) return;
    campaignMessage(`Campaign migrated to world version ${target.versionNumber}. The next generation will bootstrap a fresh model chain from database state.`, "success");
  } catch (error) {
    if (isCurrentIntent()) campaignMessage(error.message || String(error), "error");
  }
}
function transferRequest() {
  return {
    targetWorldVersionId: elements.transferTargetVersion.value,
    title: elements.transferCampaignTitle.value.trim(),
    characterStrategy: "preserve_source",
    stateStrategy: "preserve",
    targetDefaultsPolicy: "retain_source"
  };
}

function resetTransferPreview(message = "Choose a target world and version to check compatibility.") {
  transferPreview = null;
  elements.transferPreviewSummary.textContent = message;
  elements.transferPreviewSummary.className = "status";
  elements.transferFindings.replaceChildren();
  elements.transferWarningAcknowledgement.checked = false;
  elements.transferWarningAcknowledgementField.classList.add("hidden");
  elements.confirmTransferCampaign.disabled = true;
}

function renderTransferPreview(preview) {
  const findings = Array.isArray(preview.findings) ? preview.findings : [];
  const blocking = findings.filter((finding) => finding.severity === "blocking");
  const warnings = findings.filter((finding) => finding.severity === "warning");
  const counts = preview.counts || {};
  const countParts = [
    Number.isFinite(Number(counts.turns ?? preview.turnCount)) ? `${number(counts.turns ?? preview.turnCount)} accepted turns` : "",
    Number.isFinite(Number(counts.assets ?? preview.assetCount)) ? `${number(counts.assets ?? preview.assetCount)} asset references` : "",
    Number.isFinite(Number(counts.summaries ?? preview.summaryCount)) ? `${number(counts.summaries ?? preview.summaryCount)} summaries` : ""
  ].filter(Boolean);
  elements.transferPreviewSummary.textContent = blocking.length
    ? `Transfer blocked by ${number(blocking.length)} compatibility issue${blocking.length === 1 ? "" : "s"}.`
    : `Ready to create an independent copy${countParts.length ? ` with ${countParts.join(", ")}` : ""}.`;
  elements.transferPreviewSummary.className = `status ${blocking.length ? "error" : "success"}`;
  elements.transferFindings.replaceChildren(...findings.map((finding) => {
    const item = document.createElement("li");
    item.className = "transfer-finding";
    item.dataset.severity = finding.severity || "info";
    item.textContent = finding.message || finding.code || "Compatibility finding";
    return item;
  }));
  elements.transferWarningAcknowledgementField.classList.toggle("hidden", !warnings.length || !!blocking.length);
  elements.transferWarningAcknowledgement.checked = false;
  elements.confirmTransferCampaign.disabled = !!blocking.length || !!warnings.length || preview.allowed === false;
}

async function previewCampaignTransfer() {
  const sequence = ++transferPreviewSequence;
  if (!selectedCampaign || !elements.transferTargetVersion.value || !elements.transferCampaignTitle.value.trim()) {
    resetTransferPreview();
    return;
  }
  resetTransferPreview("Checking target-world compatibility…");
  try {
    const preview = await api(`/api/v1/campaigns/${selectedCampaign.id}/transfer-world/preview`, {
      method: "POST",
      body: JSON.stringify(transferRequest())
    });
    if (sequence !== transferPreviewSequence || !elements.transferCampaignDialog.open) return;
    transferPreview = preview;
    renderTransferPreview(preview);
  } catch (error) {
    if (sequence !== transferPreviewSequence) return;
    elements.transferPreviewSummary.textContent = error.message || String(error);
    elements.transferPreviewSummary.className = "status error";
  }
}

async function loadTransferTargetVersions() {
  const sequence = ++transferTargetVersionsRequestEpoch;
  const worldId = elements.transferTargetWorld.value;
  resetTransferPreview(worldId ? "Loading published versions…" : undefined);
  elements.transferTargetVersion.replaceChildren(new Option(worldId ? "Loading published versions…" : "Select a target world first", ""));
  elements.transferTargetVersion.disabled = true;
  if (!worldId) return;
  const detailRequest = getDashboardWorldDetails(worldId);
  const requestEpoch = dashboardWorldDetailRequestEpochs.get(worldId);
  const isCurrentRequest = () => sequence === transferTargetVersionsRequestEpoch
    && worldId === elements.transferTargetWorld.value
    && isDashboardWorldDetailRequestCurrent(worldId, requestEpoch);
  try {
    const world = await detailRequest;
    if (!isCurrentRequest()) return;
    elements.transferTargetVersion.replaceChildren(new Option("Select a published version", ""));
    for (const version of [...(world.versions || [])].reverse()) {
      elements.transferTargetVersion.append(new Option(`Version ${version.versionNumber}${version.releaseNotes ? ` · ${version.releaseNotes}` : ""}`, version.id));
    }
    elements.transferTargetVersion.disabled = !(world.versions || []).length;
    resetTransferPreview((world.versions || []).length ? undefined : "This world has no published version available for transfer.");
  } catch (error) {
    if (!isCurrentRequest()) return;
    resetTransferPreview(error.message || String(error));
    elements.transferPreviewSummary.className = "status error";
  }
}
async function openCampaignTransfer() {
  if (!selectedCampaign) return;
  transferIdempotencyKey = crypto.randomUUID();
  elements.transferCampaignSource.replaceChildren();
  const sourceTitle = document.createElement("strong");
  sourceTitle.textContent = selectedCampaign.title;
  const sourceDetail = document.createElement("span");
  sourceDetail.textContent = `${selectedCampaign.worldTitle} · version ${selectedCampaign.worldVersionNumber} · ${number(selectedCampaign.activeTurnNumber)} accepted turns`;
  elements.transferCampaignSource.append(sourceTitle, sourceDetail);
  elements.transferCampaignTitle.value = `${selectedCampaign.title} — transferred`;
  elements.transferTargetWorld.replaceChildren(new Option("Select another world", ""));
  for (const world of worlds.filter((world) => world.id !== selectedCampaign.worldId && world.status !== "archived" && world.latestVersionNumber)) {
    elements.transferTargetWorld.append(new Option(`${world.title} · version ${world.latestVersionNumber}`, world.id));
  }
  elements.transferTargetVersion.replaceChildren(new Option("Select a target world first", ""));
  elements.transferTargetVersion.disabled = true;
  resetTransferPreview(worlds.some((world) => world.id !== selectedCampaign.worldId && world.status !== "archived" && world.latestVersionNumber)
    ? undefined
    : "No other active world has a published version available.");
  openManagedModal(elements.transferCampaignDialog);
}

async function commitCampaignTransfer(event) {
  event.preventDefault();
  if (!selectedCampaign || !transferPreview) return;
  const sourceCampaignId = selectedCampaign.id;
  const worldSelectionIntentEpochAtStart = worldSelectionIntentEpoch;
  elements.confirmTransferCampaign.disabled = true;
  elements.cancelTransferCampaign.disabled = true;
  elements.transferPreviewSummary.textContent = "Creating the transferred campaign and rebuilding Chronicle…";
  elements.transferPreviewSummary.className = "status";
  try {
    const result = await api(`/api/v1/campaigns/${sourceCampaignId}/transfer-world`, {
      method: "POST",
      body: JSON.stringify({
        ...transferRequest(),
        idempotencyKey: transferIdempotencyKey,
        expectedActiveTurnNumber: transferPreview.expectedActiveTurnNumber,
        expectedStateRevision: transferPreview.expectedStateRevision,
        sourceFingerprint: transferPreview.sourceFingerprint,
        note: "Explicit cross-world transfer from Campaign Management."
      })
    });
    elements.transferCampaignDialog.close();
    await Promise.all([
      loadWorlds("", { selectionIntentEpoch: worldSelectionIntentEpochAtStart }),
      loadCampaigns(result.targetCampaignId, { explicitPreselect: true })
    ]);
    campaignMessage("Transferred campaign created and selected. Review it before separately archiving the original campaign; the original remains unchanged.", "success");
  } catch (error) {
    elements.transferPreviewSummary.textContent = error.statusCode === 409
      ? `${error.message || "The source campaign changed."} Preview compatibility again before retrying.`
      : error.message || String(error);
    elements.transferPreviewSummary.className = "status error";
    transferPreview = null;
  } finally {
    elements.cancelTransferCampaign.disabled = false;
    elements.confirmTransferCampaign.disabled = !transferPreview;
  }
}

async function exportSelectedCampaign() {
  if (!selectedCampaign) return;
  try {
    await downloadJson(`/api/v1/campaigns/${selectedCampaign.id}/export`, "infinite-quest-campaign.zip");
    campaignMessage("Campaign Archive exported with the exact attached world and associated original images; provider profiles and credentials are excluded.", "success");
  } catch (error) {
    campaignMessage(error.message || String(error), "error");
  }
}

async function loadSelectedCampaign() {
  if (!selectedCampaign || !(await canLeaveCampaignEditor(null))) return;
  window.location.assign("/story/" + encodeURIComponent(selectedCampaign.id));
}

async function deleteSelectedCampaign() {
  if (!selectedCampaign) return;
  const campaignId = selectedCampaign.id;
  const expectedTitle = selectedCampaign.title;
  const worldSelectionIntentEpochAtStart = worldSelectionIntentEpoch;
  const confirmed = await requestTypedDelete(expectedTitle, `This permanently deletes “${expectedTitle}”, its accepted turns, Chronicle memory, and generated asset records. This cannot be undone.`);
  if (!confirmed) return;
  elements.deleteCampaign.disabled = true;
  try {
    await api(`/api/v1/campaigns/${campaignId}`, {
      method: "DELETE",
      body: JSON.stringify({ confirmation: "DELETE", expectedTitle })
    });
    campaignSelectionRequest += 1;
    selectedCampaign = null;
    selectedCampaignIsExplicit = false;
    updateStoryViewLink();
    await loadCampaigns("", { focusNoSelection: true });
    await loadWorlds("", { selectionIntentEpoch: worldSelectionIntentEpochAtStart });
  } catch (error) {
    campaignMessage(error.message || String(error), "error");
    elements.deleteCampaign.disabled = !selectedCampaign;
  }
}

function semanticRetrievalHealthView(health) {
  const labels = {
    chronicle_available: "Chronicle available",
    semantic_disabled: "Semantic Retrieval off",
    indexing: "Indexing",
    healthy: "Ready",
    partially_indexed: "Partially indexed",
    provider_degraded: "Provider degraded",
    provider_unavailable: "Provider unavailable",
    fallback_active: "Fallback active",
    chunk_protocol_outdated: "Chunk protocol outdated",
    rebuild_required: "Rebuild required"
  };
  const status = typeof health?.status === "string" && Object.hasOwn(labels, health.status) ? health.status : "";
  const coverageValue = Number(health?.coveragePercent);
  const coveragePercent = Number.isFinite(coverageValue) ? Math.min(100, Math.max(0, Math.round(coverageValue))) : null;
  const implementationLabels = {
    legacy_hybrid: "Legacy hybrid",
    chunked_hybrid: "Chunked hybrid"
  };
  const implementation = typeof health?.retrievalImplementation === "string"
    ? implementationLabels[health.retrievalImplementation]
    : undefined;
  const shadow = typeof health?.retrievalShadowEnabled === "boolean"
    ? health.retrievalShadowEnabled ? "On" : "Off"
    : "Unavailable";
  const fallbackCode = typeof health?.fallbackCode === "string" && /^[a-z0-9][a-z0-9_.:-]{0,199}$/u.test(health.fallbackCode)
    ? health.fallbackCode.replace(/[_:.-]+/gu, " ")
    : health?.fallbackCode ? "Unavailable" : "None";
  const jobStatuses = { queued: "Queued", running: "Running", completed: "Completed", failed: "Failed" };
  const jobStatus = typeof health?.jobStatus === "string" && Object.hasOwn(jobStatuses, health.jobStatus)
    ? jobStatuses[health.jobStatus]
    : "No active job";
  const progress = health?.progress && typeof health.progress === "object" ? health.progress : {};
  const processedParents = Number(progress.processedParents ?? progress.embedded);
  const totalParents = Number(progress.totalParents ?? progress.total);
  const embeddedChunks = Number(progress.embeddedChunks);
  const skippedChunks = Number(progress.skippedChunks);
  const skippedMemories = Number(progress.skipped);
  const progressParts = [];
  if (Number.isFinite(processedParents) && Number.isFinite(totalParents) && totalParents >= 0) {
    progressParts.push(`${Math.max(0, processedParents)} of ${Math.max(0, totalParents)} memories`);
  }
  if (Number.isFinite(embeddedChunks) || Number.isFinite(skippedChunks)) {
    progressParts.push(`${Math.max(0, Number.isFinite(embeddedChunks) ? embeddedChunks : 0)} embedded chunks · ${Math.max(0, Number.isFinite(skippedChunks) ? skippedChunks : 0)} skipped`);
  } else if (Number.isFinite(skippedMemories)) {
    progressParts.push(`${Math.max(0, skippedMemories)} skipped`);
  }
  return {
    status,
    label: status ? labels[status] : "Status unavailable",
    coverageLabel: coveragePercent === null ? "Coverage unavailable" : `${coveragePercent}% compatible vector coverage`,
    productionLabel: `Production · ${implementation || "Unavailable"}`,
    shadowLabel: `Shadow comparison · ${shadow}`,
    fallbackLabel: fallbackCode,
    jobLabel: progressParts.length ? `${jobStatus} · ${progressParts.join(" · ")}` : jobStatus
  };
}

function renderSemanticMemoryHealth(health) {
  const view = semanticRetrievalHealthView(health);
  if (view.status) elements.semanticMemoryHealth.dataset.state = view.status;
  else delete elements.semanticMemoryHealth.dataset.state;
  elements.semanticMemoryHealthBadge.textContent = view.label;
  elements.semanticMemoryHealthTitle.textContent = view.label;
  const provider = health?.providerName ? ` Provider: ${health.providerName}${health.model ? ` · ${health.model}` : ""}.` : "";
  elements.semanticMemoryHealthMessage.textContent = `${health?.message || "Semantic Retrieval status is unavailable."}${provider}`;
  const details = [
    ["Coverage", view.coverageLabel],
    ["Production", view.productionLabel.replace("Production · ", "")],
    ["Shadow comparison", view.shadowLabel.replace("Shadow comparison · ", "")],
    ["Index job", view.jobLabel]
  ];
  if (health?.fallbackCode) details.push(["Fallback reason", view.fallbackLabel]);
  elements.semanticMemoryHealthDetails.replaceChildren(...details.map(([label, value]) => {
    const wrapper = document.createElement("div");
    const term = document.createElement("dt");
    const description = document.createElement("dd");
    term.textContent = label;
    description.textContent = value;
    wrapper.append(term, description);
    return wrapper;
  }));
}

async function refreshCampaignMemoryMetrics(selectionRequest = campaignSelectionRequest, signal) {
  if (!selectedCampaign) return null;
  const campaignId = selectedCampaign.id;
  const metrics = await api(`/api/v1/campaigns/${campaignId}/memory/metrics`, { signal });
  if (signal?.aborted || selectionRequest !== campaignSelectionRequest || selectedCampaign?.id !== campaignId) return null;
  elements.memoryMetrics.innerHTML = [
    [number(metrics.turns), "accepted turns"],
    [number(metrics.estimatedCompleteHistoryTokens), "complete-history tokens"],
    [number(metrics.memoryCount), "Chronicle memories"],
    [number(metrics.semanticHealth?.indexedMemories ?? metrics.embeddedMemories), "current embeddings"]
  ].map(([value, label]) => `<div class="metric"><strong>${value}</strong><span>${label}</span></div>`).join("");
  renderSemanticMemoryHealth(metrics.semanticHealth);
  return metrics;
}

function appendCostMetric(value, label) {
  const metric = document.createElement("div");
  metric.className = "cost-metric";
  const strong = document.createElement("strong");
  strong.textContent = value;
  const span = document.createElement("span");
  span.textContent = label;
  metric.append(strong, span);
  elements.campaignCostMetrics.append(metric);
}

async function refreshCampaignCostSummary(selectionRequest = campaignSelectionRequest, signal) {
  if (!selectedCampaign) {
    elements.campaignCostSection.classList.add("hidden");
    return null;
  }
  const campaignId = selectedCampaign.id;
  const summary = await api(`/api/v1/campaigns/${campaignId}/cost-summary`, { signal });
  if (signal?.aborted || selectionRequest !== campaignSelectionRequest || selectedCampaign?.id !== campaignId) return null;
  elements.campaignCostSection.classList.remove("hidden");
  elements.campaignCostMetrics.replaceChildren();
  if (!summary.hasReportedCosts || !Array.isArray(summary.totals) || !summary.totals.length) {
    elements.campaignCostMessage.textContent = "No provider-reported cost data is available. Local or unsupported providers are not recorded as zero-cost calls.";
    return summary;
  }
  elements.campaignCostMessage.textContent = "Actual charges reported by configured providers since campaign cost tracking was enabled.";
  for (const total of summary.totals) {
    const suffix = summary.totals.length > 1 ? ` (${total.currency})` : "";
    appendCostMetric(money(total.amount, total.currency), `campaign total${suffix}`);
    appendCostMetric(money(total.byCategory?.story || 0, total.currency), `text generation${suffix}`);
    appendCostMetric(money(total.byCategory?.image || 0, total.currency), `image generation${suffix}`);
    appendCostMetric(money(total.byCategory?.memory || 0, total.currency), `Semantic retrieval${suffix}`);
    appendCostMetric(money(total.historicalAndUnattributedOperations || total.otherCampaignOperations || 0, total.currency), `historical & unattributed operations${suffix}`);
  }
  return summary;
}

async function loadEmbeddingConfig(selectionRequest = campaignSelectionRequest, signal) {
  if (!selectedCampaign) return;
  const campaignId = selectedCampaign.id;
  const config = await api(`/api/v1/campaigns/${campaignId}/memory/embedding-config`, { signal });
  if (signal?.aborted || selectionRequest !== campaignSelectionRequest || selectedCampaign?.id !== campaignId) return;
  embeddingConfig = config;
  discoveredEmbeddingModels = [];
  elements.embeddingEnabled.checked = embeddingConfig.enabled;
  elements.embeddingRetrievalImplementation.value = embeddingConfig.retrievalImplementation;
  elements.embeddingRetrievalShadowEnabled.checked = embeddingConfig.retrievalShadowEnabled;
  populateEmbeddingProviderSelect();
  elements.embeddingModel.value = embeddingConfig.model ?? "";
  elements.embeddingDocumentPrefix.value = embeddingConfig.documentPrefix ?? "";
  elements.embeddingQueryPrefix.value = embeddingConfig.queryPrefix ?? "";
  elements.embeddingBatchSize.value = String(embeddingConfig.batchSize ?? "");
  elements.reindexEmbeddings.disabled = !embeddingConfig.enabled;
  elements.discoverEmbeddingModels.disabled = !elements.embeddingProvider.value;
  elements.embeddingModel.disabled = !elements.embeddingProvider.value;
  const embeddingProvider = providers.find((provider) => provider.id === elements.embeddingProvider.value);
  const fallbackLabel = embeddingProvider?.providerRole === "text" ? `text provider ${embeddingProvider.name}` : embeddingProvider?.name;
  elements.embeddingStatus.className = "status";
  elements.embeddingStatus.textContent = embeddingConfig.enabled
    ? `Semantic Retrieval is enabled with ${fallbackLabel || "the selected provider"} and ${embeddingConfig.model}. Effective task prefixes: document “${embeddingConfig.effectiveDocumentPrefix || "none"}”, query “${embeddingConfig.effectiveQueryPrefix || "none"}”. New accepted memories are indexed by a durable worker job.`
    : `Semantic Retrieval is off for this campaign. Chronicle local memory remains available when semantic retrieval is off.`;
  return embeddingConfig;
}

async function loadIllustrationConfig(selectionRequest = campaignSelectionRequest, signal) {
  if (!selectedCampaign) return;
  const campaignId = selectedCampaign.id;
  const config = await api(`/api/v1/campaigns/${campaignId}/illustration-config`, { signal });
  if (signal?.aborted || selectionRequest !== campaignSelectionRequest || selectedCampaign?.id !== campaignId) return;
  illustrationConfig = config;
  elements.campaignImageProvider.value = config.providerProfileId || "";
  elements.illustrationSourcePolicy.value = illustrationConfig.sourcePolicy || (illustrationConfig.enabled ? "generate_only" : "off");
  elements.illustrationMatchingScope.value = illustrationConfig.matchingScope || "world";
  elements.illustrationConfidenceProfile.value = illustrationConfig.confidenceProfile || "balanced";
  elements.illustrationRepetitionWindow.value = String(illustrationConfig.repetitionWindow ?? 5);
  elements.illustrationModel.value = illustrationConfig.model || "";
  elements.illustrationSize.value = illustrationConfig.size || "1024x1024";
  elements.illustrationAspectRatio.value = illustrationConfig.aspectRatio || "1:1";
  elements.illustrationQuality.value = illustrationConfig.quality || "auto";
  elements.illustrationOutputFormat.value = illustrationConfig.outputFormat || "png";
  elements.illustrationMaxAttempts.value = String(illustrationConfig.maxAttempts || 3);
  elements.illustrationSegmentWordCount.value = String(illustrationConfig.segmentWordCount || 500);
  const defaultImageCount = effectiveCampaignProvider("image")?.configuration?.defaultImageCount || 1;
  elements.illustrationImagesPerSegment.value = String(
    illustrationConfig.updatedAt ? illustrationConfig.imagesPerSegment || 1 : defaultImageCount
  );
  elements.illustrationSegmentPromptMode.value = illustrationConfig.segmentPromptMode || "direct";
  elements.illustrationArtStyle.value = illustrationConfig.artStyle || "";
  elements.illustrationNegativePrompt.value = illustrationConfig.negativePrompt ?? illustrationConfig.defaultNegativePrompt ?? "";
  defaultIllustrationRefinementPrompt = illustrationConfig.defaultRefinementPrompt || illustrationConfig.refinementPrompt || "";
  illustrationRefinementPromptValue = illustrationConfig.refinementPrompt || defaultIllustrationRefinementPrompt;
  syncIllustrationProviderAvailability(true);
  const provider = effectiveCampaignProvider("image");
  elements.campaignImageProviderSummary.textContent = provider
    ? elements.campaignImageProvider.value ? `Segment image provider: ${provider.name}.` : "Choose a segment provider for automatic generation. Manage the separate direct image assignment in Campaign settings."
    : enabledProviders("image").length
      ? "Select an image provider for this campaign before enabling illustrations."
      : "Add and enable an illustration provider in Provider Management before images can be enabled.";
  const policy = elements.illustrationSourcePolicy.value;
  elements.illustrationStatus.textContent = policy === "off"
    ? "Illustrations are disabled for this campaign. Story generation is unaffected."
    : policy === "library_only"
      ? `Library only; ${illustrationConfig.matchingScope || "world"}; ${illustrationConfig.confidenceProfile || "balanced"} matching. No image provider is required.`
      : provider
        ? `${policy === "library_then_generate" ? "Try the library first, then generate" : "Generate"} with ${illustrationConfig.model}. Endpoint health: ${providers.find((item) => item.id === illustrationConfig.providerProfileId)?.healthStatus || "unknown"}.`
        : "The saved policy requires fallback generation, but no enabled image provider is currently available. Story generation remains unaffected.";
  return illustrationConfig;
}

function illustrationPolicyUsesLibrary(policy = elements.illustrationSourcePolicy.value) {
  return policy === "library_only" || policy === "library_then_generate";
}

function illustrationPolicyUsesProvider(policy = elements.illustrationSourcePolicy.value) {
  return policy === "library_then_generate" || policy === "generate_only";
}

function openIllustrationPromptEditor() {
  if (selectedCampaign) window.location.assign(`/app/settings?section=prompts&campaignId=${encodeURIComponent(selectedCampaign.id)}&prompt=illustration_refinement`);
}

function renderIllustrationSettingsVisibility() {
  const policy = elements.illustrationSourcePolicy.value;
  const settingsVisible = Boolean(selectedCampaign);
  const automaticIllustrationsActive = policy !== "off";
  elements.illustrationSettings.classList.toggle("hidden", !settingsVisible);
  elements.illustrationSettings.setAttribute("aria-hidden", String(!settingsVisible));
  elements.illustrationMatchingSettings.classList.toggle("hidden", !automaticIllustrationsActive || !illustrationPolicyUsesLibrary(policy));
  elements.illustrationProviderSettings.classList.toggle("hidden", !automaticIllustrationsActive || !illustrationPolicyUsesProvider(policy));
  // Style applies only to images this campaign generates, not library matches.
  elements.illustrationStyleSettings.classList.toggle("hidden", !automaticIllustrationsActive || !illustrationPolicyUsesProvider(policy));
  const useRefinementPrompt = settingsVisible && elements.illustrationSegmentPromptMode.value === "ai_refined";
  elements.illustrationRefinementPromptField.classList.toggle("hidden", !useRefinementPrompt);
  elements.previewIllustrationBackfill.disabled = !selectedCampaign || !automaticIllustrationsActive;
  elements.previewIllustrationRebuild.disabled = !selectedCampaign || !automaticIllustrationsActive;
}

function syncIllustrationProviderAvailability(restoreSavedState = false) {
  const hasImageProvider = enabledProviders("image").length > 0;
  if (restoreSavedState) elements.illustrationSourcePolicy.value = illustrationConfig?.sourcePolicy || (illustrationConfig?.enabled ? "generate_only" : "off");
  elements.illustrationSourcePolicy.disabled = !selectedCampaign;
  for (const option of elements.illustrationSourcePolicy.options) {
    option.disabled = !hasImageProvider && ["library_then_generate", "generate_only"].includes(option.value)
      && option.value !== elements.illustrationSourcePolicy.value;
  }
  elements.campaignImageProvider.disabled = !selectedCampaign || !hasImageProvider;
  elements.discoverIllustrationModels.disabled = !selectedCampaign || !effectiveCampaignProvider("image");
  elements.illustrationSegmentWordCount.disabled = !selectedCampaign;
  elements.illustrationImagesPerSegment.disabled = !selectedCampaign;
  elements.illustrationSegmentPromptMode.disabled = !selectedCampaign;
  elements.openIllustrationPromptEditor.disabled = !selectedCampaign || elements.illustrationSegmentPromptMode.value !== "ai_refined";
  renderIllustrationSettingsVisibility();
}

function providerMessage(message, type = "") {
  const pendingReadFailure = dashboardWorkflowErrors.get("providers");
  delete elements.providerStatus.dataset.workflowReadFailure;
  elements.providerStatus.querySelector("#workflowRetryProviders")?.remove();
  elements.providerStatus.textContent = message;
  elements.providerStatus.className = `status ${type}`.trim();
  if (pendingReadFailure) setWorkflowReadFailure(elements.providerStatus, "providers", pendingReadFailure.message, "workflowRetryProviders", "Retry provider profiles", () => retryProviderWorkflowRead());
}

function providerTypeLabel(providerType) {
  return providerType === "sogni" ? "Sogni Creative Workflow (REST)"
    : providerType === "sogni_sdk" ? "Sogni Supernet SDK"
      : providerType;
}

function enabledProviders(role) {
  return providers.filter((provider) => provider.providerRole === role && provider.enabled);
}

function defaultProvider(role) {
  const available = enabledProviders(role);
  const explicit = available.find((provider) => provider.isDefault);
  return explicit || (role !== "intent" && available.length === 1 ? available[0] : null);
}

function effectiveCampaignProvider(role) {
  const select = role === "text" ? elements.campaignTextProvider : elements.campaignImageProvider;
  const storedId = role === "text" ? selectedCampaign?.textProviderProfileId : selectedCampaign?.imageProviderProfileId;
  const selectedId = selectedCampaign && !select.disabled ? select.value : storedId;
  return enabledProviders(role).find((provider) => provider.id === selectedId) || defaultProvider(role);
}

function populateProviderSelect(select, role, label) {
  const current = select.value;
  const available = enabledProviders(role);
  const fallback = defaultProvider(role);
  const emptyLabel = role === "image" ? "No segment override" : fallback
    ? `Use default · ${fallback.name}`
    : available.length
      ? `Select a ${label} provider`
      : `No enabled ${label} providers`;
  select.replaceChildren(new Option(emptyLabel, ""));
  for (const provider of available) {
    select.append(new Option(`${provider.name} · ${providerTypeLabel(provider.providerType)}${provider.isDefault ? " · default" : ""}`, provider.id));
  }
  select.value = available.some((provider) => provider.id === current) ? current : "";
}

function populateEmbeddingProviderSelect() {
  const current = embeddingConfig?.providerProfileId || elements.embeddingProvider.value;
  const configuredProvider = current ? providers.find((provider) => provider.id === current) : null;
  const configuredTextProvider = configuredProvider?.providerRole === "text" ? configuredProvider : null;
  const embeddingProviders = enabledProviders("embedding");
  elements.embeddingProvider.replaceChildren();
  const showIncompatibleProvider = (eligibleProviders, role) => {
    const eligiblePlaceholder = new Option("Choose an eligible embedding provider", "", true, true);
    eligiblePlaceholder.disabled = true;
    const configuredLabel = configuredTextProvider
      ? `Configured text provider is no longer eligible · ${configuredTextProvider.name}`
      : configuredProvider
        ? `Configured provider is no longer eligible · ${configuredProvider.name}`
        : "Configured provider is no longer available";
    const configuredOption = new Option(configuredLabel, current);
    configuredOption.disabled = true;
    elements.embeddingProvider.append(eligiblePlaceholder, configuredOption);
    for (const provider of eligibleProviders) {
      const prefix = role === "text" ? "Text fallback · " : "";
      elements.embeddingProvider.append(new Option(`${prefix}${provider.name} · ${providerTypeLabel(provider.providerType)}${provider.isDefault ? " · default" : ""}`, provider.id));
    }
    elements.embeddingProvider.value = "";
  };
  if (embeddingProviders.length) {
    if (current && !embeddingProviders.some((provider) => provider.id === current)) {
      showIncompatibleProvider(embeddingProviders, "embedding");
      return;
    }
    const fallback = defaultProvider("embedding");
    elements.embeddingProvider.append(new Option(fallback ? `Use default · ${fallback.name}` : "Select an embedding provider", ""));
    for (const provider of embeddingProviders) {
      elements.embeddingProvider.append(new Option(`${provider.name} · ${providerTypeLabel(provider.providerType)}${provider.isDefault ? " · default" : ""}`, provider.id));
    }
    elements.embeddingProvider.value = embeddingProviders.some((provider) => provider.id === current) ? current : (fallback?.id || "");
    return;
  }
  const textProviders = enabledProviders("text");
  const selectedTextProvider = textProviders.find((provider) => provider.id === current);
  if (current && !selectedTextProvider) {
    showIncompatibleProvider(textProviders, "text");
    return;
  }
  const textFallback = selectedTextProvider || effectiveCampaignProvider("text");
  if (textFallback) {
    elements.embeddingProvider.append(new Option(`Text fallback · ${textFallback.name} · ${textFallback.providerType}`, textFallback.id));
    elements.embeddingProvider.value = textFallback.id;
  } else {
    elements.embeddingProvider.append(new Option("No text or embedding provider configured", ""));
  }
}

async function loadProviders(preselectId = "", { preserveWorkflowFeedback = false } = {}) {
  ({ providers } = await api("/api/v1/providers"));
  clearDashboardWorkflowError("providers");
  clearWorkflowReadFailure(elements.providerStatus, "providers", "workflowRetryProviders");
  updateCharacterGeneratorAvailability();
  const currentImportProviderId = elements.providerSelect.value;
  elements.providerSelect.replaceChildren(new Option(defaultProvider("text") ? `Use default · ${defaultProvider("text").name}` : "Use the default text provider", ""));
  for (const provider of providers.filter((item) => item.providerRole === "text" && item.enabled)) {
    elements.providerSelect.append(new Option(`${provider.name} · ${providerTypeLabel(provider.providerType)}${provider.isDefault ? " · default" : ""}`, provider.id));
  }
  populateProviderSelect(elements.campaignTextProvider, "text", "text");
  populateProviderSelect(elements.campaignImageProvider, "image", "image");
  const target = providers.find((provider) => provider.id === preselectId && provider.providerRole === "text" && provider.enabled)
    || providers.find((provider) => provider.id === currentImportProviderId && provider.providerRole === "text" && provider.enabled)
    || defaultProvider("text")
    || null;
  elements.providerSelect.value = target && target.id !== defaultProvider("text")?.id ? target.id : "";
  selectedProvider = target;
  elements.discoverModels.disabled = !target;
  if (target && !preserveWorkflowFeedback) {
    providerMessage(`${target.name} selected. Profile context is ${number(target.contextWindowTokens)} tokens; maximum output is ${number(target.maxOutputTokens)} tokens.`);
  }
  if (selectedCampaign) {
    elements.campaignTextProvider.value = selectedCampaign.textProviderProfileId || "";
    syncIllustrationProviderAvailability(true);
  }
  populateEmbeddingProviderSelect();
}

function profileModelValue(model) {
  return String(model?.loaded ? model.instanceId || model.id : model?.id || "");
}

function chooseProviderModel(value) {
  elements.embeddingModel.value = value;
  const model = discoveredEmbeddingModels.find(item => profileModelValue(item) === value || item.id === value);
  elements.providerModelDialog.close();
  elements.embeddingStatus.className = "status";
  elements.embeddingStatus.textContent = `${value} selected for campaign embeddings. Save & index to apply this change${model?.contextLength ? `; its advertised ${number(model.contextLength)}-token limit applies only to embedding requests` : ""}.`;
}

function renderProviderModelPicker() {
  const query = elements.providerModelFilter.value.trim().toLowerCase();
  const discoveredModels = discoveredEmbeddingModels;
  const selectedValue = elements.embeddingModel.value.trim();
  const orderedModels = [...discoveredModels]
    .sort((left, right) => Number(right.loaded) - Number(left.loaded) || left.displayName.localeCompare(right.displayName))
    .filter((model) => !query || `${model.displayName} ${model.id} ${model.instanceId}`.toLowerCase().includes(query));
  elements.providerModelPickerList.replaceChildren();
  for (const model of orderedModels) {
    const value = profileModelValue(model);
    const button = document.createElement("button");
    button.type = "button";
    button.className = `provider-model-choice${selectedValue === value || selectedValue === model.id ? " selected" : ""}`;
    const details = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = model.displayName;
    const meta = document.createElement("span");
    meta.className = "model-meta";
    const pricing = modelPricingLabel(model);
    const capability = model.pricing?.category === "image"
      ? "image generation"
      : model.contextLength ? `${number(model.contextLength)} context` : "context not advertised";
    meta.textContent = `${value} · ${capability}${pricing ? ` · ${pricing}` : ""}`;
    details.append(name, meta);
    const state = document.createElement("span");
    state.className = `provider-model-state${model.loaded ? " active" : ""}`;
    state.textContent = model.loaded ? "Active" : "Not active";
    button.append(details, state);
    button.addEventListener("click", () => chooseProviderModel(value));
    elements.providerModelPickerList.append(button);
  }
  if (!orderedModels.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = discoveredModels.length ? "No models match this filter." : "No endpoint models are available. Refresh the endpoint or enter a custom model ID.";
    elements.providerModelPickerList.append(empty);
  }
}

async function openEmbeddingModelPicker(forceRefresh = false) {
  const provider = providers.find((item) => item.id === elements.embeddingProvider.value);
  if (!provider) {
    elements.embeddingStatus.className = "status error";
    elements.embeddingStatus.textContent = "Select an embedding provider before choosing its model.";
    return;
  }

  elements.providerModelDialogTitle.textContent = "Choose campaign embedding model";
  elements.providerModelDialogDescription.textContent = `Models advertised by ${provider.name}. Active models appear first; confirm that the selected model supports embeddings.`;
  elements.providerModelFilter.value = "";
  elements.providerCustomModel.value = elements.embeddingModel.value;
  elements.providerModelPickerStatus.textContent = discoveredEmbeddingModels.length
    ? `${discoveredEmbeddingModels.length} cached model entries for ${provider.name}. Refresh the endpoint to update this inventory.`
    : `Refresh ${provider.name} to browse its model inventory.`;
  elements.providerModelPickerStatus.className = "status";
  openManagedModal(elements.providerModelDialog);
  renderProviderModelPicker();
  if (forceRefresh || !discoveredEmbeddingModels.length) await discoverEmbeddingModels();
  elements.providerModelFilter.focus();
}

function applyCustomProviderModel() {
  const value = elements.providerCustomModel.value.trim();
  if (!value) return;
  chooseProviderModel(value);
}

async function discoverProviderModels() {
  if (!selectedProvider) return;
  elements.discoverModels.disabled = true;
  providerMessage(`Querying ${selectedProvider.name} model inventory…`);
  try {
    const { models } = await api(`/api/v1/providers/${selectedProvider.id}/models`);
    discoveredProviderModels = models;
    elements.modelSelect.replaceChildren(new Option(selectedProvider.defaultModel ? `Profile default · ${selectedProvider.defaultModel}` : "Select a model", ""));
    for (const model of models) {
      const context = model.contextLength ? ` · ${number(model.contextLength)} context` : "";
      elements.modelSelect.append(new Option(`${model.displayName}${model.loaded ? " · loaded" : ""}${context}`, model.loaded ? model.instanceId : model.id));
      elements.modelSelect.lastElementChild.dataset.contextLength = String(model.contextLength || 0);
    }
    elements.modelSelect.disabled = false;
    const loaded = models.find((model) => model.loaded) || models[0];
    if (loaded) elements.modelSelect.value = loaded.loaded ? loaded.instanceId : loaded.id;
    providerMessage(`${models.length} model entr${models.length === 1 ? "y" : "ies"} found. Loaded context length is used as the context-budget default when advertised.`, "success");
  } catch (error) {
    providerMessage(error.message || String(error), "error");
  } finally {
    elements.discoverModels.disabled = false;
  }
}

elements.providerSelect.addEventListener("change", () => {
  selectedProvider = providers.find((provider) => provider.id === elements.providerSelect.value) || defaultProvider("text");
  elements.discoverModels.disabled = !selectedProvider;
  discoveredProviderModels = [];
  elements.modelSelect.replaceChildren(new Option("Discover models or use the profile default", ""));
  elements.modelSelect.disabled = true;




  if (selectedImportSource && selectedImport?.kind === "infinite_worlds") {
    previewImportSource(selectedImportSource.sourceName, selectedImportSource.sourceText, elements.infiniteWorldsKind.value, selectedImportSource.origin).catch((error) => setStatus(error.message || String(error), "error"));
  }
});

elements.modelSelect.addEventListener("change", () => {

  if (selectedImportSource && selectedImport?.kind === "infinite_worlds") {
    previewImportSource(selectedImportSource.sourceName, selectedImportSource.sourceText, elements.infiniteWorldsKind.value, selectedImportSource.origin).catch((error) => setStatus(error.message || String(error), "error"));
  }
});

elements.embeddingProvider.addEventListener("change", () => {
  const provider = providers.find((item) => item.id === elements.embeddingProvider.value);
  discoveredEmbeddingModels = [];
  elements.discoverEmbeddingModels.disabled = !provider;
  elements.embeddingModel.disabled = !provider;
  elements.embeddingModel.value = provider?.defaultModel || "";
  elements.embeddingStatus.className = "status";
  elements.embeddingStatus.textContent = provider
    ? `${provider.name} selected. Open the embedding model picker to inspect its endpoint inventory.`
    : "Select an embedding provider before choosing its model.";
});

elements.campaignTextProvider.addEventListener("change", () => {
  applyStoryProviderContextBudget();
  if (!enabledProviders("embedding").length) populateEmbeddingProviderSelect();
});

async function discoverEmbeddingModels() {
  const provider = providers.find((item) => item.id === elements.embeddingProvider.value);
  if (!provider) return;
  elements.discoverEmbeddingModels.disabled = true;
  elements.refreshProviderModelDialog.disabled = true;
  elements.embeddingStatus.textContent = `Querying ${provider.name} model inventory…`;
  elements.providerModelPickerStatus.textContent = `Discovering active and inactive models from ${provider.name}…`;
  elements.providerModelPickerStatus.className = "status";
  try {
    const { models } = await api(`/api/v1/providers/${provider.id}/models?providerRole=embedding`);
    discoveredEmbeddingModels = models || [];
    const current = elements.embeddingModel.value.trim();
    const selected = discoveredEmbeddingModels.find((model) => profileModelValue(model) === current || model.id === current)
      || discoveredEmbeddingModels.find((model) => model.loaded && /embed/i.test(`${model.id} ${model.displayName}`))
      || discoveredEmbeddingModels.find((model) => /embed/i.test(`${model.id} ${model.displayName}`))
      || discoveredEmbeddingModels.find((model) => model.loaded)
      || discoveredEmbeddingModels[0]
      || null;
    if (selected && !current) elements.embeddingModel.value = profileModelValue(selected);
    renderProviderModelPicker();
    elements.providerModelPickerStatus.textContent = `${discoveredEmbeddingModels.length} model entr${discoveredEmbeddingModels.length === 1 ? "y" : "ies"} found. Select an embedding-capable model.`;
    elements.providerModelPickerStatus.className = "status success";
    elements.embeddingStatus.className = "status success";
    elements.embeddingStatus.textContent = `${discoveredEmbeddingModels.length} model entries found for ${provider.name}. Select one in the model picker, then save and index.`;
  } catch (error) {
    elements.embeddingStatus.textContent = error.message || String(error);
    elements.embeddingStatus.className = "status error";
    elements.providerModelPickerStatus.textContent = error.message || String(error);
    elements.providerModelPickerStatus.className = "status error";
  } finally {
    elements.discoverEmbeddingModels.disabled = false;
    elements.refreshProviderModelDialog.disabled = false;
  }
}

function embeddingConfigPayload(values) {
  return {
    enabled: values.enabled === true,
    providerProfileId: values.providerProfileId || null,
    model: String(values.model ?? ""),
    batchSize: Number(values.batchSize),
    documentPrefix: values.documentPrefix || null,
    queryPrefix: values.queryPrefix || null,
    retrievalImplementation: String(values.retrievalImplementation ?? ""),
    retrievalShadowEnabled: values.retrievalShadowEnabled === true
  };
}

function renderEmbeddingJobProgress(job) {
  const progress = job?.progress || {};
  const embedded = Number(progress.embeddedChunks ?? progress.embedded ?? 0);
  const total = Number(progress.totalParents ?? progress.total ?? 0);
  const processed = Number(progress.processedParents ?? progress.updated ?? embedded);
  elements.embeddingProgress.classList.remove("hidden");
  if (total > 0) {
    elements.embeddingProgressBar.max = total;
    elements.embeddingProgressBar.value = Math.min(total, processed);
  } else if (["completed", "failed"].includes(job.status)) {
    elements.embeddingProgressBar.max = 1;
    elements.embeddingProgressBar.value = job.status === "completed" ? 1 : 0;
  } else {
    elements.embeddingProgressBar.removeAttribute("value");
  }
  const labels = {
    queued: "Indexing queued; waiting for a Chronicle worker…",
    running: total ? `Indexing Semantic Retrieval: ${number(processed)} of ${number(total)} memories…` : "Indexing Semantic Retrieval…",
    completed: total ? `Semantic Retrieval indexing complete: ${number(total)} memories processed.` : "Semantic Retrieval indexing completed successfully.",
    failed: `Semantic Retrieval indexing failed${job.errorMessage ? `: ${job.errorMessage}` : "."}`
  };
  elements.embeddingProgressLabel.textContent = labels[job.status] || "Checking semantic indexing status…";
  elements.saveEmbeddingConfig.textContent = job.status === "queued"
    ? "Index queued…"
    : job.status === "running"
      ? total ? `Indexing ${processed}/${total}…` : "Indexing…"
      : job.status === "completed" ? "Index complete ✓" : "Index failed";
  elements.saveEmbeddingConfig.classList.toggle("busy", ["queued", "running"].includes(job.status));
  if (["queued", "running"].includes(job.status)) {
    renderSemanticMemoryHealth({
      ...embeddingConfig,
      status: "indexing",
      message: labels[job.status],
      coveragePercent: total ? Math.round(processed / total * 100) : 0,
      jobStatus: job.status,
      progress
    });
  }
}

function embeddingPollDelay(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function monitorEmbeddingJob(jobId, campaignId, monitorState, selectionRequest) {
  const monitorKey = `${campaignId}:${selectionRequest}`;
  const isCurrent = () => selectionRequest === campaignSelectionRequest && selectedCampaign?.id === campaignId;
  for (let poll = 0; poll < 1200; poll += 1) {
    if (embeddingJobMonitors.get(monitorKey) !== monitorState || !isCurrent()) return null;
    const job = await api(`/api/v1/jobs/${jobId}`);
    if (embeddingJobMonitors.get(monitorKey) !== monitorState || !isCurrent()) return null;
    monitorState.latestJob = job;
    renderEmbeddingJobProgress(job);
    if (["completed", "failed"].includes(job.status)) {
      await refreshCampaignMemoryMetrics(selectionRequest);
      if (!isCurrent()) return job;
      elements.embeddingStatus.className = `status ${job.status === "completed" ? "success" : "error"}`;
      elements.embeddingStatus.textContent = job.status === "completed"
        ? "Semantic Retrieval indexing completed. Current compatible vector coverage is shown above."
        : `${job.errorMessage || "Semantic Retrieval indexing failed."} Chronicle local memory remains available when semantic retrieval is off or unavailable.`;
      return job;
    }
    await embeddingPollDelay(1000);
  }
  throw new Error("Semantic indexing is still running, but live progress monitoring timed out. Refresh the campaign to resume monitoring.");
}

function ensureEmbeddingJobProgress(jobId, campaignId, selectionRequest = campaignSelectionRequest) {
  const monitorKey = `${campaignId}:${selectionRequest}`;
  const existing = embeddingJobMonitors.get(monitorKey);
  if (existing?.jobId === jobId) {
    if (selectionRequest === campaignSelectionRequest && selectedCampaign?.id === campaignId && existing.latestJob) renderEmbeddingJobProgress(existing.latestJob);
    return existing.promise;
  }
  const monitorState = { jobId, latestJob: null, promise: null };
  monitorState.promise = Promise.resolve()
    .then(() => monitorEmbeddingJob(jobId, campaignId, monitorState, selectionRequest))
    .finally(() => {
      if (embeddingJobMonitors.get(monitorKey) === monitorState) embeddingJobMonitors.delete(monitorKey);
    });
  embeddingJobMonitors.set(monitorKey, monitorState);
  return monitorState.promise;
}

async function resumeEmbeddingJobProgress(jobId, campaignId, selectionRequest = campaignSelectionRequest) {
  elements.saveEmbeddingConfig.disabled = true;
  elements.reindexEmbeddings.disabled = true;
  elements.saveEmbeddingConfig.classList.add("busy");
  try {
    await ensureEmbeddingJobProgress(jobId, campaignId, selectionRequest);
  } catch (error) {
    if (selectionRequest === campaignSelectionRequest && selectedCampaign?.id === campaignId) {
      elements.embeddingStatus.className = "status error";
      elements.embeddingStatus.textContent = error.message || String(error);
    }
  } finally {
    if (selectionRequest === campaignSelectionRequest && selectedCampaign?.id === campaignId) {
      elements.saveEmbeddingConfig.disabled = false;
      elements.reindexEmbeddings.disabled = !embeddingConfig?.enabled;
      elements.saveEmbeddingConfig.classList.remove("busy");
      elements.saveEmbeddingConfig.textContent = "Save & index";
    }
  }
}

async function saveEmbeddingConfig(event) {
  event.preventDefault();
  if (!selectedCampaign) return;
  const campaignId = selectedCampaign.id;
  const selectionRequest = campaignSelectionRequest;
  elements.saveEmbeddingConfig.disabled = true;
  elements.saveEmbeddingConfig.classList.add("busy");
  elements.saveEmbeddingConfig.textContent = "Saving…";
  elements.embeddingProgress.classList.add("hidden");
  elements.embeddingStatus.className = "status";
  elements.embeddingStatus.textContent = "Saving campaign memory configuration…";
  try {
    if (elements.embeddingEnabled.checked && !elements.embeddingProvider.value) {
      throw new Error("Choose an eligible embedding provider before enabling Semantic Retrieval.");
    }
    const saved = await writeCampaignSettings(api, campaignId, "chronicle", embeddingConfigPayload({
        enabled: elements.embeddingEnabled.checked,
        providerProfileId: elements.embeddingProvider.value || null,
        model: elements.embeddingModel.value,
        batchSize: elements.embeddingBatchSize.value,
        documentPrefix: elements.embeddingDocumentPrefix.value || null,
        queryPrefix: elements.embeddingQueryPrefix.value || null,
        retrievalImplementation: elements.embeddingRetrievalImplementation.value,
        retrievalShadowEnabled: elements.embeddingRetrievalShadowEnabled.checked
      }));
    if (selectionRequest !== campaignSelectionRequest || selectedCampaign?.id !== campaignId) return;
    embeddingConfig = saved;
    campaignSectionLoader.invalidate("chronicle");
    setCampaignSettingsSectionFeedback("chronicle", "success", "", selectionRequest, campaignId);
    elements.embeddingRetrievalImplementation.value = saved.retrievalImplementation;
    elements.embeddingRetrievalShadowEnabled.checked = saved.retrievalShadowEnabled;
    if (saved.enabled && !saved.jobId) throw new Error("Semantic Retrieval was enabled, but the indexing job was not created.");
    if (saved.enabled && saved.jobId) {
      elements.embeddingStatus.textContent = `Semantic Retrieval indexing queued as durable job ${saved.jobId}. Live progress will remain here until it completes or fails.`;
      await ensureEmbeddingJobProgress(saved.jobId, campaignId, selectionRequest);
    } else {
      elements.embeddingProgress.classList.add("hidden");
      await refreshCampaignMemoryMetrics(selectionRequest);
      if (selectionRequest !== campaignSelectionRequest || selectedCampaign?.id !== campaignId) return;
      elements.embeddingStatus.className = "status success";
      elements.embeddingStatus.textContent = "Semantic Retrieval disabled. Chronicle local lexical retrieval remains available; retained legacy embeddings remain available for rollback.";
    }
  } catch (error) {
    if (selectionRequest === campaignSelectionRequest && selectedCampaign?.id === campaignId) {
      elements.embeddingStatus.className = "status error";
      elements.embeddingStatus.textContent = error.message || String(error);
    }
  } finally {
    if (selectionRequest === campaignSelectionRequest && selectedCampaign?.id === campaignId) {
      elements.saveEmbeddingConfig.disabled = false;
      elements.saveEmbeddingConfig.classList.remove("busy");
      elements.saveEmbeddingConfig.textContent = "Save & index";
      elements.reindexEmbeddings.disabled = !embeddingConfig?.enabled;
    }
  }
}

async function reindexSemanticRetrieval() {
  if (!selectedCampaign || !embeddingConfig?.enabled) return;
  const campaignId = selectedCampaign.id;
  const selectionRequest = campaignSelectionRequest;
  elements.reindexEmbeddings.disabled = true;
  elements.saveEmbeddingConfig.disabled = true;
  elements.embeddingStatus.className = "status";
  elements.embeddingStatus.textContent = "Queueing a Semantic Retrieval reindex…";
  try {
    const queued = await api(`/api/v1/campaigns/${campaignId}/memory/embeddings/reindex`, {
      method: "POST",
      body: "{}"
    });
    if (selectionRequest !== campaignSelectionRequest || selectedCampaign?.id !== campaignId) return;
    if (!queued.jobId) throw new Error("The Semantic Retrieval reindex did not return a job identifier.");
    elements.embeddingStatus.textContent = `Semantic Retrieval reindex job ${queued.jobId} queued.`;
    await ensureEmbeddingJobProgress(queued.jobId, campaignId, selectionRequest);
  } catch (error) {
    if (selectionRequest === campaignSelectionRequest && selectedCampaign?.id === campaignId) {
      elements.embeddingStatus.className = "status error";
      elements.embeddingStatus.textContent = error.message || String(error);
    }
  } finally {
    if (selectionRequest === campaignSelectionRequest && selectedCampaign?.id === campaignId) {
      elements.reindexEmbeddings.disabled = !embeddingConfig?.enabled;
      elements.saveEmbeddingConfig.disabled = false;
    }
  }
}

elements.campaignImageProvider.addEventListener("change", () => {
  const provider = effectiveCampaignProvider("image");
  if (provider?.defaultModel && !elements.illustrationModel.value) elements.illustrationModel.value = provider.defaultModel;
  if (provider?.providerType === "sogni" || provider?.providerType === "sogni_sdk") {
    const config = { ...(provider.providerType === "sogni_sdk" ? SOGNI_SDK_DEFAULT_CONFIGURATION : SOGNI_DEFAULT_CONFIGURATION), ...provider.configuration };
    elements.illustrationSize.value = `${config.defaultWidth}x${config.defaultHeight}`;
    elements.illustrationAspectRatio.value = config.defaultAspectRatio;
    elements.illustrationQuality.value = config.defaultQuality;
    elements.illustrationOutputFormat.value = config.defaultOutputFormat;
    elements.illustrationMaxAttempts.value = String(config.maximumAttempts);
  }
  elements.campaignImageProviderSummary.textContent = provider
    ? elements.campaignImageProvider.value ? `Segment image provider: ${provider.name}.` : "Choose a segment provider for automatic generation."
    : "Select an image provider before saving enabled illustrations.";
  syncIllustrationProviderAvailability();
});

async function discoverIllustrationModels() {
  const provider = effectiveCampaignProvider("image");
  if (!provider) return;
  elements.discoverIllustrationModels.disabled = true;
  elements.illustrationStatus.className = "status";
  elements.illustrationStatus.textContent = `Querying ${provider.name} image model inventory…`;
  try {
    const { models } = await api(`/api/v1/providers/${provider.id}/models`);
    elements.illustrationModels.replaceChildren();
    for (const model of models) {
      const pricing = modelPricingLabel(model);
      const workers = model.workerCount === undefined ? "" : ` · ${number(model.workerCount)} worker${model.workerCount === 1 ? "" : "s"}`;
      elements.illustrationModels.append(new Option(`${model.displayName}${workers}${pricing ? ` · ${pricing}` : ""}`, model.id));
    }
    if (models[0]) elements.illustrationModel.value = models[0].id;
    elements.illustrationStatus.textContent = `${models.length} image model entr${models.length === 1 ? "y" : "ies"} found. Confirm the model and save this campaign's illustration settings.`;
  } catch (error) {
    elements.illustrationStatus.className = "status error";
    elements.illustrationStatus.textContent = error.message || String(error);
  } finally {
    elements.discoverIllustrationModels.disabled = !effectiveCampaignProvider("image");
  }
}

async function saveIllustrationConfig(event) {
  event.preventDefault();
  if (!selectedCampaign) return;
  const campaignId = selectedCampaign.id;
  const selectionRequest = campaignSelectionRequest;
  const provider = effectiveCampaignProvider("image");
  const sourcePolicy = elements.illustrationSourcePolicy.value;
  if (illustrationPolicyUsesProvider(sourcePolicy) && (!elements.campaignImageProvider.value || !provider)) {
    elements.illustrationStatus.className = "status error";
    elements.illustrationStatus.textContent = enabledProviders("image").length
      ? "Select an image provider for this campaign before enabling illustrations."
      : "Add and enable an illustration provider in Provider Management before enabling images.";
    elements.campaignImageProvider.focus();
    return;
  }
  if (illustrationPolicyUsesProvider(sourcePolicy) && !elements.illustrationModel.value.trim()) {
    elements.illustrationStatus.className = "status error";
    elements.illustrationStatus.textContent = "Select or enter an image model before enabling illustrations.";
    elements.illustrationModel.focus();
    return;
  }
  elements.saveIllustrationConfig.disabled = true;
  elements.illustrationStatus.className = "status";
  elements.illustrationStatus.textContent = "Saving independent illustration configuration…";
  try {
    const savedConfig = await writeCampaignSettings(api, campaignId, "illustrations", {
        sourcePolicy,
        matchingScope: elements.illustrationMatchingScope.value,
        confidenceProfile: elements.illustrationConfidenceProfile.value,
        repetitionWindow: elements.illustrationRepetitionWindow.value,
        providerProfileId: elements.campaignImageProvider.value || null,
        model: elements.illustrationModel.value,
        size: elements.illustrationSize.value,
        aspectRatio: elements.illustrationAspectRatio.value,
        quality: elements.illustrationQuality.value,
        outputFormat: elements.illustrationOutputFormat.value,
        maxAttempts: elements.illustrationMaxAttempts.value,
        segmentWordCount: elements.illustrationSegmentWordCount.value,
        imagesPerSegment: elements.illustrationImagesPerSegment.value,
        segmentPromptMode: elements.illustrationSegmentPromptMode.value,
        refinementPrompt: illustrationRefinementPromptValue,
        artStyle: elements.illustrationArtStyle.value,
        negativePrompt: elements.illustrationNegativePrompt.value
      });
    if (selectionRequest !== campaignSelectionRequest || selectedCampaign?.id !== campaignId) return;
    illustrationConfig = savedConfig;
    campaignSectionLoader.invalidate("illustrations");
    setCampaignSettingsSectionFeedback("illustrations", "success", "", selectionRequest, campaignId);
    defaultIllustrationRefinementPrompt = illustrationConfig.defaultRefinementPrompt || defaultIllustrationRefinementPrompt;
    illustrationRefinementPromptValue = illustrationConfig.refinementPrompt || defaultIllustrationRefinementPrompt;
    elements.illustrationStatus.className = "status success";
    elements.illustrationStatus.textContent = sourcePolicy === "off"
      ? "Illustrations disabled. No image endpoint will be called for new turns."
      : sourcePolicy === "library_only"
        ? "Library-only matching enabled. It works without image or embedding providers."
        : sourcePolicy === "library_then_generate"
          ? "Library-first matching enabled with provider fallback after a durable no-match."
          : "Generate-only illustration jobs enabled.";
  } catch (error) {
    if (selectionRequest === campaignSelectionRequest && selectedCampaign?.id === campaignId) {
      elements.illustrationStatus.className = "status error";
      elements.illustrationStatus.textContent = error.message || String(error);
    }
  } finally {
    if (selectionRequest === campaignSelectionRequest && selectedCampaign?.id === campaignId) {
      elements.saveIllustrationConfig.disabled = !selectedCampaign;
    }
  }
}

async function confirmIllustrationBackfill(mode) {
  if (!selectedCampaign) return;
  const actionButton = mode === "rebuild" ? elements.previewIllustrationRebuild : elements.previewIllustrationBackfill;
  actionButton.disabled = true;
  elements.illustrationStatus.className = "status";
  elements.illustrationStatus.textContent = mode === "rebuild"
    ? "Estimating historical segment rebuild…"
    : "Estimating missing historical illustrations…";
  try {
    const preview = await api(`/api/v1/campaigns/${selectedCampaign.id}/illustration-backfill/preview`, {
      method: "POST",
      body: JSON.stringify({ mode })
    });
    if (!preview.turnCount) {
      elements.illustrationStatus.className = "status success";
      elements.illustrationStatus.textContent = mode === "rebuild"
        ? "There are no accepted turns to rebuild."
        : "Every accepted turn already has an illustration segment set.";
      return;
    }
    const refinement = preview.refinementCallCount
      ? ` It will also make up to ${number(preview.refinementCallCount)} text prompt-refinement calls.`
      : "";
    const confirmed = confirm(
      `${mode === "rebuild" ? "Rebuild" : "Generate"} illustrations for ${number(preview.turnCount)} turn(s)?\n\n`
      + `${number(preview.segmentCount)} segments · ${number(preview.imageCount)} images · `
      + `${number(preview.providerRequestCount)} image-provider requests.${refinement}\n\n`
      + (mode === "rebuild" ? "Existing active segment sets will be superseded; retained assets remain in the image library." : "Only turns without an active segment set will be queued.")
    );
    if (!confirmed) {
      elements.illustrationStatus.textContent = "Historical illustration generation was not queued.";
      return;
    }
    const result = await api(`/api/v1/campaigns/${selectedCampaign.id}/illustration-backfill`, {
      method: "POST",
      body: JSON.stringify({
        mode,
        idempotencyKey: crypto.randomUUID(),
        expectedConfigUpdatedAt: preview.configUpdatedAt,
        expectedTurnCount: preview.totalCampaignTurns
      })
    });
    elements.illustrationStatus.className = "status success";
    elements.illustrationStatus.textContent = `Queued ${number(result.queuedSets)} turn illustration set(s). Story turns were not changed.`;
  } catch (error) {
    elements.illustrationStatus.className = "status error";
    elements.illustrationStatus.textContent = error.message || String(error);
  } finally {
    renderIllustrationSettingsVisibility();
    actionButton.disabled = !selectedCampaign || elements.illustrationSourcePolicy.value === "off";
  }
}

function renderImageJobStatus(job) {
  elements.illustrationStatus.replaceChildren();
  const unsuccessful = ["recoverable", "failed", "cancelled", "expired"].includes(job.status);
  elements.illustrationStatus.className = `status ${job.status === "completed" ? "success" : unsuccessful ? "error" : ""}`.trim();
  const text = document.createElement("span");
  const active = ["queued", "generating", "provider_pending", "downloading"].includes(job.status);
  const progress = Number(job.providerProgress);
  const progressText = Number.isFinite(progress) ? ` · ${Math.round(progress)}%` : "";
  const queueText = Number.isInteger(job.providerQueuePosition) ? ` · queue ${job.providerQueuePosition}` : "";
  const etaAt = job.providerEtaAt ? new Date(job.providerEtaAt).getTime() : Number.NaN;
  const etaText = Number.isFinite(etaAt) ? ` · about ${Math.max(0, Math.ceil((etaAt - Date.now()) / 1000))}s remaining` : "";
  text.textContent = job.status === "completed"
    ? "Illustration generated and stored in the retained Nexus image library."
    : job.status === "queued"
      ? `Illustration queued${job.attempts ? ` · attempt ${job.attempts} of ${job.maxAttempts}` : ""}. Story acceptance is already complete.`
      : active
        ? `Illustration ${String(job.providerStatus || job.status).replaceAll("_", " ")}${progressText}${queueText}${etaText} · attempt ${job.attempts} of ${job.maxAttempts}.`
        : `${job.errorMessage || "Illustration generation did not complete."} The accepted story turn is unchanged.`;
  elements.illustrationStatus.append(text);
  if (active) {
    const meter = document.createElement("progress");
    meter.max = 100;
    if (Number.isFinite(progress)) meter.value = Math.max(0, Math.min(100, progress));
    meter.setAttribute("aria-label", "Illustration generation progress");
    elements.illustrationStatus.append(meter);
  }
  if (unsuccessful) {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "button secondary inline-action";
    retry.textContent = "Retry illustration";
    retry.addEventListener("click", async () => {
      retry.disabled = true;
      const queued = await api(`/api/v1/image-jobs/${job.id}/retry`, { method: "POST", body: "{}" });
      renderImageJobStatus(queued);
      void monitorImageJob(job.id);
    });
    elements.illustrationStatus.append(retry);
  }
}

async function monitorImageJob(jobId) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const job = await api(`/api/v1/image-jobs/${jobId}`);
    renderImageJobStatus(job);
    if (job.status === "completed") {
      return;
    }
    if (["recoverable", "failed", "cancelled", "expired"].includes(job.status)) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function loadLatestImageJob(monitor = false, selectionRequest = campaignSelectionRequest, signal) {
  if (!selectedCampaign) return;
  const campaignId = selectedCampaign.id;
  const { jobs } = await api(`/api/v1/campaigns/${campaignId}/image-jobs`, { signal });
  if (signal?.aborted || selectionRequest !== campaignSelectionRequest || selectedCampaign?.id !== campaignId) return;
  const job = jobs[0];
  if (!job) return;
  renderImageJobStatus(job);
  if (monitor && ["queued", "generating", "provider_pending", "downloading"].includes(job.status)) void monitorImageJob(job.id);
}

async function importStoryObject(story, sourceName, requestOverrides = {}) {
  const selectionIntentEpoch = ++worldSelectionIntentEpoch;
  const request = { sourceName, story, ...requestOverrides };
  const preview = await api("/api/v1/imports/legacy-story/preview", {
    method: "POST",
    body: JSON.stringify(request)
  });
  if (!preview.valid) throw new Error(preview.warnings.join(" ") || "The campaign export is not valid for import.");
  setStatus(`Importing ${story.turns?.length || 0} turns into PostgreSQL and building Chronicle memory…`);

  let result;
  const isZipFile = selectedFile && (selectedFile.name.toLowerCase().endsWith('.zip') || selectedFile.name.toLowerCase().endsWith('.story')) && selectedImportSource?.origin === "file";
  if (isZipFile) {
    const formData = new FormData();
    formData.append("file", selectedFile);
    formData.append("requestOverrides", JSON.stringify(requestOverrides));

    const response = await fetch("/api/v1/imports/legacy-story", {
      method: "POST",
      body: formData
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(payload.message || `Request failed with HTTP ${response.status}.`);
        error.details = payload.details || payload.issues;
        throw error;
    }
    result = payload;
  } else {
    result = await api("/api/v1/imports/legacy-story", {
      method: "POST",
      body: JSON.stringify(request)
    });
  }

  const duplicate = result.duplicate ? "The story was already imported; the existing campaign was selected." : "Import completed.";
  setStatus(`${duplicate} ${result.stats.turnCount} turns and ${result.stats.memoryCount} memories are available. Complete history is approximately ${number(result.stats.estimatedHistoryTokens)} tokens. Use “Load story” in Campaigns to open the database-backed story.`, "success");
  await loadWorldResult(result.worldId, selectionIntentEpoch);
  await loadCampaigns(result.campaignId, { explicitPreselect: true });
}

function parseImportJson(sourceText) {
  let value = String(sourceText || "").trim().replace(/^\uFEFF/, "");
  const fenced = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) value = fenced[1].trim();
  return JSON.parse(value);
}

function infiniteWorldsRequest(sourceName, sourceText, sourceKind = elements.infiniteWorldsKind.value) {
  return {
    sourceName,
    sourceText,
    sourceKind,
    selectedCharacterIndex: 0,
    ...(elements.infiniteWorldsCharacter.value ? { selectedCharacterId: elements.infiniteWorldsCharacter.value } : {}),
    ...(selectedWorldVersionId() ? { targetWorldVersionId: selectedWorldVersionId() } : {}),
    ...(selectedProvider ? { providerProfileId: selectedProvider.id } : {}),
    ...(elements.modelSelect.value ? { model: elements.modelSelect.value } : {}),
    enrichFinalTurn: elements.infiniteWorldsEnrichFinal.checked
  };
}

function showInfiniteWorldsOptions(show) {
  elements.infiniteWorldsOptions.classList.toggle("hidden", !show);
  if (!show) elements.infiniteWorldsCharacterField.classList.add("hidden");
}

function showCampaignImportOptions(show) {
  elements.campaignImportOptions.classList.toggle("hidden", !show);
  if (!show) return;
  const previousWorldId = elements.campaignImportWorld.value;
  const eligible = worlds.filter((world) => world.status !== "archived" && world.latestVersionId);
  elements.campaignImportWorld.replaceChildren(
    new Option(eligible.length ? "Choose a target world" : "No published worlds available", ""),
    ...eligible.map((world) => new Option(`${world.title} · latest version ${world.latestVersionNumber}`, world.id))
  );
  if (eligible.some((world) => world.id === previousWorldId)) elements.campaignImportWorld.value = previousWorldId;
  updateCampaignImportDestinationVisibility();
}

function updateCampaignImportDestinationVisibility() {
  const existing = elements.campaignImportDestination.value === "existing";
  elements.campaignImportWorldField.classList.toggle("hidden", !existing);
  elements.campaignImportVersionField.classList.toggle("hidden", !existing);
}

function campaignArchiveDestination() {
  if (elements.campaignImportDestination.value === "existing") {
    return { kind: "existing_world_version", worldVersionId: elements.campaignImportVersion.value };
  }
  return { kind: "embedded" };
}

function sameCampaignArchiveDestination(left, right) {
  return left?.kind === right?.kind && left?.worldVersionId === right?.worldVersionId;
}

function campaignArchiveFileSelected() {
  return elements.importSourceType.value === "campaign_archive"
    || selectedImportSource?.sourceKind === "campaign_archive"
    || (elements.importSourceType.value === "auto" && selectedFile?.name.toLowerCase().endsWith(".zip"));
}

function clearCampaignArchivePreview() {
  campaignArchivePreviewSequence += 1;
  campaignArchivePreviewAbortController?.abort();
  campaignArchivePreviewAbortController = null;
  selectedImport = null;
  elements.importStory.disabled = true;
  elements.previewCampaignArchiveAgain.classList.add("hidden");
}

function beginCampaignImportRefresh() {
  campaignImportRefreshSequence += 1;
  clearCampaignArchivePreview();
  return campaignImportRefreshSequence;
}

function isCampaignImportRefreshCurrent(sequence) {
  return sequence === campaignImportRefreshSequence;
}

function isCampaignArchivePreviewCurrent(sequence, file, destination) {
  return sequence === campaignArchivePreviewSequence
    && file === selectedFile
    && sameCampaignArchiveDestination(destination, campaignArchiveDestination());
}

function handleCampaignImportRefreshError(error, sequence) {
  if (!isCampaignImportRefreshCurrent(sequence) || error?.name === "AbortError") return;
  clearCampaignArchivePreview();
  elements.importPreview.className = "import-preview muted";
  elements.importPreview.textContent = "The campaign destination preview could not be refreshed. No content was imported.";
  setStatus(`Could not refresh the campaign destination: ${error.message || String(error)}`, "error");
}

function campaignArchiveErrorCode(error) {
  return error?.details?.code || error?.code || error?.name || "";
}

function campaignArchivePreviewField(label, value) {
  const field = document.createElement("div");
  const term = document.createElement("dt");
  term.textContent = label;
  const detail = document.createElement("dd");
  detail.textContent = value;
  field.append(term, detail);
  return field;
}

function renderCampaignArchivePreview(preview) {
  const destination = preview.destination.operation === "create_world"
    ? "Create attached world"
    : preview.destination.operation === "reuse_world_version"
      ? "Reuse matching attached world version"
      : "Attach to selected world version";
  const character = preview.campaign.selectedCharacter
    ? `${preview.campaign.selectedCharacter.name} (${preview.campaign.selectedCharacter.id})`
    : "No selected character snapshot";
  const title = document.createElement("h3");
  title.textContent = `Campaign Archive: ${preview.campaign.title}`;
  const fields = document.createElement("dl");
  fields.append(
    campaignArchivePreviewField("World", `${preview.world.title} · version ${preview.world.versionNumber}`),
    campaignArchivePreviewField("Destination", destination),
    campaignArchivePreviewField("History", `${number(preview.campaign.acceptedTurnCount)} accepted turns`),
    campaignArchivePreviewField("Chronicle", `${number(preview.chronicle.memoryCount)} Chronicle memories · ${number(preview.chronicle.summaryCount)} summaries`),
    campaignArchivePreviewField("Original images", `${number(preview.assets.originalCount)} original images · ${number(preview.assets.totalBytes)} bytes`),
    campaignArchivePreviewField("Selected character", character),
    campaignArchivePreviewField("Provider data", "Provider profiles and credentials are excluded")
  );
  elements.importPreview.className = "import-preview campaign-archive-preview";
  elements.importPreview.replaceChildren(title, fields);
  if (preview.warnings.length) {
    const warnings = document.createElement("p");
    warnings.className = "archive-warning";
    warnings.textContent = preview.warnings.join(" ");
    elements.importPreview.append(warnings);
  }
}

async function previewCampaignArchive(file) {
  clearCampaignArchivePreview();
  const previewSequence = campaignArchivePreviewSequence;
  const abortController = new AbortController();
  campaignArchivePreviewAbortController = abortController;
  if (elements.campaignImportOptions.classList.contains("hidden")) {
    elements.campaignImportDestination.value = "embedded";
    elements.campaignImportWorld.value = "";
    elements.campaignImportVersion.replaceChildren(new Option("Choose a target world first", ""));
  }
  showInfiniteWorldsOptions(false);
  showCampaignImportOptions(true);
  const destination = campaignArchiveDestination();
  if (destination.kind === "existing_world_version" && !destination.worldVersionId) {
    elements.importPreview.className = "import-preview muted";
    elements.importPreview.textContent = "Choose a published target world version before previewing this Campaign Archive.";
    setStatus("Select the exact destination version, then preview the Campaign Archive.");
    return;
  }
  elements.importPreview.className = "import-preview muted";
  elements.importPreview.textContent = "Uploading the Campaign Archive once for server validation…";
  setStatus("Validating Campaign Archive without writing to the database…");
  const formData = new FormData();
  formData.append("file", file);
  formData.append("destination", JSON.stringify(destination));
  let response;
  try {
    response = await fetch("/api/v1/imports/campaign-archive/preview", { method: "POST", body: formData, signal: abortController.signal });
  } catch (error) {
    if (!isCampaignArchivePreviewCurrent(previewSequence, file, destination)) return false;
    throw error;
  }
  if (campaignArchivePreviewAbortController === abortController) campaignArchivePreviewAbortController = null;
  const payload = await response.json().catch(() => ({}));
  if (!isCampaignArchivePreviewCurrent(previewSequence, file, destination)) return false;
  if (!response.ok) {
    const error = new Error(payload.message || `Request failed with HTTP ${response.status}.`);
    error.name = payload.error || "ApiError";
    error.details = payload.details || payload;
    error.code = payload.code || payload.details?.code;
    throw error;
  }
  selectedImportSource = { sourceName: file.name, sourceKind: "campaign_archive", origin: "file" };
  selectedImport = { kind: "campaign_archive", previewToken: payload.previewToken, destination, preview: payload };
  renderCampaignArchivePreview(payload);
  elements.importStory.disabled = false;
  setStatus("Campaign Archive and destination validated. Import will use this preview without uploading the ZIP again.", "success");
  return true;
}

async function refreshCampaignArchivePreview() {
  if (!selectedFile) return;
  elements.importStory.disabled = true;
  await previewCampaignArchive(selectedFile);
}

function campaignArchiveImportActive() {
  return selectedImport?.kind === "campaign_archive" || campaignArchiveFileSelected();
}

async function refreshCampaignImportPreview() {
  if (campaignArchiveImportActive()) {
    await refreshCampaignArchivePreview();
    return;
  }
  await refreshPortableCampaignPreview();
}

function campaignImportRequest(sourceName, story) {
  const targetWorldVersionId = elements.campaignImportDestination.value === "existing"
    ? elements.campaignImportVersion.value : "";
  return {
    sourceName,
    story,
    ...(targetWorldVersionId ? { targetWorldVersionId, characterStrategy: "preserve_source" } : {})
  };
}

async function previewPortableCampaign(sourceName, story) {
  if (elements.campaignImportOptions.classList.contains("hidden")) {
    elements.campaignImportDestination.value = "embedded";
    elements.campaignImportWorld.value = "";
    elements.campaignImportVersion.replaceChildren(new Option("Choose a target world first", ""));
  }
  showCampaignImportOptions(true);
  const request = campaignImportRequest(sourceName, story);
  if (elements.campaignImportDestination.value === "existing" && !request.targetWorldVersionId) {
    selectedImport = null;
    elements.importStory.disabled = true;
    elements.importPreview.textContent = "Choose a published target world version before importing this campaign backup.";
    setStatus("Select the exact destination version, then review the campaign preview.");
    return;
  }
  const preview = await api("/api/v1/imports/legacy-story/preview", { method: "POST", body: JSON.stringify(request) });
  selectedImport = { kind: "campaign", request };
  const destination = request.targetWorldVersionId ? " · attaching to selected world version" : " · using embedded world";
  elements.importPreview.textContent = `${preview.duplicate ? "Duplicate" : "New"} campaign${destination} · ${preview.counts.turns} turns · approximately ${number(preview.counts.estimatedHistoryTokens)} history tokens${preview.warnings.length ? ` · ${preview.warnings.join(" ")}` : ""}`;
  elements.importStory.disabled = !preview.valid;
  setStatus(preview.valid ? (preview.duplicate ? "This campaign was already imported for this destination. Importing will select the existing record." : "Campaign and destination validated and ready to import.") : "Correct the validation warnings before importing.", preview.valid ? (preview.duplicate ? "" : "success") : "error");
}

async function refreshPortableCampaignPreview() {
  if (!selectedImportSource) return;
  let story;
  try { story = parseImportJson(selectedImportSource.sourceText); } catch { return; }
  if (!story?.world || !Array.isArray(story.turns)) return;
  await previewPortableCampaign(selectedImportSource.sourceName, story);
}

async function loadCampaignImportVersions(refreshSequence, detailRetryCount = 0) {
  if (campaignArchiveImportActive()) elements.importStory.disabled = true;
  elements.campaignImportVersion.replaceChildren(new Option("Loading published versions…", ""));
  const worldId = elements.campaignImportWorld.value;
  if (!worldId) {
    elements.campaignImportVersion.replaceChildren(new Option("Choose a target world first", ""));
    if (!isCampaignImportRefreshCurrent(refreshSequence)) return;
    await refreshCampaignImportPreview();
    return;
  }
  const detailRequest = getDashboardWorldDetails(worldId);
  const detailRequestEpoch = dashboardWorldDetailRequestEpochs.get(worldId);
  let world;
  try {
    world = await detailRequest;
  } catch (error) {
    if (!isCampaignImportRefreshCurrent(refreshSequence) || worldId !== elements.campaignImportWorld.value) return;
    if (!isDashboardWorldDetailRequestCurrent(worldId, detailRequestEpoch)) {
      if (detailRetryCount < 1) return loadCampaignImportVersions(refreshSequence, detailRetryCount + 1);
      elements.campaignImportVersion.replaceChildren(new Option("Destination changed while loading. Select it again to retry.", ""));
      return;
    }
    elements.campaignImportVersion.replaceChildren(new Option("Could not load versions. Select the destination again to retry.", ""));
    throw error;
  }
  if (!isCampaignImportRefreshCurrent(refreshSequence) || worldId !== elements.campaignImportWorld.value) return;
  if (!isDashboardWorldDetailRequestCurrent(worldId, detailRequestEpoch)) {
    if (detailRetryCount < 1) return loadCampaignImportVersions(refreshSequence, detailRetryCount + 1);
    elements.campaignImportVersion.replaceChildren(new Option("Destination changed while loading. Select it again to retry.", ""));
    return;
  }
  const versions = [...(world.versions || [])].sort((a, b) => b.versionNumber - a.versionNumber);
  elements.campaignImportVersion.replaceChildren(
    new Option(versions.length ? "Choose a published version" : "No published versions", ""),
    ...versions.map((version) => new Option(`Version ${version.versionNumber}${version.releaseNotes ? ` · ${version.releaseNotes}` : ""}`, version.id))
  );
  if (versions.length === 1) elements.campaignImportVersion.value = versions[0].id;
  if (!isCampaignImportRefreshCurrent(refreshSequence) || worldId !== elements.campaignImportWorld.value
    || !isDashboardWorldDetailRequestCurrent(worldId, detailRequestEpoch)) return;
  await refreshCampaignImportPreview();
}

async function previewInfiniteWorldsSource(sourceName, sourceText, sourceKind) {
  elements.importProgressContainer.classList.add("hidden");
  showInfiniteWorldsOptions(true);
  const request = infiniteWorldsRequest(sourceName, sourceText, sourceKind);
  const preview = await api("/api/v1/imports/infinite-worlds/preview", { method: "POST", body: JSON.stringify(request) });
  if (preview.kind === "cyoa_json") {
    elements.infiniteWorldsCharacterField.classList.add("hidden");
    elements.infiniteWorldsCharacter.replaceChildren();
    delete request.selectedCharacterId;
    elements.importPreview.textContent = `Valid Choose Your Own Adventure export · "${preview.counts.topLevelTitle}" · top-level description + ${preview.counts.layer1ChaptersCount} branch choice${preview.counts.layer1ChaptersCount === 1 ? "" : "s"} detected · LLM will synthesize world and ${preview.counts.characterTarget} upon import${preview.warnings.length ? ` · ${preview.warnings.join(" ")}` : ""}`;
  } else if (preview.kind === "world_json") {
    elements.infiniteWorldsCharacterField.classList.add("hidden");
    elements.infiniteWorldsCharacter.replaceChildren();
    delete request.selectedCharacterId;
    const characterCount = Array.isArray(preview.characters) ? preview.characters.length : 0;
    elements.importPreview.textContent = preview.valid
      ? `${preview.duplicate ? "Duplicate" : "New"} Infinite Worlds world · world details only · no story turns · all ${characterCount} playable character${characterCount === 1 ? "" : "s"} retained · ${preview.counts.entities} entities · ${preview.counts.triggers} triggers`
      : `Infinite Worlds world is not valid for import · ${preview.warnings?.join(" ") || "Add at least one playable character."}`;
  } else if (preview.kind === "world_text") {
    elements.infiniteWorldsCharacterField.classList.add("hidden");
    elements.importPreview.textContent = `Infinite Worlds world TXT · ${number(preview.counts.sourceWords)} words · LLM conversion will run when imported${preview.warnings.length ? ` · ${preview.warnings.join(" ")}` : ""}`;
  } else {
    const previousId = elements.infiniteWorldsCharacter.value;
    const characters = Array.isArray(preview.characters) ? preview.characters : [];
    const options = characters.length > 1 ? [new Option("Choose the story character", "")] : [];
    options.push(...characters.map((character) => new Option(character.name, character.id)));
    elements.infiniteWorldsCharacter.replaceChildren(...options);
    const selectedId = preview.selectedCharacterId || (characters.some((character) => character.id === previousId) ? previousId : "");
    elements.infiniteWorldsCharacter.value = selectedId;
    elements.infiniteWorldsCharacterField.classList.toggle("hidden", characters.length < 2);
    if (selectedId) request.selectedCharacterId = selectedId;
    else delete request.selectedCharacterId;
    const worldLabel = selectedWorld ? `${selectedWorld.title} version ${selectedWorld.versions?.[0]?.versionNumber || "?"}` : "no selected published world";
    elements.importPreview.textContent = `Infinite Worlds matching story TXT · story history only · ${preview.counts.turns} turns · target ${worldLabel} · approximately ${number(preview.counts.estimatedHistoryTokens || 0)} history tokens${preview.diagnostics?.length ? ` · ${preview.diagnostics.join(" ")}` : ""}`;
  }
  selectedImport = { kind: "infinite_worlds", request, preview };
  elements.importStory.disabled = !preview.valid;
  const readyMessage = preview.kind === "cyoa_json"
    ? "Choose Your Own Adventure export validated. Upon import, the selected text provider will generate a Story World with 3-4 playable characters for your review."
    : preview.kind === "world_json"
      ? "Infinite Worlds world JSON validated with every playable character retained. This imports world details only; import the matching story TXT separately to restore story history."
      : preview.kind === "story_text"
        ? "Infinite Worlds story TXT validated and ready to attach to the selected published world."
        : "Infinite Worlds export validated and ready to import.";
  setStatus(preview.valid ? readyMessage : preview.warnings?.join(" ") || "This Infinite Worlds export needs more information before import.", preview.valid ? "success" : "error");
}

async function previewImportSource(sourceName, sourceText, sourceKind = "auto", origin = "file") {
  selectedImportSource = { sourceName, sourceText, sourceKind, origin };
  selectedImport = null;
  elements.importStory.disabled = true;
  elements.importProgressContainer.classList.add("hidden");
  showCampaignImportOptions(false);
  elements.importPreview.textContent = "Validating content without writing to the database…";
  let parsed = null;
  try { parsed = parseImportJson(sourceText); } catch { /* TXT imports are validated by the server */ }
  const forcedInfiniteWorlds = sourceKind !== "auto";
  const looksLikeInfiniteWorldsJson = parsed && (Array.isArray(parsed.possibleCharacters) || (Array.isArray(parsed.triggerEvents) && ("background" in parsed || "instructions" in parsed)));
  const looksLikeCyoaJson = parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.chapters && parsed.info && typeof parsed.chapters === "object";
  if (forcedInfiniteWorlds || looksLikeInfiniteWorldsJson || looksLikeCyoaJson || sourceName.toLowerCase().endsWith(".txt")) {
    showCampaignImportOptions(false);
    await previewInfiniteWorldsSource(sourceName, sourceText, looksLikeCyoaJson && sourceKind === "auto" ? "cyoa_json" : sourceKind);
    return;
  }
  showInfiniteWorldsOptions(false);
  if (parsed?.format === "infinite-quest-world") {
    showCampaignImportOptions(false);
    const request = { sourceName, worldExport: parsed };
    const preview = await api("/api/v1/imports/world/preview", { method: "POST", body: JSON.stringify(request) });
    selectedImport = { kind: "world", request };
    elements.importPreview.textContent = `${preview.duplicate ? "Duplicate" : "New"} world · ${preview.counts.entities} entities · ${preview.counts.relationships} relationships · ${preview.counts.triggers} triggers${preview.warnings.length ? ` · ${preview.warnings.join(" ")}` : ""}`;
    elements.importStory.disabled = false;
    setStatus(preview.duplicate ? "This world was already imported. Importing will select the existing record." : "Portable world validated and ready to import.", preview.duplicate ? "" : "success");
    return;
  }
  if (parsed?.world && Array.isArray(parsed.turns)) {
    await previewPortableCampaign(sourceName, parsed);
    return;
  }
  throw new Error("The content is neither an Infinite Quest world/campaign export nor a recognized Infinite Worlds export.");
}

async function previewImportFile(file) {
  let sourceText;
  const lowerName = file.name.toLowerCase();
  const archiveSource = elements.importSourceType.value === "campaign_archive";
  const archiveCandidate = archiveSource || ((lowerName.endsWith(".zip") || lowerName.endsWith(".story")) && elements.importSourceType.value === "auto");
  if (archiveCandidate) {
    if (archiveSource && !lowerName.endsWith(".zip")) {
      clearCampaignArchivePreview();
      throw new Error("Campaign Archive imports require a .zip backup.");
    }
    try {
      await previewCampaignArchive(file);
      return;
    } catch (error) {
      if (!(lowerName.endsWith(".story") && campaignArchiveErrorCode(error) === "archive-format-unrecognized")) throw error;
    }
  }
  if (lowerName.endsWith(".zip")) {
    throw new Error("The server could not recognize this ZIP as a supported Campaign Archive. Browser code does not open archive entries.");
  }
  if (!sourceText) {
    sourceText = await file.text();
  }
  await previewImportSource(file.name, sourceText, elements.infiniteWorldsKind.value, "file");
}

function clipboardGuidance(kind = elements.clipboardImportKind.value) {
  const guidance = {
    auto: ["Choose the complete export.", "Automatic detection accepts Infinite Quest .story JSON or Infinite Worlds world JSON. Select matching story TXT explicitly because it is not JSON."],
    campaign_json: ["Infinite Quest .story includes both parts.", "The pasted JSON should contain world details and accepted story turns. Importing it creates a World Library world and a campaign with Chronicle history."],
    cyoa_json: ["Choose Your Own Adventure JSON export.", "The pasted JSON should contain the info summary and chapters. Importing it will use your selected text provider to generate an editable Story World with 3-4 playable characters."],
    world_json: ["Infinite Worlds world JSON contains no story history.", "This creates only the reusable World Library world. Afterwards, select that published world and import the separate matching story TXT to create the campaign."],
    story_text: ["Infinite Worlds story TXT must be attached to its world.", "First import and select the matching Infinite Worlds world JSON. This TXT then creates the campaign and Chronicle history against that published world version."]
  }[kind] || ["Choose the complete export.", "Paste the complete copied content before validating it."];
  elements.clipboardImportGuidance.replaceChildren();
  const title = document.createElement("strong");
  title.textContent = guidance[0];
  const detail = document.createElement("span");
  detail.textContent = guidance[1];
  elements.clipboardImportGuidance.append(title, detail);
}

function openClipboardImport() {
  elements.clipboardImportStatus.textContent = "No copied content has been validated.";
  elements.clipboardImportStatus.className = "status";
  clipboardGuidance();
  openManagedModal(elements.clipboardImportDialog);
  elements.clipboardImportText.focus();
}

async function validateClipboardImport(event) {
  event.preventDefault();
  const sourceText = elements.clipboardImportText.value.trim();
  const kind = elements.clipboardImportKind.value;
  if (!sourceText) {
    elements.clipboardImportStatus.textContent = "Paste the complete exported content before validating it.";
    elements.clipboardImportStatus.className = "status error";
    return;
  }
  elements.validateClipboardImport.disabled = true;
  elements.clipboardImportStatus.textContent = "Validating copied content without changing the database…";
  elements.clipboardImportStatus.className = "status";
  try {
    let sourceName = "clipboard-import.json";
    let sourceKind = "auto";
    if (kind === "campaign_json") {
      const parsed = parseImportJson(sourceText);
      if (!parsed?.world || !Array.isArray(parsed.turns)) throw new Error("This is not an Infinite Quest .story export: it must contain both world details and a turns array.");
      sourceName = "clipboard.story";
    } else if (kind === "world_json") {
      sourceName = "infinite-worlds-world-clipboard.json";
      sourceKind = "world_json";
      elements.infiniteWorldsKind.value = "world_json";
    } else if (kind === "cyoa_json") {
      sourceName = "cyoa-story-clipboard.json";
      sourceKind = "cyoa_json";
      elements.infiniteWorldsKind.value = "cyoa_json";
    } else if (kind === "story_text") {
      sourceName = "infinite-worlds-story-clipboard.txt";
      sourceKind = "story_text";
      elements.infiniteWorldsKind.value = "story_text";
    }
    await previewImportSource(sourceName, sourceText, sourceKind, "clipboard");
    if (!selectedImport || elements.importStory.disabled) {
      throw new Error(elements.importStatus.textContent || "The copied content needs more information before it can be imported.");
    }
    selectedFile = null;
    elements.storyFile.value = "";
    elements.clipboardImportText.value = "";
    elements.clipboardImportDialog.close();
  } catch (error) {
    elements.clipboardImportStatus.textContent = error.message || String(error);
    elements.clipboardImportStatus.className = "status error";
  } finally {
    elements.validateClipboardImport.disabled = false;
  }
}

async function importStory() {
  if (!selectedImport) return;
  const selectionIntentEpoch = ["infinite_worlds", "world", "campaign_archive"].includes(selectedImport.kind)
    ? ++worldSelectionIntentEpoch
    : null;
  elements.importStory.disabled = true;
  let progressTimer = null;
  try {
    if (selectedImport.kind === "infinite_worlds") {
      if (selectedImport.preview.kind === "cyoa_json") {
        setStatus("Synthesizing world and 3-4 playable characters via text provider…");
        elements.importProgressContainer.classList.remove("hidden");
        elements.importProgressBar.value = 5;
        elements.importProgressPercent.textContent = "5%";
        elements.importProgressLabel.textContent = "Parsing CYOA story description and branch choices…";
        const progressKey = selectedImport.request.sourceName + ":" + selectedImport.request.sourceText.length;
        progressTimer = setInterval(async () => {
          try {
            const progress = await api(`/api/v1/imports/progress?key=${encodeURIComponent(progressKey)}`);
            if (progress && progress.progressPercent) {
              elements.importProgressBar.value = progress.progressPercent;
              elements.importProgressPercent.textContent = `${progress.progressPercent}%`;
              if (progress.message) elements.importProgressLabel.textContent = progress.message;
            }
          } catch { /* ignore polling errors */ }
        }, 300);
      } else {
        setStatus(selectedImport.preview.kind === "world_text" ? "Converting and importing the Infinite Worlds world with the selected text provider…" : "Importing the validated Infinite Worlds export…");
      }
      const result = await api("/api/v1/imports/infinite-worlds", { method: "POST", body: JSON.stringify(selectedImport.request) });
      if (progressTimer) clearInterval(progressTimer);
      if (selectedImport.preview.kind === "cyoa_json") {
        elements.importProgressBar.value = 100;
        elements.importProgressPercent.textContent = "100%";
        elements.importProgressLabel.textContent = "World and character generation completed.";
        await loadWorldResult(result.worldId, selectionIntentEpoch);
        setStatus(result.duplicate
          ? "The Choose Your Own Adventure world was already imported; the existing record was loaded into the World Editor below."
          : "Choose Your Own Adventure story imported and converted into a new Story World with 3-4 playable characters. Review and edit any fields below before publishing or saving.", "success");
        return;
      }
      await loadWorldResult(result.worldId, selectionIntentEpoch);
      if (result.kind === "campaign") {
        await loadCampaigns(result.campaignId, { explicitPreselect: true });
        let imageMessage = "";
        if (elements.infiniteWorldsFinalImage.checked) {
          try {
            const config = await api(`/api/v1/campaigns/${result.campaignId}/illustration-config`);
            const { turns } = await api(`/api/v1/campaigns/${result.campaignId}/turns`);
            const finalTurn = turns.at(-1);
            if (!config.enabled) imageMessage = " Illustration was not queued because this campaign's image pipeline is disabled.";
            else if (!finalTurn?.imagePrompt) imageMessage = " Illustration was not queued because the final imported turn has no image prompt.";
            else {
              await api(`/api/v1/turns/${finalTurn.id}/illustrations`, { method: "POST", body: JSON.stringify({}) });
              imageMessage = " The latest-turn illustration was queued independently.";
            }
          } catch (error) {
            imageMessage = ` Story import succeeded; optional illustration was not queued: ${error.message || String(error)}`;
          }
        }
        setStatus(`${result.duplicate ? "The matching story was already imported; its campaign was selected." : `Imported ${result.stats.turnCount} turns and built ${result.stats.memoryCount} Chronicle memories.`}${imageMessage}`, "success");
      } else {
        setStatus(result.duplicate
          ? "The Infinite Worlds world was already imported; the existing record was selected. This JSON contains no story history—import the matching story TXT separately."
          : "Infinite Worlds world details and every playable character were imported with an immutable version and editable draft. No story history was included; import the matching story TXT separately to create a campaign.", "success");
      }
    } else if (selectedImport.kind === "world") {
      setStatus("Importing the validated portable world…");
      const result = await api("/api/v1/imports/world", { method: "POST", body: JSON.stringify(selectedImport.request) });
      await loadWorldResult(result.worldId, selectionIntentEpoch);
      setStatus(result.duplicate ? "The world was already imported; the existing World Library record was selected." : "World imported with an immutable version and editable draft.", "success");
    } else if (selectedImport.kind === "campaign_archive") {
      setStatus("Importing the validated Campaign Archive…");
      const result = await api("/api/v1/imports/campaign-archive", {
        method: "POST",
        body: JSON.stringify({
          previewToken: selectedImport.previewToken,
          destination: selectedImport.destination
        })
      });
      await loadWorldResult(result.worldId, selectionIntentEpoch);
      await loadCampaigns(result.campaignId, { explicitPreselect: true });
      const outcome = result.duplicate ? "The Campaign Archive was already imported; the existing campaign was selected." : "Campaign Archive imported.";
      setStatus(`${outcome} ${number(result.stats.turnCount)} turns, ${number(result.stats.memoryCount)} Chronicle memories, and ${number(result.stats.assetCount)} original images are available.`, "success");
      selectedImport = null;
      elements.previewCampaignArchiveAgain.classList.add("hidden");
      elements.importStory.disabled = true;
    } else {
      await importStoryObject(selectedImport.request.story, selectedImport.request.sourceName, selectedImport.request);
    }
  } catch (error) {
    if (progressTimer) clearInterval(progressTimer);
    if (campaignArchiveErrorCode(error) === "archive-preview-stale" && selectedFile) {
      clearCampaignArchivePreview();
      elements.importPreview.className = "import-preview muted";
      elements.importPreview.textContent = "This Campaign Archive preview expired. Use Preview again to validate the selected file.";
      elements.previewCampaignArchiveAgain.classList.remove("hidden");
      setStatus("This Campaign Archive preview is no longer valid. Your file is still selected; preview it again before importing.", "error");
      return;
    }
    setStatus(worldGenerationFailureMessage(error), "error");
  } finally {
    if (progressTimer) clearInterval(progressTimer);
    elements.importStory.disabled = !selectedImport;
  }
}

async function importBrowserState() {
  if (!detectedBrowserStory) return;
  elements.importBrowserState.disabled = true;
  try {
    await importStoryObject(detectedBrowserStory, "browser-local-storage.story");
  } catch (error) {
    setStatus(error.message || String(error), "error");
  } finally {
    elements.importBrowserState.disabled = !detectedBrowserStory;
  }
}

function detectBrowserStory() {
  try {
    const raw = localStorage.getItem(legacyStorageKey);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed?.world || !Array.isArray(parsed.turns)) return;
    detectedBrowserStory = parsed;
    elements.importBrowserState.disabled = false;
    const title = parsed.world.title || "Untitled adventure";
    setStatus(`Detected the current browser save “${title}” with ${parsed.turns.length} turn${parsed.turns.length === 1 ? "" : "s"}. Import it directly or choose a portable story file.`);
  } catch {
    setStatus("The current browser save could not be parsed. Choose a portable story file instead.", "error");
  }
}

async function previewContext(event) {
  event?.preventDefault();
  if (!selectedCampaign) return;
  const sequence = ++contextPreviewSequence;
  const campaignId = selectedCampaign.id;
  const selectionRequest = campaignSelectionRequest;
  elements.previewContext.disabled = true;
  elements.contextPreview.textContent = "Building fiction-only context…";
  try {
    const budgetTokens = clampedMemoryContextBudget(elements.budgetTokens.value);
    elements.budgetTokens.value = String(budgetTokens);
    const parameters = new URLSearchParams({
      budgetTokens: String(budgetTokens),
      compression: elements.compression.value,
      query: elements.memoryQuery.value,
      recentTurns: "8"
    });
    const result = await api(`/api/v1/campaigns/${campaignId}/memory/context-preview?${parameters}`);
    if (sequence !== contextPreviewSequence || selectionRequest !== campaignSelectionRequest || selectedCampaign?.id !== campaignId) return;
    elements.contextSummary.classList.remove("hidden", "error");
    elements.contextSummary.textContent = `${result.selectedCompression} compression selected · ${result.retrieval.mode} retrieval · approximately ${number(result.budget.estimatedSelectedTokens)} of ${number(result.budget.configuredTokens)} tokens · ${result.scopes.chronicle.length} Chronicle entries${result.budget.truncated ? " · context was budget-limited" : ""}`;
    elements.contextPreview.textContent = JSON.stringify(result, null, 2);
  } catch (error) {
    if (sequence !== contextPreviewSequence || selectionRequest !== campaignSelectionRequest || selectedCampaign?.id !== campaignId) return;
    elements.contextSummary.classList.remove("hidden");
    elements.contextSummary.classList.add("error");
    elements.contextSummary.textContent = safeWorkflowFailure("Context preview unavailable.", error);
    elements.contextPreview.textContent = "Context preview unavailable.";
  } finally {
    if (sequence === contextPreviewSequence && selectionRequest === campaignSelectionRequest && selectedCampaign?.id === campaignId) elements.previewContext.disabled = false;
  }
}

async function rebuildMemory() {
  if (!selectedCampaign) return;
  elements.reindexMemory.disabled = true;
  try {
    const job = await api(`/api/v1/campaigns/${selectedCampaign.id}/memory/reindex`, { method: "POST", body: "{}" });
    elements.contextSummary.classList.remove("hidden", "error");
    elements.contextSummary.textContent = `Chronicle reindex job ${job.jobId} queued.`;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const status = await api(`/api/v1/jobs/${job.jobId}`);
      if (status.status === "completed") {
        elements.contextSummary.textContent = "Chronicle memory rebuilt from the authoritative accepted-turn ledger.";
        await selectCampaign(selectedCampaign);
        return;
      }
      if (status.status === "failed") throw new Error(status.errorMessage || "Chronicle reindex failed.");
    }
    throw new Error("The reindex is still running. Refresh this page to check it later.");
  } catch (error) {
    elements.contextSummary.classList.remove("hidden");
    elements.contextSummary.classList.add("error");
    elements.contextSummary.textContent = error.message || String(error);
  } finally {
    elements.reindexMemory.disabled = false;
  }
}

elements.storyFile.addEventListener("change", async () => {
  const sourceRefreshSequence = beginCampaignImportRefresh();
  selectedFile = elements.storyFile.files?.[0] || null;
  selectedImportSource = null;
  if (!selectedFile) {
    elements.importPreview.textContent = "No file has been validated.";
    setStatus("Choose a story file to begin.");
    return;
  }
  if (elements.importSourceType.value === "auto") elements.infiniteWorldsKind.value = "auto";
  setStatus(`Reading and validating ${selectedFile.name}…`);
  try {
    await previewImportFile(selectedFile);
  } catch (error) {
    if (!isCampaignImportRefreshCurrent(sourceRefreshSequence)) return;
    elements.importPreview.textContent = "Validation failed; no database content was changed.";
    setStatus(error.message || String(error), "error");
  }
});
elements.importSourceType.addEventListener("change", () => {
  const sourceRefreshSequence = beginCampaignImportRefresh();
  if (!selectedFile) return;
  previewImportFile(selectedFile).catch((error) => {
    if (!isCampaignImportRefreshCurrent(sourceRefreshSequence)) return;
    elements.importPreview.className = "import-preview muted";
    elements.importPreview.textContent = "Validation failed; no database content was changed.";
    setStatus(error.message || String(error), "error");
  });
});
elements.infiniteWorldsKind.addEventListener("change", () => {
  if (selectedImportSource) previewImportSource(selectedImportSource.sourceName, selectedImportSource.sourceText, elements.infiniteWorldsKind.value, selectedImportSource.origin).catch((error) => setStatus(error.message || String(error), "error"));
  else if (selectedFile) previewImportFile(selectedFile).catch((error) => setStatus(error.message || String(error), "error"));
});
elements.infiniteWorldsCharacter.addEventListener("change", () => {
  if (selectedImportSource) previewImportSource(selectedImportSource.sourceName, selectedImportSource.sourceText, elements.infiniteWorldsKind.value, selectedImportSource.origin).catch((error) => setStatus(error.message || String(error), "error"));
});
elements.infiniteWorldsEnrichFinal.addEventListener("change", () => {
  if (selectedImportSource) previewImportSource(selectedImportSource.sourceName, selectedImportSource.sourceText, elements.infiniteWorldsKind.value, selectedImportSource.origin).catch((error) => setStatus(error.message || String(error), "error"));
});
elements.openClipboardImport.addEventListener("click", openClipboardImport);
elements.cancelClipboardImport.addEventListener("click", () => elements.clipboardImportDialog.close());
elements.clipboardImportKind.addEventListener("change", () => clipboardGuidance());
elements.clipboardImportForm.addEventListener("submit", validateClipboardImport);
elements.deleteConfirmationInput.addEventListener("input", () => {
  elements.confirmDelete.disabled = elements.deleteConfirmationInput.value !== pendingDeleteTitle;
});
elements.deleteDialog.addEventListener("close", () => {
  const resolve = pendingDeleteResolve;
  pendingDeleteResolve = null;
  const confirmed = elements.deleteDialog.returnValue === "confirm" && elements.deleteConfirmationInput.value === pendingDeleteTitle;
  pendingDeleteTitle = "";
  if (resolve) resolve(confirmed);
});
elements.importStory.addEventListener("click", importStory);
elements.createSystemArchive.addEventListener("click", createSystemArchiveExport);
elements.uploadSystemArchive.addEventListener("click", uploadAndPreviewSystemArchive);
elements.cancelSystemArchive.addEventListener("click", cancelSystemArchiveOperation);
elements.commitSystemImport.addEventListener("click", commitSystemArchiveImport);
elements.systemArchiveFile.addEventListener("change", () => {
  systemArchiveSelectedFile = elements.systemArchiveFile.files?.[0] || null;
  systemArchivePreview = null;
  elements.systemImportPreview.classList.add("hidden");
  elements.systemImportReport.classList.add("hidden");
  elements.systemArchiveProgress.classList.add("hidden");
  updateSystemArchiveControls();
  if (systemArchiveSelectedFile) void uploadAndPreviewSystemArchive();
});
elements.previewCampaignArchiveAgain.addEventListener("click", () => {
  if (!selectedFile || !campaignArchiveFileSelected()) return;
  const sourceRefreshSequence = beginCampaignImportRefresh();
  previewCampaignArchive(selectedFile).catch((error) => {
    if (!isCampaignImportRefreshCurrent(sourceRefreshSequence)) return;
    elements.importPreview.className = "import-preview muted";
    elements.importPreview.textContent = "Validation failed; no database content was changed.";
    setStatus(error.message || String(error), "error");
  });
});
elements.worldSearch?.addEventListener("input", () => {
  window.clearTimeout(dashboardWorldSearchTimer);
  dashboardWorldSearchTimer = window.setTimeout(renderDashboardWorlds, 250);
});
elements.worldCarouselPrev?.addEventListener("click", () => scrollCarousel(elements.dashboardWorlds, -1));
elements.worldCarouselNext?.addEventListener("click", () => scrollCarousel(elements.dashboardWorlds, 1));
elements.closeWorldDetails?.addEventListener("click", () => elements.worldDetailsDialog.close());
elements.editWorldDetails?.addEventListener("click", (event) => {
  event.preventDefault();
  void openWorldManagement(dashboardWorld?.id).catch((error) => worldMessage(error.message || String(error), "error"));
});
elements.beginCampaignFromWorld?.addEventListener("click", openQuickCampaign);
elements.openNexusAbout?.addEventListener("click", () => openManagedModal(elements.nexusAboutDialog));
elements.closeNexusAbout?.addEventListener("click", () => elements.nexusAboutDialog.close());
elements.openNexusUserProfile?.addEventListener("click", openNexusUserProfile);
elements.closeNexusUserProfile?.addEventListener("click", () => elements.nexusUserProfileDialog.close());
elements.cancelNexusUserProfile?.addEventListener("click", () => elements.nexusUserProfileDialog.close());
elements.nexusUserProfileForm?.addEventListener("submit", saveNexusUserProfile);
function closeNavigationMenus(except = null) {
  document.querySelectorAll(".nav-menu.open").forEach((menu) => {
    if (menu !== except) setNavigationMenuState(menu, false);
  });
}

function setNavigationMenuState(menu, open) {
  const trigger = menu.querySelector(".nav-menu-trigger");
  const panel = menu.querySelector(".nav-menu-panel");
  menu.classList.toggle("open", open);
  if (trigger) trigger.setAttribute("aria-expanded", String(open));
  if (panel) panel.hidden = !open;
}

document.querySelectorAll(".nav-menu-trigger").forEach((trigger) => {
  trigger.addEventListener("click", () => {
    const menu = trigger.closest(".nav-menu");
    if (!menu) return;
    const open = !menu.classList.contains("open");
    closeNavigationMenus(menu);
    setNavigationMenuState(menu, open);
  });
});
document.addEventListener("pointerdown", (event) => {
  if (!(event.target instanceof Element) || !event.target.closest(".nav-menu")) closeNavigationMenus();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeNavigationMenus();
});
document.querySelectorAll(".nav-menu-panel a, .nav-menu-panel button").forEach((control) => {
  control.addEventListener("click", () => closeNavigationMenus());
});
elements.campaignImportDestination.addEventListener("change", () => {
  const refreshSequence = beginCampaignImportRefresh();
  updateCampaignImportDestinationVisibility();
  const refresh = elements.campaignImportDestination.value === "existing"
    ? loadCampaignImportVersions(refreshSequence)
    : refreshCampaignImportPreview();
  refresh.catch((error) => handleCampaignImportRefreshError(error, refreshSequence));
});
elements.campaignImportWorld.addEventListener("change", () => {
  const refreshSequence = beginCampaignImportRefresh();
  loadCampaignImportVersions(refreshSequence).catch((error) => handleCampaignImportRefreshError(error, refreshSequence));
});
elements.campaignImportVersion.addEventListener("change", () => {
  const refreshSequence = beginCampaignImportRefresh();
  refreshCampaignImportPreview().catch((error) => handleCampaignImportRefreshError(error, refreshSequence));
});
elements.importBrowserState.addEventListener("click", importBrowserState);
elements.newWorld.addEventListener("click", newWorld);
elements.editWorldDraft.addEventListener("click", () => openWorldAuthor("edit"));
elements.generateWorldPreview.addEventListener("click", generateWorldFromPrompt);
elements.cancelWorldAuthor.addEventListener("click", () => requestModalDismissal(elements.worldAuthorDialog));
elements.chooseWorldCover.addEventListener("click", chooseWorldCoverFromLibrary);
document.querySelectorAll('input[name="worldCoverMode"]').forEach((control) => control.addEventListener("change", updateWorldCoverChoice));
elements.managementCampaignSearch.addEventListener("input", () => {
  window.clearTimeout(managementCampaignSearchTimer);
  managementCampaignSearchTimer = window.setTimeout(renderManagementCampaigns, 250);
});
elements.managementCampaignStatus.addEventListener("change", () => {
  managementCampaignStatus = elements.managementCampaignStatus.value;
  renderManagementCampaigns();
});
elements.managementCampaignSort.addEventListener("change", () => {
  managementCampaignSort = elements.managementCampaignSort.value;
  renderManagementCampaigns();
});
elements.managementWorldSearch.addEventListener("input", () => {
  window.clearTimeout(managementWorldSearchTimer);
  managementWorldSearchTimer = window.setTimeout(renderManagementWorlds, 250);
});
elements.managementWorldSort.addEventListener("change", () => {
  managementWorldSort = elements.managementWorldSort.value;
  renderManagementWorlds();
});
elements.managementWorldFilters.addEventListener("click", (event) => {
  const button = event.target.closest("[data-world-filter]");
  if (!button) return;
  managementWorldFilter = button.dataset.worldFilter;
  elements.managementWorldFilters.querySelectorAll("[data-world-filter]").forEach((candidate) => {
    const active = candidate === button;
    candidate.classList.toggle("active", active);
    candidate.setAttribute("aria-pressed", String(active));
  });
  renderManagementWorlds();
});
elements.managementWorldPrev.addEventListener("click", () => scrollCarousel(elements.worldManagementCarousel, -1));
elements.managementWorldNext.addEventListener("click", () => scrollCarousel(elements.worldManagementCarousel, 1));
elements.refreshWorlds.addEventListener("click", () => loadWorlds("", { selectionIntentEpoch: worldSelectionIntentEpoch, preserveWorkflowFeedbackForWorldId: selectedWorld?.id || "" }).catch((error) => reportWorldListReadFailure(safeWorkflowFailure("Worlds could not be refreshed.", error))));
elements.worldForm.addEventListener("submit", saveWorldDraft);
elements.worldAuthorNextStep.addEventListener("click", () => {
  const step = worldAuthorStep(worldAuthorActiveStep);
  setWorldAuthorStep(step.next);
});
for (const control of [elements.worldTitle, elements.worldGenre, elements.worldTone, elements.worldPremise, elements.worldBackground, elements.worldFirstAction, elements.worldRules]) {
  control.addEventListener("input", renderWorldAuthorChecklist);
  control.addEventListener("change", renderWorldAuthorChecklist);
}
elements.worldForm.addEventListener("click", (event) => {
  if (worldAuthorBusy && event.target instanceof Element && event.target.closest("summary")) event.preventDefault();
}, true);
const characterDuplicateWarning = document.createElement("p");
characterDuplicateWarning.id = "characterDuplicateWarning";
characterDuplicateWarning.className = "field-note hidden";
characterDuplicateWarning.setAttribute("role", "status");
elements.characterName.closest("label").after(characterDuplicateWarning);
elements.characterDuplicateWarning = characterDuplicateWarning;
elements.characterName.addEventListener("input", updateWorldCharacterDuplicateWarning);
elements.convertEntities.addEventListener("click", () => {
  if (worldAuthorBusy || !worldAuthorWorkingContent) return;
  const previews = previewEntityConversions(worldAuthorWorkingContent.entities);
  const dialog = document.createElement("dialog");
  dialog.setAttribute("aria-label", "Convert entities");
  dialog.style.cssText = "width:min(720px, calc(100vw - 32px)); max-height:85vh; padding:24px; border-radius:16px; overflow:auto";
  const heading = document.createElement("h2");
  heading.textContent = "Convert entities";
  dialog.append(heading);
  const explanation = document.createElement("p");
  explanation.textContent = "Choose people to add as Supporting characters. Their entities and relationships remain in the world. Save the world to persist these changes.";
  dialog.append(explanation);
  const normalize = value => String(value || "").normalize("NFKC").trim().toLowerCase().replace(/\s+/gu, " ");
  const termCounts = new Map();
  function countTerms(terms, change) {
    for (const term of new Set(terms.map(normalize).filter(Boolean))) termCounts.set(term, (termCounts.get(term) || 0) + change);
  }
  for (const person of playableCharactersFromContent(worldAuthorWorkingContent)) countTerms([person.name, ...(person.profile?.identity?.aliases || [])], 1);
  for (const entity of previews) countTerms([entity.name, ...entity.profile.identity.aliases], 1);
  const list = document.createElement("div"), more = document.createElement("button");
  more.type = "button"; more.className = "button secondary"; more.textContent = "Show more entities";
  dialog.append(list, more);
  const rows = [];
  function renderRow(preview) {
    const section = document.createElement("section");
    section.style.cssText = "display:grid; gap:10px; padding:16px 0; border-top:1px solid #485064";
    const label = document.createElement("label");
    const selected = document.createElement("input"); selected.type = "checkbox";
    label.style.cssText = "display:flex; align-items:center; gap:8px; font-weight:600";
    selected.style.width = "auto";
    label.append(selected, document.createTextNode(` Convert ${preview.name}`));
    const nameLabel = document.createElement("label"); nameLabel.textContent = "Character name ";
    const name = document.createElement("input"); name.value = preview.name; name.maxLength = 200; nameLabel.append(name);
    const keepLabel = document.createElement("label");
    const keep = document.createElement("input"); keep.type = "checkbox"; keep.style.width = "auto";
    keepLabel.style.cssText = "display:flex; align-items:center; gap:8px";
    keepLabel.append(keep, document.createTextNode(` Keep ${preview.name} as an alias if renamed`));
    const details = document.createElement("div");
    const mapped = document.createElement("p");
    const fields = [preview.profile.identity.aliases.length && `Aliases: ${preview.profile.identity.aliases.join(", ")}`,
      preview.profile.story.role && `Role: ${preview.profile.story.role}`, preview.profile.story.background && `Background: ${preview.profile.story.background}`,
      preview.characterText && `Notes: ${preview.characterText}`].filter(Boolean);
    mapped.textContent = fields.length ? fields.join(" · ") : "No character guidance found; you can add it later.";
    const remaining = document.createElement("p");
    remaining.textContent = Object.keys(preview.unconverted).length ? `Kept on entity (not converted): ${JSON.stringify(preview.unconverted)}` : "No additional properties.";
    const ambiguity = document.createElement("p");
    let terms = [preview.name, ...preview.profile.identity.aliases];
    function describeAmbiguity() {
      const shared = terms.filter(term => termCounts.get(normalize(term)) > 1);
      ambiguity.textContent = shared.length ? `Shared name or alias: ${shared.join(", ")}. Matching will remain ambiguous.` : "";
    }
    function changed() {
      countTerms(terms, -1);
      terms = selected.checked ? [name.value, ...preview.profile.identity.aliases, ...(keep.checked ? [preview.name] : [])] : [preview.name, ...preview.profile.identity.aliases];
      countTerms(terms, 1);
      for (const row of rows) row.describeAmbiguity();
    }
    name.addEventListener("input", changed); keep.addEventListener("change", changed); selected.addEventListener("change", changed);
    describeAmbiguity(); details.append(mapped, remaining, ambiguity);
    section.append(label, nameLabel, keepLabel, details); list.append(section);
    rows.push({ preview, selected, name, keep, describeAmbiguity });
  }
  function showPage() {
    for (const preview of previews.slice(rows.length, rows.length + 50)) renderRow(preview);
    more.hidden = rows.length >= previews.length;
  }
  more.addEventListener("click", showPage); showPage();
  const status = document.createElement("p"); status.setAttribute("role", "alert"); dialog.append(status);
  const convert = document.createElement("button"); convert.type = "button"; convert.textContent = "Convert selected";
  convert.className = "button primary";
  const cancel = document.createElement("button"); cancel.type = "button"; cancel.textContent = "Cancel"; cancel.className = "button secondary";
  dialog.append(convert, cancel); document.body.append(dialog);
  const close = () => { dialog.close(); dialog.remove(); elements.convertEntities.focus(); };
  cancel.addEventListener("click", close);
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(); });
  convert.addEventListener("click", () => {
    const chosen = rows.filter((row) => row.selected.checked);
    if (!chosen.length) { status.textContent = "Select at least one entity."; return; }
    const roster = playableCharactersFromContent(worldAuthorWorkingContent).map((item) => copyJsonValue(item));
    if (roster.length + chosen.length > MAX_PLAYABLE_CHARACTERS) {
      status.textContent = `The roster can contain up to ${MAX_PLAYABLE_CHARACTERS} characters. Select fewer entities.`; return;
    }
    const entityCounts = new Map();
    for (const entity of worldAuthorWorkingContent.entities) {
      const id = entity?.id || entity?.key;
      if (id) entityCounts.set(id, (entityCounts.get(id) || 0) + 1);
    }
    if (chosen.some(row => entityCounts.get(row.preview.entityId) !== 1)) {
      status.textContent = "An entity ID is duplicated. Resolve duplicate IDs before converting those rows."; return;
    }
    if (chosen.some((row) => row.keep.checked && normalize(row.name.value) !== normalize(row.preview.name)
      && row.preview.profile.identity.aliases.length >= 20 && !row.preview.profile.identity.aliases.some((alias) => normalize(alias) === normalize(row.preview.name)))) {
      status.textContent = "A character already has 20 aliases. Remove an alias before retaining the former name."; return;
    }
    const names = new Set(roster.map((item) => normalize(item.name)));
    for (const row of chosen) {
      const name = row.name.value.trim(); const key = normalize(name);
      if (!name || names.has(key)) { status.textContent = "Each selected character needs a unique name. Rename or deselect the conflicting row."; row.name.focus(); return; }
      names.add(key);
    }
    const links = new Map();
    for (const row of chosen) {
      const id = opaqueCharacterId(); const name = row.name.value.trim();
      const profile = copyJsonValue(row.preview.profile);
      if (row.keep.checked && normalize(name) !== normalize(row.preview.name)
        && profile.identity.aliases.length < 20
        && !profile.identity.aliases.some((alias) => normalize(alias) === normalize(row.preview.name))) profile.identity.aliases.push(row.preview.name);
      roster.push({ id, name, profile, characterText: "", campaignUse: "supporting", startingCastDefault: false,
        alwaysInContext: false, rpgStats: [], defaultTriggers: [], source: { type: "world-entity", entityId: row.preview.entityId } });
      links.set(row.preview.entityId, id);
    }
    worldAuthorWorkingContent.entities = worldAuthorWorkingContent.entities.map((entity) => entity && links.has(entity.id || entity.key)
      ? { ...entity, linkedCharacterId: links.get(entity.id || entity.key) } : entity);
    updateWorldAuthorCharacters(roster);
    elements.convertEntities.hidden = previewEntityConversions(worldAuthorWorkingContent.entities).length === 0;
    close(); setWorldAuthorStatus(`${chosen.length} entities converted. Save the world form to persist these changes.`, "success");
  });
  dialog.showModal();
});
elements.addPlayableCharacter.addEventListener("click", () => openCharacterDialog());
elements.suggestCast.addEventListener("click", () => openCastSuggestions({
  content: worldContentFromForm,
  provider: () => Boolean(configuredDefaultTextProvider()),
  suggest: (content, count, direction) => characterApi.worlds.suggestCastPreview({ content, count, ...(direction ? { direction } : {}) }),
  expand: (content, { name, role, concept }) => characterApi.worlds.generateCharacterPreview({
    content, prompt: concept, seed: { name, role, concept }, campaignUse: "supporting"
  }),
  edit: (character, apply) => openCharacterDialog("", character, apply),
  add: characters => {
    updateWorldAuthorCharacters([...playableCharactersFromContent(worldAuthorWorkingContent), ...characters]);
    setWorldAuthorStatus("Characters added to the draft. Save the world to persist them.", "success");
  }
}));
const characterReviewLockNotice = document.createElement("p");
characterReviewLockNotice.setAttribute("role", "status");
characterReviewLockNotice.className = "field-note";
elements.applyCharacterProfileReview.parentElement.before(characterReviewLockNotice);
elements.characterReviewLockNotice = characterReviewLockNotice;
elements.cancelCharacterProfileReview.addEventListener("click", () => {
  characterProfileOrganizationResult = null;
  elements.characterProfileReviewDialog.close();
});
elements.applyCharacterProfileReview.addEventListener("click", applyCharacterProfileReview);
const campaignCastApi = createCampaignCastApi();
const campaignCastPanel = createLegacyCastPanel({
  api: campaignCastApi, campaignPage: true, campaignId: () => selectedCampaign?.id ?? null,
  generationActive: () => false,
  checkLock: async id => campaignCharacterGenerationLocked(await characterApi.generation.syncStatus(id)),
  getProfile: id => characterApi.campaigns.getCharacterProfile(id),
  openProtagonist: afterClose => {
    elements.characterDialog.addEventListener("close", () => afterClose?.(elements.characterDialog.returnValue === "saved"), { once: true });
    void openCampaignCharacterDialog();
  },
  navigateToTurn: async turn => { if (selectedCampaign) window.location.assign("/story/" + encodeURIComponent(selectedCampaign.id) + "?turn=" + encodeURIComponent(turn)); }
});
elements.editCampaignCharacter.addEventListener("click", () => {
  if (castRosterAvailable) void campaignCastPanel.open(elements.editCampaignCharacter);
  else void openCampaignCharacterDialog();
});
elements.characterDialog.addEventListener("close", () => {
  suggestionApply = null;
  ++campaignCharacterOpenEpoch;
  ++campaignCharacterLockEpoch;
  if (campaignCharacterPoll) window.clearInterval(campaignCharacterPoll);
  campaignCharacterPoll = null;
  campaignCharacterController?.dispose();
  campaignCharacterController = null;
  campaignCharacterLocked = false;
  editingCharacterId = "";
  characterModalWorkingCharacter = null;
  characterEditorDraft = null;
  characterModalBusy = false;
  characterModalScope = "world";
  characterProfileOrganizationResult = null;
  setCharacterProfileOrganizationProgress(false);
  elements.characterGenerator.open = false;
  elements.characterGeneratorPrompt.value = "";
  elements.characterStats.replaceChildren();
  elements.characterTrackers.replaceChildren();
  setCharacterStatus();
});
elements.characterCampaignUse.addEventListener("change", updateCharacterUseControls);
elements.worldVersionSelect.addEventListener("change", () => {
  updateWorldVersionDeleteAvailability();
  loadWorldVersionPlayableCharacters().catch((error) => worldMessage(error.message || String(error), "error"));
});
elements.newCampaignCharacter.addEventListener("change", () => {
  updateCampaignCreationAvailability();
});
elements.publishWorld.addEventListener("click", publishSelectedWorld);
if (elements.forkWorldModalBtn) {
  elements.forkWorldModalBtn.addEventListener("click", () => {
    elements.forkWorldTitle.value = `Fork of ${selectedWorld?.title || "World"}`;
    openManagedModal(elements.forkWorldDialog);
  });
  elements.cancelForkWorld.addEventListener("click", () => elements.forkWorldDialog.close());
  elements.forkWorldForm.addEventListener("submit", (e) => { e.preventDefault(); forkSelectedWorld(); });
}
if (elements.createCampaignModalBtn) {
  elements.createCampaignModalBtn.addEventListener("click", openCreateCampaignDialog);
  elements.cancelCreateCampaign.addEventListener("click", () => requestModalDismissal(elements.createCampaignDialog));
  elements.createCampaignDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    requestModalDismissal(elements.createCampaignDialog);
  });
  elements.createCampaignDialog.addEventListener("close", () => {
    if (createCampaignSubmitting) return;
    campaignCreationSessionEpoch += 1;
    campaignCreationDialogSession = null;
    createCampaignCommitted = false;
  });
  elements.openCommittedCampaign.addEventListener("click", openCommittedCampaignStory);
  elements.retryCampaignCharacters.addEventListener("click", () => { if (campaignCreationDialogSession) void loadCampaignCreationCharacters(campaignCreationDialogSession); });
  elements.startingCastSearch.addEventListener("input", () => { if (campaignCreationDialogSession) renderStartingCast(campaignCreationDialogSession); });
  elements.newCampaignTitle.addEventListener("input", updateCampaignCreationDialogAvailability);
  elements.newCampaignCharacter.addEventListener("change", () => {
    if (campaignCreationDialogSession?.draft) campaignCreationDialogSession.draft.selectedCharacterId = elements.newCampaignCharacter.value || null;
    if (campaignCreationDialogSession) renderStartingCast(campaignCreationDialogSession);
    updateCampaignCreationDialogAvailability();
  });
  elements.newCampaignTurnControlStyle.addEventListener("change", () => {
    if (campaignCreationDialogSession?.draft) campaignCreationDialogSession.draft.turnControlStyle = normalizedTurnControlStyle(elements.newCampaignTurnControlStyle.value);
  });
  elements.createCampaignAdvanced.querySelector("summary").addEventListener("click", (event) => {
    if (createCampaignSubmitting || createCampaignCommitted) event.preventDefault();
  });
  elements.createCampaignForm.addEventListener("submit", (event) => { event.preventDefault(); void createCampaignFromWorld(event); });
}
elements.exportWorld.addEventListener("click", exportSelectedWorld);
elements.createWorldShare.addEventListener("click", createSelectedWorldShare);
elements.revokeWorldShare.addEventListener("click", revokeSelectedWorldShare);
elements.deleteWorldVersion.addEventListener("click", deleteSelectedWorldVersion);
elements.archiveWorld.addEventListener("click", toggleWorldArchive);
elements.deleteWorld.addEventListener("click", deleteSelectedWorld);
elements.refreshCampaigns.addEventListener("click", () => loadCampaigns(selectedCampaign?.id || "", { focusNoSelection: true, preserveWorkflowFeedbackForCampaignId: selectedCampaign?.id || "" }).catch((error) => reportCampaignListReadFailure(safeWorkflowFailure("Campaigns could not be refreshed.", error))));
elements.campaignForm.addEventListener("submit", saveSelectedCampaign);
for (const control of [elements.campaignTitle, elements.campaignStatus, elements.campaignTextProvider, elements.campaignTurnControlStyle, elements.campaignStoryLengthProfile, elements.campaignStoryContextBudgetTokens]) {
  control.addEventListener("input", () => renderCampaignSaveFeedback(campaignEditGuard.isDirty(campaignSettingsSnapshot()) ? "unsaved" : "saved"));
  control.addEventListener("change", () => renderCampaignSaveFeedback(campaignEditGuard.isDirty(campaignSettingsSnapshot()) ? "unsaved" : "saved"));
}
elements.saveCampaignEditsDecision.addEventListener("click", () => elements.discardChangesDialog.close("save"));
elements.campaignContinuityReviewEnabled.addEventListener("change", () => { void saveCampaignStoryMemory(); });
elements.campaignStoryMemoryLevel.addEventListener("change", () => { void saveCampaignStoryMemory(); });
const campaignSettingsRailMediaQuery = window.matchMedia("(max-width: 820px)");
syncCampaignSettingsRailOrientation(campaignSettingsRailMediaQuery);
campaignSettingsRailMediaQuery.addEventListener("change", syncCampaignSettingsRailOrientation);
elements.campaignSettingsRail.addEventListener("click", (event) => {
  const tab = event.target.closest("[data-campaign-settings-panel]");
  if (tab && !tab.disabled) setCampaignSettingsPanel(tab.dataset.campaignSettingsPanel);
});
elements.campaignSettingsRail.addEventListener("keydown", handleCampaignSettingsRailKeydown);
elements.migrateCampaign.addEventListener("click", migrateSelectedCampaign);
elements.transferCampaign.addEventListener("click", openCampaignTransfer);
elements.cancelTransferCampaign.addEventListener("click", () => elements.transferCampaignDialog.close());
elements.transferTargetWorld.addEventListener("change", loadTransferTargetVersions);
elements.transferTargetVersion.addEventListener("change", previewCampaignTransfer);
elements.transferCampaignTitle.addEventListener("change", previewCampaignTransfer);
elements.transferWarningAcknowledgement.addEventListener("change", () => {
  elements.confirmTransferCampaign.disabled = !transferPreview || !elements.transferWarningAcknowledgement.checked;
});
elements.transferCampaignForm.addEventListener("submit", commitCampaignTransfer);
elements.transferCampaignDialog.addEventListener("close", () => {
  transferPreviewSequence += 1;
  transferPreview = null;
  transferIdempotencyKey = "";
});
elements.exportCampaign.addEventListener("click", exportSelectedCampaign);
elements.loadCampaign.addEventListener("click", loadSelectedCampaign);
elements.deleteCampaign.addEventListener("click", deleteSelectedCampaign);
elements.campaignWorldVersion.addEventListener("change", () => {
  updateCampaignMigrationAvailability();
});
elements.contextForm.addEventListener("submit", previewContext);
elements.reindexMemory.addEventListener("click", rebuildMemory);
elements.reindexEmbeddings.addEventListener("click", reindexSemanticRetrieval);
window.addEventListener("beforeunload", (event) => {
  if (!campaignEditGuard.isDirty(campaignSettingsSnapshot())) return;
  event.preventDefault();
  event.returnValue = "";
});
document.addEventListener("click", (event) => {
  const link = event.target.closest("a[href]");
  if (!link || link.target === "_blank" || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const destination = new URL(link.href, window.location.href);
  if (destination.href === window.location.href || destination.origin !== window.location.origin) return;
  if (!campaignEditGuard.isDirty(campaignSettingsSnapshot())) return;
  event.preventDefault();
  void canLeaveCampaignEditor(null).then((allowed) => {
    if (allowed) window.location.assign(destination.href);
  });
});

// Setup tab behavior for world editor
document.querySelectorAll(".tab-button").forEach(button => {
  button.addEventListener("click", () => {
    const group = button.closest(".world-tabs").dataset.tabGroup;
    if (group === "world-author") {
      setWorldAuthorStep(button.dataset.worldAuthorStep);
      return;
    }
    const target = button.dataset.tabTarget;
    // Un-highlight all tabs in this group
    document.querySelectorAll(`.world-tabs[data-tab-group="${group}"] .tab-button`).forEach(btn => btn.classList.remove("active"));
    button.classList.add("active");
    // Hide all content panels in this group
    document.querySelectorAll(`.tab-content[data-tab-group="${group}"]`).forEach(content => content.classList.remove("active"));
    // Show the target panel
    const targetPanel = document.getElementById(target);
    if (targetPanel) targetPanel.classList.add("active");
  });
});
elements.closeProviderModelDialog.addEventListener("click", () => elements.providerModelDialog.close());
elements.refreshProviderModelDialog.addEventListener("click", discoverEmbeddingModels);
elements.providerModelFilter.addEventListener("input", renderProviderModelPicker);
elements.applyCustomProviderModel.addEventListener("click", applyCustomProviderModel);
elements.discoverModels.addEventListener("click", discoverProviderModels);
elements.compression.addEventListener("change", () => {
  elements.compression.title = elements.compression.selectedOptions[0]?.title || "Choose how Chronicle fits history into the context budget.";
});
elements.budgetTokens.addEventListener("input", () => {
  elements.budgetTokensSource.textContent = "Manual memory context budget. The Story Engine will cap it to the selected text provider's available input space.";
  elements.budgetTokensSource.className = "field-note manual-entry";
});
elements.discoverEmbeddingModels.addEventListener("click", async (event) => { event.stopPropagation(); await openEmbeddingModelPicker(true); });
elements.embeddingModel.addEventListener("click", () => { void openEmbeddingModelPicker(); });
elements.embeddingModel.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") { event.preventDefault(); void openEmbeddingModelPicker(); }
});


elements.openIllustrationPromptEditor.addEventListener("click", openIllustrationPromptEditor);
elements.illustrationSourcePolicy.addEventListener("change", () => {
  if (illustrationPolicyUsesProvider() && !enabledProviders("image").length) {
    elements.illustrationSourcePolicy.value = "library_only";
    elements.illustrationStatus.className = "status error";
    elements.illustrationStatus.textContent = "No image provider is available, so Library only was selected.";
  }
  const provider = effectiveCampaignProvider("image");
  if (illustrationPolicyUsesProvider() && provider?.defaultModel && !elements.illustrationModel.value.trim()) {
    elements.illustrationModel.value = provider.defaultModel;
  }
  renderIllustrationSettingsVisibility();
});
elements.illustrationSegmentPromptMode.addEventListener("change", syncIllustrationProviderAvailability);
elements.discoverIllustrationModels.addEventListener("click", discoverIllustrationModels);
elements.previewIllustrationBackfill.addEventListener("click", () => confirmIllustrationBackfill("missing"));
elements.previewIllustrationRebuild.addEventListener("click", () => confirmIllustrationBackfill("rebuild"));
async function loadSessionPreferences() {
  const response = await api("/api/v1/session", {signal: profileController.signal});
  if (profileController.signal.aborted) return;
  if (sessionUser?.id && response.user?.id && sessionUser.id !== response.user.id) {
    window.dispatchEvent(new Event("app-identity-changed"));
    return;
  }
  sessionUser = response.user || null;
  ownerDevice.activate(sessionUser);
  updateStoryViewLink();
  systemArchiveOwnerId = typeof sessionUser?.id === "string" ? sessionUser.id : null;
  beginSystemArchiveRecoveryWhenReady();
  elements.newCampaignTurnControlStyle.value = normalizedTurnControlStyle(sessionUser?.settings?.defaultTurnControlStyle);
}

const profileController = new AbortController();
const nexusDeviceFields = mountLegacyDeviceProfile(elements.nexusUserProfileForm, ownerDevice);
window.addEventListener("app-identity-changed", () => {
  profileController.abort();
  nexusDeviceFields.dispose();
  sessionUser = null;
  elements.nexusUserProfileDisplayName.value = "";
  document.body.replaceChildren();
  window.location.reload();
}, { once: true });
const nexusReaderFields = mountReaderPreferenceFields(document);
elements.nexusUserProfileForm.insertBefore(nexusReaderFields.element, elements.nexusUserProfileStatus);
async function openNexusUserProfile() {
  try {
    if (!sessionUser) await loadSessionPreferences();
    if (!sessionUser?.id || profileController.signal.aborted) return;
    nexusDeviceFields.activate(sessionUser, selectedCampaign?.id ?? null);
    nexusReaderFields.set(sessionUser?.settings?.readerPreferences);
    elements.nexusUserProfileDisplayName.value = sessionUser.displayName;
    elements.nexusUserProfileAutoSubmitChoices.checked = sessionUser?.settings?.autoSubmitTurnChoices !== false;
    elements.nexusUserProfileContinuousReading.checked = Boolean(sessionUser?.settings?.continuousReading);
    elements.nexusUserProfileDefaultTurnControlStyle.value = normalizedTurnControlStyle(sessionUser?.settings?.defaultTurnControlStyle);
    elements.nexusUserProfileStatus.textContent = "";
    elements.nexusUserProfileStatus.className = "status hidden";
    openManagedModal(elements.nexusUserProfileDialog);
  } catch (error) {
    setStatus(error.message || String(error), "error");
  }
}

async function saveNexusUserProfile(event) {
  event.preventDefault();
  const displayName = elements.nexusUserProfileDisplayName.value.trim();
  if (!displayName) return;
  elements.nexusUserProfileStatus.textContent = "Saving profile…";
  elements.nexusUserProfileStatus.className = "status";
  try {
    const response = await api("/api/v1/users/me/profile", {
      signal: profileController.signal,
      method: "PATCH",
      body: JSON.stringify({
        displayName,
        settings: {
          readerPreferences: nexusReaderFields.get(),
          autoSubmitTurnChoices: elements.nexusUserProfileAutoSubmitChoices.checked,
          continuousReading: elements.nexusUserProfileContinuousReading.checked,
          defaultTurnControlStyle: normalizedTurnControlStyle(elements.nexusUserProfileDefaultTurnControlStyle.value)
        }
      })
    });
    if (profileController.signal.aborted) return;
    if (response.user?.id !== sessionUser?.id) { window.dispatchEvent(new Event("app-identity-changed")); return; }
    sessionUser = response.user;
    elements.newCampaignTurnControlStyle.value = normalizedTurnControlStyle(sessionUser?.settings?.defaultTurnControlStyle);
    elements.nexusUserProfileDialog.close();
  } catch (error) {
    elements.nexusUserProfileStatus.textContent = error.message || String(error);
    elements.nexusUserProfileStatus.className = "status error";
  }
}

detectBrowserStory();
loadSessionPreferences().catch(() => undefined);
loadProviders().catch((error) => {
  const message = safeWorkflowFailure("Provider profiles could not be loaded.", error);
  reportProviderListReadFailure(message);
});
void loadWorlds().then(() => {
  initialWorldListReady = true;
  return applyExplicitManagementSelection(acceptedManagementRoute, managementNavigationIntent);
}).catch((error) => {
  initialWorldListReady = true;
  const route = acceptedManagementRoute;
  const message = safeWorkflowFailure("Worlds could not be loaded.", error);
  if (route?.selection?.kind === "world") {
    managementSelectionError(route, `Worlds could not be loaded to resolve this link. ${message}`);
    reportDashboardWorkflowError("worlds", message, () => retryWorldWorkflowRead());
  } else reportWorldListReadFailure(message);
});
const initialCampaignId = acceptedManagementRoute?.selection?.kind === "campaign" ? acceptedManagementRoute.selection.id : "";
void loadCampaigns(initialCampaignId, { explicitPreselect: Boolean(initialCampaignId) }).then(() => {
  initialCampaignListReady = true;
  return applyExplicitManagementSelection(acceptedManagementRoute, managementNavigationIntent);
}).catch((error) => {
  initialCampaignListReady = true;
  const route = acceptedManagementRoute;
  const message = safeWorkflowFailure("Campaigns could not be loaded.", error);
  if (route?.selection?.kind === "campaign") {
    managementSelectionError(route, `Campaigns could not be loaded to resolve this link. ${message}`);
    reportDashboardWorkflowError("campaigns", message, () => retryCampaignWorkflowRead());
  } else reportCampaignListReadFailure(message);
});
