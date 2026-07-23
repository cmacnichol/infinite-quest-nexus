import { createImageLibraryBrowser } from "/nexus/image-library-browser.js";

const elements = Object.fromEntries([...document.querySelectorAll("[id]")].map((element) => [element.id, element]));
const assetLibraryBrowser = createImageLibraryBrowser({
  dialog: elements.assetLibraryDialog,
  grid: elements.assetLibraryGrid,
  status: elements.assetLibraryStatus,
  filterContainer: elements.assetLibraryFilters,
  loadMore: elements.assetLibraryLoadMore,
  closeButton: elements.closeAssetLibrary
});
let selectedFile = null;
let selectedImportSource = null;
let selectedImport = null;
let selectedCampaign = null;
let worlds = [];
let campaigns = [];
let selectedWorld = null;
let dashboardWorld = null;
const dashboardWorldDetails = new Map();
let worldVersionCharacters = [];
let worldVersionCampaignReady = false;
let playableCharacterLoadSequence = 0;
let editingCharacterId = "";
let characterModalWorkingCharacter = null;
let characterModalBusy = false;
let characterModalScope = "world";
let campaignCharacterProfileRevision = 0;
let characterProfileOrganizationResult = null;
let characterProfileOrganizationApplied = false;
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
let editingProviderId = "";
let discoveredProfileModels = [];
let discoveredEmbeddingModels = [];
let providerModelPickerTarget = "provider";
let embeddingJobPollSequence = 0;
let worldCoverJobPollSequence = 0;
let illustrationRefinementPromptValue = "";
let defaultIllustrationRefinementPrompt = "";
let sessionUser = null;
let transferPreviewSequence = 0;
let transferPreview = null;
let transferIdempotencyKey = "";
let promptLibrary = null;
let selectedPromptTemplateKey = "";
let promptLibraryPreviewVisible = false;
let promptLibraryEditorBaseline = "";
let promptLibraryEditorContext = "";
let promptLibraryCategory = "All";
let promptLibraryActiveScope = "application";
let promptLibraryActiveCampaignId = "";
let promptLibraryPreviewTimer = 0;
let promptLibraryPreviewSequence = 0;
const MIN_MEMORY_CONTEXT_BUDGET_TOKENS = 512;
const MAX_MEMORY_CONTEXT_BUDGET_TOKENS = 1_000_000;
const DEFAULT_MEMORY_CONTEXT_BUDGET_TOKENS = 32_000;
const CHARACTER_PROFILE_FIELDS = Object.freeze({
  "identity.aliases": "characterAliases",
  "identity.pronouns": "characterPronouns",
  "story.role": "characterRole",
  "story.background": "characterBackground",
  "story.personality": "characterPersonality",
  "story.motivations": "characterMotivations",
  "story.goals": "characterGoals",
  "story.fearsAndConflicts": "characterFearsAndConflicts",
  "story.keyRelationships": "characterKeyRelationships",
  "story.narrativeHooks": "characterNarrativeHooks",
  "story.voiceAndMannerisms": "characterVoiceAndMannerisms",
  "story.otherGuidance": "characterOtherGuidance",
  "appearance.ancestryOrSpecies": "characterAncestryOrSpecies",
  "appearance.apparentAge": "characterApparentAge",
  "appearance.genderPresentation": "characterGenderPresentation",
  "appearance.build": "characterBuild",
  "appearance.skinOrComplexion": "characterSkinOrComplexion",
  "appearance.face": "characterFace",
  "appearance.eyes": "characterEyes",
  "appearance.hair": "characterHair",
  "appearance.distinguishingFeatures": "characterDistinguishingFeatures",
  "appearance.clothing": "characterClothing",
  "appearance.equipmentAndAccessories": "characterEquipmentAndAccessories",
  "appearance.otherVisualDetails": "characterOtherVisualDetails",
  unclassifiedNotes: "characterUnclassifiedNotes"
});
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
    return `${control.id}:${control.value}`;
  }).join("\u001f");
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
  const bounds = dialog.getBoundingClientRect();
  return event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
}

function requestModalDismissal(dialog) {
  if (dialog === elements.characterDialog && characterModalBusy) return;
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
    dialog.addEventListener("close", () => modalBaselines.delete(dialog));
  });
  elements.discardChangesDialog.addEventListener("close", () => {
    if (elements.discardChangesDialog.returnValue === "discard" && discardModalTarget?.open) discardModalTarget.close();
    discardModalTarget = null;
  });
}

installClickAwayModalDismissal();

async function loadApplicationMetadata() {
  try {
    const response = await fetch("/api/v1/meta");
    if (!response.ok) return;
    const metadata = await response.json();
    const version = metadata?.application?.version;
    if (!version || !elements.nexusVersion) return;
    elements.nexusVersion.textContent = `v${version}`;
    elements.nexusVersion.classList.remove("hidden");
  } catch {
    // Build metadata is informational and must never block Nexus management.
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
  if (!elements.storyViewLink) return;
  const lastCampaignId = localStorage.getItem("infiniteQuestLastCampaignId");
  let storyHref = "/story";
  if (selectedCampaign) {
    storyHref = "/story/" + encodeURIComponent(selectedCampaign.id);
  } else if (lastCampaignId) {
    storyHref = "/story/" + encodeURIComponent(lastCampaignId);
  }
  elements.storyViewLink.href = storyHref;
  if (elements.dashboardStoryLink) elements.dashboardStoryLink.href = storyHref;
}

function applyManagementView() {
  const hash = window.location.hash || "#dashboard";
  const dashboardView = hash === "#dashboard";
  const providerView = hash === "#providers";
  const promptLibraryView = hash === "#prompt-library";
  document.body.dataset.managementView = dashboardView ? "dashboard" : providerView ? "providers" : promptLibraryView ? "prompt-library" : "worlds";
  elements.managementTitle.textContent = providerView ? "Provider Management" : promptLibraryView ? "Prompt Library" : hash === "#campaigns" ? "Campaign Management" : "World Management";
  elements.managementDescription.textContent = providerView
    ? "Add and manage provider profiles independently for story text, turn intent, image generation, and Chronicle embeddings."
    : promptLibraryView
      ? "Edit the application-owned instructions used for text and image generation. Changes apply to newly queued work."
      : hash === "#campaigns"
      ? "Configure campaigns, Chronicle memory, provider selection, illustrations, and world-version migrations."
      : "Author reusable versioned worlds, configure campaigns, and inspect the fiction-only memory selected for generation.";
  document.title = dashboardView ? "Infinite Quest Nexus" : `${elements.managementTitle.textContent} · Infinite Quest Nexus`;

  [elements.navDashboard, elements.navProviders, elements.navPromptLibrary, elements.navWorlds, elements.navCampaigns, elements.navImports].forEach((link) => link?.classList.remove("active"));
  if (dashboardView) elements.navDashboard?.classList.add("active");
  if (providerView) elements.navProviders?.classList.add("active");
  if (promptLibraryView) { elements.navPromptLibrary?.classList.add("active"); void loadPromptLibrary(); }
  if (hash === "#world-library") elements.navWorlds?.classList.add("active");
  if (hash === "#campaigns") elements.navCampaigns?.classList.add("active");
  if (hash === "#imports") elements.navImports?.classList.add("active");
  elements.navSetup?.classList.toggle("active", !dashboardView);

  updateStoryViewLink();
}

applyManagementView();
window.addEventListener("hashchange", applyManagementView);

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

function promptLibraryCampaignId() {
  return elements.promptLibraryScope?.value === "campaign" ? elements.promptLibraryCampaign?.value || "" : "";
}

function promptLibrarySelectedTemplate() {
  return promptLibrary?.templates?.find((template) => template.key === selectedPromptTemplateKey) || null;
}

function promptLibraryIsDirty() {
  return Boolean(promptLibraryEditorContext && elements.promptLibraryContent.value !== promptLibraryEditorBaseline);
}

function renderPromptLibraryDirtyState() {
  const dirty = promptLibraryIsDirty();
  elements.promptLibraryUnsaved?.classList.toggle("hidden", !dirty);
  elements.promptLibraryDiscard?.classList.toggle("hidden", !dirty);
}

function syncPromptLibraryCampaigns() {
  if (!elements.promptLibraryCampaign) return;
  const current = elements.promptLibraryCampaign.value || selectedCampaign?.id || "";
  elements.promptLibraryCampaign.replaceChildren(
    new Option("Select a campaign", ""),
    ...campaigns.map((campaign) => new Option(campaign.title, campaign.id))
  );
  if (campaigns.some((campaign) => campaign.id === current)) elements.promptLibraryCampaign.value = current;
  elements.promptLibraryCampaignField?.classList.toggle("hidden", elements.promptLibraryScope.value !== "campaign");
}

async function renderPromptLibraryPreview() {
  const template = promptLibrarySelectedTemplate();
  if (!template || !elements.promptLibraryPreviewPanel) return;
  elements.promptLibraryPreviewPanel.classList.toggle("hidden", !promptLibraryPreviewVisible);
  elements.promptLibraryPreview.setAttribute("aria-expanded", String(promptLibraryPreviewVisible));
  elements.promptLibraryPreview.textContent = promptLibraryPreviewVisible ? "Hide full request" : "Preview full request";
  if (!promptLibraryPreviewVisible) return;
  const sequence = ++promptLibraryPreviewSequence;
  elements.promptLibraryPreviewContent.textContent = "Building sample request…";
  try {
    const preview = await api("/api/v1/prompt-library/preview", {
      method: "POST",
      body: JSON.stringify({ key: template.key, content: elements.promptLibraryContent.value })
    });
    if (sequence !== promptLibraryPreviewSequence) return;
    const sections = preview.sections.map((section) => `── ${section.label} [${section.role}] ──\n${section.content}`).join("\n\n");
    const unresolved = preview.unresolvedVariables.length ? preview.unresolvedVariables.map((name) => `{{${name}}}`).join(", ") : "none";
    elements.promptLibraryPreviewContent.textContent = `Estimated tokens: ${preview.estimatedTokens.toLocaleString()}\nUnresolved variables: ${unresolved}\n\n${sections}`;
  } catch (error) {
    if (sequence === promptLibraryPreviewSequence) elements.promptLibraryPreviewContent.textContent = error.message || String(error);
  }
}

function schedulePromptLibraryPreview() {
  clearTimeout(promptLibraryPreviewTimer);
  if (promptLibraryPreviewVisible) promptLibraryPreviewTimer = setTimeout(() => void renderPromptLibraryPreview(), 250);
}

function selectPromptLibraryTemplate(key) {
  if (key === selectedPromptTemplateKey) return;
  if (promptLibraryIsDirty()) {
    elements.promptLibraryStatus.textContent = "Save or discard the current edits before switching prompts.";
    elements.promptLibraryStatus.className = "status warning";
    return;
  }
  selectedPromptTemplateKey = key;
  renderPromptLibrary(true);
}

function renderPromptLibrary(loadEditor = false) {
  if (!elements.promptLibraryList || !promptLibrary) return;
  const filter = (elements.promptLibraryFilter?.value || "").trim().toLowerCase();
  const campaignScope = elements.promptLibraryScope?.value === "campaign";
  syncPromptLibraryCampaigns();
  elements.promptLibraryCampaignHint.textContent = campaignScope
    ? (promptLibraryCampaignId() ? "Only campaign-runtime prompts can be overridden; authoring and import prompts remain application-wide." : "Choose a campaign to manage its runtime overrides.")
    : "Application defaults apply to all new work unless an eligible campaign override exists.";
  const categories = ["All", ...new Set(promptLibrary.templates.map((template) => template.category))];
  elements.promptLibraryCategories?.replaceChildren(...categories.map((category) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = category;
    button.classList.toggle("active", category === promptLibraryCategory);
    button.addEventListener("click", () => { promptLibraryCategory = category; renderPromptLibrary(); });
    return button;
  }));
  const templates = promptLibrary.templates.filter((template) => !campaignScope || template.campaignOverrideAllowed)
    .filter((template) => promptLibraryCategory === "All" || template.category === promptLibraryCategory)
    .filter((template) => !filter || `${template.title} ${template.category} ${template.description}`.toLowerCase().includes(filter));
  elements.promptLibraryList.replaceChildren(...templates.map((template) => {
    const button = document.createElement("button");
    button.type = "button"; button.className = `prompt-library-item${template.key === selectedPromptTemplateKey ? " active" : ""}`;
    button.dataset.promptKey = template.key;
    button.setAttribute("aria-pressed", String(template.key === selectedPromptTemplateKey));
    const title = document.createElement("strong"); title.textContent = template.title;
    const source = document.createElement("small"); source.textContent = `${template.category} · ${template.effectiveSource}`;
    const description = document.createElement("small"); description.textContent = template.description;
    button.append(title, source, description);
    button.addEventListener("click", () => selectPromptLibraryTemplate(template.key));
    return button;
  }));
  const template = promptLibrarySelectedTemplate();
  elements.promptLibraryEditor.classList.toggle("hidden", !template);
  if (!template) return;
  elements.promptLibraryEditorTitle.textContent = template.title;
  elements.promptLibraryEditorDescription.textContent = template.description;
  elements.promptLibraryEditorMeta.textContent = `Effective source: ${template.effectiveSource}. Variables: ${template.variables.length ? template.variables.map((name) => `{{${name}}}`).join(", ") : "none"}. Limit: ${template.maxLength.toLocaleString()} characters.`;
  elements.promptLibraryContent.maxLength = template.maxLength;
  const context = `${elements.promptLibraryScope.value}:${promptLibraryCampaignId()}:${template.key}`;
  if (loadEditor || context !== promptLibraryEditorContext) {
    promptLibraryEditorContext = context;
    promptLibraryEditorBaseline = template.effectiveContent;
    elements.promptLibraryContent.value = template.effectiveContent;
  }
  elements.promptLibraryWarning?.classList.toggle("hidden", template.category !== "Story Engine");
  const resetAvailable = campaignScope ? template.effectiveSource === "campaign" : template.effectiveSource === "application";
  elements.promptLibraryReset.textContent = campaignScope ? "Use inherited application prompt" : "Restore shipped default";
  elements.promptLibraryReset.disabled = !resetAvailable;
  renderPromptLibraryDirtyState();
  if (promptLibraryPreviewVisible) schedulePromptLibraryPreview();
  requestAnimationFrame(() => elements.promptLibraryList.querySelector(".prompt-library-item.active")?.scrollIntoView({ block: "nearest", inline: "nearest" }));
}

async function loadPromptLibrary() {
  if (!elements.promptLibraryStatus) return;
  syncPromptLibraryCampaigns();
  const campaignId = promptLibraryCampaignId();
  if (elements.promptLibraryScope?.value === "campaign" && !campaignId) {
    elements.promptLibraryStatus.textContent = "Select a campaign before editing campaign overrides.";
    elements.promptLibraryStatus.className = "status error";
    promptLibrary = { templates: [] }; renderPromptLibrary(); return;
  }
  elements.promptLibraryStatus.textContent = "Loading prompt library…"; elements.promptLibraryStatus.className = "status";
  try {
    promptLibrary = await api(`/api/v1/prompt-library${campaignId ? `?campaignId=${encodeURIComponent(campaignId)}` : ""}`);
    if (!selectedPromptTemplateKey) selectedPromptTemplateKey = promptLibrary.templates[0]?.key || "";
    promptLibraryActiveScope = elements.promptLibraryScope.value;
    promptLibraryActiveCampaignId = campaignId;
    elements.promptLibraryStatus.textContent = "Changes apply to newly queued jobs; queued and retried jobs retain their snapshotted prompt.";
    elements.promptLibraryStatus.className = "status";
    renderPromptLibrary(true);
  } catch (error) { elements.promptLibraryStatus.textContent = error.message || String(error); elements.promptLibraryStatus.className = "status error"; }
}

async function savePromptLibraryTemplate(event) {
  event.preventDefault();
  const template = promptLibrarySelectedTemplate(); if (!template) return;
  const scope = elements.promptLibraryScope.value;
  try {
    const response = await api("/api/v1/prompt-library/overrides", { method: "PUT", body: JSON.stringify({ key: template.key, scope, ...(scope === "campaign" ? { campaignId: promptLibraryCampaignId() } : {}), content: elements.promptLibraryContent.value }) });
    promptLibrary = response.library; elements.promptLibraryStatus.textContent = "Prompt saved. New jobs will use this version."; elements.promptLibraryStatus.className = "status success"; renderPromptLibrary(true);
  } catch (error) { elements.promptLibraryStatus.textContent = error.message || String(error); elements.promptLibraryStatus.className = "status error"; }
}

