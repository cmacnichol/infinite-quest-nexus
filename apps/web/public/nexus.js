const elements = Object.fromEntries([...document.querySelectorAll("[id]")].map((element) => [element.id, element]));
let selectedFile = null;
let selectedImportSource = null;
let selectedImport = null;
let selectedCampaign = null;
let worlds = [];
let selectedWorld = null;
let worldVersionCharacters = [];
let worldCharacterLoadSequence = 0;
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
const MIN_MEMORY_CONTEXT_BUDGET_TOKENS = 512;
const MAX_MEMORY_CONTEXT_BUDGET_TOKENS = 1_000_000;
const DEFAULT_MEMORY_CONTEXT_BUDGET_TOKENS = 32_000;

function clampedMemoryContextBudget(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_MEMORY_CONTEXT_BUDGET_TOKENS;
  return Math.min(MAX_MEMORY_CONTEXT_BUDGET_TOKENS, Math.max(MIN_MEMORY_CONTEXT_BUDGET_TOKENS, Math.trunc(numeric)));
}

function applyEmbeddingModelContextBudget(model) {
  const modelContextTokens = Number(model?.contextLength || 0);
  if (!modelContextTokens) {
    elements.budgetTokensSource.textContent = "This embedding model did not advertise a context limit; the memory context budget remains editable.";
    elements.budgetTokensSource.className = "field-note manual-entry";
    return;
  }
  const textProvider = effectiveCampaignProvider("text");
  const storyInputCapacity = textProvider
    ? Number(textProvider.contextWindowTokens || 0) - Number(textProvider.maxOutputTokens || 0) - 1024
    : 0;
  const embeddingCapacity = Math.max(MIN_MEMORY_CONTEXT_BUDGET_TOKENS, modelContextTokens - 512);
  const safeBudget = clampedMemoryContextBudget(storyInputCapacity >= MIN_MEMORY_CONTEXT_BUDGET_TOKENS
    ? Math.min(embeddingCapacity, storyInputCapacity)
    : embeddingCapacity);
  elements.budgetTokens.value = String(safeBudget);
  elements.budgetTokensSource.textContent = storyInputCapacity >= MIN_MEMORY_CONTEXT_BUDGET_TOKENS && storyInputCapacity < embeddingCapacity
    ? `Automatically set to ${number(safeBudget)} tokens: capped by the story provider after reserving output and protocol space.`
    : `Automatically set to ${number(safeBudget)} tokens from the model's advertised ${number(modelContextTokens)}-token context, with a 512-token safety reserve.`;
  elements.budgetTokensSource.className = "field-note api-supplied";
}

function updateStoryViewLink() {
  if (!elements.storyViewLink) return;
  const lastCampaignId = localStorage.getItem("infiniteQuestLastCampaignId");
  if (selectedCampaign) {
    elements.storyViewLink.href = "/story/" + encodeURIComponent(selectedCampaign.id);
  } else if (lastCampaignId) {
    elements.storyViewLink.href = "/story/" + encodeURIComponent(lastCampaignId);
  } else {
    elements.storyViewLink.href = "/story";
  }
}

function applyManagementView() {
  const hash = window.location.hash || "#world-library";
  const providerView = hash === "#providers";
  document.body.dataset.managementView = providerView ? "providers" : "worlds";
  elements.managementTitle.textContent = providerView ? "Provider Management" : "World Management";
  elements.managementDescription.textContent = providerView
    ? "Add and manage provider profiles independently for text, image generation, and Chronicle embeddings."
    : "Author reusable versioned worlds, configure campaigns, and inspect the fiction-only memory selected for generation.";
  document.title = `${elements.managementTitle.textContent} · Infinite Quest Nexus`;

  // UI Pass on navigation active states
  if (elements.navProviders) elements.navProviders.className = hash === "#providers" ? "button primary" : "button secondary";
  if (elements.navWorlds) elements.navWorlds.className = hash === "#world-library" || hash === "" ? "button primary" : "button secondary";
  if (elements.navCampaigns) elements.navCampaigns.className = hash === "#campaigns" ? "button primary" : "button secondary";

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
    error.details = payload.details || null;
    throw error;
  }
  return payload;
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

function worldMessage(message, type = "") {
  elements.worldStatus.textContent = message;
  elements.worldStatus.className = `status ${type}`.trim();
}

