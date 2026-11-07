import { bindEditDialogDismissal, requestEditDismissal } from "@infinite-quest/client-web";
import { createSelectionEditorState, providerReadinessForRole, reduceSelectionEditor, serializeSelectionEditorPatch } from "@infinite-quest/client-core";
import { nativePresetSupport } from "@infinite-quest/client-web";
import markup from "./provider-editor.html?raw";

export function mountProviderEditor(root, ports) {
  const document = root.ownerDocument;
  const window = document.defaultView;
  const controller = new AbortController();
  const signal = controller.signal;
  root.innerHTML = markup;
  const elements = Object.fromEntries([...root.querySelectorAll("[id]")].map(element => [element.id, element]));
  let providers = [];
  let providerInventoryObservations = [];
  let providerInventoryRequestSequence = 0;
  const providerInventoryRequestEpochs = new Map();
  let editingProviderId = "";
  let discoveredProfileModels = [];
  let discoveredProfileModelsIdentity = "";
  let responseFormatCapabilitySequence = 0;
  let responseFormatCapabilityProfile = null;
  let nativeTextExecutionPlansSupportState = "loading";
  let providerSelectionEditor = null;
  let providerSelectionRequestSequence = 0;
  let providerPresetListController = null;
  let providerPresetDetailController = null;
  let providerSelectionCredentialRevision = 0;
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

  let providerSaveBusy = false;
  let formDestination = "";
  let inventoryRequest = null;
  const rangeDefaults = [elements.providerSogniSteps, elements.providerSogniGuidance, elements.providerSogniPreviewCount]
    .map(input => ({input, min: input.min, max: input.max, step: input.step}));
  const destination = () => JSON.stringify([elements.providerType.value, elements.providerRole.value, elements.providerBaseUrl.value.trim()]);
  const suppliedCredential = () => elements.providerApiKey.value.trim();
  function sameSavedDestination(profile) {
    return profile && profile.providerType === elements.providerType.value && profile.providerRole === elements.providerRole.value
      && profile.baseUrl === elements.providerBaseUrl.value.trim();
  }
  function invalidateInventory() {
    inventoryRequest?.abort();
    inventoryRequest = null;
    clearResponseFormatCapability();
    providerSelectionCredentialRevision++;
    const hadInventory = discoveredProfileModels.length > 0;
    const previousModel = elements.providerDefaultModel.value;
    if (discoveredProfileModels.some(model => profileModelValue(model) === previousModel)) {
      elements.providerDefaultModel.value = "";
      if (providerSelectionEditor?.mode === "model") setProviderSelectionState({type:"modelDraftChanged", modelId:"", responseFormatPolicy: elements.providerResponseFormatPolicy.value});
    }
    discoveredProfileModels = [];
    discoveredProfileModelsIdentity = "";
    elements.providerModelPickerList.replaceChildren();
    elements.providerModelPickerStatus.textContent = "";
    elements.providerCustomModel.value = "";
    elements.refreshProviderModels.disabled = false;
    elements.refreshProviderModelDialog.disabled = false;
    if (elements.providerContextTokens.readOnly) elements.providerContextTokens.value = "32768";
    applyProfileModelContext();
    if (hadInventory) {
      for (const {input, min, max, step} of rangeDefaults) { input.min = min; input.max = max; input.step = step; }
      for (const select of [elements.providerSogniSampler, elements.providerSogniScheduler]) select.replaceChildren(new Option("Model default", ""));
      elements.providerSogniSizePreset.replaceChildren(new Option("Custom dimensions", "custom"));
      applySogniWorkerTypeOptions(null);
    }
    if (providerSelectionEditor) setProviderSelectionState({type:"authorityChanged", ...providerSelectionAuthority(providers.find(p => p.id === editingProviderId))});
  }
  function syncDestination() {
    const next = destination();
    if (next === formDestination) return;
    formDestination = next;
    elements.providerApiKey.value = "";
    invalidateInventory();
  }
  const DEFAULT_LM_STUDIO_BASE_URL = "http://10.11.41.224:1234";
  const providerPresetsApi = ports.presets;
  const openManagedModal = dialog => dialog.showModal();
  let baseline = "";
  let opener = null;
  const snapshot = () => JSON.stringify([...elements.providerForm.elements].map(control =>
    control.type === "password" ? Boolean(control.value) : [control.value, control.checked]));
  function openEditDialog(dialog, trigger = document.activeElement) {
    baseline = snapshot();
    opener = trigger;
    dialog.showModal();
  }
  function dismissalOptions() {
    return {
      isBusy: () => providerSaveBusy, isDirty: () => snapshot() !== baseline,
      isCurrent: () => !signal.aborted, returnFocusTo: opener,
      discard: () => { resetProviderForm(); baseline = snapshot(); },
      confirm: () => new Promise(resolve => {
        const decision = elements.discardChangesDialog;
        decision.returnValue = "";
        decision.addEventListener("close", () => resolve(decision.returnValue === "discard" ? "discard" : "stay"), {once:true});
        decision.showModal();
      })
    };
  }
  const releaseCancel = bindEditDialogDismissal(elements.providerDialog, dismissalOptions);
  const dismissEditDialog = dialog => requestEditDismissal({dialog, ...dismissalOptions()});
  function providerMessage(message, type = "") {
    elements.providerStatus.textContent = message;
    elements.providerStatus.className = `status ${type}`;
    elements.providerEditorStatus.textContent = message;
  }
  function reportProviderListReadFailure(message) {
    if (signal.aborted) return;
    providerMessage(message, "error");
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "Retry provider profiles";
    retry.onclick = () => loadProviders().then(() => providerMessage("Provider profiles refreshed.", "success")).catch(() => reportProviderListReadFailure(message));
    elements.providerStatus.append(retry);
  }
  async function loadProviders() {
    const response = await ports.list(signal);
    if (signal.aborted) return;
    providers = response.providers;
    renderProviderProfiles();
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
  function safeWorkflowFailure(label, error) {
    const correlationId = typeof error?.correlationId === "string" && /^[a-z0-9-]{1,80}$/iu.test(error.correlationId)
      ? ` Reference: ${error.correlationId}.`
      : "";
    return `${label}${correlationId}`;
  }
  function providerTypeLabel(providerType) {
    return providerType === "sogni" ? "Sogni Creative Workflow (REST)"
      : providerType === "sogni_sdk" ? "Sogni Supernet SDK"
        : providerType;
  }
  function enabledProviders(role) {
    return providers.filter((provider) => provider.providerRole === role && provider.enabled);
  }
  function providerReadinessCapabilityLabel(status) {
    const labels = {
      "not-applicable": "Not applicable",
      unknown: "Unknown",
      advertised: "Advertised, not verified",
      expired: "Expired",
      malformed: "Malformed evidence",
      "identity-mismatch": "Does not match current model/schema",
      unsupported: "Not supported",
      verified: "Verified for current schema"
    };
    return labels[status] || "Unknown";
  }

  function renderProviderReadiness() {
    for (const role of ["text", "image", "embedding"]) {
      const card = elements.providers.querySelector(`[data-provider-readiness="${role}"]`);
      if (!card) continue;
      const readiness = providerReadinessForRole(role, providers, providerInventoryObservations, Date.now(), Date.parse);
      card.dataset.readinessState = readiness.state;
      card.querySelector("[data-readiness-health]").textContent = readiness.health.replaceAll("-", " ");
      card.querySelector("[data-readiness-inventory]").textContent = readiness.inventory.replaceAll("-", " ");
      card.querySelector("[data-readiness-capability]").textContent = providerReadinessCapabilityLabel(readiness.capability);
      card.querySelector("[data-readiness-state]").textContent = readiness.state === "ready"
        ? "Ready · current observed evidence"
        : readiness.state === "checking"
          ? "Checking model inventory…"
          : readiness.state === "not-configured"
            ? "Not configured"
            : "Not ready · see evidence above";
      const check = card.querySelector("[data-readiness-check]");
      check.hidden = !readiness.profileId;
      check.classList.toggle("hidden", !readiness.profileId);
      check.disabled = readiness.inventory === "checking";
      check.textContent = check.disabled ? "Checking inventory…" : "Check model inventory";
    }
  }

  async function refreshProviderReadinessInventory(role) {
    const card = elements.providers.querySelector(`[data-provider-readiness="${role}"]`);
    const readiness = providerReadinessForRole(role, providers, providerInventoryObservations, Date.now(), Date.parse);
    const profile = providers.find((item) => item.id === readiness.profileId);
    if (!card || !profile) return;
    const identity = {
      profileId: profile.id,
      role,
      providerType: profile.providerType,
      baseUrl: profile.baseUrl,
      modelId: profile.defaultModel
    };
    const requestEpoch = ++providerInventoryRequestSequence;
    providerInventoryRequestEpochs.set(profile.id, requestEpoch);
    providerInventoryObservations = providerInventoryObservations.filter((item) => item.profileId !== profile.id);
    providerInventoryObservations.push({ ...identity, status: "checking", modelIds: [], checkedAt: null });
    renderProviderReadiness();
    try {
      const result = await ports.models(profile.id, signal);
      if (providerInventoryRequestEpochs.get(profile.id) !== requestEpoch) return;
      const currentProfile = providers.find((item) => item.id === profile.id);
      if (!currentProfile || currentProfile.providerRole !== identity.role || currentProfile.providerType !== identity.providerType || currentProfile.baseUrl !== identity.baseUrl || currentProfile.defaultModel !== identity.modelId) return;
      const modelIds = Array.isArray(result.models) ? result.models.map(profileModelValue).filter((modelId) => typeof modelId === "string" && modelId.length > 0) : [];
      providerInventoryObservations = providerInventoryObservations.filter((item) => item.profileId !== profile.id);
      providerInventoryObservations.push({ ...identity, status: modelIds.length ? "available" : "unavailable", modelIds, checkedAt: new Date().toISOString() });
    } catch {
      if (providerInventoryRequestEpochs.get(profile.id) !== requestEpoch) return;
      providerInventoryObservations = providerInventoryObservations.filter((item) => item.profileId !== profile.id);
      providerInventoryObservations.push({ ...identity, status: "unavailable", modelIds: [], checkedAt: new Date().toISOString() });
    } finally {
      if (providerInventoryRequestEpochs.get(profile.id) === requestEpoch) {
        providerInventoryRequestEpochs.delete(profile.id);
        renderProviderReadiness();
      }
    }
  }
  function renderProviderProfiles() {
    renderProviderReadiness();
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
      const selection = providerTextSelection(provider);
      const selectionLabel = selection.kind === "openrouter_preset" ? `Preset · ${selection.slug}` : `Model · ${selection.modelId || "not selected"}`;
      summary.textContent = `${provider.providerRole} · ${providerTypeLabel(provider.providerType)} · ${selectionLabel} · ${Number(provider.requestTimeoutMs || 300000) / 60000} min timeout`;
      details.append(title, summary);
      if (provider.providerRole === "intent") {
        const retired = document.createElement("span");
        retired.className = "default-badge";
        retired.textContent = "Retired classifier profile · retained for historical provenance";
        details.append(retired);
        row.append(details);
        elements.providerProfileList.append(row);
        continue;
      }
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
        const impact = "Campaign assignments and provider-linked jobs, chains, or derived data may be removed.";
        if (!window.confirm(`Delete provider profile “${provider.name}”? ${impact}`)) return;
        remove.disabled = true;
        try {
          await ports.remove(provider.id, signal);
          if (editingProviderId === provider.id) resetProviderForm();
          await loadProviders();
          providerMessage(`${provider.name} deleted. Campaigns now use another default profile when available.`, "success");
        } catch (error) {
          providerMessage(error.message || String(error), "error");
          remove.disabled = false;
        }
      });
      actions.append(remove);
      const implicitlyDefault = provider.enabled && enabledProviders(provider.providerRole).length === 1;
      if (provider.isDefault || implicitlyDefault) {
        const badge = document.createElement("span");
        badge.className = "default-badge";
        badge.textContent = provider.isDefault ? "My default" : "Default (only profile)";
        details.append(badge);
        row.append(details, actions);
      } else {
        const makeDefault = document.createElement("button");
        makeDefault.type = "button";
        makeDefault.className = "button secondary";
        makeDefault.textContent = "Make default";
        makeDefault.addEventListener("click", async () => {
          makeDefault.disabled = true;
          try {
            await ports.makeDefault(provider.id, signal);
            await loadProviders();
            providerMessage(`${provider.name} is now the default ${provider.providerRole} profile.`, "success");
          } catch { providerMessage("The default profile could not be changed.", "error"); makeDefault.disabled = false; }
        });
        actions.append(makeDefault);
        row.append(details, actions);
      }
      elements.providerProfileList.append(row);
    }
  }
  const providerOverrideFields = Object.freeze({
    temperature: "providerOverrideTemperature",
    top_p: "providerOverrideTopP",
    top_k: "providerOverrideTopK",
    frequency_penalty: "providerOverrideFrequencyPenalty",
    presence_penalty: "providerOverridePresencePenalty",
    repetition_penalty: "providerOverrideRepetitionPenalty",
    min_p: "providerOverrideMinP",
    top_a: "providerOverrideTopA",
    seed: "providerOverrideSeed",
    max_tokens: "providerOverrideMaxTokens",
    max_completion_tokens: "providerOverrideMaxCompletionTokens"
  });

  function providerTextSelection(provider = null) {
    if (provider?.textSelection?.kind === "openrouter_preset" || provider?.textSelection?.kind === "model") return provider.textSelection;
    const value = String(provider?.defaultModel || "");
    const match = /^@preset\/([a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)$/u.exec(value);
    return match ? { kind: "openrouter_preset", slug: match[1] } : { kind: "model", modelId: value };
  }

  function providerSelectionAuthority(provider = null) {
    return {
      profileRevision: provider ? `${provider.id}:${provider.updatedAt || "saved"}` : "new",
      configurationRevision: JSON.stringify(provider?.configuration || {}),
      credentialRevision: `${provider?.hasApiKey === true}:${providerSelectionCredentialRevision}`
    };
  }

  function initializeProviderSelectionEditor(provider = null) {
    abortProviderPresetRequests();
    const authority = providerSelectionAuthority(provider);
    providerSelectionEditor = createSelectionEditorState({
      savedSelection: providerTextSelection(provider),
      responseFormatPolicy: provider?.configuration?.textResponseFormatPolicy || "required",
      ...(provider?.configuration?.textExecutionOverrides ? { textExecutionOverrides: provider.configuration.textExecutionOverrides } : {}),
      ...authority
    });
    renderProviderSelectionEditor();
  }

  function activeProviderSelectionDraft() {
    if (!providerSelectionEditor) return null;
    return providerSelectionEditor.mode === "model" ? providerSelectionEditor.modelDraft : providerSelectionEditor.presetDraft;
  }

  function syncProviderSelectionSupport() {
    if (!elements.providerTextSelectionMode) return;
    const eligible = nativeTextExecutionPlansSupportState === "supported" && elements.providerRole.value === "text" && elements.providerType.value === "openrouter";
    const candidate = elements.providerRole.value === "text" && elements.providerType.value === "openrouter";
    elements.providerTextSelectionMode.classList.toggle("hidden", !eligible);
    elements.providerTextSelectionMode.hidden = !eligible;
    elements.providerTextSelectionSupport.classList.toggle("hidden", !candidate || eligible);
    elements.providerTextSelectionSupport.hidden = !candidate || eligible;
    elements.providerTextSelectionSupport.textContent = nativeTextExecutionPlansSupportState === "loading"
      ? "Checking whether this server supports native Model/Preset selection…"
      : "This server does not advertise native text execution plans. The saved selection will be preserved when you save other settings.";
    renderProviderSelectionEditor();
  }

  function setProviderSelectionState(event) {
    if (!providerSelectionEditor) return;
    if (event.type === "modeChanged" || event.type === "authorityChanged") abortProviderPresetRequests();
    if (event.type === "presetDraftChanged") abortProviderPresetRequests({ list: false });
    providerSelectionEditor = reduceSelectionEditor(providerSelectionEditor, event);
    renderProviderSelectionEditor();
  }

  function abortProviderPresetRequests({ list = true, detail = true } = {}) {
    if (list) { providerPresetListController?.abort(); providerPresetListController = null; }
    if (detail) { providerPresetDetailController?.abort(); providerPresetDetailController = null; }
  }

  function formatPresetObject(value) {
    const entries = Object.entries(value || {});
    return entries.length ? entries.map(([key, item]) => `${key}: ${Array.isArray(item) ? item.join(" → ") : String(item)}`).join(" · ") : "Provider defaults";
  }

  function renderProviderPresetDetail() {
    const detail = providerSelectionEditor?.detail.value;
    const presetMode = nativeTextExecutionPlansSupportState === "supported" && providerSelectionEditor?.mode === "preset";
    elements.providerPresetDetail.classList.toggle("hidden", !presetMode);
    elements.providerPresetDetail.hidden = !presetMode;
    if (!presetMode) return;
    if (providerSelectionEditor.detail.busy) {
      elements.providerPresetPrompt.textContent = "Loading preset details…";
      return;
    }
    if (providerSelectionEditor.detail.error) {
      elements.providerPresetPrompt.textContent = `Preset details are unavailable (${providerSelectionEditor.detail.error}${providerSelectionEditor.detail.errorField ? `: ${providerSelectionEditor.detail.errorField}` : ""}).`;
      return;
    }
    if (!detail) {
      elements.providerPresetPrompt.textContent = "Choose a preset to inspect its standard prompt.";
      elements.providerPresetVersion.textContent = "Unknown";
      elements.providerPresetModels.textContent = "Unknown";
      elements.providerPresetPolicy.textContent = "Unknown";
      elements.providerPresetLimits.textContent = "Unknown";
      elements.providerPresetParameters.textContent = "Inherited";
      return;
    }
    elements.providerPresetPrompt.textContent = detail.standardPrompt || "No standard prompt configured.";
    elements.providerPresetVersion.textContent = `${detail.version} · ${detail.versionId}`;
    elements.providerPresetModels.textContent = detail.candidateModelIds.length ? detail.candidateModelIds.join(" → ") : "No configured model candidates";
    elements.providerPresetPolicy.textContent = formatPresetObject(detail.providerPolicy);
    const limit = (value) => value === null ? "Unknown" : number(value);
    elements.providerPresetLimits.textContent = `Configured max_tokens: ${limit(detail.limits.configuredMaxTokens)} · configured max_completion_tokens: ${limit(detail.limits.configuredMaxCompletionTokens)} · effective max output: ${limit(detail.limits.effectiveMaxOutputTokens)} · context capacity unknown until execution`;
    elements.providerPresetParameters.textContent = formatPresetObject(detail.parameters);
  }

  function renderProviderOverrides() {
    const eligible = nativeTextExecutionPlansSupportState === "supported" && elements.providerRole.value === "text" && elements.providerType.value === "openrouter";
    elements.providerTextOverrides.classList.toggle("hidden", !eligible);
    elements.providerTextOverrides.hidden = !eligible;
    if (!eligible || !providerSelectionEditor) return;
    const intent = activeProviderSelectionDraft().overrideIntent;
    elements.providerTextOverrideMode.value = intent.mode;
    elements.providerTextOverrideFields.classList.toggle("hidden", intent.mode !== "explicit");
    elements.providerTextOverrideFields.hidden = intent.mode !== "explicit";
    const overrides = intent.mode === "explicit" ? intent.value : intent.mode === "preserve" ? intent.value || {} : {};
    for (const [key, id] of Object.entries(providerOverrideFields)) elements[id].value = overrides.parameters?.[key] ?? "";
    elements.providerOverrideContextTokens.value = overrides.conservativeContextWindowTokens ?? "";
  }

  function renderProviderSelectionEditor() {
    if (!providerSelectionEditor || !elements.providerSelectionModel) return;
    const eligible = nativeTextExecutionPlansSupportState === "supported" && elements.providerRole.value === "text" && elements.providerType.value === "openrouter";
    const illustration = elements.providerRole.value === "image";
    const presetMode = providerSelectionEditor.mode === "preset";
    elements.providerSelectionModel.checked = !presetMode;
    elements.providerSelectionPreset.checked = presetMode;
    elements.providerModelSelectionField.classList.toggle("hidden", presetMode);
    elements.providerModelSelectionField.hidden = presetMode;
    elements.providerPresetSelectionPanel.classList.toggle("hidden", !eligible || !presetMode);
    elements.providerPresetSelectionPanel.hidden = !eligible || !presetMode;
    elements.providerResponseFormatPolicyField.classList.toggle("hidden", illustration || presetMode);
    elements.providerResponseFormatPolicyField.hidden = illustration || presetMode;
    elements.providerResponseFormatCapability.classList.toggle("hidden", illustration || presetMode);
    elements.providerResponseFormatCapability.hidden = illustration || presetMode;
    if (!presetMode) {
      elements.providerDefaultModel.value = providerSelectionEditor.modelDraft.modelId;
      elements.providerResponseFormatPolicy.value = providerSelectionEditor.modelDraft.responseFormatPolicy;
      elements.providerResponseFormatPolicyNote.textContent = providerSelectionEditor.modelDraft.responseFormatPolicy === "required"
        ? "Required is the default for new Model work and blocks before dispatch when exact current schema evidence is unavailable."
        : `${providerSelectionEditor.modelDraft.responseFormatPolicy === "legacy" ? "Legacy JSON" : "Automatic schema"} is an explicit historical compatibility override for this Model draft. New selections default to Required.`;
    } else {
      const draftSlug = providerSelectionEditor.presetDraft.slug;
      const selectedExists = providerSelectionEditor.list.presets.some((preset) => preset.slug === draftSlug);
      elements.providerPresetSelect.replaceChildren(new Option("Choose a preset", ""));
      if (draftSlug && !selectedExists) {
        const label = providerSelectionEditor.savedChoiceAvailability === "unavailable" ? `${draftSlug} · unavailable` : `${draftSlug} · saved selection`;
        elements.providerPresetSelect.append(new Option(label, draftSlug));
      }
      for (const preset of providerSelectionEditor.list.presets) elements.providerPresetSelect.append(new Option(`${preset.name} · ${preset.status}`, preset.slug));
      elements.providerPresetSelect.value = draftSlug;
      elements.providerPresetSelect.disabled = providerSelectionEditor.list.busy;
      elements.refreshProviderPresets.disabled = providerSelectionEditor.list.busy;
      elements.loadMoreProviderPresets.classList.toggle("hidden", providerSelectionEditor.list.nextOffset === null);
      elements.loadMoreProviderPresets.hidden = providerSelectionEditor.list.nextOffset === null;
      elements.loadMoreProviderPresets.disabled = providerSelectionEditor.list.busy;
      if (providerSelectionEditor.list.busy) elements.providerPresetStatus.textContent = "Loading OpenRouter presets…";
      else if (providerSelectionEditor.list.error) elements.providerPresetStatus.textContent = `Preset discovery failed (${providerSelectionEditor.list.error}${providerSelectionEditor.list.errorField ? `: ${providerSelectionEditor.list.errorField}` : ""}). Your selection is unchanged.`;
      else if (providerSelectionEditor.savedChoiceAvailability === "unavailable") elements.providerPresetStatus.textContent = `Saved preset ${draftSlug} is unavailable. It remains selected until you explicitly change it.`;
      else if (providerSelectionEditor.list.presets.length) elements.providerPresetStatus.textContent = `${providerSelectionEditor.list.presets.length} of ${providerSelectionEditor.list.totalCount} presets loaded.`;
      else elements.providerPresetStatus.textContent = "No presets loaded. Choose Refresh to query OpenRouter.";
    }
    renderProviderPresetDetail();
    renderProviderOverrides();
  }

  function providerPresetCandidate() {
    const existing = editingProviderId ? providers.find((item) => item.id === editingProviderId) : null;
    const discoverySelection = { kind: "model", modelId: providerSelectionEditor.modelDraft.modelId };
    return {
      name: elements.providerName.value || "Unsaved OpenRouter provider",
      providerType: "openrouter",
      providerRole: "text",
      baseUrl: elements.providerBaseUrl.value,
      defaultModel: discoverySelection.modelId,
      textSelection: discoverySelection,
      contextWindowTokens: Number(elements.providerContextTokens.value),
      maxOutputTokens: Number(elements.providerOutputTokens.value),
      temperature: Number(elements.providerTemperature.value),
      requestTimeoutMs: Math.round(Number(elements.providerRequestTimeoutMinutes.value) * 60000),
      ...(suppliedCredential() ? { apiKey: suppliedCredential() } : {}),
      enabled: elements.providerEnabled.checked,
      isDefault: elements.providerIsDefault.checked,
      configuration: { ...(existing?.configuration || {}), textResponseFormatPolicy: "required", streaming: elements.providerStreaming.checked }
    };
  }

  function providerPresetDiagnostic(error) {
    const code = error?.details?.code;
    const knownCodes = ["authentication", "discovery_unavailable", "preset_missing", "preset_inactive", "preset_config_unsupported", "invalid_response"];
    const diagnostic = knownCodes.includes(code) ? code : error?.statusCode === 401 || error?.statusCode === 403 ? "authentication" : error?.statusCode === 404 ? "preset_missing" : "discovery_unavailable";
    const field = error?.details?.field;
    return { error: diagnostic, ...(diagnostic === "preset_config_unsupported" && typeof field === "string" && field.length <= 64 && /^[a-z_]+(?:\.[a-z_]+){0,2}$/u.test(field) ? { field } : {}) };
  }

  function useSavedProviderPresetApi() {
    const profile = providers.find((item) => item.id === editingProviderId);
    return Boolean(sameSavedDestination(profile) && !suppliedCredential());
  }

  async function loadProviderPresets({ offset = 0, refresh = false } = {}) {
    syncDestination();
    if (!providerSelectionEditor || providerSelectionEditor.mode !== "preset") return;
    providerPresetListController?.abort();
    const controller = new AbortController();
    providerPresetListController = controller;
    const requestId = `preset-list-${++providerSelectionRequestSequence}`;
    setProviderSelectionState({ type: "requestStarted", requestId, mode: "preset", offset });
    try {
      const page = useSavedProviderPresetApi()
        ? await providerPresetsApi.listSaved(editingProviderId, { offset, limit: 25, refresh }, controller.signal)
        : await providerPresetsApi.listCandidate(providerPresetCandidate(), { offset, limit: 25 }, controller.signal);
      setProviderSelectionState({ type: "listLoaded", requestId, page });
    } catch (error) {
      if (!controller.signal.aborted) setProviderSelectionState({ type: "requestFailed", requestId, ...providerPresetDiagnostic(error) });
    } finally {
      if (providerPresetListController === controller) providerPresetListController = null;
      setProviderSelectionState({ type: "requestFinished", requestId });
    }
  }

  async function loadProviderPresetDetail(slug) {
    syncDestination();
    if (!providerSelectionEditor || providerSelectionEditor.mode !== "preset" || !slug) return;
    providerPresetDetailController?.abort();
    const controller = new AbortController();
    providerPresetDetailController = controller;
    const requestId = `preset-detail-${++providerSelectionRequestSequence}`;
    setProviderSelectionState({ type: "detailRequestStarted", requestId, slug });
    try {
      const detail = useSavedProviderPresetApi()
        ? await providerPresetsApi.detailSaved(editingProviderId, slug, controller.signal)
        : await providerPresetsApi.detailCandidate(providerPresetCandidate(), slug, controller.signal);
      setProviderSelectionState({ type: "detailLoaded", requestId, detail });
    } catch (error) {
      if (!controller.signal.aborted) setProviderSelectionState({ type: "detailFailed", requestId, ...providerPresetDiagnostic(error) });
    } finally {
      if (providerPresetDetailController === controller) providerPresetDetailController = null;
      setProviderSelectionState({ type: "detailRequestFinished", requestId });
    }
  }

  function currentProviderExplicitOverrides() {
    const parameters = {};
    for (const [key, id] of Object.entries(providerOverrideFields)) {
      const raw = elements[id].value;
      if (raw !== "") parameters[key] = Number(raw);
    }
    const overrides = {};
    if (Object.keys(parameters).length) overrides.parameters = parameters;
    if (elements.providerOverrideContextTokens.value !== "") overrides.conservativeContextWindowTokens = Number(elements.providerOverrideContextTokens.value);
    return overrides;
  }

  function updateProviderOverrideIntent() {
    if (!providerSelectionEditor) return;
    const mode = elements.providerTextOverrideMode.value;
    const intent = mode === "inherit" ? { mode: "inherit" } : mode === "explicit" ? { mode: "explicit", value: currentProviderExplicitOverrides() } : { mode: "preserve", ...(activeProviderSelectionDraft().overrideIntent.value ? { value: activeProviderSelectionDraft().overrideIntent.value } : {}) };
    setProviderSelectionState({ type: providerSelectionEditor.mode === "model" ? "modelOverrideIntentChanged" : "presetOverrideIntentChanged", intent });
  }

  function resetProviderForm() {
    invalidateInventory();
    clearResponseFormatCapability();
    editingProviderId = "";
    elements.providerForm.reset();
    elements.providerName.value = nextAvailableProviderName("Local LM Studio");
    elements.providerType.value = "lmstudio";
    elements.providerRole.value = "text";
    elements.providerBaseUrl.value = DEFAULT_LM_STUDIO_BASE_URL;
    elements.providerContextTokens.value = "32768";
    elements.providerOutputTokens.value = "4096";
    elements.providerTemperature.value = "0.8";
    elements.providerResponseFormatPolicy.value = "required";
    elements.providerRequestTimeoutMinutes.value = "5";
    applySogniConfiguration(SOGNI_DEFAULT_CONFIGURATION);
    elements.providerAdvancedSettings.open = false;
    elements.providerStreaming.checked = false;
    elements.providerEnabled.checked = true;
    elements.providerType.disabled = false;
    elements.providerRole.disabled = false;
    elements.saveProvider.textContent = "Save provider";
    elements.cancelProviderEdit.classList.remove("hidden");
    discoveredProfileModels = [];
    elements.providerModelPickerList.replaceChildren();
    elements.providerContextTokens.readOnly = false;
    elements.providerContextSource.textContent = "Editable until model discovery supplies a context length.";
    elements.providerContextSource.className = "field-note";
    initializeProviderSelectionEditor();
    syncProviderRoleSettings();
    formDestination = destination();
  }

  function clearResponseFormatCapability() {
    responseFormatCapabilitySequence += 1;
    responseFormatCapabilityProfile = null;
    if (!elements.providerResponseFormatCapability) return;
    elements.providerResponseFormatCapability.textContent = "Schema compatibility is unknown until the server returns a capability summary.";
    elements.providerResponseFormatCapability.className = "text-model-setting field-note";
  }

  function storedProfileMatchesResponseFormatIdentity() {
    const profile = providers.find((item) => item.id === editingProviderId);
    if (!profile) return false;
    return profile.providerRole === elements.providerRole.value
      && profile.providerType === elements.providerType.value
      && profile.baseUrl === elements.providerBaseUrl.value
      && (profile.defaultModel || "") === elements.providerDefaultModel.value
      && Boolean(profile.configuration?.streaming || profile.configuration?.streamingSupport) === elements.providerStreaming.checked
      && (profile.configuration?.textResponseFormatPolicy || "required") === elements.providerResponseFormatPolicy.value;
  }

  function responseFormatCapabilityIdentity() {
    return [editingProviderId, elements.providerRole.value, elements.providerType.value, elements.providerBaseUrl.value.trim(), elements.providerDefaultModel.value.trim(), elements.providerStreaming.checked, elements.providerResponseFormatPolicy.value].join("\u001f");
  }

  function capabilityTime(value) {
    const date = typeof value === "string" ? new Date(value) : null;
    return date && !Number.isNaN(date.getTime()) ? date.toLocaleString() : null;
  }

  function safeResponseFormatReason(reason) {
    if (reason === "schema_incompatible") return "The current tracker schema is incompatible with this adapter.";
    if (reason === "discovery_unavailable") return "Server verification is unavailable.";
    return "Server verification has not confirmed this capability.";
  }

  function renderResponseFormatCapability(capability, identity = responseFormatCapabilityIdentity()) {
    if (identity !== responseFormatCapabilityIdentity() || !elements.providerResponseFormatCapability) return;
    const status = elements.providerResponseFormatCapability;
    const operations = Array.isArray(capability?.operations) ? capability.operations : [];
    const now = Date.now();
    const verified = operations.filter((operation) => operation?.status === "verified" && capabilityTime(operation.expiresAt) && new Date(operation.expiresAt).getTime() > now);
    const unsupported = operations.find((operation) => operation?.status === "unsupported");
    const advertised = operations.some((operation) => operation?.status === "advertised");
    const advertisedAt = capabilityTime(capability?.advertisedAt);
    if (verified.length && unsupported) {
      const verifiedCoverage = verified.map((operation) => operation.operation === "continuity_review" ? "continuity review" : operation.operation).join(", ");
      const unavailableOperation = unsupported.operation === "continuity_review" ? "continuity review" : unsupported.operation;
      status.textContent = `Mixed schema coverage: verified for ${verifiedCoverage}; ${unavailableOperation} is unavailable. ${safeResponseFormatReason(unsupported.reason)}`;
      status.className = "text-model-setting field-note warning";
    } else if (verified.length) {
      const coverage = verified.map((operation) => `${operation.operation === "continuity_review" ? "continuity review" : operation.operation}${operation.streaming ? " streaming" : ""}`).join(", ");
      const expiresAt = capabilityTime(verified.map((operation) => operation.expiresAt).sort()[0]);
      status.textContent = `Verified schema coverage: ${coverage}${advertisedAt ? `, discovered ${advertisedAt}` : ""}${expiresAt ? `, expires ${expiresAt}` : ""}. Server verification is required before schema use.`;
      status.className = "text-model-setting field-note success";
    } else if (unsupported) {
      status.textContent = `Schema support is unavailable. ${safeResponseFormatReason(unsupported.reason)}`;
      status.className = "text-model-setting field-note warning";
    } else if (advertised) {
      status.textContent = `Schema support is advertised${advertisedAt ? ` from ${advertisedAt}` : ""}, but is not verified. Required blocks a new job before dispatch.`;
      status.className = "text-model-setting field-note warning";
    } else {
      status.textContent = "Schema compatibility is unknown. Required blocks a new job before dispatch until the server verifies it.";
      status.className = "text-model-setting field-note warning";
    }
  }

  function nextAvailableProviderName(baseName) {
    const existingNames = new Set(providers.map((provider) => provider.name.trim().toLocaleLowerCase()));
    if (!existingNames.has(baseName.toLocaleLowerCase())) return baseName;
    let suffix = 2;
    while (existingNames.has(`${baseName} ${suffix}`.toLocaleLowerCase())) suffix += 1;
    return `${baseName} ${suffix}`;
  }

  function syncProviderRoleSettings(options = {}) {
    const sogniRest = elements.providerType.value === "sogni";
    const sogniSdk = elements.providerType.value === "sogni_sdk";
    const sogni = sogniRest || sogniSdk;
    if (sogni) elements.providerRole.value = "image";
    const illustration = elements.providerRole.value === "image";
    elements.providerRoleNote.textContent = elements.providerRole.value === "image"
        ? "Illustration providers are independent from story text and use separate credentials."
        : elements.providerRole.value === "embedding"
          ? "Embedding providers index Chronicle memory and do not generate narration."
          : "Story text providers generate narration.";
    elements.providerStreaming.disabled = sogni;
    if (sogni) elements.providerStreaming.checked = false;
    elements.providerRole.disabled = Boolean(editingProviderId) || sogni;
    for (const field of root.querySelectorAll(".text-model-setting")) {
      field.classList.toggle("hidden", illustration);
      field.hidden = illustration;
      field.setAttribute("aria-hidden", String(illustration));
    }
    if (illustration) clearResponseFormatCapability();
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
    syncProviderSelectionSupport();
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
    if (nativeTextExecutionPlansSupportState === "supported" && elements.providerRole.value === "text" && elements.providerType.value === "openrouter" && providerSelectionEditor) {
      const patch = serializeSelectionEditorPatch(providerSelectionEditor);
      const presetMode = providerSelectionEditor.mode === "preset";
      const hasSavedFormatPolicy = Object.prototype.hasOwnProperty.call(existingConfig, "textResponseFormatPolicy");
      if (!hasSavedFormatPolicy && patch.configuration.textResponseFormatPolicy === "required" && editingProviderId && !presetMode && providerTextSelection(providers.find(item => item.id === editingProviderId)).kind === "model") delete configuration.textResponseFormatPolicy;
      else configuration.textResponseFormatPolicy = presetMode && hasSavedFormatPolicy
        ? existingConfig.textResponseFormatPolicy
        : patch.configuration.textResponseFormatPolicy;
      if (Object.prototype.hasOwnProperty.call(patch.configuration, "textExecutionOverrides")) {
        configuration.textExecutionOverrides = patch.configuration.textExecutionOverrides;
      }
      return configuration;
    }
    const hasExplicitResponseFormatPolicy = Object.prototype.hasOwnProperty.call(existingConfig, "textResponseFormatPolicy");
    if (elements.providerRole.value === "text" && (elements.providerResponseFormatPolicy.value !== "required" || hasExplicitResponseFormatPolicy)) {
      configuration.textResponseFormatPolicy = elements.providerResponseFormatPolicy.value;
    } else {
      delete configuration.textResponseFormatPolicy;
    }
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
    invalidateInventory();
    const returnFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    clearResponseFormatCapability();
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
    elements.providerResponseFormatPolicy.value = provider.configuration?.textResponseFormatPolicy || "required";
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
    responseFormatCapabilityProfile = provider.responseFormatCapability || null;
    elements.providerModelPickerList.replaceChildren();
    initializeProviderSelectionEditor(provider);
    elements.providerAdvancedSettings.open = false;
    syncProviderRoleSettings();
    formDestination = destination();
    openEditDialog(elements.providerDialog, returnFocusTo);
    elements.providerName.focus();
    providerMessage(`Editing ${provider.name}. Leave the API key blank to keep the stored credential.`);
    renderResponseFormatCapability(responseFormatCapabilityProfile);

  }
  async function saveProvider(event) {
    event.preventDefault();
    if (providerSaveBusy) return;
    syncDestination();
    const savedProfile = providers.find(item => item.id === editingProviderId);
    if (savedProfile?.hasApiKey && !sameSavedDestination(savedProfile) && !suppliedCredential()) {
      providerMessage("Enter a new API key for the changed endpoint, or restore the saved endpoint.", "error");
      elements.providerApiKey.focus();
      return;
    }
    providerSaveBusy = true;
    const providerControls = [...elements.providerForm.querySelectorAll("input, select, textarea, button")];
    const disabledBeforeSave = providerControls.map((control) => control.disabled);
    providerControls.forEach((control) => { control.disabled = true; });
    providerMessage("Saving provider profile…");
    let provider;
    const wasEditing = Boolean(editingProviderId);
    try {
      const existingConfig = editingProviderId ? (providers.find((item) => item.id === editingProviderId)?.configuration || {}) : {};
      const preservedSelection = providerSelectionEditor ? serializeSelectionEditorPatch(providerSelectionEditor) : null;
      const nativeSelection = nativeTextExecutionPlansSupportState === "supported" && elements.providerRole.value === "text" && elements.providerType.value === "openrouter" && providerSelectionEditor
        ? serializeSelectionEditorPatch(providerSelectionEditor)
        : null;
      provider = await ports.save(editingProviderId, {
          name: elements.providerName.value,
          ...(!editingProviderId ? { providerType: elements.providerType.value, providerRole: elements.providerRole.value } : {}),
          baseUrl: elements.providerBaseUrl.value,
          apiKey: suppliedCredential() || undefined,
          isDefault: elements.providerIsDefault.checked,
          defaultModel: nativeSelection?.defaultModel ?? preservedSelection?.defaultModel ?? elements.providerDefaultModel.value,
          ...(nativeSelection ? { textSelection: nativeSelection.textSelection } : {}),
          ...(!isIllustrationProviderForm() ? {
            contextWindowTokens: elements.providerContextTokens.value,
            maxOutputTokens: elements.providerOutputTokens.value,
            temperature: elements.providerTemperature.value
          } : {}),
          requestTimeoutMs: Math.round(Number(elements.providerRequestTimeoutMinutes.value) * 60000),
          enabled: elements.providerEnabled.checked,
          configuration: providerConfigurationFromForm(existingConfig)
      }, signal);
    } catch (error) {
      providerMessage(safeWorkflowFailure("Provider profile could not be saved.", error), "error");
      providerControls.forEach((control, index) => { control.disabled = disabledBeforeSave[index] ?? false; });
      providerSaveBusy = false;
      return;
    }

    providerInventoryRequestEpochs.set(provider.id, ++providerInventoryRequestSequence);
    providerInventoryObservations = providerInventoryObservations.filter((item) => item.profileId !== provider.id);
    resetProviderForm();
    try {
      await loadProviders();
    } catch (error) {
      reportProviderListReadFailure(`${provider.name} was ${wasEditing ? "updated" : "saved"}. The provider list could not be refreshed. Retry provider profiles to confirm the saved profile.`);
      if (elements.providerDialog) elements.providerDialog.close();
      providerControls.forEach((control, index) => { control.disabled = disabledBeforeSave[index] ?? false; });
      providerSaveBusy = false;
      return;
    }

    providerMessage(`${provider.name} ${wasEditing ? "updated" : "saved"}. Credentials, if supplied, were encrypted before database storage.`, "success");
    if (elements.providerDialog) elements.providerDialog.close();
    providerControls.forEach((control, index) => { control.disabled = disabledBeforeSave[index] ?? false; });
    providerSaveBusy = false;
  }
  async function refreshProviderModelsFromForm() {
    syncDestination();
    inventoryRequest?.abort();
    const request = new AbortController();
    inventoryRequest = request;
    const sequence = ++responseFormatCapabilitySequence;
    const identity = responseFormatCapabilityIdentity();
    clearResponseFormatCapability();
    elements.refreshProviderModels.disabled = true;
    elements.refreshProviderModelDialog.disabled = true;
    providerMessage("Discovering models from this provider profile…");
    elements.providerModelPickerStatus.textContent = "Discovering active and inactive models from the endpoint…";
    elements.providerModelPickerStatus.className = "status";
    try {
      const useStoredProfile = useSavedProviderPresetApi();
      const existingConfig = editingProviderId ? (providers.find((item) => item.id === editingProviderId)?.configuration || {}) : {};
      const result = useStoredProfile
        ? await ports.models(editingProviderId, request.signal)
        : await ports.discover({
            name: elements.providerName.value || "Unsaved provider",
            providerType: elements.providerType.value,
            providerRole: elements.providerRole.value,
            baseUrl: elements.providerBaseUrl.value,
            apiKey: suppliedCredential() || undefined,
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
      }, request.signal);
      if (request.signal.aborted || sequence !== responseFormatCapabilitySequence - 1 || identity !== responseFormatCapabilityIdentity()) return;
      discoveredProfileModels = result.models || [];
      discoveredProfileModelsIdentity = identity;
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
      const responseFormatIdentityMatches = discoveredProfileModelsIdentity === responseFormatCapabilityIdentity() && storedProfileMatchesResponseFormatIdentity();
      const selectedCapability = responseFormatIdentityMatches
        ? selected?.responseFormatCapability || (responseFormatCapabilityProfile?.model === elements.providerDefaultModel.value ? responseFormatCapabilityProfile : null)
        : null;
      renderResponseFormatCapability(selectedCapability, identity);
      applyProfileModelContext();
      renderProviderModelPicker();
      elements.providerModelPickerStatus.textContent = `${discoveredProfileModels.length} model entr${discoveredProfileModels.length === 1 ? "y" : "ies"} found. Active models are listed first.`;
      elements.providerModelPickerStatus.className = "status success";
      providerMessage(`${discoveredProfileModels.length} model entr${discoveredProfileModels.length === 1 ? "y" : "ies"} found. Select one from Default model and save the profile.`, "success");
    } catch (error) {
      if (request.signal.aborted || sequence !== responseFormatCapabilitySequence - 1 || identity !== responseFormatCapabilityIdentity()) return;
      clearResponseFormatCapability();
      const message = "Model inventory is unavailable. Check the endpoint and credentials, then refresh.";
      providerMessage(message, "error");
      elements.providerModelPickerStatus.textContent = message;
      elements.providerModelPickerStatus.className = "status error";
    } finally {
      if (inventoryRequest === request) {
        inventoryRequest = null;
        elements.refreshProviderModels.disabled = false;
        elements.refreshProviderModelDialog.disabled = false;
      }
    }
  }
  function profileModelValue(model) {
    return String(model?.loaded ? model.instanceId || model.id : model?.id || "");
  }
  function chooseProviderModel(value) {
    elements.providerDefaultModel.value = value;
    if (providerSelectionEditor && providerSelectionEditor.mode === "model") {
      const policy = value === providerSelectionEditor.modelDraft.modelId
        ? providerSelectionEditor.modelDraft.responseFormatPolicy
        : "required";
      setProviderSelectionState({ type: "modelDraftChanged", modelId: value, responseFormatPolicy: policy });
    }
    clearResponseFormatCapability();
    if (discoveredProfileModelsIdentity === responseFormatCapabilityIdentity() && storedProfileMatchesResponseFormatIdentity()) renderResponseFormatCapability(discoveredProfileModels.find((item) => profileModelValue(item) === value || item.id === value)?.responseFormatCapability);
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
    const discoveredModels = discoveredProfileModels;
    const selectedValue = elements.providerDefaultModel.value.trim();
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
    syncDestination();

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
    openManagedModal(elements.providerModelDialog);
    renderProviderModelPicker();
    if (forceRefresh || !discoveredProfileModels.length) await refreshProviderModelsFromForm();
    elements.providerModelFilter.focus();
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
      constrainProviderOutputReserve(contextLength);
    } else {
      elements.providerContextTokens.readOnly = false;
      elements.providerOutputTokens.setCustomValidity("");
      elements.providerContextSource.textContent = model
        ? "The endpoint did not advertise a context length for this model; enter it manually."
        : "Editable until a discovered model supplies a context length.";
      elements.providerContextSource.className = contextLength ? "field-note api-supplied" : "field-note manual-entry";
    }
  }
  function constrainProviderOutputReserve(contextLength) {
    const maximumOutputTokens = contextLength - 513;
    if (maximumOutputTokens < 128) {
      elements.providerOutputTokens.setCustomValidity("This model does not leave the required 512 tokens of input context.");
      return;
    }
    elements.providerOutputTokens.setCustomValidity("");
    const requestedOutputTokens = Number(elements.providerOutputTokens.value);
    if (!Number.isFinite(requestedOutputTokens) || requestedOutputTokens > maximumOutputTokens) {
      elements.providerOutputTokens.value = String(maximumOutputTokens);
    }
  }
  elements.providerType.addEventListener("change", () => {
    clearResponseFormatCapability();
    const defaults = {
      lmstudio: DEFAULT_LM_STUDIO_BASE_URL,
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
    syncDestination();
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
    syncProviderRoleSettings({ applySuggestedDefaults: !editingProviderId });
    syncDestination();
  });
  for (const event of ["input", "change"]) {
    elements.providerBaseUrl.addEventListener(event, syncDestination);
    elements.providerApiKey.addEventListener(event, invalidateInventory);
    elements.providerStreaming.addEventListener(event, clearResponseFormatCapability);
    elements.providerResponseFormatPolicy.addEventListener(event, clearResponseFormatCapability);
  }
  elements.providerResponseFormatPolicy.addEventListener("change", () => {
    if (providerSelectionEditor?.mode === "model") {
      setProviderSelectionState({ type: "modelDraftChanged", modelId: elements.providerDefaultModel.value.trim(), responseFormatPolicy: elements.providerResponseFormatPolicy.value });
    }
  });
  elements.providerSelectionModel.addEventListener("change", () => {
    if (!elements.providerSelectionModel.checked || !providerSelectionEditor) return;
    setProviderSelectionState({ type: "modeChanged", mode: "model" });
    clearResponseFormatCapability();
    renderResponseFormatCapability(responseFormatCapabilityProfile);
  });
  elements.providerSelectionPreset.addEventListener("change", () => {
    if (!elements.providerSelectionPreset.checked || !providerSelectionEditor) return;
    setProviderSelectionState({ type: "modeChanged", mode: "preset" });
    const selectedSlug = providerSelectionEditor.presetDraft.slug;
    if (!providerSelectionEditor.list.presets.length) {
      void loadProviderPresets().then(() => {
        if (selectedSlug && providerSelectionEditor?.mode === "preset" && providerSelectionEditor.presetDraft.slug === selectedSlug) {
          void loadProviderPresetDetail(selectedSlug);
        }
      });
    } else if (selectedSlug) {
      void loadProviderPresetDetail(selectedSlug);
    }
  });
  elements.refreshProviderPresets.addEventListener("click", async () => {
    await loadProviderPresets({ refresh: true });
    const slug = providerSelectionEditor?.presetDraft.slug;
    if (slug && providerSelectionEditor.mode === "preset") await loadProviderPresetDetail(slug);
  });
  elements.loadMoreProviderPresets.addEventListener("click", () => {
    if (providerSelectionEditor?.list.nextOffset !== null) void loadProviderPresets({ offset: providerSelectionEditor.list.nextOffset });
  });
  elements.providerPresetSelect.addEventListener("change", () => {
    if (!providerSelectionEditor) return;
    const slug = elements.providerPresetSelect.value;
    setProviderSelectionState({ type: "presetDraftChanged", slug });
    if (slug) void loadProviderPresetDetail(slug);
  });
  elements.providerTextOverrideMode.addEventListener("change", updateProviderOverrideIntent);
  for (const id of [...Object.values(providerOverrideFields), "providerOverrideContextTokens"]) {
    elements[id].addEventListener("input", () => {
      if (elements.providerTextOverrideMode.value === "explicit") updateProviderOverrideIntent();
    });
  }
  if (elements.newProviderButton) {
    elements.newProviderButton.addEventListener("click", () => {
      resetProviderForm();
      openEditDialog(elements.providerDialog);
    });
  }
  elements.providerForm.addEventListener("submit", saveProvider);
  for (const check of elements.providers.querySelectorAll("[data-readiness-check]")) check.addEventListener("click", () => { void refreshProviderReadinessInventory(check.dataset.readinessCheck); });
  elements.cancelProviderEdit.addEventListener("click", () => {
    if (elements.providerDialog) dismissEditDialog(elements.providerDialog);
  });
  elements.providerDialog.addEventListener("close", abortProviderPresetRequests);
  elements.refreshProviderModels.addEventListener("click", async (event) => { event.stopPropagation(); await openProviderModelPicker(true); });
  elements.providerDefaultModel.addEventListener("click", () => { void openProviderModelPicker(); });
  elements.providerDefaultModel.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); void openProviderModelPicker(); }
  });
  elements.closeProviderModelDialog.addEventListener("click", () => elements.providerModelDialog.close());
  elements.refreshProviderModelDialog.addEventListener("click", refreshProviderModelsFromForm);
  elements.providerModelFilter.addEventListener("input", renderProviderModelPicker);
  elements.applyCustomProviderModel.addEventListener("click", applyCustomProviderModel);
  elements.providerDefaultModel.addEventListener("change", () => {
    clearResponseFormatCapability();
    applyProfileModelContext();
    renderResponseFormatCapability(discoveredProfileModels.find((item) => profileModelValue(item) === elements.providerDefaultModel.value || item.id === elements.providerDefaultModel.value)?.responseFormatCapability);
  });

  elements.providerDialog.addEventListener("click", event => {
    if (event.target !== elements.providerDialog || providerSaveBusy) return;
    const bounds = elements.providerDialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dismissEditDialog(elements.providerDialog);
  });
  elements.closeProviderProfile.addEventListener("click", () => dismissEditDialog(elements.providerDialog));
  elements.providerDialog.addEventListener("close", () => { elements.providerApiKey.value = ""; });
  void ports.metadata(signal).then(metadata => {
    if (signal.aborted) return;
    nativeTextExecutionPlansSupportState = nativePresetSupport(metadata).state;
    syncProviderSelectionSupport();
  }).catch(() => { if (!signal.aborted) { nativeTextExecutionPlansSupportState = "unsupported"; syncProviderSelectionSupport(); } });
  void loadProviders().catch(() => reportProviderListReadFailure("Provider profiles could not be loaded."));
  return {dispose() {
    controller.abort();
    inventoryRequest?.abort();
    releaseCancel();
    if (elements.discardChangesDialog.open) elements.discardChangesDialog.close();
    abortProviderPresetRequests();
    providerInventoryRequestEpochs.clear();
    responseFormatCapabilitySequence++;
    providers = [];
    elements.providerApiKey.value = "";
    if (elements.providerModelDialog.open) elements.providerModelDialog.close();
    if (elements.providerDialog.open) elements.providerDialog.close();
    root.replaceChildren();
  }};
}
