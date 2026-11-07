import markup from "./prompt-editor.html?raw";

export function mountPromptEditor(root, ports, campaignId, promptKey, requireCampaign = false) {
  const document = root.ownerDocument;
  const window = document.defaultView;
  const controller = new AbortController();
  const signal = controller.signal;
  root.innerHTML = markup;
  const elements = Object.fromEntries([...root.querySelectorAll("[id]")].map(element => [element.id, element]));
  let promptLibrary = null;
  let selectedPromptTemplateKey = promptKey || "";
  let promptLibraryPreviewVisible = false;
  let promptLibraryEditorBaseline = "";
  let promptLibraryEditorContext = "";
  let promptLibraryCategory = "All";
  let promptLibraryActiveScope = "application";
  let promptLibraryActiveCampaignId = "";
  let promptLibraryPreviewTimer = 0;
  let promptLibraryPreviewSequence = 0;
  let campaigns = [];
  let scopeEpoch = 0;
  let saving = false;
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
    const current = elements.promptLibraryCampaign.value || "";
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
      const previewCampaignId = promptLibraryCampaignId();
      const preview = await ports.preview({ key: template.key, content: elements.promptLibraryContent.value, ...(previewCampaignId ? { campaignId: previewCampaignId } : {}) }, signal);
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
      : "Your application defaults apply unless one of your campaigns overrides an eligible prompt.";
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
    const compatibility = template.compatibility;
    elements.promptLibraryCompatibility?.classList.toggle("hidden", !compatibility);
    elements.promptLibraryRequiredShape?.classList.toggle("hidden", !compatibility);
    if (compatibility) {
      elements.promptLibraryCompatibilityCopy.textContent = `Required output shape version ${compatibility.requiredShapeVersion}. Saving records this prompt against the current shape; the application adds the required output rules automatically.${compatibility.acknowledged ? "" : " Saved for an earlier output shape or outside the Prompt Library. Save it again before generation can use it."}`;
      elements.promptLibraryRequiredShape.textContent = compatibility.requiredShapePreview;
    }
    const resetAvailable = campaignScope ? template.effectiveSource === "campaign" : template.effectiveSource === "application";
    elements.promptLibraryReset.textContent = campaignScope ? "Use inherited application prompt" : "Restore shipped default";
    elements.promptLibraryReset.disabled = !resetAvailable;
    elements.promptLibraryResetCampaigns.classList.toggle("hidden", campaignScope || !template.campaignOverrideAllowed);
    renderPromptLibraryDirtyState();
    if (promptLibraryPreviewVisible) schedulePromptLibraryPreview();
    requestAnimationFrame(() => elements.promptLibraryList.querySelector(".prompt-library-item.active")?.scrollIntoView({ block: "nearest", inline: "nearest" }));
  }
  async function loadPromptLibrary() {
    const epoch = ++scopeEpoch;
    ++promptLibraryPreviewSequence;
    promptLibrary = { templates: [] };
    promptLibraryEditorContext = "";
    elements.promptLibraryEditor.classList.add("hidden");
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
      const library = await ports.list(campaignId, signal);
      if (signal.aborted || epoch !== scopeEpoch) return;
      promptLibrary = library;
      if (!promptLibrary.templates.some(item => item.key === selectedPromptTemplateKey && (!campaignId || item.campaignOverrideAllowed))) selectedPromptTemplateKey = promptLibrary.templates.find(item => !campaignId || item.campaignOverrideAllowed)?.key || "";
      promptLibraryActiveScope = elements.promptLibraryScope.value;
      promptLibraryActiveCampaignId = campaignId;
      elements.promptLibraryStatus.textContent = "Changes apply to newly queued jobs; queued and retried jobs retain their snapshotted prompt.";
      elements.promptLibraryStatus.className = "status";
      renderPromptLibrary(true);
    } catch (error) {
      if (signal.aborted || epoch !== scopeEpoch) return;
      elements.promptLibraryStatus.textContent = error.message || String(error);
      elements.promptLibraryStatus.className = "status error";
    }
  }
  async function savePromptLibraryTemplate(event) {
    event.preventDefault();
    if (saving) return;
    const template = promptLibrarySelectedTemplate(); if (!template) return;
    const scope = elements.promptLibraryScope.value;
    const epoch = scopeEpoch;
    saving = true;
    const submit = elements.promptLibraryEditor.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      const content = elements.promptLibraryContent.value;
      const response = await ports.save({ key: template.key, scope, ...(scope === "campaign" ? { campaignId: promptLibraryCampaignId() } : {}), content }, signal);
      if (signal.aborted || epoch !== scopeEpoch) return;
      promptLibrary = response.library;
      if (template.key === selectedPromptTemplateKey) {
        const editedDuringSave = elements.promptLibraryContent.value !== content;
        promptLibraryEditorBaseline = promptLibrarySelectedTemplate()?.effectiveContent ?? content;
        if (!editedDuringSave) elements.promptLibraryContent.value = promptLibraryEditorBaseline;
      }
      elements.promptLibraryStatus.textContent = promptLibraryIsDirty() ? "Prompt saved. You have further unsaved edits." : "Prompt saved. New jobs will use this version.";
      elements.promptLibraryStatus.className = "status success";
      renderPromptLibrary();
    } catch (error) {
      if (signal.aborted || epoch !== scopeEpoch) return;
      elements.promptLibraryStatus.textContent = error.message || String(error);
      elements.promptLibraryStatus.className = "status error";
    } finally {
      saving = false;
      submit.disabled = false;
    }
  }
  async function resetPromptLibraryTemplate() {
    const template = promptLibrarySelectedTemplate(); if (!template) return;
    const scope = elements.promptLibraryScope.value;
    const epoch = scopeEpoch;
    try {
      const response = await ports.reset({ key: template.key, scope, ...(scope === "campaign" ? { campaignId: promptLibraryCampaignId() } : {}) }, signal);
      if (signal.aborted || epoch !== scopeEpoch) return;
      promptLibrary = response.library; elements.promptLibraryStatus.textContent = scope === "campaign" ? "Campaign override removed; the inherited application prompt is active." : "Application override removed; the shipped default is active."; elements.promptLibraryStatus.className = "status success"; renderPromptLibrary(true);
    } catch (error) {
      if (signal.aborted || epoch !== scopeEpoch) return;
      elements.promptLibraryStatus.textContent = error.message || String(error);
      elements.promptLibraryStatus.className = "status error";
    }
  }
  async function resetAllCampaignPromptOverrides() {
    const template = promptLibrarySelectedTemplate();
    if (!template || !template.campaignOverrideAllowed || elements.promptLibraryScope.value !== "application") return;
    if (promptLibraryIsDirty()) {
      elements.promptLibraryStatus.textContent = "Save or discard your edits before resetting campaign overrides.";
      elements.promptLibraryStatus.className = "status warning";
      return;
    }
    if (!window.confirm(`Reset “${template.title}” for all your campaigns to the saved application default? This will overwrite all campaign overrides for this prompt by removing them. This cannot be undone. Other prompts and already queued jobs will not change.`)) return;
    const epoch = scopeEpoch;
    elements.promptLibraryResetCampaigns.disabled = true;
    try {
      await ports.reset({ key: template.key, scope: "application", allCampaigns: true }, signal);
      if (signal.aborted || epoch !== scopeEpoch) return;
      elements.promptLibraryStatus.textContent = `All your campaigns now inherit the application default for “${template.title}”. New jobs will use this prompt.`;
      elements.promptLibraryStatus.className = "status success";
    } catch (error) {
      if (signal.aborted || epoch !== scopeEpoch) return;
      elements.promptLibraryStatus.textContent = error.message || String(error);
      elements.promptLibraryStatus.className = "status error";
    } finally {
      elements.promptLibraryResetCampaigns.disabled = false;
    }
  }
  function scrollPromptLibrary(direction) {
    if (!elements.promptLibraryList) return;
    elements.promptLibraryList.scrollBy({
      left: direction * Math.max(260, elements.promptLibraryList.clientWidth * .8),
      behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"
    });
  }
  elements.promptLibraryFilter?.addEventListener("input", () => renderPromptLibrary());
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
  elements.promptLibraryResetCampaigns?.addEventListener("click", resetAllCampaignPromptOverrides);
  elements.promptLibraryPreview?.addEventListener("click", () => { promptLibraryPreviewVisible = !promptLibraryPreviewVisible; void renderPromptLibraryPreview(); });
  elements.promptLibraryContent?.addEventListener("input", () => { renderPromptLibraryDirtyState(); schedulePromptLibraryPreview(); });
  elements.promptLibraryDiscard?.addEventListener("click", () => {
    elements.promptLibraryContent.value = promptLibraryEditorBaseline;
    renderPromptLibraryDirtyState();
    schedulePromptLibraryPreview();
  });
  elements.promptLibraryPrevious?.addEventListener("click", () => scrollPromptLibrary(-1));
  elements.promptLibraryNext?.addEventListener("click", () => scrollPromptLibrary(1));
  const preventLoss = event => {
    if (!promptLibraryIsDirty()) return;
    event.preventDefault();
    event.returnValue = "";
  };
  window.addEventListener("beforeunload", preventLoss);

  void ports.campaigns(signal).then(result => {
    if (signal.aborted) return;
    campaigns = result.campaigns;
    syncPromptLibraryCampaigns();
    if (campaignId || requireCampaign) {
      elements.promptLibraryScope.value = "campaign";
      elements.promptLibraryCampaign.value = campaigns.some(c => c.id === campaignId) ? campaignId : "";
    }
    return loadPromptLibrary();
  }).catch(() => {
    if (!signal.aborted) elements.promptLibraryStatus.textContent = "Your campaigns could not be loaded. Reload to try again.";
  });
  return {dispose() {
    controller.abort();
    scopeEpoch++;
    promptLibraryPreviewSequence++;
    clearTimeout(promptLibraryPreviewTimer);
    window.removeEventListener("beforeunload", preventLoss);
    promptLibrary = null;
    campaigns = [];
    elements.promptLibraryContent.value = "";
    root.replaceChildren();
  }};
}