function campaignMessage(message, type = "") {
  elements.campaignStatusMessage.textContent = message;
  elements.campaignStatusMessage.className = `status ${type}`.trim();
  elements.campaignStatusMessage.classList.remove("hidden");
}

function requestTypedDelete(title, message) {
  if (pendingDeleteResolve) pendingDeleteResolve(false);
  pendingDeleteTitle = title;
  elements.deleteDialogMessage.textContent = message;
  elements.deleteExpectedTitle.textContent = title;
  elements.deleteConfirmationInput.value = "";
  elements.confirmDelete.disabled = true;
  elements.deleteDialog.showModal();
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
    elements.worldCharacter,
    elements.worldFirstAction,
    elements.worldRules,
    elements.worldReleaseNotes,
    elements.forkWorldTitle,
    elements.newCampaignTitle,
    elements.newCampaignCharacter,
    elements.saveWorldDraft,
    elements.publishWorld,
    elements.forkWorld,
    elements.createCampaign,
    elements.exportWorld,
    elements.archiveWorld,
    elements.deleteWorld
  ].forEach((element) => { element.disabled = disabled; });
}

function worldContentFromForm() {
  const current = selectedWorld?.draftContent || {};
  return {
    ...current,
    schemaVersion: Number(current.schemaVersion || 2),
    world: {
      ...(current.world || {}),
      title: elements.worldTitle.value,
      genre: elements.worldGenre.value,
      tone: elements.worldTone.value,
      premise: elements.worldPremise.value,
      backgroundStory: elements.worldBackground.value,
      character: elements.worldCharacter.value,
      firstAction: elements.worldFirstAction.value,
      rules: elements.worldRules.value
    },
    entities: Array.isArray(current.entities) ? current.entities : [],
    relationships: Array.isArray(current.relationships) ? current.relationships : [],
    rpgStats: Array.isArray(current.rpgStats) ? current.rpgStats : [],
    defaultTriggers: Array.isArray(current.defaultTriggers) ? current.defaultTriggers : [],
    eventTriggers: Array.isArray(current.eventTriggers) ? current.eventTriggers : [],
    assets: Array.isArray(current.assets) ? current.assets : [],
    defaults: current.defaults && typeof current.defaults === "object" ? current.defaults : {}
  };
}

function renderWorldCharacterRoster(content = selectedWorld?.draftContent || {}) {
  const structured = Array.isArray(content.playableCharacters) ? content.playableCharacters : [];
  const legacyText = String(content.world?.character || "").trim();
  const characters = structured.length ? structured : legacyText ? [{ name: legacyText.split(/\r?\n/)[0], characterText: legacyText, legacy: true }] : [];
  elements.worldCharacterRoster.replaceChildren();
  if (!characters.length) {
    const empty = document.createElement("span");
    empty.className = "muted";
    empty.textContent = "No predefined player character. Campaigns will use the world’s general guidance.";
    elements.worldCharacterRoster.append(empty);
    return;
  }
  for (const character of characters) {
    const card = document.createElement("div");
    card.className = "character-roster-card";
    const name = document.createElement("strong");
    name.textContent = String(character.name || "Unnamed character");
    const detail = document.createElement("span");
    const stats = Array.isArray(character.rpgStats) ? character.rpgStats.length : 0;
    const trackers = Array.isArray(character.defaultTriggers) ? character.defaultTriggers.length : 0;
    detail.textContent = character.legacy
      ? "Legacy/default character"
      : `${stats} RPG stat${stats === 1 ? "" : "s"} · ${trackers} starting tracker${trackers === 1 ? "" : "s"}`;
    const description = document.createElement("span");
    description.textContent = String(character.characterText || "").slice(0, 260) || "No character description.";
    card.append(name, detail, description);
    elements.worldCharacterRoster.append(card);
  }
}

