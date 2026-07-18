const elements = Object.fromEntries([...document.querySelectorAll("[id]")].map((element) => [element.id, element]));
let selectedFile = null;
let selectedCampaign = null;
const legacyStorageKey = "infiniteQuestNexusClientState.v1";
let detectedBrowserStory = null;
let providers = [];
let selectedProvider = null;
let embeddingConfig = null;
let contextPreviewSequence = 0;

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

async function loadCampaigns(preselectId = "") {
  const { campaigns } = await api("/api/v1/campaigns");
  elements.campaignList.replaceChildren();
  if (!campaigns.length) {
    elements.campaignList.innerHTML = '<p class="muted">No database-backed campaigns yet.</p>';
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
    details.textContent = `${campaign.activeTurnNumber} accepted turns · ${campaign.worldTitle}`;
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
  const metrics = await api(`/api/v1/campaigns/${campaign.id}/memory/metrics`);
  elements.memoryMetrics.innerHTML = [
    [number(metrics.turns), "accepted turns"],
    [number(metrics.estimatedCompleteHistoryTokens), "complete-history tokens"],
    [number(metrics.memoryCount), "Chronicle memories"],
    [number(metrics.embeddedMemories), "embedded memories"]
  ].map(([value, label]) => `<div class="metric"><strong>${value}</strong><span>${label}</span></div>`).join("");
  await loadEmbeddingConfig();
  await previewContext();
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

function providerMessage(message, type = "") {
  elements.providerStatus.textContent = message;
  elements.providerStatus.className = `status ${type}`.trim();
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
      if (loaded.contextLength) {
        const available = Math.max(512, loaded.contextLength - selectedProvider.maxOutputTokens - 1024);
        elements.budgetTokens.value = String(available);
      }
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

elements.modelSelect.addEventListener("change", () => {
  const contextLength = Number(elements.modelSelect.selectedOptions[0]?.dataset.contextLength || 0);
  if (contextLength && selectedProvider) elements.budgetTokens.value = String(Math.max(512, contextLength - selectedProvider.maxOutputTokens - 1024));
});

async function displayLatestTurn() {
  if (!selectedCampaign) return;
  const { turns } = await api(`/api/v1/campaigns/${selectedCampaign.id}/turns`);
  const turn = turns.at(-1);
  if (!turn) return;
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
  elements.generatedTurn.append(title, narration, choices);
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
  setStatus(`Importing ${story.turns?.length || 0} turns into PostgreSQL and building Chronicle memory…`);
  const result = await api("/api/v1/imports/legacy-story", {
    method: "POST",
    body: JSON.stringify({ sourceName, story })
  });
  const duplicate = result.duplicate ? "The story was already imported; the existing campaign was selected." : "Import completed.";
  setStatus(`${duplicate} ${result.stats.turnCount} turns and ${result.stats.memoryCount} memories are available. Complete history is approximately ${number(result.stats.estimatedHistoryTokens)} tokens.`, "success");
  await loadCampaigns(result.campaignId);
}

async function importStory() {
  if (!selectedFile) return;
  elements.importStory.disabled = true;
  setStatus(`Reading ${selectedFile.name}…`);
  try {
    const text = await selectedFile.text();
    const story = JSON.parse(text.replace(/^\uFEFF/, ""));
    await importStoryObject(story, selectedFile.name);
  } catch (error) {
    setStatus(error.message || String(error), "error");
  } finally {
    elements.importStory.disabled = !selectedFile;
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

elements.storyFile.addEventListener("change", () => {
  selectedFile = elements.storyFile.files?.[0] || null;
  elements.importStory.disabled = !selectedFile;
  setStatus(selectedFile ? `${selectedFile.name} is ready to import.` : "Choose a story file to begin.");
});
elements.importStory.addEventListener("click", importStory);
elements.importBrowserState.addEventListener("click", importBrowserState);
elements.refreshCampaigns.addEventListener("click", () => loadCampaigns().catch((error) => setStatus(error.message, "error")));
elements.contextForm.addEventListener("submit", previewContext);
elements.reindexMemory.addEventListener("click", rebuildMemory);
elements.providerForm.addEventListener("submit", saveProvider);
elements.discoverModels.addEventListener("click", discoverProviderModels);
elements.discoverEmbeddingModels.addEventListener("click", discoverEmbeddingModels);
elements.embeddingForm.addEventListener("submit", saveEmbeddingConfig);
elements.generationForm.addEventListener("submit", generateTurn);

detectBrowserStory();
loadProviders().catch((error) => providerMessage(error.message || String(error), "error"));
loadCampaigns().catch((error) => setStatus(error.message || String(error), "error"));