async function resetPromptLibraryTemplate() {
  const template = promptLibrarySelectedTemplate(); if (!template) return;
  const scope = elements.promptLibraryScope.value;
  try {
    const response = await api("/api/v1/prompt-library/overrides", { method: "DELETE", body: JSON.stringify({ key: template.key, scope, ...(scope === "campaign" ? { campaignId: promptLibraryCampaignId() } : {}) }) });
    promptLibrary = response.library; elements.promptLibraryStatus.textContent = scope === "campaign" ? "Campaign override removed; the inherited application prompt is active." : "Application override removed; the shipped default is active."; elements.promptLibraryStatus.className = "status success"; renderPromptLibrary(true);
  } catch (error) { elements.promptLibraryStatus.textContent = error.message || String(error); elements.promptLibraryStatus.className = "status error"; }
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

function worldPreview(world, detail = dashboardWorldDetails.get(world.id)) {
  const content = world?.latestPreview || detail?.latestPreview || detail?.draftContent?.world || {};
  return {
    genre: String(content.genre || "Uncharted genre"),
    tone: String(content.tone || "Open-ended"),
    description: String(content.premise || content.backgroundStory || "A published world ready for a new campaign."),
    firstAction: String(content.firstAction || "Begin the adventure."),
    imageUrl: detail?.imageUrl || content.imageUrl || content.artworkUrl || ""
  };
}

function createDashboardWorldCard(world) {
  const preview = worldPreview(world);
  const card = document.createElement("button");
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
  card.append(art, body);
  card.addEventListener("click", () => openWorldDetails(world.id));
  return card;
}

function renderDashboardWorlds() {
  if (!elements.dashboardWorlds) return;
  const query = elements.worldSearch.value.trim().toLocaleLowerCase();
  const available = worlds.filter((world) => world.status !== "archived" && world.latestVersionId).filter((world) => {
    const preview = worldPreview(world);
    return [world.title, preview.genre, preview.tone, preview.description].join(" ").toLocaleLowerCase().includes(query);
  });
  elements.dashboardWorlds.replaceChildren();
  if (!available.length) {
    const empty = document.createElement("p");
    empty.className = "carousel-empty";
    empty.textContent = query ? "No worlds match that search." : "No published worlds are available yet. Open World Management to prepare one.";
    elements.dashboardWorlds.append(empty);
    return;
  }
  available.forEach((world) => elements.dashboardWorlds.append(createDashboardWorldCard(world)));
}

async function hydrateDashboardWorlds() {
  const available = worlds.filter((world) => world.status !== "archived" && world.latestVersionId);
  await Promise.all(available.map(async (world) => {
    if (dashboardWorldDetails.has(world.id)) return;
    try {
      dashboardWorldDetails.set(world.id, await api(`/api/v1/worlds/${world.id}`));
    } catch {
      // The summary card remains usable if optional detail hydration fails.
    }
  }));
  renderDashboardWorlds();
}

function createDashboardCampaignCard(campaign) {
  const card = document.createElement("button");
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
  card.append(art, body);
  card.addEventListener("click", () => {
    localStorage.setItem("infiniteQuestLastCampaignId", campaign.id);
    window.location.assign(`/story/${encodeURIComponent(campaign.id)}`);
  });
  return card;
}

function renderDashboardCampaigns() {
  if (!elements.dashboardCampaigns) return;
  const query = elements.campaignSearch.value.trim().toLocaleLowerCase();
  const matches = campaigns.filter((campaign) => [campaign.title, campaign.worldTitle, campaign.selectedCharacterName].join(" ").toLocaleLowerCase().includes(query));
  elements.dashboardCampaigns.replaceChildren();
  if (!matches.length) {
    const empty = document.createElement("p");
    empty.className = "carousel-empty";
    empty.textContent = query ? "No campaigns match that search." : "No campaigns yet. Choose an available world to begin one.";
    elements.dashboardCampaigns.append(empty);
    return;
  }
  matches.forEach((campaign) => elements.dashboardCampaigns.append(createDashboardCampaignCard(campaign)));
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

async function loadDashboardStats() {
  if (!elements.dashboardStatsGrid) return;
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
  } catch (error) {
    elements.statWorlds.textContent = number(worlds.filter((world) => world.status !== "archived" && world.latestVersionId).length);
    elements.statCampaigns.textContent = number(campaigns.filter((campaign) => campaign.status === "active").length);
    elements.statTurns.textContent = number(campaigns.reduce((total, campaign) => total + Number(campaign.activeTurnNumber || 0), 0));
    elements.statActiveWorlds.textContent = number(worlds.filter((world) => world.latestVersionId).length);
    elements.statCost.textContent = "Unavailable";
    elements.statCostProviders.textContent = "Refresh to retry provider totals";
    elements.dashboardStatsStatus.textContent = error.message || "Dashboard statistics are temporarily unavailable.";
  }
}

async function openWorldDetails(worldId) {
  const summary = worlds.find((world) => world.id === worldId);
  if (!summary) return;
  let detail = dashboardWorldDetails.get(worldId);
  if (!detail) {
    try {
      detail = await api(`/api/v1/worlds/${worldId}`);
      dashboardWorldDetails.set(worldId, detail);
    } catch (error) {
      elements.dashboardStatsStatus.textContent = error.message || String(error);
      return;
    }
  }
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
  elements.editWorldDetails.href = `#world-library`;
  openManagedModal(elements.worldDetailsDialog);
}

async function openQuickCampaign() {
  if (!dashboardWorld?.latestVersionId) return;
  elements.worldDetailsDialog.close();
  elements.quickCampaignWorld.textContent = `${dashboardWorld.title} · version ${dashboardWorld.latestVersionNumber}`;
  elements.quickCampaignName.value = `${dashboardWorld.title} Adventure`;
  elements.quickCampaignCharacter.replaceChildren(new Option("Loading characters…", ""));
  elements.confirmQuickCampaign.disabled = true;
  elements.quickCampaignStatus.className = "status hidden";
  openManagedModal(elements.quickCampaignDialog);
  try {
    const result = await api(`/api/v1/world-versions/${dashboardWorld.latestVersionId}/playable-characters`);
    const characters = Array.isArray(result.characters) ? result.characters : [];
    elements.quickCampaignCharacter.replaceChildren();
    if (!result.readiness?.ready || !characters.length) {
      elements.quickCampaignCharacter.append(new Option("No playable characters available", ""));
      elements.quickCampaignCharacterNote.textContent = result.readiness?.issues?.[0]?.message || "Publish this world with a playable character before creating a campaign.";
      refreshModalBaseline(elements.quickCampaignDialog);
      return;
    }
    if (characters.length > 1) elements.quickCampaignCharacter.append(new Option("Choose a character", ""));
    characters.forEach((character) => elements.quickCampaignCharacter.append(new Option(character.name, character.id)));
    if (characters.length === 1) elements.quickCampaignCharacter.value = characters[0].id;
    elements.quickCampaignCharacterNote.textContent = characters.length === 1
      ? `${characters[0].name} will be snapshotted into the campaign.`
      : `Choose one of ${characters.length} published playable characters.`;
    elements.confirmQuickCampaign.disabled = false;
    refreshModalBaseline(elements.quickCampaignDialog);
    elements.quickCampaignName.focus();
  } catch (error) {
    elements.quickCampaignStatus.textContent = error.message || String(error);
    elements.quickCampaignStatus.className = "status error";
    refreshModalBaseline(elements.quickCampaignDialog);
  }
}

async function createQuickCampaign(event) {
  event.preventDefault();
  if (!dashboardWorld?.latestVersionId) return;
  const title = elements.quickCampaignName.value.trim();
  const selectedCharacterId = elements.quickCampaignCharacter.value;
  if (!title || !selectedCharacterId) return;
  elements.confirmQuickCampaign.disabled = true;
  elements.quickCampaignStatus.textContent = "Creating your campaign and opening the first scene…";
  elements.quickCampaignStatus.className = "status";
  try {
    const campaign = await api("/api/v1/campaigns", {
      method: "POST",
      body: JSON.stringify({ title, worldVersionId: dashboardWorld.latestVersionId, selectedCharacterId })
    });
    localStorage.setItem("infiniteQuestLastCampaignId", campaign.id);
    window.location.assign(`/story/${encodeURIComponent(campaign.id)}`);
  } catch (error) {
    elements.confirmQuickCampaign.disabled = false;
    elements.quickCampaignStatus.textContent = error.message || String(error);
    elements.quickCampaignStatus.className = "status error";
  }
}

function scrollCarousel(element, direction) {
  element.scrollBy({ left: direction * Math.max(280, element.clientWidth * .82), behavior: "smooth" });
}

function worldMessage(message, type = "") {
  elements.worldStatus.textContent = message;
  elements.worldStatus.className = `status ${type}`.trim();
}

function campaignMessage(message, type = "") {
  elements.campaignStatusMessage.textContent = message;
  elements.campaignStatusMessage.className = `status ${type}`.trim();
  elements.campaignStatusMessage.classList.remove("hidden");
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
    elements.worldTitle,
    elements.worldGenre,
    elements.worldTone,
    elements.worldPremise,
    elements.worldBackground,
    elements.worldFirstAction,
    elements.worldRules,
    elements.worldReleaseNotes,
    elements.worldCoverPrompt,
    elements.chooseWorldCover,
    elements.generateWorldCover,
    elements.addPlayableCharacter,
    elements.forkWorldTitle,
    elements.newCampaignTitle,
    elements.newCampaignCharacter,
    elements.newCampaignTurnControlStyle,
    elements.saveWorldDraft,
    elements.publishWorld,
    elements.forkWorldModalBtn,
    elements.confirmForkWorld,
    elements.createCampaignModalBtn,
    elements.confirmCreateCampaign,
    elements.exportWorld,
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
  const current = selectedWorld?.draftContent || {};
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
    && Boolean(configuredDefaultTextProvider())
    && selectedWorld?.status !== "archived";
  elements.characterGenerator.classList.toggle("hidden", !available);
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

function setProfileValue(profile, path, value) {
  const keys = path.split(".");
  let target = profile;
  for (const key of keys.slice(0, -1)) {
    target[key] ||= {};
    target = target[key];
  }
  target[keys.at(-1)] = value;
}

function profileFromForm() {
  const profile = emptyCharacterProfile();
  for (const [path, id] of Object.entries(CHARACTER_PROFILE_FIELDS)) {
    const raw = elements[id].value.trim();
    const value = path === "identity.aliases"
      ? raw.split(",").map((entry) => entry.trim()).filter(Boolean)
      : path === "appearance.distinguishingFeatures"
        ? raw.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)
        : raw;
    setProfileValue(profile, path, value);
  }
  return profile;
}

function profileHasGuidance(profile) {
  return Object.keys(CHARACTER_PROFILE_FIELDS).filter((path) => path.startsWith("story.")).some((path) => {
    const value = profileValue(profile, path);
    return Array.isArray(value) ? value.length > 0 : Boolean(String(value || "").trim());
  });
}

function populateCharacterForm(character, readOnly = false) {
  characterModalWorkingCharacter = copyJsonValue(character);
  elements.characterName.value = String(character.name || "");
  elements.characterGuidance.value = String(character.characterText || "");
  const profile = character.profile || emptyCharacterProfile();
  for (const [path, id] of Object.entries(CHARACTER_PROFILE_FIELDS)) {
    const value = profileValue(profile, path);
    elements[id].value = Array.isArray(value)
      ? value.join(path === "identity.aliases" ? ", " : "\n")
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
  for (const control of [elements.characterName, elements.addCharacterStat, elements.addCharacterTracker, elements.organizeCharacterProfile]) {
    control.disabled = readOnly || busy;
  }
  elements.characterDialog.querySelectorAll(".character-profile-section input, .character-profile-section textarea").forEach((control) => {
    control.disabled = readOnly || busy;
  });
  elements.characterDialog.querySelectorAll(".character-edit-row input, .character-row-remove").forEach((control) => {
    control.disabled = readOnly || busy;
  });
  elements.characterGeneratorPrompt.disabled = busy || characterModalScope === "campaign";
  elements.saveCharacter.disabled = readOnly || busy;
  elements.deleteCharacter.disabled = readOnly || busy;
  elements.cancelCharacter.disabled = busy;
  updateCharacterGeneratorAvailability();
}

function openCharacterDialog(characterId = "") {
  if (!selectedWorld) return;
  const readOnly = selectedWorld.status === "archived";
  const character = characterId
    ? playableCharactersFromContent(selectedWorld.draftContent).find((item) => item.id === characterId)
    : null;
  if (characterId && !character) {
    worldMessage("That character is no longer present in this world draft.", "error");
    return;
  }
  editingCharacterId = character?.id || "";
  characterModalScope = "world";
  characterProfileOrganizationResult = null;
  characterProfileOrganizationApplied = false;
  const initial = character || { id: "", name: "", characterText: "", rpgStats: [], defaultTriggers: [], source: { type: "world-library-editor" } };
  populateCharacterForm(initial, readOnly);
  elements.characterGeneratorPrompt.value = "";
  elements.characterDialogTitle.textContent = readOnly ? "View character" : character ? "Edit character" : "Add character";
  elements.characterDialogDescription.textContent = readOnly
    ? "This world is archived. Restore it before changing this character."
    : character
      ? "Update this character in the current world draft."
      : "Create a playable character for this world draft.";
  elements.saveCharacter.textContent = character ? "Save changes" : "Add character";
  elements.saveCharacter.classList.toggle("hidden", readOnly);
  elements.deleteCharacter.classList.toggle("hidden", !character || readOnly);
  elements.cancelCharacter.textContent = readOnly ? "Close" : "Cancel";
  elements.characterMechanicsFields.classList.remove("hidden");
  elements.characterDialog.querySelector(".eyebrow").textContent = "World Library";
  setCharacterStatus();
  setCharacterModalControls(readOnly);
  openManagedModal(elements.characterDialog);
  if (!readOnly) elements.characterName.focus();
}

function characterRowsFromForm(kind, characterId) {
  const isStat = kind === "stat";
  const container = isStat ? elements.characterStats : elements.characterTrackers;
  const result = [];
  for (const editor of container.querySelectorAll(".character-edit-row")) {
    const values = Object.fromEntries([...editor.querySelectorAll("[data-character-field]")].map((input) => [input.dataset.characterField, input.value.trim()]));
    const hasContent = Object.values(values).some(Boolean);
    if (!hasContent) continue;
    if (!values.name) throw new Error(`${isStat ? "Every statistic" : "Every tracker"} with content needs a name.`);
    const original = characterRowOriginals.get(editor) || {};
    const id = String(original.id || opaqueCharacterId());
    if (isStat) {
      const numeric = values.value === "" ? 50 : Number(values.value);
      if (!Number.isInteger(numeric) || numeric < 1 || numeric > 99) throw new Error(`The value for “${values.name}” must be a whole number from 1 to 99.`);
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

function characterFromForm() {
  const name = elements.characterName.value.trim();
  const characterText = elements.characterGuidance.value.trim();
  const profile = profileFromForm();
  if (!name) throw new Error("Enter a character name.");
  if (!profileHasGuidance(profile) && !characterText) {
    throw new Error("Enter targeted character profile details or retain valid legacy guidance.");
  }
  const base = characterModalWorkingCharacter || {};
  const id = String(base.id || opaqueCharacterId());
  return {
    ...base,
    id,
    name,
    characterText,
    profile,
    rpgStats: characterRowsFromForm("stat", id),
    defaultTriggers: characterRowsFromForm("tracker", id),
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
  for (const character of roster) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "character-roster-card";
    card.setAttribute("aria-label", `${selectedWorld?.status === "archived" ? "View" : "Edit"} ${String(character.name || "unnamed character")}`);
    const name = document.createElement("strong");
    name.textContent = String(character.name || "Unnamed character");
    const detail = document.createElement("span");
    const stats = Array.isArray(character.rpgStats) ? character.rpgStats.length : 0;
    const trackers = Array.isArray(character.defaultTriggers) ? character.defaultTriggers.length : 0;
    detail.textContent = `${stats} RPG stat${stats === 1 ? "" : "s"} · ${trackers} starting tracker${trackers === 1 ? "" : "s"}`;
    const description = document.createElement("span");
    description.textContent = String(character.characterText || "").slice(0, 260) || "No character description.";
    card.append(name, detail, description);
    card.addEventListener("click", () => openCharacterDialog(character.id));
    elements.playableCharacterRoster.append(card);
  }
}

async function loadWorlds(preselectId = "") {
  ({ worlds } = await api("/api/v1/worlds"));
  renderDashboardWorlds();
  void hydrateDashboardWorlds();
  void loadDashboardStats();
  elements.worldList.replaceChildren();
  if (!worlds.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No worlds yet. Create one or import a portable world.";
    elements.worldList.append(empty);
    selectedWorld = null;
    worldVersionCharacters = [];
    worldVersionCampaignReady = false;
    playableCharacterLoadSequence += 1;
    renderPlayableCharacterRoster([]);
    setWorldEditorDisabled(true);
    updateCharacterGeneratorAvailability();
    elements.worldCampaignReadiness.textContent = "Select or create a world before checking campaign readiness.";
    elements.worldCampaignReadiness.className = "status";
    return;
  }
  for (const world of worlds) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "world-button";
    button.dataset.worldId = world.id;
    const title = document.createElement("strong");
    title.textContent = world.title;
    const details = document.createElement("span");
    details.textContent = `${world.status} · ${world.latestVersionNumber ? `version ${world.latestVersionNumber}` : "unpublished"} · ${number(world.campaignCount)} campaign${Number(world.campaignCount) === 1 ? "" : "s"}`;
    button.append(title, details);
    button.addEventListener("click", () => selectWorld(world.id));
    elements.worldList.append(button);
  }
  const targetId = preselectId || selectedWorld?.id;
  if (targetId && worlds.some((world) => world.id === targetId)) await selectWorld(targetId);
}

async function selectWorld(worldId) {
  const coverPollSequence = ++worldCoverJobPollSequence;
  selectedWorld = await api(`/api/v1/worlds/${worldId}`);
  document.querySelectorAll(".world-button").forEach((button) => button.classList.toggle("active", button.dataset.worldId === worldId));
  const overview = selectedWorld.draftContent?.world || {};
  elements.worldEditorTitle.textContent = selectedWorld.title;
  elements.worldEditorMeta.textContent = `${selectedWorld.status} · draft revision ${selectedWorld.draftRevision} · ${selectedWorld.versions.length} published version${selectedWorld.versions.length === 1 ? "" : "s"}`;
  elements.worldTitle.value = overview.title || selectedWorld.title;
  elements.worldGenre.value = overview.genre || "";
  elements.worldTone.value = overview.tone || "";
  elements.worldPremise.value = overview.premise || "";
  elements.worldBackground.value = overview.backgroundStory || "";
  renderPlayableCharacterRoster(playableCharactersFromContent(selectedWorld.draftContent));
  elements.worldFirstAction.value = overview.firstAction || "";
  elements.worldRules.value = overview.rules || "";
  elements.worldReleaseNotes.value = "";
  const coverUrl = artworkUrl(selectedWorld);
  elements.worldCoverPreview.src = coverUrl;
  elements.worldCoverPreview.classList.toggle("hidden", !coverUrl);
  elements.worldCoverStatus.textContent = coverUrl
    ? "This cover is stored in the retained Nexus image library. Generate again to replace it."
    : "No cover has been generated for this world.";
  elements.worldVersionSelect.replaceChildren(new Option(selectedWorld.versions.length ? "Latest published version" : "No published versions", ""));
  for (const version of selectedWorld.versions) {
    elements.worldVersionSelect.append(new Option(`Version ${version.versionNumber}${version.releaseNotes ? ` · ${version.releaseNotes}` : ""}`, version.id));
  }
  elements.worldVersionSelect.disabled = !selectedWorld.versions.length;
  setWorldEditorDisabled(false);
  const archived = selectedWorld.status === "archived";
  elements.archiveWorld.textContent = archived ? "Restore" : "Archive";
  elements.saveWorldDraft.disabled = archived;
  elements.publishWorld.disabled = archived;
  elements.addPlayableCharacter.disabled = archived;
  elements.createCampaignModalBtn.disabled = true;
  elements.confirmCreateCampaign.disabled = true;
  elements.exportWorld.disabled = !selectedWorld.versions.length;
  elements.forkWorldModalBtn.disabled = !selectedWorld.versions.length;
  updateWorldVersionDeleteAvailability();
  elements.deleteWorld.disabled = false;
  updateCharacterGeneratorAvailability();
  void resumeWorldCoverJob(worldId, coverPollSequence);
  await loadWorldVersionPlayableCharacters();
  worldMessage(archived ? "This world is archived. Restore it before editing or publishing." : "Draft loaded from authoritative PostgreSQL storage.");
}

async function newWorld() {
  const title = elements.newWorldTitle.value.trim();
  if (!title) {
    worldMessage("Enter a title for the new world.", "error");
    elements.newWorldTitle.focus();
    return;
  }
  worldMessage("Creating world draft…");
  try {
    const generateCover = elements.newWorldGenerateCover.checked;
    const world = await api("/api/v1/worlds", { method: "POST", body: JSON.stringify({ title }) });
    elements.newWorldTitle.value = "";
    await loadWorlds(world.id);
    if (generateCover) {
      worldMessage("World draft created. Queuing its cover with the default image provider…", "success");
      await generateWorldCoverImage();
    } else {
      worldMessage("World draft created. It must be published before a campaign can use it.", "success");
    }
  } catch (error) {
    worldMessage(error.message || String(error), "error");
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
      renderWorldCoverJobStatus(job);
      selectedWorld.imageUrl = job.assetUrl;
      elements.worldCoverPreview.src = job.assetUrl;
      elements.worldCoverPreview.classList.remove("hidden");
      const cached = worlds.find((world) => world.id === worldId);
      if (cached) cached.imageUrl = job.assetUrl;
      renderDashboardWorlds();
      return job;
    }
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
    if (["queued", "generating", "provider_pending", "downloading"].includes(job.status)) {
      elements.generateWorldCover.disabled = true;
      await monitorWorldCoverJobWithSequence(job.id, worldId, sequence);
    }
  } catch (error) {
    if (selectedWorld?.id !== worldId || sequence !== worldCoverJobPollSequence) return;
    elements.worldCoverStatus.className = "status error";
    elements.worldCoverStatus.textContent = error.message || String(error);
  } finally {
    if (selectedWorld?.id === worldId && sequence === worldCoverJobPollSequence) {
      elements.generateWorldCover.disabled = selectedWorld.status === "archived";
    }
  }
}

async function generateWorldCoverImage() {
  if (!selectedWorld) return;
  const worldId = selectedWorld.id;
  elements.generateWorldCover.disabled = true;
  elements.worldCoverStatus.className = "status";
  elements.worldCoverStatus.textContent = "Queuing a world cover with the default image provider…";
  try {
    const job = await api(`/api/v1/worlds/${worldId}/cover`, {
      method: "POST",
      body: JSON.stringify({
        prompt: elements.worldCoverPrompt.value.trim(),
        size: "1024x1536",
        aspectRatio: "2:3",
        quality: "auto",
        outputFormat: "png",
        replace: Boolean(selectedWorld.imageUrl)
      })
    });
    await monitorWorldCoverJob(job.id, worldId);
  } catch (error) {
    elements.worldCoverStatus.className = "status error";
    elements.worldCoverStatus.textContent = error.message || String(error);
  } finally {
    if (selectedWorld?.id === worldId) elements.generateWorldCover.disabled = selectedWorld.status === "archived";
  }
}

async function openAssetLibrary(onSelect, context = {}) {
  await assetLibraryBrowser.open({ mode: onSelect ? "picker" : "browse", onSelect, context });
}

async function chooseWorldCoverFromLibrary() {
  if (!selectedWorld) return;
  const worldId = selectedWorld.id;
  await openAssetLibrary(async (asset) => {
    const result = await api(`/api/v1/worlds/${worldId}/cover-asset`, {
      method: "PUT",
      body: JSON.stringify({ assetId: asset.id })
    });
    if (selectedWorld?.id !== worldId) return;
    selectedWorld.imageUrl = result.assetUrl;
    elements.worldCoverPreview.src = result.assetUrl;
    elements.worldCoverPreview.classList.remove("hidden");
    elements.worldCoverStatus.className = "status success";
    elements.worldCoverStatus.textContent = "Selected a retained image from the image library.";
    const cached = worlds.find((world) => world.id === worldId);
    if (cached) cached.imageUrl = result.assetUrl;
    renderDashboardWorlds();
  }, { worldId });
}

async function saveWorldDraft(event) {
  event.preventDefault();
  if (!selectedWorld) return;
  elements.saveWorldDraft.disabled = true;
  worldMessage("Saving world draft…");
  try {
    const saved = await persistWorldDraft(worldContentFromForm());
    worldMessage(`Draft revision ${saved.revision} saved. Existing campaigns remain unchanged.`, "success");
  } catch (error) {
    worldMessage(error.message || String(error), "error");
  } finally {
    elements.saveWorldDraft.disabled = selectedWorld?.status === "archived";
  }
}

async function persistWorldDraft(content) {
  if (!selectedWorld) throw new Error("Select a world draft first.");
  const worldId = selectedWorld.id;
  const saved = await api(`/api/v1/worlds/${worldId}/draft`, {
    method: "PUT",
    body: JSON.stringify({
      expectedRevision: selectedWorld.draftRevision,
      title: elements.worldTitle.value,
      content
    })
  });
  await loadWorlds(worldId);
  return saved;
}

async function generateCharacterFromPrompt() {
  if (!selectedWorld || characterModalBusy || selectedWorld.status === "archived") return;
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
  const previousName = elements.characterName.value;
  const previousGuidance = elements.characterGuidance.value;
  const previousProfile = profileFromForm();
  setCharacterModalControls(false, true);
  setCharacterStatus("Generating a complete character from the current world draft…");
  try {
    const result = await api(`/api/v1/worlds/${selectedWorld.id}/draft/playable-characters/generate`, {
      method: "POST",
      body: JSON.stringify({
        expectedRevision: selectedWorld.draftRevision,
        prompt,
        ...(editingCharacterId ? { characterId: editingCharacterId } : {})
      })
    });
    const candidate = result?.character;
    if (!candidate || typeof candidate !== "object" || !String(candidate.name || "").trim() || !candidate.profile) {
      throw new Error("The text model did not return a complete character.");
    }
    const base = characterModalWorkingCharacter || {};
    const merged = {
      ...base,
      ...candidate,
      id: editingCharacterId || String(candidate.id || base.id || opaqueCharacterId()),
      ...(editingCharacterId && base.source !== undefined ? { source: base.source } : {})
    };
    populateCharacterForm(merged, false);
    setCharacterStatus("Character generated. Review every field, then save to update the world draft.", "success");
  } catch (error) {
    // Fields are populated only after a complete response has passed the client boundary checks.
    elements.characterName.value = previousName;
    elements.characterGuidance.value = previousGuidance;
    for (const [path, id] of Object.entries(CHARACTER_PROFILE_FIELDS)) {
      const value = profileValue(previousProfile, path);
      elements[id].value = Array.isArray(value) ? value.join(path === "identity.aliases" ? ", " : "\n") : String(value || "");
    }
    setCharacterStatus(error.statusCode === 409
      ? "The world draft changed while this modal was open. Your entries are still here; close and reload the world before trying again."
      : error.message || String(error), "error");
  } finally {
    setCharacterModalControls(false, false);
  }
}

function renderCharacterProfileReview(result) {
  characterProfileOrganizationResult = result;
  elements.characterProfileReviewList.replaceChildren();
  const existingProfile = profileFromForm();
  for (const [path] of Object.entries(CHARACTER_PROFILE_FIELDS)) {
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
  if (characterModalBusy) return;
  let character;
  try {
    character = characterFromForm();
  } catch (error) {
    setCharacterStatus(error.message || String(error), "error");
    return;
  }
  const campaignScope = characterModalScope === "campaign";
  if (campaignScope ? !selectedCampaign : !selectedWorld) return;
  const endpoint = campaignScope
    ? `/api/v1/campaigns/${selectedCampaign.id}/character-profile/organize`
    : `/api/v1/worlds/${selectedWorld.id}/draft/playable-characters/organize`;
  const expectedRevision = campaignScope ? campaignCharacterProfileRevision : selectedWorld.draftRevision;
  setCharacterModalControls(false, true);
  setCharacterProfileOrganizationProgress(true);
  setCharacterStatus("Organizing supplied facts into targeted profile fields…");
  try {
    const result = await api(endpoint, {
      method: "POST",
      body: JSON.stringify({ expectedRevision, character })
    });
    renderCharacterProfileReview(result);
    setCharacterStatus("Review the evidence-backed proposals before applying them.", "success");
  } catch (error) {
    setCharacterStatus(error.message || String(error), "error");
  } finally {
    setCharacterProfileOrganizationProgress(false);
    setCharacterModalControls(false, false);
  }
}

function applyCharacterProfileReview() {
  if (!characterProfileOrganizationResult) return;
  let appliedCount = 0;
  for (const checkbox of elements.characterProfileReviewList.querySelectorAll("[data-profile-path]:checked")) {
    const path = checkbox.dataset.profilePath;
    const id = CHARACTER_PROFILE_FIELDS[path];
    const value = profileValue(characterProfileOrganizationResult.candidate, path);
    elements[id].value = Array.isArray(value)
      ? value.join(path === "identity.aliases" ? ", " : "\n")
      : String(value || "");
    appliedCount += 1;
  }
  characterProfileOrganizationApplied = appliedCount > 0;
  elements.characterProfileReviewDialog.close();
  setCharacterStatus("Selected proposals applied to the unsaved form. Save the character to persist them.", "success");
}

async function openCampaignCharacterDialog() {
  if (!selectedCampaign) return;
  try {
    const result = await api(`/api/v1/campaigns/${selectedCampaign.id}/character-profile`);
    characterModalScope = "campaign";
    campaignCharacterProfileRevision = result.revision;
    editingCharacterId = result.characterId || "";
    characterProfileOrganizationResult = null;
    characterProfileOrganizationApplied = false;
    populateCharacterForm({
      id: result.characterId || "",
      name: result.name || "Player Character",
      characterText: result.legacyCharacterText || "",
      profile: result.profile || emptyCharacterProfile(),
      rpgStats: result.rpgStats || [],
      defaultTriggers: result.defaultTriggers || [],
      source: { type: "campaign-character-profile" }
    });
    elements.characterDialog.querySelector(".eyebrow").textContent = "Campaign";
    elements.characterDialogTitle.textContent = "Edit campaign character profile";
    elements.characterDialogDescription.textContent = "This editable campaign copy can diverge without changing its immutable world-version snapshot.";
    elements.characterGenerator.classList.add("hidden");
    elements.characterMechanicsFields.classList.add("hidden");
    elements.deleteCharacter.classList.add("hidden");
    elements.saveCharacter.classList.remove("hidden");
    elements.saveCharacter.textContent = "Save campaign profile";
    elements.cancelCharacter.textContent = "Cancel";
    setCharacterStatus();
    setCharacterModalControls(false);
    openManagedModal(elements.characterDialog);
    elements.characterName.focus();
  } catch (error) {
    campaignMessage(error.message || String(error), "error");
  }
}

async function saveCharacterFromModal(event) {
  event.preventDefault();
  if (characterModalBusy) return;
  let character;
  try {
    character = characterFromForm();
  } catch (error) {
    setCharacterStatus(error.message || String(error), "error");
    return;
  }
  if (characterModalScope === "campaign") {
    if (!selectedCampaign) return;
    setCharacterModalControls(false, true);
    setCharacterStatus("Saving campaign character profile…");
    try {
      const saved = await api(`/api/v1/campaigns/${selectedCampaign.id}/character-profile`, {
        method: "PUT",
        body: JSON.stringify({
          expectedRevision: campaignCharacterProfileRevision,
          name: character.name,
          profile: character.profile,
          editSource: characterProfileOrganizationApplied ? "ai_organized" : "manual"
        })
      });
      campaignCharacterProfileRevision = saved.revision;
      elements.characterDialog.close();
      await loadCampaigns(selectedCampaign.id);
      campaignMessage(`Campaign character profile saved at revision ${saved.revision}.`, "success");
    } catch (error) {
      setCharacterStatus(error.message || String(error), "error");
      setCharacterModalControls(false, false);
    }
    return;
  }
  if (!selectedWorld || selectedWorld.status === "archived") return;
  const content = worldContentFromForm();
  const roster = playableCharactersFromContent(content).map((item) => copyJsonValue(item));
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
  setCharacterModalControls(false, true);
  setCharacterStatus(editingCharacterId ? "Saving character changes…" : "Adding character to the world draft…");
  try {
    const saved = await persistWorldDraft({ ...content, playableCharacters: roster });
    const action = editingCharacterId ? "updated" : "added";
    elements.characterDialog.close();
    worldMessage(`${character.name} ${action} in draft revision ${saved.revision}. Published versions and existing campaigns remain unchanged.`, "success");
  } catch (error) {
    setCharacterStatus(error.statusCode === 409
      ? "The world draft changed while this modal was open. Your entries are still here; close and reload the world before saving."
      : error.message || String(error), "error");
    setCharacterModalControls(false, false);
  }
}

async function deleteCharacterFromModal() {
  if (!selectedWorld || !editingCharacterId || characterModalBusy || selectedWorld.status === "archived") return;
  const name = elements.characterName.value.trim() || "this character";
  if (!window.confirm(`Delete “${name}” from the current draft? Published versions and existing campaigns remain unchanged. Removing the last character makes this world unavailable for new campaigns until another character is added and published.`)) return;
  const content = worldContentFromForm();
  const roster = playableCharactersFromContent(content).filter((item) => item.id !== editingCharacterId);
  if (roster.length === playableCharactersFromContent(content).length) {
    setCharacterStatus("This character is no longer present in the selected draft.", "error");
    return;
  }
  setCharacterModalControls(false, true);
  setCharacterStatus("Deleting character from the world draft…");
  try {
    const saved = await persistWorldDraft({ ...content, playableCharacters: roster });
    elements.characterDialog.close();
    worldMessage(`${name} deleted from draft revision ${saved.revision}. Published versions and existing campaigns remain unchanged.`, "success");
  } catch (error) {
    setCharacterStatus(error.statusCode === 409
      ? "The world draft changed while this modal was open. Your entries are still here; close and reload the world before deleting."
      : error.message || String(error), "error");
    setCharacterModalControls(false, false);
  }
}

async function publishSelectedWorld() {
  if (!selectedWorld) return;
  elements.publishWorld.disabled = true;
  worldMessage("Publishing immutable world version…");
  try {
    const published = await api(`/api/v1/worlds/${selectedWorld.id}/publish`, {
      method: "POST",
      body: JSON.stringify({ expectedRevision: selectedWorld.draftRevision, releaseNotes: elements.worldReleaseNotes.value })
    });
    await loadWorlds(selectedWorld.id);
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
  const hasPublishedVersion = Boolean(selectedWorldVersionId());
  const hasRequiredSelection = worldVersionCharacters.length === 1 || Boolean(elements.newCampaignCharacter.value);
  elements.createCampaignModalBtn.disabled = !hasPublishedVersion || !worldVersionCampaignReady;
  elements.confirmCreateCampaign.disabled = !hasPublishedVersion || !worldVersionCampaignReady || !hasRequiredSelection;
}

function setWorldCampaignReadiness(message, type = "") {
  elements.worldCampaignReadiness.textContent = message;
  elements.worldCampaignReadiness.className = `status ${type}`.trim();
}

async function loadWorldVersionPlayableCharacters() {
  const sequence = ++playableCharacterLoadSequence;
  const worldVersionId = selectedWorldVersionId();
  worldVersionCharacters = [];
  worldVersionCampaignReady = false;
  elements.newCampaignCharacter.replaceChildren(new Option(worldVersionId ? "Loading characters…" : "Publish a world version first", ""));
  elements.newCampaignCharacter.disabled = true;
  updateCampaignCreationAvailability();
  if (!worldVersionId) {
    setWorldCampaignReadiness("Publish a world version with at least one playable character before creating a campaign.");
    return;
  }
  setWorldCampaignReadiness("Checking whether the selected world version is campaign-ready…");
  try {
    const response = await api(`/api/v1/world-versions/${worldVersionId}/playable-characters`);
    if (sequence !== playableCharacterLoadSequence || worldVersionId !== selectedWorldVersionId()) return;
    worldVersionCharacters = Array.isArray(response.characters) ? response.characters : [];
    const hasReadinessAssessment = response.readiness && typeof response.readiness.ready === "boolean";
    worldVersionCampaignReady = hasReadinessAssessment ? response.readiness.ready : worldVersionCharacters.length > 0;
    const firstReadinessIssue = Array.isArray(response.readiness?.issues) ? response.readiness.issues[0] : null;
    const firstReadinessIssueMessage = typeof firstReadinessIssue === "string"
      ? firstReadinessIssue
      : String(firstReadinessIssue?.message || "").trim();
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
    updateCampaignCreationAvailability();
  } catch (error) {
    if (sequence !== playableCharacterLoadSequence || worldVersionId !== selectedWorldVersionId()) return;
    worldVersionCharacters = [];
    worldVersionCampaignReady = false;
    elements.newCampaignCharacter.replaceChildren(new Option("Characters unavailable", ""));
    elements.newCampaignCharacterNote.textContent = error.message || String(error);
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
  try {
    const fork = await api(`/api/v1/worlds/${selectedWorld.id}/fork`, {
      method: "POST",
      body: JSON.stringify({ title, sourceWorldVersionId: selectedWorldVersionId() })
    });
    elements.forkWorldTitle.value = "";
    await loadWorlds(fork.worldId);
    worldMessage("Fork created as an unpublished independent draft.", "success");
    if (elements.forkWorldDialog) elements.forkWorldDialog.close();
  } catch (error) {
    worldMessage(error.message || String(error), "error");
  }
}

async function toggleWorldArchive() {
  if (!selectedWorld) return;
  const nextStatus = selectedWorld.status === "archived"
    ? (selectedWorld.versions.length ? "active" : "draft")
    : "archived";
  try {
    await api(`/api/v1/worlds/${selectedWorld.id}`, { method: "PATCH", body: JSON.stringify({ status: nextStatus }) });
    await loadWorlds(selectedWorld.id);
    worldMessage(nextStatus === "archived" ? "World archived. Existing campaigns remain available." : "World restored.", "success");
  } catch (error) {
    worldMessage(error.message || String(error), "error");
  }
}

async function deleteSelectedWorld() {
  if (!selectedWorld) return;
  if (Number(selectedWorld.campaignCount || worlds.find((world) => world.id === selectedWorld.id)?.campaignCount || 0)) {
    worldMessage("Delete every campaign using this world before deleting the world.", "error");
    return;
  }
  const expectedTitle = selectedWorld.title;
  const confirmed = await requestTypedDelete(expectedTitle, `This permanently deletes “${expectedTitle}”, its draft, and all published versions. This cannot be undone.`);
  if (!confirmed) return;
  elements.deleteWorld.disabled = true;
  try {
    await api(`/api/v1/worlds/${selectedWorld.id}`, {
      method: "DELETE",
      body: JSON.stringify({ confirmation: "DELETE", expectedTitle })
    });
    selectedWorld = null;
    await loadWorlds();
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
  const selectedCampaignId = selectedCampaign?.id || "";
  elements.deleteWorldVersion.disabled = true;
  worldMessage(`Deleting world version ${version.versionNumber}…`);
  try {
    await api(`/api/v1/worlds/${worldId}/versions/${version.id}`, {
      method: "DELETE",
      body: JSON.stringify({ confirmation: "DELETE", expectedVersionNumber: version.versionNumber })
    });
    await loadWorlds(worldId);
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
  const response = await fetch(path, { headers: { accept: "application/json" } });
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

async function createCampaignFromWorld() {
  if (!selectedWorld || !selectedWorldVersionId()) return;
  if (!worldVersionCampaignReady) {
    worldMessage(elements.worldCampaignReadiness.textContent || "This world version is not campaign-ready.", "error");
    return;
  }
  const title = elements.newCampaignTitle.value.trim();
  if (!title) {
    worldMessage("Enter a title for the new campaign.", "error");
    elements.newCampaignTitle.focus();
    return;
  }
  const selectedCharacterId = elements.newCampaignCharacter.value;
  if (worldVersionCharacters.length > 1 && !selectedCharacterId) {
    worldMessage("Choose a player character for the new campaign.", "error");
    elements.newCampaignCharacter.focus();
    return;
  }
  try {
    const campaign = await api("/api/v1/campaigns", {
      method: "POST",
      body: JSON.stringify({
        title,
        worldVersionId: selectedWorldVersionId(),
        turnControlStyle: elements.newCampaignTurnControlStyle.value,
        ...(selectedCharacterId ? { selectedCharacterId } : {})
      })
    });
    elements.newCampaignTitle.value = "";
    await loadCampaigns(campaign.id);
    worldMessage(`Campaign created for ${campaign.selectedCharacterName || "the selected character"} from the selected immutable world version.`, "success");
    if (elements.createCampaignDialog) elements.createCampaignDialog.close();
  } catch (error) {
    worldMessage(error.message || String(error), "error");
  }
}

async function loadCampaigns(preselectId = "") {
  ({ campaigns } = await api("/api/v1/campaigns"));
  renderDashboardCampaigns();
  void loadDashboardStats();
  elements.campaignList.replaceChildren();
  if (!campaigns.length) {
    elements.campaignList.innerHTML = '<p class="muted">No database-backed campaigns yet.</p>';
    selectedCampaign = null;
    updateStoryViewLink();
    [elements.campaignTitle, elements.campaignStatus, elements.campaignWorldVersion, elements.campaignTextProvider, elements.campaignTurnControlStyle, elements.campaignStoryLengthProfile, elements.saveCampaign, elements.migrateCampaign, elements.transferCampaign, elements.editCampaignCharacter, elements.loadCampaign, elements.exportCampaign, elements.deleteCampaign, elements.illustrationSourcePolicy, elements.campaignImageProvider, elements.illustrationModel, elements.illustrationSize, elements.illustrationAspectRatio, elements.illustrationQuality, elements.illustrationOutputFormat, elements.illustrationMaxAttempts, elements.illustrationMatchingScope, elements.illustrationConfidenceProfile, elements.illustrationRepetitionWindow, elements.illustrationSegmentWordCount, elements.illustrationImagesPerSegment, elements.illustrationSegmentPromptMode, elements.openIllustrationPromptEditor, elements.previewIllustrationBackfill, elements.previewIllustrationRebuild, elements.saveIllustrationConfig, elements.discoverIllustrationModels].forEach((element) => { element.disabled = true; });
    elements.illustrationSourcePolicy.value = "off";
    renderIllustrationSettingsVisibility();
    elements.campaignCostSection.classList.add("hidden");
    return;
  }
  for (const campaign of campaigns) {
    const button = document.createElement("button");
    button.className = "campaign-button";
    button.type = "button";
    button.dataset.campaignId = campaign.id;
    const title = document.createElement("strong");
    title.textContent = campaign.title;
    const details = document.createElement("span");
    details.textContent = `${campaign.activeTurnNumber} accepted turns · ${campaign.worldTitle} v${campaign.worldVersionNumber}${campaign.selectedCharacterName ? ` · ${campaign.selectedCharacterName}` : ""}${campaign.worldUpdateAvailable ? " · update available" : ""}${campaign.status === "archived" ? " · archived" : ""}`;
    button.append(title, details);
    button.addEventListener("click", () => selectCampaign(campaign));
    elements.campaignList.append(button);
  }
  const target = campaigns.find((campaign) => campaign.id === preselectId) || (selectedCampaign && campaigns.find((campaign) => campaign.id === selectedCampaign.id));
  if (target) await selectCampaign(target);
}

async function selectCampaign(campaign) {
  embeddingJobPollSequence += 1;
  elements.embeddingProgress.classList.add("hidden");
  selectedCampaign = campaign;
  updateStoryViewLink();
  document.querySelectorAll(".campaign-button").forEach((button) => button.classList.toggle("active", button.dataset.campaignId === campaign.id));
  elements.memoryTitle.textContent = campaign.title;
  elements.reindexMemory.disabled = false;
  elements.previewContext.disabled = false;
  elements.saveEmbeddingConfig.disabled = false;
  elements.saveIllustrationConfig.disabled = false;
  elements.campaignTitle.value = campaign.title;
  elements.campaignStatus.value = campaign.status;
  [elements.campaignTitle, elements.campaignStatus, elements.campaignWorldVersion, elements.campaignTextProvider, elements.campaignTurnControlStyle, elements.campaignStoryLengthProfile, elements.saveCampaign, elements.transferCampaign, elements.editCampaignCharacter, elements.loadCampaign, elements.exportCampaign, elements.deleteCampaign, elements.illustrationSourcePolicy, elements.campaignImageProvider, elements.illustrationModel, elements.illustrationSize, elements.illustrationAspectRatio, elements.illustrationQuality, elements.illustrationOutputFormat, elements.illustrationMaxAttempts, elements.illustrationMatchingScope, elements.illustrationConfidenceProfile, elements.illustrationRepetitionWindow, elements.illustrationSegmentWordCount, elements.illustrationImagesPerSegment, elements.illustrationSegmentPromptMode, elements.openIllustrationPromptEditor].forEach((element) => { element.disabled = false; });
  elements.campaignTextProvider.value = campaign.textProviderProfileId || "";
  elements.campaignImageProvider.value = campaign.imageProviderProfileId || "";
  elements.campaignTurnControlStyle.value = campaign.turnControlStyle || "flexible_auto";
  elements.campaignStoryLengthProfile.value = campaign.storyLengthProfile || "standard";
  applyStoryProviderContextBudget();
  populateEmbeddingProviderSelect();
  const world = await api(`/api/v1/worlds/${campaign.worldId}`);
  elements.campaignWorldVersion.replaceChildren();
  for (const version of [...world.versions].reverse()) {
    elements.campaignWorldVersion.append(new Option(`Version ${version.versionNumber}`, version.id));
  }
  elements.campaignWorldVersion.value = campaign.worldVersionId;
  elements.migrateCampaign.disabled = !world.versions.some((version) => version.versionNumber > campaign.worldVersionNumber);
  if (campaign.worldUpdateAvailable) campaignMessage(`This campaign is pinned to version ${campaign.worldVersionNumber}; version ${campaign.latestWorldVersionNumber} is available. Migration is explicit and does not rewrite accepted turns.`);
  else elements.campaignStatusMessage.classList.add("hidden");
  const metrics = await refreshCampaignMemoryMetrics();
  await refreshCampaignCostSummary();
  await loadEmbeddingConfig();
  if (["queued", "running"].includes(metrics?.semanticHealth?.jobStatus) && metrics.semanticHealth.jobId) {
    void resumeEmbeddingJobProgress(metrics.semanticHealth.jobId, campaign.id);
  }
  await loadIllustrationConfig();
  await loadLatestImageJob(false);
  await previewContext();
}

async function saveSelectedCampaign(event) {
  event.preventDefault();
  if (!selectedCampaign) return;
  elements.saveCampaign.disabled = true;
  try {
    await api(`/api/v1/campaigns/${selectedCampaign.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        title: elements.campaignTitle.value,
        status: elements.campaignStatus.value,
        textProviderProfileId: elements.campaignTextProvider.value || null,
        turnControlStyle: elements.campaignTurnControlStyle.value,
        storyLengthProfile: elements.campaignStoryLengthProfile.value
      })
    });
    await loadCampaigns(selectedCampaign.id);
    campaignMessage("Campaign metadata, turn input style, and default story length saved. Accepted turns and Chronicle memory were unchanged.", "success");
  } catch (error) {
    campaignMessage(error.message || String(error), "error");
  } finally {
    elements.saveCampaign.disabled = !selectedCampaign;
  }
}

async function migrateSelectedCampaign() {
  if (!selectedCampaign) return;
  const world = await api(`/api/v1/worlds/${selectedCampaign.worldId}`);
  const targetId = elements.campaignWorldVersion.value;
  const target = world.versions.find((version) => version.id === targetId);
  if (!target || target.versionNumber <= selectedCampaign.worldVersionNumber) {
    campaignMessage("Select a newer published version before migrating.", "error");
    return;
  }
  if (!window.confirm(`Migrate this campaign from world version ${selectedCampaign.worldVersionNumber} to version ${target.versionNumber}? Accepted turns will remain append-only.`)) return;
  elements.migrateCampaign.disabled = true;
  try {
    await api(`/api/v1/campaigns/${selectedCampaign.id}/migrate-world`, {
      method: "POST",
      body: JSON.stringify({ worldVersionId: target.id, note: "Explicit migration from the World Library interface." })
    });
    await loadCampaigns(selectedCampaign.id);
    campaignMessage(`Campaign migrated to world version ${target.versionNumber}. The next generation will bootstrap a fresh model chain from database state.`, "success");
  } catch (error) {
    campaignMessage(error.message || String(error), "error");
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
  const worldId = elements.transferTargetWorld.value;
  resetTransferPreview(worldId ? "Loading published versions…" : undefined);
  elements.transferTargetVersion.replaceChildren(new Option(worldId ? "Loading published versions…" : "Select a target world first", ""));
  elements.transferTargetVersion.disabled = true;
  if (!worldId) return;
  try {
    const world = await api(`/api/v1/worlds/${worldId}`);
    elements.transferTargetVersion.replaceChildren(new Option("Select a published version", ""));
    for (const version of [...(world.versions || [])].reverse()) {
      elements.transferTargetVersion.append(new Option(`Version ${version.versionNumber}${version.releaseNotes ? ` · ${version.releaseNotes}` : ""}`, version.id));
    }
    elements.transferTargetVersion.disabled = !(world.versions || []).length;
    resetTransferPreview((world.versions || []).length ? undefined : "This world has no published version available for transfer.");
  } catch (error) {
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
    await Promise.all([loadWorlds(), loadCampaigns(result.targetCampaignId)]);
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
    await downloadJson(`/api/v1/campaigns/${selectedCampaign.id}/export`, "infinite-quest-campaign.json");
    campaignMessage("Portable campaign exported without provider profiles or credentials.", "success");
  } catch (error) {
    campaignMessage(error.message || String(error), "error");
  }
}

async function loadSelectedCampaign() {
  if (!selectedCampaign) return;
  window.location.assign("/story/" + encodeURIComponent(selectedCampaign.id));
}

async function deleteSelectedCampaign() {
  if (!selectedCampaign) return;
  const campaignId = selectedCampaign.id;
  const expectedTitle = selectedCampaign.title;
  const confirmed = await requestTypedDelete(expectedTitle, `This permanently deletes “${expectedTitle}”, its accepted turns, Chronicle memory, and generated asset records. This cannot be undone.`);
  if (!confirmed) return;
  elements.deleteCampaign.disabled = true;
  try {
    await api(`/api/v1/campaigns/${campaignId}`, {
      method: "DELETE",
      body: JSON.stringify({ confirmation: "DELETE", expectedTitle })
    });
    selectedCampaign = null;
    updateStoryViewLink();
    await loadCampaigns();
    await loadWorlds(selectedWorld?.id || "");
    campaignMessage(`Campaign “${expectedTitle}” was permanently deleted.`, "success");
  } catch (error) {
    campaignMessage(error.message || String(error), "error");
    elements.deleteCampaign.disabled = !selectedCampaign;
  }
}

function renderSemanticMemoryHealth(health) {
  const state = health?.status || "disabled";
  const labels = {
    disabled: "Disabled",
    indexing: "Indexing",
    healthy: "Healthy",
    degraded: "Degraded",
    failed: "Failed",
    unavailable: "Unavailable"
  };
  elements.semanticMemoryHealth.dataset.state = state;
  elements.semanticMemoryHealthBadge.textContent = labels[state] || state;
  elements.semanticMemoryHealthTitle.textContent = state === "healthy"
    ? `Semantic memory healthy · ${number(health.coveragePercent)}% coverage`
    : state === "indexing"
      ? `Semantic indexing in progress · ${number(health.coveragePercent)}% available`
      : state === "disabled"
        ? "Semantic memory disabled"
        : `Semantic memory ${labels[state]?.toLowerCase() || state}`;
  const provider = health?.providerName ? ` Provider: ${health.providerName}${health.model ? ` · ${health.model}` : ""}.` : "";
  elements.semanticMemoryHealthMessage.textContent = `${health?.message || "Semantic memory status is unavailable."}${provider}`;
}

async function refreshCampaignMemoryMetrics() {
  if (!selectedCampaign) return null;
  const campaignId = selectedCampaign.id;
  const metrics = await api(`/api/v1/campaigns/${campaignId}/memory/metrics`);
  if (selectedCampaign?.id !== campaignId) return null;
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

async function refreshCampaignCostSummary() {
  if (!selectedCampaign) {
    elements.campaignCostSection.classList.add("hidden");
    return null;
  }
  const campaignId = selectedCampaign.id;
  const summary = await api(`/api/v1/campaigns/${campaignId}/cost-summary`);
  if (selectedCampaign?.id !== campaignId) return null;
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
    appendCostMetric(money(total.byCategory?.memory || 0, total.currency), `semantic memory${suffix}`);
    appendCostMetric(money(total.historicalAndUnattributedOperations || total.otherCampaignOperations || 0, total.currency), `historical & unattributed operations${suffix}`);
  }
  return summary;
}

async function loadEmbeddingConfig() {
  if (!selectedCampaign) return;
  embeddingConfig = await api(`/api/v1/campaigns/${selectedCampaign.id}/memory/embedding-config`);
  discoveredEmbeddingModels = [];
  elements.embeddingEnabled.checked = embeddingConfig.enabled;
  populateEmbeddingProviderSelect();
  if (embeddingConfig.providerProfileId) elements.embeddingProvider.value = embeddingConfig.providerProfileId;
  elements.embeddingModel.value = embeddingConfig.model || "text-embedding-nomic-embed-text-v1.5";
  elements.embeddingDocumentPrefix.value = embeddingConfig.documentPrefix ?? "";
  elements.embeddingQueryPrefix.value = embeddingConfig.queryPrefix ?? "";
  elements.embeddingBatchSize.value = String(embeddingConfig.batchSize || 16);
  elements.discoverEmbeddingModels.disabled = !elements.embeddingProvider.value;
  elements.embeddingModel.disabled = !elements.embeddingProvider.value;
  const embeddingProvider = providers.find((provider) => provider.id === elements.embeddingProvider.value);
  const fallbackLabel = embeddingProvider?.providerRole === "text" ? `text provider ${embeddingProvider.name}` : embeddingProvider?.name;
  elements.embeddingStatus.className = "status";
  elements.embeddingStatus.textContent = embeddingConfig.enabled
    ? `Hybrid retrieval is enabled with ${fallbackLabel || "the selected provider"} and ${embeddingConfig.model}. Effective task prefixes: document “${embeddingConfig.effectiveDocumentPrefix || "none"}”, query “${embeddingConfig.effectiveQueryPrefix || "none"}”. New accepted memories are indexed by a durable worker job.`
    : `Semantic retrieval is disabled for this campaign. When enabled, it will use ${fallbackLabel || "the selected provider"} with ${embeddingConfig.model}; deterministic lexical and chronological retrieval remains active.`;
}

async function loadIllustrationConfig() {
  if (!selectedCampaign) return;
  illustrationConfig = await api(`/api/v1/campaigns/${selectedCampaign.id}/illustration-config`);
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
  defaultIllustrationRefinementPrompt = illustrationConfig.defaultRefinementPrompt || illustrationConfig.refinementPrompt || "";
  illustrationRefinementPromptValue = illustrationConfig.refinementPrompt || defaultIllustrationRefinementPrompt;
  elements.illustrationRefinementPrompt.value = illustrationRefinementPromptValue;
  renderIllustrationPromptSummary();
  syncIllustrationProviderAvailability(true);
  const provider = effectiveCampaignProvider("image");
  elements.campaignImageProviderSummary.textContent = provider
    ? `Using ${provider.name}${selectedCampaign?.imageProviderProfileId ? " for this campaign" : " as the default image profile"}.`
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
}

function illustrationPolicyUsesLibrary(policy = elements.illustrationSourcePolicy.value) {
  return policy === "library_only" || policy === "library_then_generate";
}

function illustrationPolicyUsesProvider(policy = elements.illustrationSourcePolicy.value) {
  return policy === "library_then_generate" || policy === "generate_only";
}

function renderIllustrationPromptSummary() {
  const usesDefault = illustrationRefinementPromptValue.trim() === defaultIllustrationRefinementPrompt.trim();
  elements.illustrationRefinementPromptSummary.textContent = usesDefault
    ? "Using the default refinement prompt."
    : "Using a custom campaign prompt.";
}

function openIllustrationPromptEditor() {
  elements.promptLibraryScope.value = "campaign";
  syncPromptLibraryCampaigns();
  elements.promptLibraryCampaign.value = selectedCampaign?.id || "";
  selectedPromptTemplateKey = "illustration_refinement";
  window.location.hash = "#prompt-library";
}

function applyIllustrationPrompt(event) {
  event.preventDefault();
  const prompt = elements.illustrationRefinementPrompt.value.trim();
  if (!prompt) {
    elements.illustrationRefinementPrompt.setCustomValidity("Enter an image-prompt refinement prompt.");
    elements.illustrationRefinementPrompt.reportValidity();
    return;
  }
  elements.illustrationRefinementPrompt.setCustomValidity("");
  illustrationRefinementPromptValue = prompt;
  renderIllustrationPromptSummary();
  elements.illustrationPromptDialog.close("apply");
}

function restoreDefaultIllustrationPrompt() {
  elements.illustrationRefinementPrompt.value = defaultIllustrationRefinementPrompt;
  elements.illustrationRefinementPrompt.setCustomValidity("");
  elements.illustrationRefinementPrompt.focus();
}

function renderIllustrationSettingsVisibility() {
  const policy = elements.illustrationSourcePolicy.value;
  const settingsVisible = Boolean(selectedCampaign);
  const automaticIllustrationsActive = policy !== "off";
  elements.illustrationSettings.classList.toggle("hidden", !settingsVisible);
  elements.illustrationSettings.setAttribute("aria-hidden", String(!settingsVisible));
  elements.illustrationMatchingSettings.classList.toggle("hidden", !automaticIllustrationsActive || !illustrationPolicyUsesLibrary(policy));
  elements.illustrationProviderSettings.classList.toggle("hidden", !automaticIllustrationsActive || !illustrationPolicyUsesProvider(policy));
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
  elements.providerStatus.textContent = message;
  elements.providerStatus.className = `status ${type}`.trim();
}

function providerTypeLabel(providerType) {
  return providerType === "sogni" ? "Sogni Creative Workflow (REST)"
    : providerType === "sogni_sdk" ? "Sogni Supernet SDK"
      : providerType;
}

function applyDiscoveredProviderContext() {
  const option = elements.modelSelect.selectedOptions[0];
  const contextLength = Number(option?.dataset.contextLength || 0);
  const model = discoveredProviderModels.find((item) => (item.loaded ? item.instanceId : item.id) === elements.modelSelect.value);
  if (model) elements.providerDefaultModel.value = model.id;
  if (contextLength > 0) {
    elements.providerContextTokens.value = String(contextLength);
    elements.providerContextTokens.readOnly = true;
    elements.providerContextTokens.setAttribute("aria-readonly", "true");
    elements.providerContextSource.textContent = `Locked to ${number(contextLength)} tokens advertised by the selected model.`;
    elements.providerContextSource.className = "field-note api-supplied";
  } else {
    elements.providerContextTokens.readOnly = false;
    elements.providerContextTokens.removeAttribute("aria-readonly");
    elements.providerContextSource.textContent = "The model API did not advertise a context length; enter the loaded context manually.";
    elements.providerContextSource.className = "field-note manual-entry";
  }
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
  const emptyLabel = fallback
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
  const embeddingProviders = enabledProviders("embedding");
  elements.embeddingProvider.replaceChildren();
  if (embeddingProviders.length) {
    const fallback = defaultProvider("embedding");
    elements.embeddingProvider.append(new Option(fallback ? `Use default · ${fallback.name}` : "Select an embedding provider", ""));
    for (const provider of embeddingProviders) {
      elements.embeddingProvider.append(new Option(`${provider.name} · ${providerTypeLabel(provider.providerType)}${provider.isDefault ? " · default" : ""}`, provider.id));
    }
    elements.embeddingProvider.value = embeddingProviders.some((provider) => provider.id === current) ? current : (fallback?.id || "");
    return;
  }
  const textFallback = effectiveCampaignProvider("text");
  if (textFallback) {
    elements.embeddingProvider.append(new Option(`Text fallback · ${textFallback.name} · ${textFallback.providerType}`, textFallback.id));
    elements.embeddingProvider.value = textFallback.id;
  } else {
    elements.embeddingProvider.append(new Option("No text or embedding provider configured", ""));
  }
}

function renderProviderProfiles() {
  elements.providerProfileList.replaceChildren();
  if (!providers.length) {
    elements.providerProfileList.innerHTML = '<p class="muted">No provider profiles have been added.</p>';
    return;
  }
  for (const provider of providers) {
    const row = document.createElement("div");
    row.className = "provider-profile";
    const details = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = provider.name;
    const summary = document.createElement("span");
    summary.textContent = `${provider.providerRole} · ${providerTypeLabel(provider.providerType)} · ${provider.defaultModel || "model not selected"} · ${Number(provider.requestTimeoutMs || 300000) / 60000} min timeout`;
    details.append(title, summary);
    const actions = document.createElement("div");
    actions.className = "button-row";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "button secondary";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => beginProviderEdit(provider));
    actions.append(edit);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "button danger";
    remove.textContent = "Delete";
    remove.addEventListener("click", async () => {
      const impact = provider.providerRole === "intent"
        ? "Future Auto decisions will fall back to each campaign's Story text provider. Existing turns are unchanged."
        : "Campaign assignments and provider-linked jobs, chains, or derived data may be removed.";
      if (!window.confirm(`Delete provider profile “${provider.name}”? ${impact}`)) return;
      remove.disabled = true;
      try {
        await api(`/api/v1/providers/${provider.id}`, { method: "DELETE" });
        if (editingProviderId === provider.id) resetProviderForm();
        await loadProviders();
        providerMessage(`${provider.name} deleted. Campaigns now use another default profile when available.`, "success");
      } catch (error) {
        providerMessage(error.message || String(error), "error");
        remove.disabled = false;
      }
    });
    actions.append(remove);
    const implicitlyDefault = provider.providerRole !== "intent" && enabledProviders(provider.providerRole).length === 1;
    if (provider.isDefault || implicitlyDefault) {
      const badge = document.createElement("span");
      badge.className = "default-badge";
      badge.textContent = provider.isDefault ? "System default" : "Default (only profile)";
      details.append(badge);
      row.append(details, actions);
    } else {
      if (provider.providerRole === "intent") {
        const inactive = document.createElement("span");
        inactive.className = "default-badge";
        inactive.textContent = "Inactive · Story text fallback";
        details.append(inactive);
      }
      const makeDefault = document.createElement("button");
      makeDefault.type = "button";
      makeDefault.className = "button secondary";
      makeDefault.textContent = provider.providerRole === "intent" ? "Make system default" : "Make default";
      makeDefault.addEventListener("click", async () => {
        makeDefault.disabled = true;
        await api(`/api/v1/providers/${provider.id}/default`, { method: "PUT", body: "{}" });
        await loadProviders();
        providerMessage(`${provider.name} is now the default ${provider.providerRole} profile.`, "success");
      });
      actions.append(makeDefault);
      row.append(details, actions);
    }
    elements.providerProfileList.append(row);
  }
}

function resetProviderForm() {
  editingProviderId = "";
  elements.providerForm.reset();
  elements.providerName.value = "Local LM Studio";
  elements.providerType.value = "lmstudio";
  elements.providerRole.value = "text";
  elements.providerBaseUrl.value = "http://host.docker.internal:1234";
  elements.providerContextTokens.value = "32768";
  elements.providerOutputTokens.value = "4096";
  elements.providerTemperature.value = "0.8";
  elements.providerRequestTimeoutMinutes.value = "5";
  applySogniConfiguration(SOGNI_DEFAULT_CONFIGURATION);
  elements.providerAdvancedSettings.open = false;
  elements.providerStreaming.checked = false;
  elements.providerEnabled.checked = true;
  elements.providerType.disabled = false;
  elements.providerRole.disabled = false;
  elements.saveProvider.textContent = "Save provider";
  elements.cancelProviderEdit.classList.add("hidden");
  discoveredProfileModels = [];
  elements.providerModelPickerList.replaceChildren();
  elements.providerContextTokens.readOnly = false;
  elements.providerContextSource.textContent = "Editable until model discovery supplies a context length.";
  elements.providerContextSource.className = "field-note";
  syncProviderRoleSettings();
}

function syncProviderRoleSettings(options = {}) {
  const sogniRest = elements.providerType.value === "sogni";
  const sogniSdk = elements.providerType.value === "sogni_sdk";
  const sogni = sogniRest || sogniSdk;
  if (sogni) elements.providerRole.value = "image";
  const illustration = elements.providerRole.value === "image";
  const intent = elements.providerRole.value === "intent";
  elements.providerRoleNote.textContent = intent
    ? "Classifies Auto as Action or Scene direction only. It never generates story narration. Until explicitly made system default, Auto uses the campaign Story text provider."
    : elements.providerRole.value === "image"
      ? "Illustration providers are independent from story text and use separate credentials."
      : elements.providerRole.value === "embedding"
        ? "Embedding providers index Chronicle memory and do not generate narration."
        : "Story text providers generate narration and are the fallback for Auto classification.";
  elements.providerStreaming.disabled = intent || sogni;
  if (intent || sogni) elements.providerStreaming.checked = false;
  elements.providerRole.disabled = Boolean(editingProviderId) || sogni;
  for (const field of document.querySelectorAll(".text-model-setting")) {
    field.classList.toggle("hidden", illustration);
    field.hidden = illustration;
    field.setAttribute("aria-hidden", String(illustration));
  }
  elements.providerSogniSettings.classList.toggle("hidden", !sogni);
  elements.providerSogniSettings.setAttribute("aria-hidden", String(!sogni));
  for (const control of elements.providerSogniSettings.querySelectorAll("input, select")) control.disabled = !sogni;
  elements.providerSogniSdkSettings.classList.toggle("hidden", !sogniSdk);
  elements.providerSogniSdkSettings.setAttribute("aria-hidden", String(!sogniSdk));
  for (const control of elements.providerSogniSdkSettings.querySelectorAll("input, select")) control.disabled = !sogniSdk;
  elements.providerSogniRestNote.classList.toggle("hidden", !sogniRest);
  elements.providerSogniSdkNote.classList.toggle("hidden", !sogniSdk);
  elements.providerSogniWebpFormat.hidden = !sogniSdk;
  elements.providerSogniWebpFormat.disabled = !sogniSdk;
  if (sogniRest && elements.providerSogniOutputFormat.value === "webp") elements.providerSogniOutputFormat.value = "png";
  if (intent && options.applySuggestedDefaults) {
    elements.providerContextTokens.value = "8192";
    elements.providerOutputTokens.value = "256";
    elements.providerTemperature.value = "0";
  }
}

function isIllustrationProviderForm() {
  return elements.providerRole.value === "image";
}

function applySogniConfiguration(configuration = {}, providerType = elements.providerType.value) {
  const config = { ...(providerType === "sogni_sdk" ? SOGNI_SDK_DEFAULT_CONFIGURATION : SOGNI_DEFAULT_CONFIGURATION), ...configuration };
  elements.providerSogniWidth.value = String(config.defaultWidth);
  elements.providerSogniHeight.value = String(config.defaultHeight);
  elements.providerSogniAspectRatio.value = config.defaultAspectRatio;
  elements.providerSogniImageCount.value = String(config.defaultImageCount);
  elements.providerSogniOutputFormat.value = config.defaultOutputFormat;
  elements.providerSogniQuality.value = config.defaultQuality;
  elements.providerSogniNetwork.value = config.network || "fast";
  elements.providerSogniTokenType.value = config.tokenType || "auto";
  elements.providerSogniContentFilter.value = config.contentFilter || "enabled";
  const configuredSizePreset = config.defaultSizePreset || "custom";
  elements.providerSogniSizePreset.replaceChildren(new Option("Custom dimensions", "custom"));
  if (configuredSizePreset !== "custom") elements.providerSogniSizePreset.append(new Option(configuredSizePreset, configuredSizePreset));
  elements.providerSogniSizePreset.value = configuredSizePreset;
  elements.providerSogniSteps.value = config.defaultSteps ?? "";
  elements.providerSogniGuidance.value = config.defaultGuidance ?? "";
  elements.providerSogniSeed.value = config.defaultSeed ?? "";
  elements.providerSogniSampler.replaceChildren(new Option("Model default", ""));
  if (config.defaultSampler) elements.providerSogniSampler.append(new Option(config.defaultSampler, config.defaultSampler));
  elements.providerSogniSampler.value = config.defaultSampler || "";
  elements.providerSogniScheduler.replaceChildren(new Option("Model default", ""));
  if (config.defaultScheduler) elements.providerSogniScheduler.append(new Option(config.defaultScheduler, config.defaultScheduler));
  elements.providerSogniScheduler.value = config.defaultScheduler || "";
  elements.providerSogniPreviewCount.value = String(config.defaultPreviewCount || 0);
  elements.providerSogniPollIntervalSeconds.value = String(Number(config.pollIntervalMs) / 1000);
  elements.providerSogniMaximumPollIntervalSeconds.value = String(Number(config.maximumPollIntervalMs) / 1000);
  elements.providerSogniGenerationTimeoutSeconds.value = String(Number(config.generationTimeoutMs) / 1000);
  elements.providerSogniMaximumAttempts.value = String(config.maximumAttempts);
  elements.providerSogniModelDiscoveryEnabled.checked = config.modelDiscoveryEnabled !== false;
}

function providerConfigurationFromForm(existingConfig = {}) {
  const configuration = { ...existingConfig, streaming: elements.providerStreaming.checked };
  const providerType = elements.providerType.value;
  if (providerType !== "sogni" && providerType !== "sogni_sdk") return configuration;
  const common = {
    ...configuration,
    defaultWidth: Number(elements.providerSogniWidth.value),
    defaultHeight: Number(elements.providerSogniHeight.value),
    defaultAspectRatio: elements.providerSogniAspectRatio.value.trim(),
    defaultImageCount: Number(elements.providerSogniImageCount.value),
    defaultOutputFormat: elements.providerSogniOutputFormat.value,
    defaultQuality: elements.providerSogniQuality.value,
    pollIntervalMs: Math.round(Number(elements.providerSogniPollIntervalSeconds.value) * 1000),
    maximumPollIntervalMs: Math.round(Number(elements.providerSogniMaximumPollIntervalSeconds.value) * 1000),
    generationTimeoutMs: Math.round(Number(elements.providerSogniGenerationTimeoutSeconds.value) * 1000),
    maximumAttempts: Number(elements.providerSogniMaximumAttempts.value),
    modelDiscoveryEnabled: elements.providerSogniModelDiscoveryEnabled.checked
  };
  delete common.sensitiveContentFilter;
  delete common.workflowSafeContentFilterSupported;
  if (providerType === "sogni") return common;
  const sdkConfiguration = {
    ...common,
    network: elements.providerSogniNetwork.value,
    tokenType: elements.providerSogniTokenType.value,
    contentFilter: elements.providerSogniContentFilter.value,
    defaultSizePreset: elements.providerSogniSizePreset.value.trim() || "custom",
    ...(elements.providerSogniSteps.value ? { defaultSteps: Number(elements.providerSogniSteps.value) } : {}),
    ...(elements.providerSogniGuidance.value ? { defaultGuidance: Number(elements.providerSogniGuidance.value) } : {}),
    ...(elements.providerSogniSeed.value ? { defaultSeed: Number(elements.providerSogniSeed.value) } : {}),
    defaultSampler: elements.providerSogniSampler.value.trim(),
    defaultScheduler: elements.providerSogniScheduler.value.trim(),
    defaultPreviewCount: Number(elements.providerSogniPreviewCount.value)
  };
  for (const key of ["defaultSteps", "defaultGuidance", "defaultSeed"]) {
    if (!elements[{ defaultSteps: "providerSogniSteps", defaultGuidance: "providerSogniGuidance", defaultSeed: "providerSogniSeed" }[key]].value) delete sdkConfiguration[key];
  }
  return sdkConfiguration;
}

function beginProviderEdit(provider) {
  editingProviderId = provider.id;
  elements.providerName.value = provider.name;
  elements.providerType.value = provider.providerType;
  elements.providerRole.value = provider.providerRole;
  elements.providerBaseUrl.value = provider.baseUrl;
  elements.providerApiKey.value = "";
  elements.providerDefaultModel.value = provider.defaultModel || "";
  elements.providerContextTokens.value = String(provider.contextWindowTokens);
  elements.providerOutputTokens.value = String(provider.maxOutputTokens);
  elements.providerTemperature.value = String(provider.temperature);
  elements.providerRequestTimeoutMinutes.value = String(Number(provider.requestTimeoutMs || 300000) / 60000);
  applySogniConfiguration(provider.configuration, provider.providerType);
  elements.providerStreaming.checked = Boolean(provider.configuration?.streaming || provider.configuration?.streamingSupport);
  elements.providerEnabled.checked = provider.enabled;
  elements.providerIsDefault.checked = provider.isDefault;
  elements.providerType.disabled = true;
  elements.providerRole.disabled = true;
  elements.saveProvider.textContent = "Save changes";
  elements.cancelProviderEdit.classList.remove("hidden");
  discoveredProfileModels = [];
  elements.providerModelPickerList.replaceChildren();
  elements.providerName.focus();
  openManagedModal(elements.providerDialog);
  providerMessage(`Editing ${provider.name}. Leave the API key blank to keep the stored credential.`);
  syncProviderRoleSettings();
}

async function loadProviders(preselectId = "") {
  ({ providers } = await api("/api/v1/providers"));
  renderProviderProfiles();
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
  if (target) providerMessage(`${target.name} selected. Profile context is ${number(target.contextWindowTokens)} tokens; maximum output is ${number(target.maxOutputTokens)} tokens.`);
  if (selectedCampaign) {
    elements.campaignTextProvider.value = selectedCampaign.textProviderProfileId || "";
    elements.campaignImageProvider.value = selectedCampaign.imageProviderProfileId || "";
    syncIllustrationProviderAvailability(true);
  }
  populateEmbeddingProviderSelect();
}

async function saveProvider(event) {
  event.preventDefault();
  providerMessage("Saving provider profile…");
  try {
    const existingConfig = editingProviderId ? (providers.find((item) => item.id === editingProviderId)?.configuration || {}) : {};
    const provider = await api(editingProviderId ? `/api/v1/providers/${editingProviderId}` : "/api/v1/providers", {
      method: editingProviderId ? "PATCH" : "POST",
      body: JSON.stringify({
        name: elements.providerName.value,
        ...(!editingProviderId ? { providerType: elements.providerType.value, providerRole: elements.providerRole.value } : {}),
        baseUrl: elements.providerBaseUrl.value,
        apiKey: elements.providerApiKey.value || undefined,
        isDefault: elements.providerIsDefault.checked,
        defaultModel: elements.providerDefaultModel.value,
        ...(!isIllustrationProviderForm() ? {
          contextWindowTokens: elements.providerContextTokens.value,
          maxOutputTokens: elements.providerOutputTokens.value,
          temperature: elements.providerTemperature.value
        } : {}),
        requestTimeoutMs: Math.round(Number(elements.providerRequestTimeoutMinutes.value) * 60000),
        enabled: elements.providerEnabled.checked,
        configuration: providerConfigurationFromForm(existingConfig)
      })
    });
    const wasEditing = Boolean(editingProviderId);
    resetProviderForm();
    await loadProviders(provider.providerRole === "text" ? provider.id : "");
    if (provider.providerRole === "embedding") {
      elements.embeddingProvider.value = provider.id;
      elements.embeddingModel.value = provider.defaultModel || "";
      elements.embeddingModel.disabled = false;
      elements.discoverEmbeddingModels.disabled = false;
      discoveredEmbeddingModels = [];
    }
    if (provider.providerRole === "image") {
      elements.campaignImageProvider.value = provider.id;
      elements.illustrationModel.value = provider.defaultModel || "";
      elements.discoverIllustrationModels.disabled = false;
    }
    providerMessage(`${provider.name} ${wasEditing ? "updated" : "saved"}. Credentials, if supplied, were encrypted before database storage.`, "success");
    if (elements.providerDialog) elements.providerDialog.close();
  } catch (error) {
    providerMessage(error.message || String(error), "error");
  }
}

async function refreshProviderModelsFromForm() {
  elements.refreshProviderModels.disabled = true;
  elements.refreshProviderModelDialog.disabled = true;
  providerMessage("Discovering models from this provider profile…");
  elements.providerModelPickerStatus.textContent = "Discovering active and inactive models from the endpoint…";
  elements.providerModelPickerStatus.className = "status";
  try {
    const useStoredProfile = editingProviderId && !elements.providerApiKey.value;
    const existingConfig = editingProviderId ? (providers.find((item) => item.id === editingProviderId)?.configuration || {}) : {};
    const result = useStoredProfile
      ? await api(`/api/v1/providers/${editingProviderId}/models`)
      : await api("/api/v1/providers/discover-models", {
        method: "POST",
        body: JSON.stringify({
          name: elements.providerName.value || "Unsaved provider",
          providerType: elements.providerType.value,
          providerRole: elements.providerRole.value,
          baseUrl: elements.providerBaseUrl.value,
          apiKey: elements.providerApiKey.value || undefined,
          defaultModel: elements.providerDefaultModel.value,
          ...(!isIllustrationProviderForm() ? {
            contextWindowTokens: elements.providerContextTokens.value,
            maxOutputTokens: elements.providerOutputTokens.value,
            temperature: elements.providerTemperature.value
          } : {}),
          requestTimeoutMs: Math.round(Number(elements.providerRequestTimeoutMinutes.value) * 60000),
          enabled: elements.providerEnabled.checked,
          isDefault: elements.providerIsDefault.checked,
          configuration: providerConfigurationFromForm(existingConfig)
        })
    });
    discoveredProfileModels = result.models || [];
    const orderedModels = [...discoveredProfileModels].sort((left, right) => Number(right.loaded) - Number(left.loaded) || left.displayName.localeCompare(right.displayName));
    const current = elements.providerDefaultModel.value.trim();
    const selected = orderedModels.find((model) => profileModelValue(model) === current || model.id === current)
      || orderedModels.find((model) => model.loaded)
      || orderedModels[0]
      || null;
    if (selected) {
      const value = profileModelValue(selected);
      elements.providerDefaultModel.value = value;
      applySogniSdkModelOptions(selected);
    }
    applyProfileModelContext();
    renderProviderModelPicker();
    elements.providerModelPickerStatus.textContent = `${discoveredProfileModels.length} model entr${discoveredProfileModels.length === 1 ? "y" : "ies"} found. Active models are listed first.`;
    elements.providerModelPickerStatus.className = "status success";
    providerMessage(`${discoveredProfileModels.length} model entr${discoveredProfileModels.length === 1 ? "y" : "ies"} found. Select one from Default model and save the profile.`, "success");
  } catch (error) {
    providerMessage(error.message || String(error), "error");
    elements.providerModelPickerStatus.textContent = error.message || String(error);
    elements.providerModelPickerStatus.className = "status error";
  } finally {
    elements.refreshProviderModels.disabled = false;
    elements.refreshProviderModelDialog.disabled = false;
  }
}

function profileModelValue(model) {
  return String(model?.loaded ? model.instanceId || model.id : model?.id || "");
}

function activeModelPickerModels() {
  return providerModelPickerTarget === "embedding" ? discoveredEmbeddingModels : discoveredProfileModels;
}

function activeModelPickerValue() {
  return providerModelPickerTarget === "embedding"
    ? elements.embeddingModel.value.trim()
    : elements.providerDefaultModel.value.trim();
}

function chooseProviderModel(value) {
  if (providerModelPickerTarget === "embedding") {
    elements.embeddingModel.value = value;
    const model = discoveredEmbeddingModels.find((item) => profileModelValue(item) === value || item.id === value);
    elements.providerModelDialog.close();
    elements.embeddingStatus.className = "status";
    elements.embeddingStatus.textContent = `${value} selected for campaign embeddings. Save & index to apply this change${model?.contextLength ? `; its advertised ${number(model.contextLength)}-token limit applies only to embedding requests` : ""}.`;
    return;
  }
  elements.providerDefaultModel.value = value;
  applyProfileModelContext();
  applySogniSdkModelOptions(discoveredProfileModels.find((item) => profileModelValue(item) === value || item.id === value));
  elements.providerModelDialog.close();
  providerMessage(`${value} selected as the profile default. Save the profile to keep this change.`);
}

function applySogniWorkerTypeOptions(model) {
  if (elements.providerType.value !== "sogni_sdk") return;
  const selectedType = elements.providerSogniNetwork.value || "fast";
  const workerTypes = model?.workerAvailability?.length ? model.workerAvailability : [
    {
      type: "fast",
      displayName: "Fast GPU workers",
      description: "High-end GPU workers that generate images faster at a higher cost."
    },
    {
      type: "relaxed",
      displayName: "Relaxed Mac workers",
      description: "Mac workers that generate images more slowly at a lower cost."
    }
  ];
  elements.providerSogniNetwork.replaceChildren();
  for (const workerType of workerTypes) {
    const count = Number(workerType.workerCount);
    const countLabel = Number.isFinite(count) ? ` · ${number(count)} available` : "";
    const option = new Option(`${workerType.displayName}${countLabel}`, workerType.type);
    option.title = workerType.description;
    elements.providerSogniNetwork.append(option);
  }
  elements.providerSogniNetwork.value = workerTypes.some((item) => item.type === selectedType) ? selectedType : workerTypes[0]?.type || "fast";
  const selected = workerTypes.find((item) => item.type === elements.providerSogniNetwork.value);
  const selectedCount = Number(selected?.workerCount);
  const availability = Number.isFinite(selectedCount)
    ? ` ${number(selectedCount)} worker${selectedCount === 1 ? "" : "s"} currently available for this model.`
    : "";
  elements.providerSogniWorkerTypeNote.textContent = `${selected?.description || ""}${availability}`.trim();
  elements.providerSogniWorkerTypeNote.title = selected?.description || "";
}

function applySogniWorkerAvailability() {
  if (elements.providerType.value !== "sogni_sdk") return;
  const selectedType = elements.providerSogniNetwork.value;
  for (const model of discoveredProfileModels) {
    const availability = model.workerAvailability?.find((item) => item.type === selectedType);
    if (!availability) continue;
    model.workerCount = Number(availability.workerCount || 0);
    model.loaded = model.workerCount > 0;
  }
  const selectedModel = discoveredProfileModels.find((item) => profileModelValue(item) === elements.providerDefaultModel.value || item.id === elements.providerDefaultModel.value);
  applySogniWorkerTypeOptions(selectedModel);
  renderProviderModelPicker();
}

function applySogniSdkModelOptions(model) {
  if (elements.providerType.value !== "sogni_sdk") return;
  applySogniWorkerTypeOptions(model);
  if (!model?.imageOptions) return;
  const options = model.imageOptions;
  const selectedPreset = elements.providerSogniSizePreset.value || "custom";
  elements.providerSogniSizePreset.replaceChildren(new Option("Custom dimensions", "custom"));
  for (const preset of options.sizePresets) elements.providerSogniSizePreset.append(new Option(`${preset.label} · ${preset.width}×${preset.height}`, preset.id));
  elements.providerSogniSizePreset.value = options.sizePresets.some((preset) => preset.id === selectedPreset) ? selectedPreset : "custom";
  const configuredPreset = options.sizePresets.find((preset) => preset.id === elements.providerSogniSizePreset.value);
  if (configuredPreset) {
    elements.providerSogniWidth.value = String(configuredPreset.width);
    elements.providerSogniHeight.value = String(configuredPreset.height);
    elements.providerSogniAspectRatio.value = configuredPreset.ratio || elements.providerSogniAspectRatio.value;
  }
  if (options.steps) {
    elements.providerSogniSteps.min = String(options.steps.min);
    elements.providerSogniSteps.max = String(options.steps.max);
    elements.providerSogniSteps.step = String(options.steps.step);
    if (!elements.providerSogniSteps.value) elements.providerSogniSteps.value = String(options.steps.default);
  }
  if (options.guidance) {
    elements.providerSogniGuidance.min = String(options.guidance.min);
    elements.providerSogniGuidance.max = String(options.guidance.max);
    elements.providerSogniGuidance.step = String(options.guidance.step);
    if (!elements.providerSogniGuidance.value) elements.providerSogniGuidance.value = String(options.guidance.default);
  }
  const selectedSampler = elements.providerSogniSampler.value;
  elements.providerSogniSampler.replaceChildren(new Option("Model default", ""));
  for (const sampler of options.samplers) elements.providerSogniSampler.append(new Option(sampler, sampler));
  elements.providerSogniSampler.value = options.samplers.includes(selectedSampler) ? selectedSampler : options.defaultSampler || "";
  const selectedScheduler = elements.providerSogniScheduler.value;
  elements.providerSogniScheduler.replaceChildren(new Option("Model default", ""));
  for (const scheduler of options.schedulers) elements.providerSogniScheduler.append(new Option(scheduler, scheduler));
  elements.providerSogniScheduler.value = options.schedulers.includes(selectedScheduler) ? selectedScheduler : options.defaultScheduler || "";
  elements.providerSogniPreviewCount.max = String(options.maximumPreviews ?? 10);
}

function renderProviderModelPicker() {
  const query = elements.providerModelFilter.value.trim().toLowerCase();
  const discoveredModels = activeModelPickerModels();
  const selectedValue = activeModelPickerValue();
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

async function openProviderModelPicker(forceRefresh = false) {
  providerModelPickerTarget = "provider";
  const role = elements.providerRole.value;
  elements.providerModelDialogTitle.textContent = role === "image" ? "Choose image model" : role === "embedding" ? "Choose embedding model" : role === "intent" ? "Choose intent classifier model" : "Choose default model";
  elements.providerModelDialogDescription.textContent = role === "image"
    ? "Only image-capable models are shown when the provider advertises modality data. Active models appear first."
    : role === "embedding"
      ? "Only embedding models are shown when the provider offers a dedicated inventory. Active models appear first."
      : role === "intent"
        ? "Choose a small, instruction-following text model. Classification requests use deterministic settings and at most 256 output tokens."
        : "Active models appear first. You may also select an available model that is not currently loaded.";
  elements.providerModelFilter.value = "";
  elements.providerCustomModel.value = elements.providerDefaultModel.value;
  elements.providerModelPickerStatus.textContent = discoveredProfileModels.length
    ? `${discoveredProfileModels.length} cached model entries. Refresh the endpoint to update this inventory.`
    : "Refresh the endpoint to browse its model inventory.";
  elements.providerModelPickerStatus.className = "status";
  openManagedModal(elements.providerModelDialog);
  renderProviderModelPicker();
  if (forceRefresh || !discoveredProfileModels.length) await refreshProviderModelsFromForm();
  elements.providerModelFilter.focus();
}

async function openEmbeddingModelPicker(forceRefresh = false) {
  const provider = providers.find((item) => item.id === elements.embeddingProvider.value);
  if (!provider) {
    elements.embeddingStatus.className = "status error";
    elements.embeddingStatus.textContent = "Select an embedding provider before choosing its model.";
    return;
  }
  providerModelPickerTarget = "embedding";
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

async function refreshActiveModelPicker() {
  if (providerModelPickerTarget === "embedding") await discoverEmbeddingModels();
  else await refreshProviderModelsFromForm();
}

function applyCustomProviderModel() {
  const value = elements.providerCustomModel.value.trim();
  if (!value) return;
  chooseProviderModel(value);
}

function applyProfileModelContext() {
  const selectedValue = elements.providerDefaultModel.value.trim();
  const model = discoveredProfileModels.find((item) => profileModelValue(item) === selectedValue || item.id === selectedValue);
  const contextLength = Number(model?.contextLength || 0);
  if (contextLength > 0) {
    elements.providerContextTokens.value = String(contextLength);
    elements.providerContextTokens.readOnly = true;
    elements.providerContextSource.textContent = `Locked to ${number(contextLength)} tokens advertised by ${model.displayName}.`;
    elements.providerContextSource.className = "field-note api-supplied";
  } else {
    elements.providerContextTokens.readOnly = false;
    elements.providerContextSource.textContent = model
      ? "The endpoint did not advertise a context length for this model; enter it manually."
      : "Editable until a discovered model supplies a context length.";
    elements.providerContextSource.className = contextLength ? "field-note api-supplied" : "field-note manual-entry";
  }
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
    if (loaded) {
      elements.modelSelect.value = loaded.loaded ? loaded.instanceId : loaded.id;
      applyDiscoveredProviderContext();
    } else {
      applyDiscoveredProviderContext();
    }
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
  elements.providerContextTokens.readOnly = false;
  elements.providerContextTokens.removeAttribute("aria-readonly");
  elements.providerContextSource.textContent = "Editable until model discovery supplies a context length.";
  elements.providerContextSource.className = "field-note";
  if (selectedImportSource && selectedImport?.kind === "infinite_worlds") {
    previewImportSource(selectedImportSource.sourceName, selectedImportSource.sourceText, elements.infiniteWorldsKind.value, selectedImportSource.origin).catch((error) => setStatus(error.message || String(error), "error"));
  }
});

elements.modelSelect.addEventListener("change", () => {
  applyDiscoveredProviderContext();
  if (selectedImportSource && selectedImport?.kind === "infinite_worlds") {
    previewImportSource(selectedImportSource.sourceName, selectedImportSource.sourceText, elements.infiniteWorldsKind.value, selectedImportSource.origin).catch((error) => setStatus(error.message || String(error), "error"));
  }
});

elements.providerType.addEventListener("change", () => {
  const defaults = {
    lmstudio: "http://host.docker.internal:1234",
    openrouter: "https://openrouter.ai/api/v1",
    sogni: "https://api.sogni.ai",
    sogni_sdk: "https://api.sogni.ai"
  };
  const suggested = defaults[elements.providerType.value];
  if (suggested) elements.providerBaseUrl.value = suggested;
  if (elements.providerType.value === "sogni" || elements.providerType.value === "sogni_sdk") {
    if (elements.providerName.value === "Local LM Studio") elements.providerName.value = elements.providerType.value === "sogni_sdk" ? "Sogni Supernet SDK" : "Sogni Creative Workflow";
    elements.providerRequestTimeoutMinutes.value = "0.5";
    applySogniConfiguration({}, elements.providerType.value);
  }
  syncProviderRoleSettings({ applySuggestedDefaults: !editingProviderId });
});

elements.providerSogniSizePreset.addEventListener("change", () => {
  const model = discoveredProfileModels.find((item) => profileModelValue(item) === elements.providerDefaultModel.value || item.id === elements.providerDefaultModel.value);
  const preset = model?.imageOptions?.sizePresets.find((item) => item.id === elements.providerSogniSizePreset.value);
  if (!preset) return;
  elements.providerSogniWidth.value = String(preset.width);
  elements.providerSogniHeight.value = String(preset.height);
  elements.providerSogniAspectRatio.value = preset.ratio || elements.providerSogniAspectRatio.value;
});

elements.providerSogniNetwork.addEventListener("change", applySogniWorkerAvailability);

elements.providerRole.addEventListener("change", () => {
  discoveredProfileModels = [];
  syncProviderRoleSettings({ applySuggestedDefaults: !editingProviderId });
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
    const { models } = await api(`/api/v1/providers/${provider.id}/models`);
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

function renderEmbeddingJobProgress(job) {
  const progress = job?.progress || {};
  const embedded = Number(progress.embedded || 0);
  const total = Number(progress.total || 0);
  elements.embeddingProgress.classList.remove("hidden");
  if (total > 0) {
    elements.embeddingProgressBar.max = total;
    elements.embeddingProgressBar.value = Math.min(total, embedded);
  } else if (["completed", "failed"].includes(job.status)) {
    elements.embeddingProgressBar.max = 1;
    elements.embeddingProgressBar.value = job.status === "completed" ? 1 : 0;
  } else {
    elements.embeddingProgressBar.removeAttribute("value");
  }
  const labels = {
    queued: "Indexing queued; waiting for a Chronicle worker…",
    running: total ? `Indexing semantic memory: ${number(embedded)} of ${number(total)} memories…` : "Indexing semantic memory…",
    completed: total ? `Semantic indexing complete: ${number(total)} memories are ready.` : "Semantic indexing completed successfully.",
    failed: `Semantic indexing failed${job.errorMessage ? `: ${job.errorMessage}` : "."}`
  };
  elements.embeddingProgressLabel.textContent = labels[job.status] || "Checking semantic indexing status…";
  elements.saveEmbeddingConfig.textContent = job.status === "queued"
    ? "Index queued…"
    : job.status === "running"
      ? total ? `Indexing ${embedded}/${total}…` : "Indexing…"
      : job.status === "completed" ? "Index complete ✓" : "Index failed";
  elements.saveEmbeddingConfig.classList.toggle("busy", ["queued", "running"].includes(job.status));
  if (["queued", "running"].includes(job.status)) {
    elements.semanticMemoryHealth.dataset.state = "indexing";
    elements.semanticMemoryHealthBadge.textContent = "Indexing";
    elements.semanticMemoryHealthTitle.textContent = total
      ? `Semantic indexing in progress · ${number(Math.round(embedded / total * 100))}%`
      : "Semantic indexing in progress";
    elements.semanticMemoryHealthMessage.textContent = labels[job.status];
  }
}

function embeddingPollDelay(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function monitorEmbeddingJob(jobId, campaignId, sequence) {
  for (let poll = 0; poll < 1200; poll += 1) {
    if (sequence !== embeddingJobPollSequence || selectedCampaign?.id !== campaignId) return null;
    const job = await api(`/api/v1/jobs/${jobId}`);
    renderEmbeddingJobProgress(job);
    if (["completed", "failed"].includes(job.status)) {
      await refreshCampaignMemoryMetrics();
      elements.embeddingStatus.className = `status ${job.status === "completed" ? "success" : "error"}`;
      elements.embeddingStatus.textContent = job.status === "completed"
        ? "Semantic memory indexing completed. Hybrid retrieval is ready for the indexed Chronicle coverage shown above."
        : `${job.errorMessage || "Semantic memory indexing failed."} Lexical Chronicle retrieval remains active; correct the provider or model and save again to retry.`;
      return job;
    }
    await embeddingPollDelay(1000);
  }
  throw new Error("Semantic indexing is still running, but live progress monitoring timed out. Refresh the campaign to resume monitoring.");
}

async function resumeEmbeddingJobProgress(jobId, campaignId) {
  const sequence = ++embeddingJobPollSequence;
  elements.saveEmbeddingConfig.disabled = true;
  elements.saveEmbeddingConfig.classList.add("busy");
  try {
    await monitorEmbeddingJob(jobId, campaignId, sequence);
  } catch (error) {
    if (sequence === embeddingJobPollSequence && selectedCampaign?.id === campaignId) {
      elements.embeddingStatus.className = "status error";
      elements.embeddingStatus.textContent = error.message || String(error);
    }
  } finally {
    if (sequence === embeddingJobPollSequence && selectedCampaign?.id === campaignId) {
      elements.saveEmbeddingConfig.disabled = false;
      elements.saveEmbeddingConfig.classList.remove("busy");
      elements.saveEmbeddingConfig.textContent = "Save & index";
    }
  }
}

async function saveEmbeddingConfig(event) {
  event.preventDefault();
  if (!selectedCampaign) return;
  const campaignId = selectedCampaign.id;
  const sequence = ++embeddingJobPollSequence;
  elements.saveEmbeddingConfig.disabled = true;
  elements.saveEmbeddingConfig.classList.add("busy");
  elements.saveEmbeddingConfig.textContent = "Saving…";
  elements.embeddingProgress.classList.add("hidden");
  elements.embeddingStatus.className = "status";
  elements.embeddingStatus.textContent = "Saving campaign memory configuration…";
  try {
    const saved = await api(`/api/v1/campaigns/${selectedCampaign.id}/memory/embedding-config`, {
      method: "PUT",
      body: JSON.stringify({
        enabled: elements.embeddingEnabled.checked,
        providerProfileId: elements.embeddingProvider.value || null,
        model: elements.embeddingModel.value,
        batchSize: elements.embeddingBatchSize.value,
        documentPrefix: elements.embeddingDocumentPrefix.value || null,
        queryPrefix: elements.embeddingQueryPrefix.value || null
      })
    });
    embeddingConfig = saved;
    if (saved.enabled && !saved.jobId) throw new Error("Semantic memory was enabled, but the indexing job was not created.");
    if (saved.enabled && saved.jobId) {
      elements.embeddingStatus.textContent = `Semantic indexing queued as durable job ${saved.jobId}. Live progress will remain here until it completes or fails.`;
      await monitorEmbeddingJob(saved.jobId, campaignId, sequence);
    } else {
      elements.embeddingProgress.classList.add("hidden");
      await refreshCampaignMemoryMetrics();
      elements.embeddingStatus.className = "status success";
      elements.embeddingStatus.textContent = "Semantic retrieval disabled and derived vectors removed. Lexical Chronicle retrieval remains available.";
    }
  } catch (error) {
    elements.embeddingStatus.className = "status error";
    elements.embeddingStatus.textContent = error.message || String(error);
  } finally {
    if (sequence === embeddingJobPollSequence && selectedCampaign?.id === campaignId) {
      elements.saveEmbeddingConfig.disabled = false;
      elements.saveEmbeddingConfig.classList.remove("busy");
      elements.saveEmbeddingConfig.textContent = "Save & index";
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
    ? `Using ${provider.name} for this campaign.`
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
  const provider = effectiveCampaignProvider("image");
  const sourcePolicy = elements.illustrationSourcePolicy.value;
  if (illustrationPolicyUsesProvider(sourcePolicy) && !provider) {
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
    if (illustrationPolicyUsesProvider(sourcePolicy)) {
      const updatedCampaign = await api(`/api/v1/campaigns/${selectedCampaign.id}`, {
        method: "PATCH",
        body: JSON.stringify({ imageProviderProfileId: elements.campaignImageProvider.value || null })
      });
      selectedCampaign = { ...selectedCampaign, ...updatedCampaign };
    }
    illustrationConfig = await api(`/api/v1/campaigns/${selectedCampaign.id}/illustration-config`, {
      method: "PUT",
      body: JSON.stringify({
        sourcePolicy,
        matchingScope: elements.illustrationMatchingScope.value,
        confidenceProfile: elements.illustrationConfidenceProfile.value,
        repetitionWindow: elements.illustrationRepetitionWindow.value,
        providerProfileId: illustrationPolicyUsesProvider(sourcePolicy) ? provider?.id || null : null,
        model: elements.illustrationModel.value,
        size: elements.illustrationSize.value,
        aspectRatio: elements.illustrationAspectRatio.value,
        quality: elements.illustrationQuality.value,
        outputFormat: elements.illustrationOutputFormat.value,
        maxAttempts: elements.illustrationMaxAttempts.value,
        segmentWordCount: elements.illustrationSegmentWordCount.value,
        imagesPerSegment: elements.illustrationImagesPerSegment.value,
        segmentPromptMode: elements.illustrationSegmentPromptMode.value
      })
    });
    defaultIllustrationRefinementPrompt = illustrationConfig.defaultRefinementPrompt || defaultIllustrationRefinementPrompt;
    illustrationRefinementPromptValue = illustrationConfig.refinementPrompt || defaultIllustrationRefinementPrompt;
    renderIllustrationPromptSummary();
    elements.illustrationStatus.className = "status success";
    elements.illustrationStatus.textContent = sourcePolicy === "off"
      ? "Illustrations disabled. No image endpoint will be called for new turns."
      : sourcePolicy === "library_only"
        ? "Library-only matching enabled. It works without image or embedding providers."
        : sourcePolicy === "library_then_generate"
          ? "Library-first matching enabled with provider fallback after a durable no-match."
          : "Generate-only illustration jobs enabled.";
  } catch (error) {
    elements.illustrationStatus.className = "status error";
    elements.illustrationStatus.textContent = error.message || String(error);
  } finally {
    elements.saveIllustrationConfig.disabled = !selectedCampaign;
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

async function loadLatestImageJob(monitor = false) {
  if (!selectedCampaign) return;
  const { jobs } = await api(`/api/v1/campaigns/${selectedCampaign.id}/image-jobs`);
  const job = jobs[0];
  if (!job) return;
  renderImageJobStatus(job);
  if (monitor && ["queued", "generating", "provider_pending", "downloading"].includes(job.status)) void monitorImageJob(job.id);
}

async function importStoryObject(story, sourceName, requestOverrides = {}) {
  const request = { sourceName, story, ...requestOverrides };
  const preview = await api("/api/v1/imports/legacy-story/preview", {
    method: "POST",
    body: JSON.stringify(request)
  });
  if (!preview.valid) throw new Error(preview.warnings.join(" ") || "The campaign export is not valid for import.");
  setStatus(`Importing ${story.turns?.length || 0} turns into PostgreSQL and building Chronicle memory…`);
  const result = await api("/api/v1/imports/legacy-story", {
    method: "POST",
    body: JSON.stringify(request)
  });
  const duplicate = result.duplicate ? "The story was already imported; the existing campaign was selected." : "Import completed.";
  setStatus(`${duplicate} ${result.stats.turnCount} turns and ${result.stats.memoryCount} memories are available. Complete history is approximately ${number(result.stats.estimatedHistoryTokens)} tokens. Use “Load story” in Campaigns to open the database-backed story.`, "success");
  await loadWorlds(result.worldId);
  await loadCampaigns(result.campaignId);
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

async function loadCampaignImportVersions() {
  elements.campaignImportVersion.replaceChildren(new Option("Loading published versions…", ""));
  const worldId = elements.campaignImportWorld.value;
  if (!worldId) {
    elements.campaignImportVersion.replaceChildren(new Option("Choose a target world first", ""));
    await refreshPortableCampaignPreview();
    return;
  }
  const world = await api(`/api/v1/worlds/${worldId}`);
  const versions = [...(world.versions || [])].sort((a, b) => b.versionNumber - a.versionNumber);
  elements.campaignImportVersion.replaceChildren(
    new Option(versions.length ? "Choose a published version" : "No published versions", ""),
    ...versions.map((version) => new Option(`Version ${version.versionNumber}${version.releaseNotes ? ` · ${version.releaseNotes}` : ""}`, version.id))
  );
  if (versions.length === 1) elements.campaignImportVersion.value = versions[0].id;
  await refreshPortableCampaignPreview();
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
  const sourceText = await file.text();
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
        await loadWorlds(result.worldId);
        setStatus(result.duplicate
          ? "The Choose Your Own Adventure world was already imported; the existing record was loaded into the World Editor below."
          : "Choose Your Own Adventure story imported and converted into a new Story World with 3-4 playable characters. Review and edit any fields below before publishing or saving.", "success");
        return;
      }
      await loadWorlds(result.worldId);
      if (result.kind === "campaign") {
        await loadCampaigns(result.campaignId);
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
      await loadWorlds(result.worldId);
      setStatus(result.duplicate ? "The world was already imported; the existing World Library record was selected." : "World imported with an immutable version and editable draft.", "success");
    } else {
      await importStoryObject(selectedImport.request.story, selectedImport.request.sourceName, selectedImport.request);
    }
  } catch (error) {
    if (progressTimer) clearInterval(progressTimer);
    setStatus(error.message || String(error), "error");
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
    const result = await api(`/api/v1/campaigns/${selectedCampaign.id}/memory/context-preview?${parameters}`);
    if (sequence !== contextPreviewSequence) return;
    elements.contextSummary.classList.remove("hidden", "error");
    elements.contextSummary.textContent = `${result.selectedCompression} compression selected · ${result.retrieval.mode} retrieval · approximately ${number(result.budget.estimatedSelectedTokens)} of ${number(result.budget.configuredTokens)} tokens · ${result.scopes.chronicle.length} Chronicle entries${result.budget.truncated ? " · context was budget-limited" : ""}`;
    elements.contextPreview.textContent = JSON.stringify(result, null, 2);
  } catch (error) {
    if (sequence !== contextPreviewSequence) return;
    elements.contextSummary.classList.remove("hidden");
    elements.contextSummary.classList.add("error");
    elements.contextSummary.textContent = error.message || String(error);
    elements.contextPreview.textContent = "Context preview unavailable.";
  } finally {
    if (sequence === contextPreviewSequence) elements.previewContext.disabled = false;
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
  selectedFile = elements.storyFile.files?.[0] || null;
  selectedImportSource = null;
  selectedImport = null;
  elements.importStory.disabled = true;
  if (!selectedFile) {
    elements.importPreview.textContent = "No file has been validated.";
    setStatus("Choose a story file to begin.");
    return;
  }
  elements.infiniteWorldsKind.value = "auto";
  setStatus(`Reading and validating ${selectedFile.name}…`);
  try {
    await previewImportFile(selectedFile);
  } catch (error) {
    elements.importPreview.textContent = "Validation failed; no database content was changed.";
    setStatus(error.message || String(error), "error");
  }
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
elements.worldSearch?.addEventListener("input", renderDashboardWorlds);
elements.campaignSearch?.addEventListener("input", renderDashboardCampaigns);
elements.worldCarouselPrev?.addEventListener("click", () => scrollCarousel(elements.dashboardWorlds, -1));
elements.worldCarouselNext?.addEventListener("click", () => scrollCarousel(elements.dashboardWorlds, 1));
elements.campaignCarouselPrev?.addEventListener("click", () => scrollCarousel(elements.dashboardCampaigns, -1));
elements.campaignCarouselNext?.addEventListener("click", () => scrollCarousel(elements.dashboardCampaigns, 1));
elements.closeWorldDetails?.addEventListener("click", () => elements.worldDetailsDialog.close());
elements.editWorldDetails?.addEventListener("click", () => elements.worldDetailsDialog.close());
elements.beginCampaignFromWorld?.addEventListener("click", openQuickCampaign);
elements.cancelQuickCampaign?.addEventListener("click", () => elements.quickCampaignDialog.close());
elements.quickCampaignForm?.addEventListener("submit", createQuickCampaign);
elements.advancedCampaignCreation?.addEventListener("click", () => elements.quickCampaignDialog.close());
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
elements.campaignImportDestination.addEventListener("change", async () => {
  updateCampaignImportDestinationVisibility();
  if (elements.campaignImportDestination.value === "existing") {
    await loadCampaignImportVersions();
  } else {
    await refreshPortableCampaignPreview();
  }
});
elements.campaignImportWorld.addEventListener("change", loadCampaignImportVersions);
elements.campaignImportVersion.addEventListener("change", refreshPortableCampaignPreview);
elements.importBrowserState.addEventListener("click", importBrowserState);
elements.newWorld.addEventListener("click", newWorld);
elements.generateWorldCover.addEventListener("click", generateWorldCoverImage);
elements.refreshWorlds.addEventListener("click", () => loadWorlds().catch((error) => worldMessage(error.message || String(error), "error")));
elements.worldForm.addEventListener("submit", saveWorldDraft);
elements.addPlayableCharacter.addEventListener("click", () => openCharacterDialog());
elements.characterForm.addEventListener("submit", saveCharacterFromModal);
elements.cancelCharacter.addEventListener("click", () => elements.characterDialog.close());
elements.deleteCharacter.addEventListener("click", deleteCharacterFromModal);
elements.generateCharacter.addEventListener("click", generateCharacterFromPrompt);
elements.organizeCharacterProfile.addEventListener("click", organizeCharacterProfile);
elements.cancelCharacterProfileReview.addEventListener("click", () => {
  characterProfileOrganizationResult = null;
  characterProfileOrganizationApplied = false;
  elements.characterProfileReviewDialog.close();
});
elements.applyCharacterProfileReview.addEventListener("click", applyCharacterProfileReview);
elements.editCampaignCharacter.addEventListener("click", openCampaignCharacterDialog);
elements.addCharacterStat.addEventListener("click", () => addCharacterEditorRow("stat"));
elements.addCharacterTracker.addEventListener("click", () => addCharacterEditorRow("tracker"));
elements.characterDialog.addEventListener("close", () => {
  editingCharacterId = "";
  characterModalWorkingCharacter = null;
  characterModalBusy = false;
  characterModalScope = "world";
  characterProfileOrganizationResult = null;
  characterProfileOrganizationApplied = false;
  setCharacterProfileOrganizationProgress(false);
  elements.characterGenerator.open = false;
  elements.characterGeneratorPrompt.value = "";
  elements.characterStats.replaceChildren();
  elements.characterTrackers.replaceChildren();
  setCharacterStatus();
});
elements.characterDialog.addEventListener("cancel", (event) => {
  if (characterModalBusy) event.preventDefault();
});
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
    elements.forkWorldTitle.value = `Fork of ${selectedWorld?.world?.title || "World"}`;
    openManagedModal(elements.forkWorldDialog);
  });
  elements.cancelForkWorld.addEventListener("click", () => elements.forkWorldDialog.close());
  elements.forkWorldForm.addEventListener("submit", (e) => { e.preventDefault(); forkSelectedWorld(); });
}
if (elements.createCampaignModalBtn) {
  elements.createCampaignModalBtn.addEventListener("click", () => {
    if (!worldVersionCampaignReady) {
      worldMessage(elements.worldCampaignReadiness.textContent || "This world version is not campaign-ready.", "error");
      return;
    }
    elements.newCampaignTitle.value = "";
    elements.newCampaignCharacter.value = worldVersionCharacters.length === 1 ? worldVersionCharacters[0].id : "";
    updateCampaignCreationAvailability();
    openManagedModal(elements.createCampaignDialog);
  });
  elements.cancelCreateCampaign.addEventListener("click", () => elements.createCampaignDialog.close());
  elements.createCampaignForm.addEventListener("submit", (e) => { e.preventDefault(); createCampaignFromWorld(); });
}
elements.exportWorld.addEventListener("click", exportSelectedWorld);
elements.deleteWorldVersion.addEventListener("click", deleteSelectedWorldVersion);
elements.archiveWorld.addEventListener("click", toggleWorldArchive);
elements.deleteWorld.addEventListener("click", deleteSelectedWorld);
elements.refreshCampaigns.addEventListener("click", () => loadCampaigns().catch((error) => setStatus(error.message, "error")));
elements.campaignForm.addEventListener("submit", saveSelectedCampaign);
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
  elements.migrateCampaign.disabled = !selectedCampaign || elements.campaignWorldVersion.value === selectedCampaign.worldVersionId;
});
elements.contextForm.addEventListener("submit", previewContext);
elements.reindexMemory.addEventListener("click", rebuildMemory);
if (elements.newProviderButton) {
  elements.newProviderButton.addEventListener("click", () => {
    resetProviderForm();
    openManagedModal(elements.providerDialog);
  });
}
elements.providerForm.addEventListener("submit", saveProvider);
elements.cancelProviderEdit.addEventListener("click", () => {
  resetProviderForm();
  if (elements.providerDialog) elements.providerDialog.close();
});

// Setup tab behavior for world editor
document.querySelectorAll(".tab-button").forEach(button => {
  button.addEventListener("click", () => {
    const group = button.closest(".world-tabs").dataset.tabGroup;
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
elements.refreshProviderModels.addEventListener("click", async (event) => { event.stopPropagation(); await openProviderModelPicker(true); });
elements.providerDefaultModel.addEventListener("click", () => { void openProviderModelPicker(); });
elements.providerDefaultModel.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") { event.preventDefault(); void openProviderModelPicker(); }
});
elements.closeProviderModelDialog.addEventListener("click", () => elements.providerModelDialog.close());
elements.refreshProviderModelDialog.addEventListener("click", refreshActiveModelPicker);
elements.providerModelFilter.addEventListener("input", renderProviderModelPicker);
elements.applyCustomProviderModel.addEventListener("click", applyCustomProviderModel);
elements.providerDefaultModel.addEventListener("change", applyProfileModelContext);
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
elements.embeddingForm.addEventListener("submit", saveEmbeddingConfig);
elements.illustrationForm.addEventListener("submit", saveIllustrationConfig);
elements.openIllustrationPromptEditor.addEventListener("click", openIllustrationPromptEditor);
elements.illustrationPromptForm.addEventListener("submit", applyIllustrationPrompt);
elements.restoreDefaultIllustrationPrompt.addEventListener("click", restoreDefaultIllustrationPrompt);
elements.cancelIllustrationPrompt.addEventListener("click", () => requestModalDismissal(elements.illustrationPromptDialog));
elements.illustrationPromptDialog.addEventListener("close", () => {
  elements.illustrationRefinementPrompt.value = illustrationRefinementPromptValue;
  elements.illustrationRefinementPrompt.setCustomValidity("");
});
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
elements.chooseWorldCover.addEventListener("click", chooseWorldCoverFromLibrary);
elements.promptLibraryFilter?.addEventListener("input", renderPromptLibrary);
elements.promptLibraryScope?.addEventListener("change", () => {
  if (promptLibraryIsDirty()) {
    elements.promptLibraryScope.value = promptLibraryActiveScope;
    elements.promptLibraryStatus.textContent = "Save or discard the current edits before changing scope.";
    elements.promptLibraryStatus.className = "status warning";
    return;
  }
  selectedPromptTemplateKey = "";
  void loadPromptLibrary();
});
elements.promptLibraryCampaign?.addEventListener("change", () => {
  if (promptLibraryIsDirty()) {
    elements.promptLibraryCampaign.value = promptLibraryActiveCampaignId;
    elements.promptLibraryStatus.textContent = "Save or discard the current edits before changing campaigns.";
    elements.promptLibraryStatus.className = "status warning";
    return;
  }
  selectedPromptTemplateKey = "";
  void loadPromptLibrary();
});
elements.promptLibraryEditor?.addEventListener("submit", savePromptLibraryTemplate);
elements.promptLibraryReset?.addEventListener("click", resetPromptLibraryTemplate);
elements.promptLibraryPreview?.addEventListener("click", () => { promptLibraryPreviewVisible = !promptLibraryPreviewVisible; void renderPromptLibraryPreview(); });
elements.promptLibraryContent?.addEventListener("input", () => { renderPromptLibraryDirtyState(); schedulePromptLibraryPreview(); });
elements.promptLibraryDiscard?.addEventListener("click", () => {
  elements.promptLibraryContent.value = promptLibraryEditorBaseline;
  renderPromptLibraryDirtyState();
  schedulePromptLibraryPreview();
});
elements.promptLibraryPrevious?.addEventListener("click", () => elements.promptLibraryList.scrollBy({ left: -Math.max(260, elements.promptLibraryList.clientWidth * .8), behavior: "smooth" }));
elements.promptLibraryNext?.addEventListener("click", () => elements.promptLibraryList.scrollBy({ left: Math.max(260, elements.promptLibraryList.clientWidth * .8), behavior: "smooth" }));
window.addEventListener("beforeunload", (event) => {
  if (!promptLibraryIsDirty()) return;
  event.preventDefault();
  event.returnValue = "";
});
async function loadSessionPreferences() {
  const response = await api("/api/v1/session");
  sessionUser = response.user || null;
  const style = sessionUser?.settings?.defaultTurnControlStyle;
  if (["action_only", "flexible_auto", "flexible_action", "flexible_scene"].includes(style)) {
    elements.newCampaignTurnControlStyle.value = style;
  }
}

async function openNexusUserProfile() {
  try {
    if (!sessionUser) await loadSessionPreferences();
    elements.nexusUserProfileDisplayName.value = sessionUser?.displayName || "Initial Owner";
    elements.nexusUserProfileAutoSubmitChoices.checked = sessionUser?.settings?.autoSubmitTurnChoices !== false;
    elements.nexusUserProfileContinuousReading.checked = Boolean(sessionUser?.settings?.continuousReading);
    elements.nexusUserProfileDefaultTurnControlStyle.value = sessionUser?.settings?.defaultTurnControlStyle || "flexible_auto";
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
      method: "PATCH",
      body: JSON.stringify({
        displayName,
        settings: {
          autoSubmitTurnChoices: elements.nexusUserProfileAutoSubmitChoices.checked,
          continuousReading: elements.nexusUserProfileContinuousReading.checked,
          defaultTurnControlStyle: elements.nexusUserProfileDefaultTurnControlStyle.value
        }
      })
    });
    sessionUser = response.user || sessionUser;
    elements.newCampaignTurnControlStyle.value = sessionUser?.settings?.defaultTurnControlStyle || "flexible_auto";
    elements.nexusUserProfileDialog.close();
  } catch (error) {
    elements.nexusUserProfileStatus.textContent = error.message || String(error);
    elements.nexusUserProfileStatus.className = "status error";
  }
}

detectBrowserStory();
loadSessionPreferences().catch(() => undefined);
loadProviders().catch((error) => providerMessage(error.message || String(error), "error"));
loadWorlds().catch((error) => worldMessage(error.message || String(error), "error"));
loadCampaigns().catch((error) => setStatus(error.message || String(error), "error"));