async function loadWorlds(preselectId = "") {
  ({ worlds } = await api("/api/v1/worlds"));
  elements.worldList.replaceChildren();
  if (!worlds.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No worlds yet. Create one or import a portable world.";
    elements.worldList.append(empty);
    selectedWorld = null;
    worldVersionCharacters = [];
    renderWorldCharacterRoster({});
    setWorldEditorDisabled(true);
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
  elements.worldCharacter.value = overview.character || "";
  renderWorldCharacterRoster(selectedWorld.draftContent);
  elements.worldFirstAction.value = overview.firstAction || "";
  elements.worldRules.value = overview.rules || "";
  elements.worldReleaseNotes.value = "";
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
  elements.createCampaign.disabled = !selectedWorld.versions.length;
  elements.exportWorld.disabled = !selectedWorld.versions.length;
  elements.forkWorld.disabled = !selectedWorld.versions.length;
  elements.deleteWorld.disabled = false;
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
    const world = await api("/api/v1/worlds", { method: "POST", body: JSON.stringify({ title }) });
    elements.newWorldTitle.value = "";
    await loadWorlds(world.id);
    worldMessage("World draft created. It must be published before a campaign can use it.", "success");
  } catch (error) {
    worldMessage(error.message || String(error), "error");
  }
}

async function saveWorldDraft(event) {
  event.preventDefault();
  if (!selectedWorld) return;
  elements.saveWorldDraft.disabled = true;
  worldMessage("Saving world draft…");
  try {
    const saved = await api(`/api/v1/worlds/${selectedWorld.id}/draft`, {
      method: "PUT",
      body: JSON.stringify({
        expectedRevision: selectedWorld.draftRevision,
        title: elements.worldTitle.value,
        content: worldContentFromForm()
      })
    });
    await loadWorlds(selectedWorld.id);
    worldMessage(`Draft revision ${saved.revision} saved. Existing campaigns remain unchanged.`, "success");
  } catch (error) {
    worldMessage(error.message || String(error), "error");
  } finally {
    elements.saveWorldDraft.disabled = selectedWorld?.status === "archived";
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

async function loadWorldVersionPlayableCharacters() {
  const sequence = ++worldCharacterLoadSequence;
  const worldVersionId = selectedWorldVersionId();
  worldVersionCharacters = [];
  elements.newCampaignCharacter.replaceChildren(new Option(worldVersionId ? "Loading characters…" : "Publish a world version first", ""));
  elements.newCampaignCharacter.disabled = true;
  elements.createCampaign.disabled = true;
  if (!worldVersionId) return;
  try {
    const response = await api(`/api/v1/world-versions/${worldVersionId}/playable-characters`);
    if (sequence !== worldCharacterLoadSequence || worldVersionId !== selectedWorldVersionId()) return;
    worldVersionCharacters = Array.isArray(response.characters) ? response.characters : [];
    const options = [];
    if (worldVersionCharacters.length > 1) options.push(new Option("Choose a player character", ""));
    for (const character of worldVersionCharacters) {
      options.push(new Option(`${character.name} · ${character.rpgStatCount} stats · ${character.defaultTriggerCount} trackers`, character.id));
    }
    elements.newCampaignCharacter.replaceChildren(...options);
    if (worldVersionCharacters.length === 1) elements.newCampaignCharacter.value = worldVersionCharacters[0].id;
    elements.newCampaignCharacter.disabled = worldVersionCharacters.length < 2;
    elements.newCampaignCharacterNote.textContent = worldVersionCharacters.length > 1
      ? `Choose one of ${worldVersionCharacters.length} retained characters. The choice is snapshotted into the campaign.`
      : "This world has one character option, which will be snapshotted automatically.";
    elements.createCampaign.disabled = worldVersionCharacters.length > 1 && !elements.newCampaignCharacter.value;
  } catch (error) {
    if (sequence !== worldCharacterLoadSequence) return;
    elements.newCampaignCharacter.replaceChildren(new Option("Characters unavailable", ""));
    elements.newCampaignCharacterNote.textContent = error.message || String(error);
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
      body: JSON.stringify({ title, worldVersionId: selectedWorldVersionId(), ...(selectedCharacterId ? { selectedCharacterId } : {}) })
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
  const { campaigns } = await api("/api/v1/campaigns");
  elements.campaignList.replaceChildren();
  if (!campaigns.length) {
    elements.campaignList.innerHTML = '<p class="muted">No database-backed campaigns yet.</p>';
    selectedCampaign = null;
    updateStoryViewLink();
    [elements.campaignTitle, elements.campaignStatus, elements.campaignWorldVersion, elements.campaignTextProvider, elements.campaignStoryLengthProfile, elements.saveCampaign, elements.migrateCampaign, elements.loadCampaign, elements.exportCampaign, elements.deleteCampaign, elements.illustrationEnabled, elements.campaignImageProvider, elements.illustrationModel, elements.illustrationSize, elements.illustrationAspectRatio, elements.illustrationQuality, elements.illustrationOutputFormat, elements.illustrationMaxAttempts, elements.saveIllustrationConfig, elements.discoverIllustrationModels].forEach((element) => { element.disabled = true; });
    elements.illustrationEnabled.checked = false;
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
  [elements.campaignTitle, elements.campaignStatus, elements.campaignWorldVersion, elements.campaignTextProvider, elements.campaignStoryLengthProfile, elements.saveCampaign, elements.loadCampaign, elements.exportCampaign, elements.deleteCampaign, elements.illustrationEnabled, elements.campaignImageProvider, elements.illustrationModel, elements.illustrationSize, elements.illustrationAspectRatio, elements.illustrationQuality, elements.illustrationOutputFormat, elements.illustrationMaxAttempts].forEach((element) => { element.disabled = false; });
  elements.campaignTextProvider.value = campaign.textProviderProfileId || "";
  elements.campaignImageProvider.value = campaign.imageProviderProfileId || "";
  elements.campaignStoryLengthProfile.value = campaign.storyLengthProfile || "standard";
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
        storyLengthProfile: elements.campaignStoryLengthProfile.value
      })
    });
    await loadCampaigns(selectedCampaign.id);
    campaignMessage("Campaign metadata and default story length saved. Accepted turns and Chronicle memory were unchanged.", "success");
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
    appendCostMetric(money(total.byCategory?.story || 0, total.currency), `story${suffix}`);
    appendCostMetric(money(total.byCategory?.image || 0, total.currency), `images${suffix}`);
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
  elements.illustrationModel.value = illustrationConfig.model || "";
  elements.illustrationSize.value = illustrationConfig.size || "1024x1024";
  elements.illustrationAspectRatio.value = illustrationConfig.aspectRatio || "1:1";
  elements.illustrationQuality.value = illustrationConfig.quality || "auto";
  elements.illustrationOutputFormat.value = illustrationConfig.outputFormat || "png";
  elements.illustrationMaxAttempts.value = String(illustrationConfig.maxAttempts || 3);
  syncIllustrationProviderAvailability(true);
  const provider = effectiveCampaignProvider("image");
  elements.campaignImageProviderSummary.textContent = provider
    ? `Using ${provider.name}${selectedCampaign?.imageProviderProfileId ? " for this campaign" : " as the default image profile"}.`
    : enabledProviders("image").length
      ? "Select an image provider for this campaign before enabling illustrations."
      : "Add and enable an illustration provider in Provider Management before images can be enabled.";
  elements.illustrationStatus.textContent = illustrationConfig.enabled && provider
    ? `Automatic illustrations are enabled with ${illustrationConfig.model}. Endpoint health: ${providers.find((provider) => provider.id === illustrationConfig.providerProfileId)?.healthStatus || "unknown"}. They run after story acceptance and cannot change the accepted turn.`
    : illustrationConfig.enabled
      ? "Illustrations were configured previously, but no enabled image provider is available now. Automatic image jobs are disabled until a provider is restored and the settings are saved."
      : "Illustrations are disabled for this campaign. Story generation is unaffected.";
}

