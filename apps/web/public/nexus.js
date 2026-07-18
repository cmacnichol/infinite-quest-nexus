const elements = Object.fromEntries([...document.querySelectorAll("[id]")].map((element) => [element.id, element]));
let selectedFile = null;
let selectedImport = null;
let selectedCampaign = null;
let worlds = [];
let selectedWorld = null;
const legacyStorageKey = "infiniteQuestNexusClientState.v1";
const campaignResumeStorageKey = "infiniteQuestNexusCampaignResume.v1";
let detectedBrowserStory = null;
let providers = [];
let selectedProvider = null;
let embeddingConfig = null;
let illustrationConfig = null;
let latestDisplayedTurn = null;
let contextPreviewSequence = 0;
let discoveredProviderModels = [];
let pendingDeleteTitle = "";
let pendingDeleteResolve = null;

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || `Request failed with HTTP ${response.status}.`);
  return payload;
}

function setStatus(message, type = "") {
  elements.importStatus.textContent = message;
  elements.importStatus.className = `status ${type}`.trim();
}

function number(value) {
  return Number(value || 0).toLocaleString();
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

async function loadWorlds(preselectId = "") {
  ({ worlds } = await api("/api/v1/worlds"));
  elements.worldList.replaceChildren();
  if (!worlds.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No worlds yet. Create one or import a portable world.";
    elements.worldList.append(empty);
    selectedWorld = null;
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
  try {
    const campaign = await api("/api/v1/campaigns", {
      method: "POST",
      body: JSON.stringify({ title, worldVersionId: selectedWorldVersionId() })
    });
    elements.newCampaignTitle.value = "";
    await loadCampaigns(campaign.id);
    worldMessage("Campaign created from the selected immutable world version.", "success");
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
    [elements.campaignTitle, elements.campaignStatus, elements.campaignWorldVersion, elements.saveCampaign, elements.migrateCampaign, elements.loadCampaign, elements.exportCampaign, elements.deleteCampaign].forEach((element) => { element.disabled = true; });
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
    details.textContent = `${campaign.activeTurnNumber} accepted turns · ${campaign.worldTitle} v${campaign.worldVersionNumber}${campaign.worldUpdateAvailable ? " · update available" : ""}${campaign.status === "archived" ? " · archived" : ""}`;
    button.append(title, details);
    button.addEventListener("click", () => selectCampaign(campaign));
    elements.campaignList.append(button);
  }
  const target = campaigns.find((campaign) => campaign.id === preselectId) || (selectedCampaign && campaigns.find((campaign) => campaign.id === selectedCampaign.id));
  if (target) await selectCampaign(target);
}

async function selectCampaign(campaign) {
  selectedCampaign = campaign;
  document.querySelectorAll(".campaign-button").forEach((button) => button.classList.toggle("active", button.dataset.campaignId === campaign.id));
  elements.memoryTitle.textContent = campaign.title;
  elements.reindexMemory.disabled = false;
  elements.previewContext.disabled = false;
  elements.generateTurn.disabled = !selectedProvider;
  elements.saveEmbeddingConfig.disabled = false;
  elements.saveIllustrationConfig.disabled = false;
  elements.campaignTitle.value = campaign.title;
  elements.campaignStatus.value = campaign.status;
  [elements.campaignTitle, elements.campaignStatus, elements.campaignWorldVersion, elements.saveCampaign, elements.loadCampaign, elements.exportCampaign, elements.deleteCampaign].forEach((element) => { element.disabled = false; });
  const world = await api(`/api/v1/worlds/${campaign.worldId}`);
  elements.campaignWorldVersion.replaceChildren();
  for (const version of [...world.versions].reverse()) {
    elements.campaignWorldVersion.append(new Option(`Version ${version.versionNumber}`, version.id));
  }
  elements.campaignWorldVersion.value = campaign.worldVersionId;
  elements.migrateCampaign.disabled = !world.versions.some((version) => version.versionNumber > campaign.worldVersionNumber);
  if (campaign.worldUpdateAvailable) campaignMessage(`This campaign is pinned to version ${campaign.worldVersionNumber}; version ${campaign.latestWorldVersionNumber} is available. Migration is explicit and does not rewrite accepted turns.`);
  else elements.campaignStatusMessage.classList.add("hidden");
  const metrics = await api(`/api/v1/campaigns/${campaign.id}/memory/metrics`);
  elements.memoryMetrics.innerHTML = [
    [number(metrics.turns), "accepted turns"],
    [number(metrics.estimatedCompleteHistoryTokens), "complete-history tokens"],
    [number(metrics.memoryCount), "Chronicle memories"],
    [number(metrics.embeddedMemories), "embedded memories"]
  ].map(([value, label]) => `<div class="metric"><strong>${value}</strong><span>${label}</span></div>`).join("");
  await loadEmbeddingConfig();
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
      body: JSON.stringify({ title: elements.campaignTitle.value, status: elements.campaignStatus.value })
    });
    await loadCampaigns(selectedCampaign.id);
    campaignMessage("Campaign metadata saved. Accepted turns and Chronicle memory were unchanged.", "success");
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
  elements.loadCampaign.disabled = true;
  campaignMessage("Preparing the accepted campaign ledger for the story view…");
  try {
    const story = await api(`/api/v1/campaigns/${selectedCampaign.id}/export`);
    sessionStorage.setItem(campaignResumeStorageKey, JSON.stringify({
      campaignId: selectedCampaign.id,
      activeTurnNumber: selectedCampaign.activeTurnNumber,
      story
    }));
    window.location.assign("/");
  } catch (error) {
    campaignMessage(error.message || String(error), "error");
    elements.loadCampaign.disabled = !selectedCampaign;
  }
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
    await loadCampaigns();
    await loadWorlds(selectedWorld?.id || "");
    campaignMessage(`Campaign “${expectedTitle}” was permanently deleted.`, "success");
  } catch (error) {
    campaignMessage(error.message || String(error), "error");
    elements.deleteCampaign.disabled = !selectedCampaign;
  }
}