function renderIllustrationSettingsVisibility() {
  const visible = elements.illustrationEnabled.checked && enabledProviders("image").length > 0;
  elements.illustrationSettings.classList.toggle("hidden", !visible);
  elements.illustrationSettings.setAttribute("aria-hidden", String(!visible));
}

function syncIllustrationProviderAvailability(restoreSavedState = false) {
  const hasImageProvider = enabledProviders("image").length > 0;
  if (restoreSavedState) elements.illustrationEnabled.checked = Boolean(illustrationConfig?.enabled && hasImageProvider);
  if (!hasImageProvider) elements.illustrationEnabled.checked = false;
  elements.illustrationEnabled.disabled = !selectedCampaign || !hasImageProvider;
  elements.illustrationEnabled.title = hasImageProvider
    ? "Enable independent illustration jobs for accepted turns."
    : "Add and enable an illustration provider in Provider Management first.";
  elements.campaignImageProvider.disabled = !selectedCampaign || !hasImageProvider;
  elements.discoverIllustrationModels.disabled = !selectedCampaign || !effectiveCampaignProvider("image");
  renderIllustrationSettingsVisibility();
}

function providerMessage(message, type = "") {
  elements.providerStatus.textContent = message;
  elements.providerStatus.className = `status ${type}`.trim();
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
    if (selectedProvider?.providerRole === "text") {
      elements.budgetTokens.value = String(clampedMemoryContextBudget(contextLength - selectedProvider.maxOutputTokens - 1024));
    }
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
  return available.find((provider) => provider.isDefault) || (available.length === 1 ? available[0] : null);
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
    select.append(new Option(`${provider.name} · ${provider.providerType}${provider.isDefault ? " · default" : ""}`, provider.id));
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
      elements.embeddingProvider.append(new Option(`${provider.name} · ${provider.providerType}${provider.isDefault ? " · default" : ""}`, provider.id));
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
    summary.textContent = `${provider.providerRole} · ${provider.providerType} · ${provider.defaultModel || "model not selected"} · ${Number(provider.requestTimeoutMs || 300000) / 60000} min timeout`;
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
      if (!window.confirm(`Delete provider profile “${provider.name}”? Campaign assignments and provider-linked jobs, chains, and derived embeddings will be removed.`)) return;
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
    if (provider.isDefault || enabledProviders(provider.providerRole).length === 1) {
      const badge = document.createElement("span");
      badge.className = "default-badge";
      badge.textContent = provider.isDefault ? "Default" : "Default (only profile)";
      details.append(badge);
      row.append(details, actions);
    } else {
      const makeDefault = document.createElement("button");
      makeDefault.type = "button";
      makeDefault.className = "button secondary";
      makeDefault.textContent = "Make default";
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
  if (elements.providerDialog) elements.providerDialog.showModal();
  providerMessage(`Editing ${provider.name}. Leave the API key blank to keep the stored credential.`);
}

async function loadProviders(preselectId = "") {
  ({ providers } = await api("/api/v1/providers"));
  renderProviderProfiles();
  const currentImportProviderId = elements.providerSelect.value;
  elements.providerSelect.replaceChildren(new Option(defaultProvider("text") ? `Use default · ${defaultProvider("text").name}` : "Use the default text provider", ""));
  for (const provider of providers.filter((item) => item.providerRole === "text" && item.enabled)) {
    elements.providerSelect.append(new Option(`${provider.name} · ${provider.providerType}${provider.isDefault ? " · default" : ""}`, provider.id));
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
        contextWindowTokens: elements.providerContextTokens.value,
        maxOutputTokens: elements.providerOutputTokens.value,
        temperature: elements.providerTemperature.value,
        requestTimeoutMs: Math.round(Number(elements.providerRequestTimeoutMinutes.value) * 60000),
        enabled: elements.providerEnabled.checked,
        configuration: { ...existingConfig, streaming: elements.providerStreaming.checked }
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
          contextWindowTokens: elements.providerContextTokens.value,
          maxOutputTokens: elements.providerOutputTokens.value,
          temperature: elements.providerTemperature.value,
          requestTimeoutMs: Math.round(Number(elements.providerRequestTimeoutMinutes.value) * 60000),
          enabled: elements.providerEnabled.checked,
          isDefault: elements.providerIsDefault.checked,
          configuration: { ...existingConfig, streaming: elements.providerStreaming.checked }
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
    applyEmbeddingModelContextBudget(model);
    elements.providerModelDialog.close();
    elements.embeddingStatus.className = "status";
    elements.embeddingStatus.textContent = `${value} selected for campaign embeddings. Save & index to apply this change${model?.contextLength ? " and the advertised context budget" : ""}.`;
    return;
  }
  elements.providerDefaultModel.value = value;
  applyProfileModelContext();
  elements.providerModelDialog.close();
  providerMessage(`${value} selected as the profile default. Save the profile to keep this change.`);
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
    meta.textContent = `${value}${model.contextLength ? ` · ${number(model.contextLength)} context` : " · context not advertised"}`;
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
  elements.providerModelDialogTitle.textContent = role === "image" ? "Choose image model" : role === "embedding" ? "Choose embedding model" : "Choose default model";
  elements.providerModelDialogDescription.textContent = role === "image"
    ? "Only image-capable models are shown when the provider advertises modality data. Active models appear first."
    : role === "embedding"
      ? "Only embedding models are shown when the provider offers a dedicated inventory. Active models appear first."
      : "Active models appear first. You may also select an available model that is not currently loaded.";
  elements.providerModelFilter.value = "";
  elements.providerCustomModel.value = elements.providerDefaultModel.value;
  elements.providerModelPickerStatus.textContent = discoveredProfileModels.length
    ? `${discoveredProfileModels.length} cached model entries. Refresh the endpoint to update this inventory.`
    : "Refresh the endpoint to browse its model inventory.";
  elements.providerModelPickerStatus.className = "status";
  elements.providerModelDialog.showModal();
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
  elements.providerModelDialog.showModal();
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
    openrouter: "https://openrouter.ai/api/v1"
  };
  const suggested = defaults[elements.providerType.value];
  if (suggested) elements.providerBaseUrl.value = suggested;
});