async function loadEmbeddingConfig() {
  if (!selectedCampaign) return;
  embeddingConfig = await api(`/api/v1/campaigns/${selectedCampaign.id}/memory/embedding-config`);
  elements.embeddingEnabled.checked = embeddingConfig.enabled;
  elements.embeddingProvider.value = embeddingConfig.providerProfileId || "";
  elements.embeddingModel.value = embeddingConfig.model || "";
  elements.embeddingBatchSize.value = String(embeddingConfig.batchSize || 16);
  elements.discoverEmbeddingModels.disabled = !elements.embeddingProvider.value;
  elements.embeddingStatus.textContent = embeddingConfig.enabled
    ? `Hybrid retrieval is enabled with ${embeddingConfig.model}. New accepted memories are indexed by a durable worker job.`
    : "Semantic retrieval is disabled for this campaign; deterministic lexical and chronological retrieval remains active.";
}

async function loadIllustrationConfig() {
  if (!selectedCampaign) return;
  illustrationConfig = await api(`/api/v1/campaigns/${selectedCampaign.id}/illustration-config`);
  elements.illustrationEnabled.checked = illustrationConfig.enabled;
  elements.illustrationProvider.value = illustrationConfig.providerProfileId || "";
  elements.illustrationModel.value = illustrationConfig.model || "";
  elements.illustrationSize.value = illustrationConfig.size || "1024x1024";
  elements.illustrationAspectRatio.value = illustrationConfig.aspectRatio || "1:1";
  elements.illustrationQuality.value = illustrationConfig.quality || "auto";
  elements.illustrationOutputFormat.value = illustrationConfig.outputFormat || "png";
  elements.illustrationMaxAttempts.value = String(illustrationConfig.maxAttempts || 3);
  elements.discoverIllustrationModels.disabled = !elements.illustrationProvider.value;
  elements.illustrationStatus.textContent = illustrationConfig.enabled
    ? `Automatic illustrations are enabled with ${illustrationConfig.model}. Endpoint health: ${providers.find((provider) => provider.id === illustrationConfig.providerProfileId)?.healthStatus || "unknown"}. They run after story acceptance and cannot change the accepted turn.`
    : "Illustrations are disabled for this campaign. Story generation is unaffected.";
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
    if (selectedProvider) elements.budgetTokens.value = String(Math.max(512, contextLength - selectedProvider.maxOutputTokens - 1024));
  } else {
    elements.providerContextTokens.readOnly = false;
    elements.providerContextTokens.removeAttribute("aria-readonly");
    elements.providerContextSource.textContent = "The model API did not advertise a context length; enter the loaded context manually.";
    elements.providerContextSource.className = "field-note manual-entry";
  }
}

async function loadProviders(preselectId = "") {
  ({ providers } = await api("/api/v1/providers"));
  elements.providerSelect.replaceChildren(new Option("No text provider configured", ""));
  for (const provider of providers.filter((item) => item.providerRole === "text" && item.enabled)) {
    elements.providerSelect.append(new Option(`${provider.name} · ${provider.providerType}`, provider.id));
  }
  elements.embeddingProvider.replaceChildren(new Option("No embedding provider configured", ""));
  for (const provider of providers.filter((item) => item.providerRole === "embedding" && item.enabled)) {
    elements.embeddingProvider.append(new Option(`${provider.name} · ${provider.providerType}`, provider.id));
  }
  elements.illustrationProvider.replaceChildren(new Option("No image provider configured", ""));
  for (const provider of providers.filter((item) => item.providerRole === "image" && item.enabled)) {
    elements.illustrationProvider.append(new Option(`${provider.name} · ${provider.providerType} · ${provider.healthStatus || "unknown"}`, provider.id));
  }
  const target = providers.find((provider) => provider.id === preselectId && provider.providerRole === "text" && provider.enabled)
    || providers.find((provider) => provider.id === elements.providerSelect.value)
    || providers.find((provider) => provider.providerRole === "text" && provider.enabled)
    || null;
  elements.providerSelect.value = target?.id || "";
  selectedProvider = target;
  elements.discoverModels.disabled = !target;
  elements.generateTurn.disabled = !target || !selectedCampaign;
  if (target) providerMessage(`${target.name} selected. Profile context is ${number(target.contextWindowTokens)} tokens; maximum output is ${number(target.maxOutputTokens)} tokens.`);
  if (embeddingConfig?.providerProfileId) elements.embeddingProvider.value = embeddingConfig.providerProfileId;
  if (illustrationConfig?.providerProfileId) elements.illustrationProvider.value = illustrationConfig.providerProfileId;
}

async function saveProvider(event) {
  event.preventDefault();
  providerMessage("Saving provider profile…");
  try {
    const provider = await api("/api/v1/providers", {
      method: "POST",
      body: JSON.stringify({
        name: elements.providerName.value,
        providerType: elements.providerType.value,
        providerRole: elements.providerRole.value,
        baseUrl: elements.providerBaseUrl.value,
        apiKey: elements.providerApiKey.value || undefined,
        defaultModel: elements.providerDefaultModel.value,
        contextWindowTokens: elements.providerContextTokens.value,
        maxOutputTokens: elements.providerOutputTokens.value,
        temperature: 0.8,
        configuration: {}
      })
    });
    elements.providerApiKey.value = "";
    await loadProviders(provider.providerRole === "text" ? provider.id : "");
    if (provider.providerRole === "embedding") {
      elements.embeddingProvider.value = provider.id;
      elements.embeddingModel.value = provider.defaultModel || "";
      elements.discoverEmbeddingModels.disabled = false;
    }
    if (provider.providerRole === "image") {
      elements.illustrationProvider.value = provider.id;
      elements.illustrationModel.value = provider.defaultModel || "";
      elements.discoverIllustrationModels.disabled = false;
    }
    providerMessage(`${provider.name} saved. Credentials, if supplied, were encrypted before database storage.`, "success");
  } catch (error) {
    providerMessage(error.message || String(error), "error");
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
  selectedProvider = providers.find((provider) => provider.id === elements.providerSelect.value) || null;
  elements.discoverModels.disabled = !selectedProvider;
  elements.generateTurn.disabled = !selectedProvider || !selectedCampaign;
  discoveredProviderModels = [];
  elements.modelSelect.replaceChildren(new Option("Discover models or use the profile default", ""));
  elements.modelSelect.disabled = true;
  elements.providerContextTokens.readOnly = false;
  elements.providerContextTokens.removeAttribute("aria-readonly");
  elements.providerContextSource.textContent = "Editable until model discovery supplies a context length.";
  elements.providerContextSource.className = "field-note";
});

elements.modelSelect.addEventListener("change", applyDiscoveredProviderContext);

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
  elements.discoverEmbeddingModels.disabled = !provider;
  if (provider?.defaultModel && !elements.embeddingModel.value) elements.embeddingModel.value = provider.defaultModel;
});