elements.embeddingProvider.addEventListener("change", () => {
  const provider = providers.find((item) => item.id === elements.embeddingProvider.value);
  discoveredEmbeddingModels = [];
  elements.discoverEmbeddingModels.disabled = !provider;
  elements.embeddingModel.disabled = !provider;
  elements.embeddingModel.value = provider?.defaultModel || "";
  elements.budgetTokensSource.textContent = provider
    ? "Open the embedding model picker to apply an advertised context limit automatically."
    : "Select a discovered embedding model to apply an advertised context limit automatically.";
  elements.budgetTokensSource.className = "field-note";
  elements.embeddingStatus.className = "status";
  elements.embeddingStatus.textContent = provider
    ? `${provider.name} selected. Open the embedding model picker to inspect its endpoint inventory.`
    : "Select an embedding provider before choosing its model.";
});

elements.campaignTextProvider.addEventListener("change", () => {
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
    if (selected && (!current || profileModelValue(selected) === current || selected.id === current)) applyEmbeddingModelContextBudget(selected);
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
    for (const model of models) elements.illustrationModels.append(new Option(model.displayName, model.id));
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
  if (elements.illustrationEnabled.checked && !provider) {
    elements.illustrationStatus.className = "status error";
    elements.illustrationStatus.textContent = enabledProviders("image").length
      ? "Select an image provider for this campaign before enabling illustrations."
      : "Add and enable an illustration provider in Provider Management before enabling images.";
    elements.campaignImageProvider.focus();
    return;
  }
  if (elements.illustrationEnabled.checked && !elements.illustrationModel.value.trim()) {
    elements.illustrationStatus.className = "status error";
    elements.illustrationStatus.textContent = "Select or enter an image model before enabling illustrations.";
    elements.illustrationModel.focus();
    return;
  }
  elements.saveIllustrationConfig.disabled = true;
  elements.illustrationStatus.className = "status";
  elements.illustrationStatus.textContent = "Saving independent illustration configuration…";
  try {
    const updatedCampaign = await api(`/api/v1/campaigns/${selectedCampaign.id}`, {
      method: "PATCH",
      body: JSON.stringify({ imageProviderProfileId: elements.campaignImageProvider.value || null })
    });
    selectedCampaign = { ...selectedCampaign, ...updatedCampaign };
    illustrationConfig = await api(`/api/v1/campaigns/${selectedCampaign.id}/illustration-config`, {
      method: "PUT",
      body: JSON.stringify({
        enabled: elements.illustrationEnabled.checked,
        providerProfileId: provider?.id || null,
        model: elements.illustrationModel.value,
        size: elements.illustrationSize.value,
        aspectRatio: elements.illustrationAspectRatio.value,
        quality: elements.illustrationQuality.value,
        outputFormat: elements.illustrationOutputFormat.value,
        maxAttempts: elements.illustrationMaxAttempts.value
      })
    });
    elements.illustrationStatus.className = "status success";
    elements.illustrationStatus.textContent = illustrationConfig.enabled
      ? "Automatic illustration child jobs are enabled. Story turns still commit successfully if the image endpoint is unavailable."
      : "Illustrations disabled. No image endpoint will be called for new turns.";
  } catch (error) {
    elements.illustrationStatus.className = "status error";
    elements.illustrationStatus.textContent = error.message || String(error);
  } finally {
    elements.saveIllustrationConfig.disabled = !selectedCampaign;
  }
}

function renderImageJobStatus(job) {
  elements.illustrationStatus.replaceChildren();
  elements.illustrationStatus.className = `status ${job.status === "completed" ? "success" : ["recoverable", "failed"].includes(job.status) ? "error" : ""}`.trim();
  const text = document.createElement("span");
  text.textContent = job.status === "completed"
    ? "Illustration generated and stored in Nexus shared asset storage."
    : job.status === "queued"
      ? `Illustration queued${job.attempts ? ` · attempt ${job.attempts} of ${job.maxAttempts}` : ""}. Story acceptance is already complete.`
      : job.status === "generating"
        ? `Illustration generating · attempt ${job.attempts} of ${job.maxAttempts}.`
        : `${job.errorMessage || "Illustration generation did not complete."} The accepted story turn is unchanged.`;
  elements.illustrationStatus.append(text);
  if (["recoverable", "failed"].includes(job.status)) {
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
    if (["recoverable", "failed"].includes(job.status)) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function loadLatestImageJob(monitor = false) {
  if (!selectedCampaign) return;
  const { jobs } = await api(`/api/v1/campaigns/${selectedCampaign.id}/image-jobs`);
  const job = jobs[0];
  if (!job) return;
  renderImageJobStatus(job);
  if (monitor && ["queued", "generating"].includes(job.status)) void monitorImageJob(job.id);
}

async function importStoryObject(story, sourceName) {
  const preview = await api("/api/v1/imports/legacy-story/preview", {
    method: "POST",
    body: JSON.stringify({ sourceName, story })
  });
  if (!preview.valid) throw new Error(preview.warnings.join(" ") || "The campaign export is not valid for import.");
  setStatus(`Importing ${story.turns?.length || 0} turns into PostgreSQL and building Chronicle memory…`);
  const result = await api("/api/v1/imports/legacy-story", {
    method: "POST",
    body: JSON.stringify({ sourceName, story })
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
    elements.importPreview.textContent = `${preview.duplicate ? "Duplicate" : "New"} Infinite Worlds world · world details only · no story turns · all ${preview.characters.length || 1} playable character${preview.characters.length === 1 ? "" : "s"} retained · ${preview.counts.entities} entities · ${preview.counts.triggers} triggers`;
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
  elements.importPreview.textContent = "Validating content without writing to the database…";
  let parsed = null;
  try { parsed = parseImportJson(sourceText); } catch { /* TXT imports are validated by the server */ }
  const forcedInfiniteWorlds = sourceKind !== "auto";
  const looksLikeInfiniteWorldsJson = parsed && (Array.isArray(parsed.possibleCharacters) || (Array.isArray(parsed.triggerEvents) && ("background" in parsed || "instructions" in parsed)));
  const looksLikeCyoaJson = parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.chapters && parsed.info && typeof parsed.chapters === "object";
  if (forcedInfiniteWorlds || looksLikeInfiniteWorldsJson || looksLikeCyoaJson || sourceName.toLowerCase().endsWith(".txt")) {
    await previewInfiniteWorldsSource(sourceName, sourceText, looksLikeCyoaJson && sourceKind === "auto" ? "cyoa_json" : sourceKind);
    return;
  }
  showInfiniteWorldsOptions(false);
  if (parsed?.format === "infinite-quest-world") {
    const request = { sourceName, worldExport: parsed };
    const preview = await api("/api/v1/imports/world/preview", { method: "POST", body: JSON.stringify(request) });
    selectedImport = { kind: "world", request };
    elements.importPreview.textContent = `${preview.duplicate ? "Duplicate" : "New"} world · ${preview.counts.entities} entities · ${preview.counts.relationships} relationships · ${preview.counts.triggers} triggers${preview.warnings.length ? ` · ${preview.warnings.join(" ")}` : ""}`;
    elements.importStory.disabled = false;
    setStatus(preview.duplicate ? "This world was already imported. Importing will select the existing record." : "Portable world validated and ready to import.", preview.duplicate ? "" : "success");
    return;
  }
  if (parsed?.world && Array.isArray(parsed.turns)) {
    const request = { sourceName, story: parsed };
    const preview = await api("/api/v1/imports/legacy-story/preview", { method: "POST", body: JSON.stringify(request) });
    selectedImport = { kind: "campaign", request };
    elements.importPreview.textContent = `${preview.duplicate ? "Duplicate" : "New"} campaign · ${preview.counts.turns} turns · approximately ${number(preview.counts.estimatedHistoryTokens)} history tokens${preview.warnings.length ? ` · ${preview.warnings.join(" ")}` : ""}`;
    elements.importStory.disabled = !preview.valid;
    setStatus(preview.valid ? (preview.duplicate ? "This campaign was already imported. Importing will select the existing record." : "Campaign validated and ready to import.") : "Correct the validation warnings before importing.", preview.valid ? (preview.duplicate ? "" : "success") : "error");
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
  elements.clipboardImportDialog.showModal();
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
      await importStoryObject(selectedImport.request.story, selectedImport.request.sourceName);
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
elements.importBrowserState.addEventListener("click", importBrowserState);
elements.newWorld.addEventListener("click", newWorld);
elements.refreshWorlds.addEventListener("click", () => loadWorlds().catch((error) => worldMessage(error.message || String(error), "error")));
elements.worldForm.addEventListener("submit", saveWorldDraft);
elements.worldVersionSelect.addEventListener("change", () => {
  loadWorldVersionPlayableCharacters().catch((error) => worldMessage(error.message || String(error), "error"));
});
elements.newCampaignCharacter.addEventListener("change", () => {
  elements.createCampaign.disabled = worldVersionCharacters.length > 1 && !elements.newCampaignCharacter.value;
});
elements.publishWorld.addEventListener("click", publishSelectedWorld);
if (elements.forkWorldModalBtn) {
  elements.forkWorldModalBtn.addEventListener("click", () => {
    elements.forkWorldTitle.value = `Fork of ${selectedWorld?.world?.title || "World"}`;
    elements.forkWorldDialog.showModal();
  });
  elements.cancelForkWorld.addEventListener("click", () => elements.forkWorldDialog.close());
  elements.forkWorldForm.addEventListener("submit", (e) => { e.preventDefault(); forkSelectedWorld(); });
}
if (elements.createCampaignModalBtn) {
  elements.createCampaignModalBtn.addEventListener("click", () => {
    elements.newCampaignTitle.value = "";
    elements.newCampaignCharacter.value = "";
    elements.createCampaignDialog.showModal();
  });
  elements.cancelCreateCampaign.addEventListener("click", () => elements.createCampaignDialog.close());
  elements.createCampaignForm.addEventListener("submit", (e) => { e.preventDefault(); createCampaignFromWorld(); });
}
elements.exportWorld.addEventListener("click", exportSelectedWorld);
elements.archiveWorld.addEventListener("click", toggleWorldArchive);
elements.deleteWorld.addEventListener("click", deleteSelectedWorld);
elements.refreshCampaigns.addEventListener("click", () => loadCampaigns().catch((error) => setStatus(error.message, "error")));
elements.campaignForm.addEventListener("submit", saveSelectedCampaign);
elements.migrateCampaign.addEventListener("click", migrateSelectedCampaign);
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
    if (elements.providerDialog) elements.providerDialog.showModal();
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
  elements.budgetTokensSource.textContent = "Manual memory context budget. Selecting a discovered embedding model can recalculate it from advertised limits.";
  elements.budgetTokensSource.className = "field-note manual-entry";
});
elements.discoverEmbeddingModels.addEventListener("click", async (event) => { event.stopPropagation(); await openEmbeddingModelPicker(true); });
elements.embeddingModel.addEventListener("click", () => { void openEmbeddingModelPicker(); });
elements.embeddingModel.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") { event.preventDefault(); void openEmbeddingModelPicker(); }
});
elements.embeddingForm.addEventListener("submit", saveEmbeddingConfig);
elements.illustrationForm.addEventListener("submit", saveIllustrationConfig);
elements.illustrationEnabled.addEventListener("change", () => {
  if (elements.illustrationEnabled.checked && !enabledProviders("image").length) {
    elements.illustrationEnabled.checked = false;
    elements.illustrationStatus.className = "status error";
    elements.illustrationStatus.textContent = "Add and enable an illustration provider in Provider Management before enabling images.";
  }
  const provider = effectiveCampaignProvider("image");
  if (elements.illustrationEnabled.checked && provider?.defaultModel && !elements.illustrationModel.value.trim()) {
    elements.illustrationModel.value = provider.defaultModel;
  }
  renderIllustrationSettingsVisibility();
});
elements.discoverIllustrationModels.addEventListener("click", discoverIllustrationModels);
detectBrowserStory();
loadProviders().catch((error) => providerMessage(error.message || String(error), "error"));
loadWorlds().catch((error) => worldMessage(error.message || String(error), "error"));
loadCampaigns().catch((error) => setStatus(error.message || String(error), "error"));