async function discoverEmbeddingModels() {
  const provider = providers.find((item) => item.id === elements.embeddingProvider.value);
  if (!provider) return;
  elements.discoverEmbeddingModels.disabled = true;
  elements.embeddingStatus.textContent = `Querying ${provider.name} model inventory…`;
  try {
    const { models } = await api(`/api/v1/providers/${provider.id}/models`);
    elements.embeddingModels.replaceChildren();
    for (const model of models) elements.embeddingModels.append(new Option(model.displayName, model.id));
    const preferred = models.find((model) => /embed/i.test(`${model.id} ${model.displayName}`)) || models[0];
    if (preferred) elements.embeddingModel.value = preferred.id;
    elements.embeddingStatus.textContent = `${models.length} model entries found. Confirm an embedding-capable model before saving.`;
  } catch (error) {
    elements.embeddingStatus.textContent = error.message || String(error);
    elements.embeddingStatus.className = "status error";
  } finally {
    elements.discoverEmbeddingModels.disabled = false;
  }
}

async function saveEmbeddingConfig(event) {
  event.preventDefault();
  if (!selectedCampaign) return;
  elements.saveEmbeddingConfig.disabled = true;
  elements.embeddingStatus.className = "status";
  elements.embeddingStatus.textContent = "Saving campaign memory configuration…";
  try {
    const saved = await api(`/api/v1/campaigns/${selectedCampaign.id}/memory/embedding-config`, {
      method: "PUT",
      body: JSON.stringify({
        enabled: elements.embeddingEnabled.checked,
        providerProfileId: elements.embeddingProvider.value || null,
        model: elements.embeddingModel.value,
        batchSize: elements.embeddingBatchSize.value
      })
    });
    embeddingConfig = saved;
    elements.embeddingStatus.className = "status success";
    elements.embeddingStatus.textContent = saved.enabled
      ? `Semantic indexing queued as durable job ${saved.jobId}. Context retrieval will fall back safely until vectors are ready.`
      : "Semantic retrieval disabled and derived vectors removed. Lexical Chronicle retrieval remains available.";
  } catch (error) {
    elements.embeddingStatus.className = "status error";
    elements.embeddingStatus.textContent = error.message || String(error);
  } finally {
    elements.saveEmbeddingConfig.disabled = !selectedCampaign;
  }
}

elements.illustrationProvider.addEventListener("change", () => {
  const provider = providers.find((item) => item.id === elements.illustrationProvider.value);
  elements.discoverIllustrationModels.disabled = !provider;
  if (provider?.defaultModel && !elements.illustrationModel.value) elements.illustrationModel.value = provider.defaultModel;
});

async function discoverIllustrationModels() {
  const provider = providers.find((item) => item.id === elements.illustrationProvider.value);
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
    elements.discoverIllustrationModels.disabled = !elements.illustrationProvider.value;
  }
}

async function saveIllustrationConfig(event) {
  event.preventDefault();
  if (!selectedCampaign) return;
  elements.saveIllustrationConfig.disabled = true;
  elements.illustrationStatus.className = "status";
  elements.illustrationStatus.textContent = "Saving independent illustration configuration…";
  try {
    illustrationConfig = await api(`/api/v1/campaigns/${selectedCampaign.id}/illustration-config`, {
      method: "PUT",
      body: JSON.stringify({
        enabled: elements.illustrationEnabled.checked,
        providerProfileId: elements.illustrationProvider.value || null,
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
      await displayLatestTurn();
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

async function requestLatestIllustration(replace = false) {
  if (!latestDisplayedTurn) return;
  const job = await api(`/api/v1/turns/${latestDisplayedTurn.id}/illustrations`, {
    method: "POST",
    body: JSON.stringify({ replace })
  });
  renderImageJobStatus(job);
  if (["queued", "generating"].includes(job.status)) void monitorImageJob(job.id);
}

elements.modelSelect.addEventListener("change", () => {
  const contextLength = Number(elements.modelSelect.selectedOptions[0]?.dataset.contextLength || 0);
  if (contextLength && selectedProvider) elements.budgetTokens.value = String(Math.max(512, contextLength - selectedProvider.maxOutputTokens - 1024));
});

async function displayLatestTurn() {
  if (!selectedCampaign) return;
  const { turns } = await api(`/api/v1/campaigns/${selectedCampaign.id}/turns`);
  const turn = turns.at(-1);
  if (!turn) {
    latestDisplayedTurn = null;
    return;
  }
  latestDisplayedTurn = turn;
  elements.generatedTurn.replaceChildren();
  const title = document.createElement("h3");
  title.textContent = `Turn ${turn.turnNumber}`;
  const narration = document.createElement("p");
  narration.textContent = turn.narration;
  const choices = document.createElement("ol");
  for (const choice of turn.choices || []) {
    const item = document.createElement("li");
    item.textContent = choice;
    choices.append(item);
  }
  elements.generatedTurn.append(title, narration);
  if (turn.imageUrl) {
    const image = document.createElement("img");
    image.src = turn.imageUrl;
    image.alt = `Illustration for turn ${turn.turnNumber}`;
    image.loading = "lazy";
    image.className = "turn-illustration";
    elements.generatedTurn.append(image);
  }
  elements.generatedTurn.append(choices);
  if (turn.imagePrompt && illustrationConfig?.providerProfileId) {
    const illustrationButton = document.createElement("button");
    illustrationButton.type = "button";
    illustrationButton.className = "button secondary";
    illustrationButton.textContent = turn.imageUrl ? "Regenerate illustration" : "Generate illustration";
    illustrationButton.addEventListener("click", () => requestLatestIllustration(Boolean(turn.imageUrl)).catch((error) => {
      elements.illustrationStatus.className = "status error";
      elements.illustrationStatus.textContent = error.message || String(error);
    }));
    elements.generatedTurn.append(illustrationButton);
  }
  elements.generatedTurn.classList.remove("hidden");
}

async function generateTurn(event) {
  event.preventDefault();
  if (!selectedCampaign || !selectedProvider) return;
  elements.generateTurn.disabled = true;
  elements.generationStatus.classList.remove("hidden", "error", "success");
  elements.generationStatus.textContent = "Queueing durable story generation…";
  try {
    const job = await api(`/api/v1/campaigns/${selectedCampaign.id}/generations`, {
      method: "POST",
      body: JSON.stringify({
        action: elements.storyAction.value,
        providerProfileId: selectedProvider.id,
        model: elements.modelSelect.value || undefined,
        idempotencyKey: crypto.randomUUID(),
        context: {
          budgetTokens: elements.budgetTokens.value,
          compression: elements.compression.value,
          recentTurns: 8,
          modelContextWindowTokens: Number(elements.modelSelect.selectedOptions[0]?.dataset.contextLength || 0) || selectedProvider.contextWindowTokens
        }
      })
    });
    for (let attempt = 0; attempt < 600; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const status = await api(`/api/v1/generation-jobs/${job.id}`);
      elements.generationStatus.textContent = `Story Engine: ${status.status}${status.attempts ? ` · execution ${status.attempts}` : ""}`;
      if (status.status === "completed") {
        elements.generationStatus.classList.add("success");
        elements.generationStatus.textContent = "Turn validated, committed, and indexed in Chronicle.";
        elements.storyAction.value = "";
        await loadCampaigns(selectedCampaign.id);
        await displayLatestTurn();
        await loadLatestImageJob(true);
        return;
      }
      if (status.status === "recoverable") throw new Error(`${status.errorMessage || "The provider response was incomplete."} The existing turn is unchanged; this job can be retried.`);
      if (status.status === "failed") throw new Error(status.errorMessage || "Story generation failed without changing the campaign.");
    }
    throw new Error("Generation is still running. Its durable job will continue on the server.");
  } catch (error) {
    elements.generationStatus.classList.add("error");
    elements.generationStatus.textContent = error.message || String(error);
  } finally {
    elements.generateTurn.disabled = !selectedCampaign || !selectedProvider;
  }
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
  setStatus(`${duplicate} ${result.stats.turnCount} turns and ${result.stats.memoryCount} memories are available. Complete history is approximately ${number(result.stats.estimatedHistoryTokens)} tokens.`, "success");
  await loadWorlds(result.worldId);
  await loadCampaigns(result.campaignId);
}

async function previewImportFile(file) {
  selectedImport = null;
  elements.importStory.disabled = true;
  elements.importPreview.textContent = "Validating file without writing to the database…";
  const text = await file.text();
  const parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
  if (parsed?.format === "infinite-quest-world") {
    const request = { sourceName: file.name, worldExport: parsed };
    const preview = await api("/api/v1/imports/world/preview", { method: "POST", body: JSON.stringify(request) });
    selectedImport = { kind: "world", request };
    elements.importPreview.textContent = `${preview.duplicate ? "Duplicate" : "New"} world · ${preview.counts.entities} entities · ${preview.counts.relationships} relationships · ${preview.counts.triggers} triggers${preview.warnings.length ? ` · ${preview.warnings.join(" ")}` : ""}`;
    elements.importStory.disabled = false;
    setStatus(preview.duplicate ? "This world was already imported. Importing will select the existing record." : "Portable world validated and ready to import.", preview.duplicate ? "" : "success");
    return;
  }
  if (parsed?.world && Array.isArray(parsed.turns)) {
    const request = { sourceName: file.name, story: parsed };
    const preview = await api("/api/v1/imports/legacy-story/preview", { method: "POST", body: JSON.stringify(request) });
    selectedImport = { kind: "campaign", request };
    elements.importPreview.textContent = `${preview.duplicate ? "Duplicate" : "New"} campaign · ${preview.counts.turns} turns · approximately ${number(preview.counts.estimatedHistoryTokens)} history tokens${preview.warnings.length ? ` · ${preview.warnings.join(" ")}` : ""}`;
    elements.importStory.disabled = !preview.valid;
    setStatus(preview.valid ? (preview.duplicate ? "This campaign was already imported. Importing will select the existing record." : "Campaign validated and ready to import.") : "Correct the validation warnings before importing.", preview.valid ? (preview.duplicate ? "" : "success") : "error");
    return;
  }
  throw new Error("The file is neither a portable Infinite Quest world nor a campaign/story export.");
}

async function importStory() {
  if (!selectedFile || !selectedImport) return;
  elements.importStory.disabled = true;
  try {
    if (selectedImport.kind === "world") {
      setStatus("Importing the validated portable world…");
      const result = await api("/api/v1/imports/world", { method: "POST", body: JSON.stringify(selectedImport.request) });
      await loadWorlds(result.worldId);
      setStatus(result.duplicate ? "The world was already imported; the existing World Library record was selected." : "World imported with an immutable version and editable draft.", "success");
    } else {
      await importStoryObject(selectedImport.request.story, selectedImport.request.sourceName);
    }
  } catch (error) {
    setStatus(error.message || String(error), "error");
  } finally {
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
    const parameters = new URLSearchParams({
      budgetTokens: elements.budgetTokens.value,
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
  selectedImport = null;
  elements.importStory.disabled = true;
  if (!selectedFile) {
    elements.importPreview.textContent = "No file has been validated.";
    setStatus("Choose a story file to begin.");
    return;
  }
  setStatus(`Reading and validating ${selectedFile.name}…`);
  try {
    await previewImportFile(selectedFile);
  } catch (error) {
    elements.importPreview.textContent = "Validation failed; no database content was changed.";
    setStatus(error.message || String(error), "error");
  }
});
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
elements.publishWorld.addEventListener("click", publishSelectedWorld);
elements.forkWorld.addEventListener("click", forkSelectedWorld);
elements.createCampaign.addEventListener("click", createCampaignFromWorld);
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
elements.providerForm.addEventListener("submit", saveProvider);
elements.discoverModels.addEventListener("click", discoverProviderModels);
elements.compression.addEventListener("change", () => {
  elements.compression.title = elements.compression.selectedOptions[0]?.title || "Choose how Chronicle fits history into the context budget.";
});
elements.discoverEmbeddingModels.addEventListener("click", discoverEmbeddingModels);
elements.embeddingForm.addEventListener("submit", saveEmbeddingConfig);
elements.illustrationForm.addEventListener("submit", saveIllustrationConfig);
elements.discoverIllustrationModels.addEventListener("click", discoverIllustrationModels);
elements.generationForm.addEventListener("submit", generateTurn);

detectBrowserStory();
loadProviders().catch((error) => providerMessage(error.message || String(error), "error"));
loadWorlds().catch((error) => worldMessage(error.message || String(error), "error"));
loadCampaigns().catch((error) => setStatus(error.message || String(error), "error"));
