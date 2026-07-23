import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const storyHtml = readFileSync("apps/web/public/story.html", "utf8");
const storyScript = readFileSync("apps/web/public/story.js", "utf8");
const managementHtml = readFileSync("apps/web/public/index.html", "utf8");
const managementScript = readFileSync("apps/web/public/nexus.js", "utf8");
const managementCss = readFileSync("apps/web/public/nexus.css", "utf8");

describe("Nexus management UI contracts", () => {
  it("dismisses every Nexus modal from its backdrop while protecting unsaved form edits", () => {
    expect(managementHtml).toContain('id="discardChangesDialog"');
    expect(managementHtml).toContain("Discard unsaved changes?");
    expect(managementHtml).toContain('id="deleteDialog" class="confirm-dialog" data-dismiss-mode="cancel"');
    expect(managementScript).toContain("function modalFormSnapshot(dialog)");
    expect(managementScript).toContain("function openManagedModal(dialog)");
    expect(managementScript).toContain("function clickedDialogBackdrop(dialog, event)");
    expect(managementScript).toContain("function requestModalDismissal(dialog)");
    expect(managementScript).toContain("function installClickAwayModalDismissal()");
    expect(managementScript).toContain('dialog.close("cancel")');
    expect(managementScript).toContain('discardModalTarget?.open');
    expect(managementScript).toContain("if (dialog === elements.characterDialog && characterModalBusy) return;");
  });

  it("offers an explicit turn-intent provider role without implicit activation", () => {
    expect(managementHtml).toContain('<option value="intent">Turn intent classification</option>');
    expect(managementScript).toContain("Inactive · Story text fallback");
    expect(managementScript).toContain("Make system default");
    expect(managementScript).toContain("It never generates story narration");
  });

  it("configures Sogni as an independent illustration provider without exposing stored secrets", () => {
    expect(managementHtml).toContain('<option value="sogni">Sogni AI</option>');
    expect(managementHtml).toContain('id="providerSogniSettings" class="hidden" aria-hidden="true"');
    expect(managementHtml).toContain('Provider default (safest)');
    expect(managementHtml).toContain('id="providerSogniImageCount"');
    expect(managementHtml).toContain('<option value="2">2 images</option>');
    expect(managementHtml).toContain('id="providerSogniModelDiscoveryEnabled"');
    expect(managementHtml).toContain('id="providerSogniSupportsSafeContentFilter"');
    expect(managementScript).toContain('sogni: "https://api.sogni.ai"');
    expect(managementScript).toContain('maximumPollIntervalMs: Math.round(Number(elements.providerSogniMaximumPollIntervalSeconds.value) * 1000)');
    expect(managementScript).toContain('generationTimeoutMs: Math.round(Number(elements.providerSogniGenerationTimeoutSeconds.value) * 1000)');
    expect(managementScript).toContain('elements.providerApiKey.value = "";');
    expect(managementScript).not.toContain('elements.providerApiKey.value = provider.');
  });

  it("leaves fiction-boundary validation exclusively to the Nexus Story Engine", () => {
    expect(storyScript).not.toContain("STORY_RPG_MECHANIC_PATTERNS");
    expect(storyScript).not.toContain("storyRpgMechanicLeakFields");
    expect(storyScript).not.toContain("repairStatelessStoryRpgLeak");
    expect(storyScript).not.toContain("sanitizeFullHistoryRpgMechanics");
  });

  it("uses Nexus branding and focused management navigation", () => {
    expect(storyHtml).toContain('<strong>Infinite Quest</strong>');
    expect(storyHtml).toContain('src="/nexus/nexus-mark.png"');
    expect(storyHtml).toContain('id="btnNexusDashboard"');
    expect(storyHtml).toContain('href="/nexus/#world-library"');
    expect(storyHtml).toContain('href="/nexus/#providers"');
    expect(storyHtml).not.toContain("modelSettingsDialog");
    expect(storyHtml).not.toContain("infiniteWorldsImportDialog");
    expect(storyHtml).not.toContain('id="importFile"');
    expect(storyScript).not.toContain("function loadStory(file)");
  });

  it("keeps management navigation separate from authoritative story persistence", () => {
    expect(storyHtml).toContain('id="btnWorldManagement" href="/nexus/#world-library"');
    expect(storyHtml).toContain('id="btnProviderSetup" href="/nexus/#providers"');
    expect(storyScript).not.toContain("localStorage.setItem(\"storyState\"");
    expect(storyScript).not.toContain("syncInlineWorldEditorState");
  });

  it("consolidates Infinite Worlds files into the World Management importer", () => {
    expect(managementHtml).toContain('id="infiniteWorldsOptions"');
    expect(managementHtml).toContain('value="world_json"');
    expect(managementHtml).toContain('value="world_text"');
    expect(managementHtml).toContain('value="story_text"');
    expect(managementHtml).toContain('accept=".story,.json,.txt,application/json,text/plain"');
    expect(managementScript).toContain('/api/v1/imports/infinite-worlds/preview');
    expect(managementScript).toContain('/api/v1/imports/infinite-worlds');
  });

  it("can attach a portable campaign backup to an explicit world version", () => {
    expect(managementHtml).toContain('id="campaignImportOptions"');
    expect(managementHtml).toContain('id="campaignImportDestination"');
    expect(managementHtml).toContain('id="campaignImportWorld"');
    expect(managementHtml).toContain('id="campaignImportVersion"');
    expect(managementScript).toContain("async function previewPortableCampaign(sourceName, story)");
    expect(managementScript).toContain('characterStrategy: "preserve_source"');
    expect(managementScript).toContain("targetWorldVersionId");
    expect(managementHtml).toContain("Target-world defaults are not merged automatically");
  });

  it("uses structured playable-character rosters for manual, imported, and generated worlds", () => {
    expect(managementHtml).toContain('id="playableCharacterRoster"');
    expect(managementHtml).toContain('id="addPlayableCharacter"');
    expect(managementHtml).toContain('id="newCampaignCharacter"');
    expect(managementHtml).toContain("Playable characters can be authored, imported, or generated.");
    expect(managementHtml).toContain("World imports retain every playable character.");
    expect(managementHtml).not.toContain('id="worldCharacter"');
    expect(managementHtml).not.toContain("Legacy/default character guidance");
    expect(managementScript).toContain("function renderPlayableCharacterRoster(characters = [])");
    expect(managementScript).toContain("playableCharactersFromContent(selectedWorld.draftContent)");
    expect(managementScript).not.toContain("Legacy/default character");
    expect(managementScript).toContain("async function loadWorldVersionPlayableCharacters()");
    expect(managementScript).toContain('/playable-characters`');
    expect(managementScript).toContain("selectedCharacterId");
    expect(managementScript).toContain("const characterCount = Array.isArray(preview.characters) ? preview.characters.length : 0;");
    expect(managementScript).toContain("all ${characterCount} playable character");
    expect(managementScript).not.toContain("preview.characters.length || 1");
    expect(managementScript).toContain('elements.infiniteWorldsCharacterField.classList.add("hidden");');
  });

  it("uses one reviewed character modal for adding, editing, generating, and deleting", () => {
    expect(managementHtml.match(/id="characterDialog"/g)).toHaveLength(1);
    expect(managementHtml).toContain('id="characterForm"');
    expect(managementHtml).toContain('id="characterName" required');
    expect(managementHtml).toContain('id="characterGuidance" required');
    expect(managementHtml).toContain('id="characterStats"');
    expect(managementHtml).toContain('id="addCharacterStat"');
    expect(managementHtml).toContain('id="characterTrackers"');
    expect(managementHtml).toContain('id="addCharacterTracker"');
    expect(managementHtml).toContain('id="deleteCharacter"');
    expect(managementHtml).toContain('id="saveCharacter"');
    expect(managementHtml).toContain('id="characterGenerator" class="character-generator hidden"');
    expect(managementHtml).toContain('id="characterGeneratorPrompt"');
    expect(managementHtml).toContain('id="generateCharacter"');
    expect(managementHtml).toContain("Generation fills this form only. Review and save the result to change the draft.");
    expect(managementCss).toContain(".character-dialog-modal");
    expect(managementCss).toContain(".character-edit-row");
    expect(managementCss).toContain(".character-roster-card:hover");
    expect(managementScript).toContain("function openCharacterDialog(characterId = \"\")");
    expect(managementScript).toContain('card.addEventListener("click", () => openCharacterDialog(character.id));');
    expect(managementScript).toContain('elements.addPlayableCharacter.addEventListener("click", () => openCharacterDialog());');
    expect(managementScript).toContain("async function persistWorldDraft(content)");
    expect(managementScript).toContain("async function saveCharacterFromModal(event)");
    expect(managementScript).toContain("async function deleteCharacterFromModal()");
    expect(managementScript).toContain("Published versions and existing campaigns remain unchanged.");
    expect(managementScript).toContain("if (!name) throw new Error(\"Enter a character name.\");");
    expect(managementScript).toContain("if (!characterText) throw new Error");
    expect(managementScript).toContain("must be a whole number from 1 to 99");
  });

  it("offers character generation only through an available default text model and never auto-saves it", () => {
    expect(managementScript).toContain('const provider = defaultProvider("text");');
    expect(managementScript).toContain('String(provider.defaultModel || "").trim()');
    expect(managementScript).toContain('elements.characterGenerator.classList.toggle("hidden", !available);');
    expect(managementScript).toContain("async function generateCharacterFromPrompt()");
    expect(managementScript).toContain("/draft/playable-characters/generate");
    expect(managementScript).toContain("expectedRevision: selectedWorld.draftRevision");
    expect(managementScript).toContain("Character generated. Review every field, then save to update the world draft.");
    const generator = managementScript.match(/async function generateCharacterFromPrompt\(\) \{[\s\S]*?\n\}/)?.[0] || "";
    expect(generator).not.toContain("persistWorldDraft(");
    expect(generator).toContain("elements.characterName.value = previousName;");
    expect(generator).toContain("elements.characterGuidance.value = previousGuidance;");
  });

  it("strips legacy overview guidance when saving version-4 drafts", () => {
    expect(managementScript).toContain("function worldOverviewWithoutLegacyCharacter(world = {})");
    expect(managementScript).toContain("delete overview.character;");
    expect(managementScript).toContain("const currentOverview = worldOverviewWithoutLegacyCharacter(current.world);");
    expect(managementScript).toContain("schemaVersion: 4");
    expect(managementScript).not.toContain("elements.worldCharacter");
    expect(managementScript).not.toContain("overview.character ||");
  });

  it("keeps character loading ordered and blocks campaigns for versions without a roster", () => {
    expect(managementHtml).toContain('id="worldCampaignReadiness"');
    expect(managementScript).toContain("let playableCharacterLoadSequence = 0;");
    expect(managementScript).toContain("let worldVersionCampaignReady = false;");
    expect(managementScript).not.toContain("worldCharacterLoadSequence");
    expect(managementScript).toContain("sequence !== playableCharacterLoadSequence || worldVersionId !== selectedWorldVersionId()");
    expect(managementScript).toContain('worldVersionCampaignReady = hasReadinessAssessment ? response.readiness.ready : worldVersionCharacters.length > 0;');
    expect(managementScript).toContain('String(firstReadinessIssue?.message || "").trim()');
    expect(managementScript).toContain("function updateCampaignCreationAvailability()");
    expect(managementScript).toContain("elements.createCampaignModalBtn.disabled = !hasPublishedVersion || !worldVersionCampaignReady;");
    expect(managementScript).toContain("elements.confirmCreateCampaign.disabled = !hasPublishedVersion || !worldVersionCampaignReady || !hasRequiredSelection;");
    expect(managementScript).toContain("This world version is not campaign-ready; update the draft and publish a new version");
    expect(managementScript).toContain("if (!worldVersionCampaignReady) {");
  });

  it("keeps Provider Management dedicated to profiles and campaign provider assignments in World Management", () => {
    expect(managementHtml).toContain('class="card provider-card anchor-section provider-management"');
    expect(managementHtml).toContain('class="card world-library-card anchor-section world-management"');
    expect(managementHtml).toContain('id="providerIsDefault"');
    expect(managementHtml).toContain('id="providerTemperature"');
    expect(managementHtml).toContain('id="refreshProviderModels"');
    expect(managementHtml).toContain('id="providerModelDialog"');
    expect(managementHtml).toContain('id="providerModelPickerList"');
    expect(managementHtml).not.toContain('id="providerDiscoveredModel"');
    expect(managementHtml).toContain('provider-model-settings');
    expect(managementHtml).toContain('title="Maximum combined prompt and response capacity.');
    expect(managementHtml).not.toContain('id="generationForm"');
    expect(managementHtml).not.toContain('id="storyAction"');
    expect(managementHtml).not.toContain("Generate next turn");
    expect(managementScript).not.toContain("async function generateTurn(event)");
    expect(managementHtml).toContain('id="providerProfileList"');
    expect(managementHtml).toContain('id="providerAdvancedSettings"');
    expect(managementHtml).toContain('id="providerRequestTimeoutMinutes"');
    expect(managementHtml).toContain('value="5"');
    expect(managementScript).toContain("requestTimeoutMs: Math.round(Number(elements.providerRequestTimeoutMinutes.value) * 60000)");
    expect(managementHtml).toContain('id="campaignTextProvider"');
    expect(managementHtml).toContain('id="campaignImageProvider"');
    expect(managementHtml).toContain('id="campaignStoryLengthProfile"');
    expect(managementHtml).toContain('id="campaignTurnControlStyle"');
    expect(managementHtml).toContain('id="newCampaignTurnControlStyle"');
    expect(managementHtml).toContain('value="action_only">Player actions only');
    expect(managementHtml).toContain('value="flexible_auto" selected>Flexible — Auto');
    expect(managementHtml).toContain('value="flexible_action">Flexible — Action first');
    expect(managementHtml).toContain('value="flexible_scene">Flexible — Scene direction first');
    expect(managementHtml).toContain('value="brief">Brief — 250–450 words');
    expect(managementHtml).toContain('value="extended">Extended — 1,200–2,000 words');
    expect(managementScript).toContain('storyLengthProfile: elements.campaignStoryLengthProfile.value');
    expect(managementScript).toContain('turnControlStyle: elements.newCampaignTurnControlStyle.value');
    expect(managementScript).toContain('turnControlStyle: elements.campaignTurnControlStyle.value');
    expect(managementScript).toContain('document.body.dataset.managementView = dashboardView ? "dashboard" : providerView ? "providers" : "worlds"');
    expect(managementCss).toContain('body[data-management-view="dashboard"] .world-management');
    expect(managementCss).toContain('body[data-management-view="providers"] .world-management');
    expect(managementCss).toContain('body[data-management-view="worlds"] .provider-management');
    expect(managementScript).toContain('provider.isDefault');
    expect(managementScript).toContain('available.length === 1');
    expect(managementScript).toContain("async function refreshProviderModelsFromForm()");
    expect(managementScript).toContain('state.textContent = model.loaded ? "Active" : "Not active"');
    expect(managementScript).toContain("function profileModelValue(model)");
    expect(managementScript).toContain("async function openProviderModelPicker(forceRefresh = false)");
    expect(managementScript).toContain('elements.providerContextTokens.readOnly = true');
    expect(managementScript).toContain('method: "DELETE"');
    expect(managementScript).toContain('const hasBody = options.body !== undefined && options.body !== null');
    expect(managementScript).toContain('method: editingProviderId ? "PATCH" : "POST"');
    expect(storyScript).not.toContain('/provider-text/generate');
    expect(storyScript).toContain('/generation-jobs/${jobId}');
    expect(managementHtml).toContain('value="text-embedding-nomic-embed-text-v1.5"');
    expect(managementHtml).toContain('id="embeddingDocumentPrefix"');
    expect(managementHtml).toContain('id="embeddingQueryPrefix"');
    expect(managementHtml).toContain('id="embeddingModel" maxlength="500" value="text-embedding-nomic-embed-text-v1.5" readonly role="button" aria-haspopup="dialog" aria-controls="providerModelDialog"');
    expect(managementHtml).not.toContain('id="embeddingModels"');
    expect(managementScript).toContain("function populateEmbeddingProviderSelect()");
    expect(managementScript).toContain('providerModelPickerTarget === "embedding"');
    expect(managementScript).toContain("async function openEmbeddingModelPicker(forceRefresh = false)");
    expect(managementScript).toContain("async function refreshActiveModelPicker()");
    expect(managementScript).toContain("Text fallback ·");
  });

  it("supports pasted exports while keeping Infinite Worlds world and story data separate", () => {
    expect(managementHtml).toContain('id="openClipboardImport"');
    expect(managementHtml).toContain('id="clipboardImportDialog"');
    expect(managementHtml).toContain('value="campaign_json">Infinite Quest .story JSON — world and story history');
    expect(managementHtml).toContain('value="world_json">Infinite Worlds world JSON — world details only');
    expect(managementHtml).toContain('value="story_text">Infinite Worlds matching story TXT — story history only');
    expect(managementScript).toContain("async function validateClipboardImport(event)");
    expect(managementScript).toContain("This JSON contains no story history—import the matching story TXT separately.");
    expect(managementScript).toContain("Infinite Worlds story TXT validated and ready to attach to the selected published world.");
  });

  it("exposes campaign resume and guarded campaign/world deletion", () => {
    expect(managementHtml).toContain("Upload a file or paste its copied contents.");
    expect(managementHtml).toContain("Infinite Worlds world JSON contains only world details");
    expect(managementHtml).toContain("Infinite Quest <code>.story</code>/campaign or world export");
    expect(managementHtml).toContain('id="loadCampaign"');
    expect(managementHtml).toContain('id="deleteCampaign"');
    expect(managementHtml).toContain('id="deleteWorld"');
    expect(managementHtml).toContain('id="deleteDialog"');
    expect(managementScript).toContain('window.location.assign("/story/" + encodeURIComponent(selectedCampaign.id));');
    expect(managementScript).toContain("Use “Load story” in Campaigns");
    expect(storyScript).toContain("async function resumePendingGeneration()");
    expect(storyScript).toContain("const resumed = await resumePendingGeneration();");
    expect(storyScript).toContain("if (!resumed && state.turns.length === 0 && !state.busy)");
    expect(managementScript).toContain("function parseImportJson(sourceText)");
    expect(managementScript).not.toContain("window.prompt");
  });

  it("offers an accessible copy-first cross-world campaign transfer", () => {
    expect(managementHtml).toContain('id="transferCampaign"');
    expect(managementHtml).toContain('id="transferCampaignDialog"');
    expect(managementHtml).toContain('aria-labelledby="transferCampaignTitleLabel"');
    expect(managementHtml).toContain('id="transferTargetWorld"');
    expect(managementHtml).toContain('id="transferTargetVersion"');
    expect(managementHtml).toContain("Leave the source campaign unchanged.");
    expect(managementHtml).toContain('id="transferWarningAcknowledgement"');
    expect(managementScript).toContain("async function previewCampaignTransfer()");
    expect(managementScript).toContain('/transfer-world/preview`');
    expect(managementScript).toContain('/transfer-world`');
    expect(managementScript).toContain('characterStrategy: "preserve_source"');
    expect(managementScript).toContain('stateStrategy: "preserve"');
    expect(managementScript).toContain('targetDefaultsPolicy: "retain_source"');
    expect(managementScript).toContain("expectedActiveTurnNumber: transferPreview.expectedActiveTurnNumber");
    expect(managementScript).toContain("expectedStateRevision: transferPreview.expectedStateRevision");
    expect(managementScript).toContain("sourceFingerprint: transferPreview.sourceFingerprint");
    expect(managementScript).toContain("idempotencyKey: transferIdempotencyKey");
    expect(managementScript).toContain("await Promise.all([loadWorlds(), loadCampaigns(result.targetCampaignId)])");
    expect(managementScript).toContain("the original remains unchanged");
    expect(managementCss).toContain(".transfer-finding[data-severity=\"blocking\"]");
  });

  it("deletes only an explicitly selected unused World version with a typed confirmation", () => {
    expect(managementHtml).toContain('id="deleteWorldVersion"');
    expect(managementHtml).toContain("Delete selected version");
    expect(managementHtml).toContain('id="deleteDialogDetails"');
    expect(managementScript).toContain("function explicitlySelectedWorldVersion()");
    expect(managementScript).toContain("function updateWorldVersionDeleteAvailability()");
    expect(managementScript).toContain("async function deleteSelectedWorldVersion()");
    expect(managementScript).toContain("expectedVersionNumber: version.versionNumber");
    expect(managementScript).toContain("Remaining versions keep their existing numbers; gaps are not renumbered or reused.");
    expect(managementScript).toContain("error.details?.blockers");
    expect(managementScript).toContain("await loadWorlds(worldId);");
    expect(managementScript).toContain("await loadCampaigns(selectedCampaignId);");
    expect(managementScript).toContain('elements.deleteWorldVersion.addEventListener("click", deleteSelectedWorldVersion);');
  });

  it("documents compression and locks only API-supplied context", () => {
    expect(managementHtml.match(/option value="(?:auto|full|balanced|compact|summary)" title=/g)).toHaveLength(5);
    expect(managementScript).toContain("providerContextTokens.readOnly = true");
    expect(managementScript).toContain("providerContextTokens.readOnly = false");
    expect(managementScript).toContain("did not advertise a context length");
    expect(managementScript).toContain('const textProvider = effectiveCampaignProvider("text")');
    expect(managementScript).toContain("clampedMemoryContextBudget(elements.budgetTokens.value)");
  });

  it("separates campaign illustrations from Chronicle context and collapses disabled image settings", () => {
    const illustrationSection = managementHtml.indexOf('id="campaignIllustrationSection"');
    const contextSection = managementHtml.indexOf('id="campaignContextSection"');
    const imageProvider = managementHtml.indexOf('id="campaignImageProvider"');
    expect(illustrationSection).toBeGreaterThan(-1);
    expect(contextSection).toBeGreaterThan(illustrationSection);
    expect(imageProvider).toBeGreaterThan(illustrationSection);
    expect(imageProvider).toBeLessThan(contextSection);
    expect(managementHtml).toContain('id="illustrationSettings" class="illustration-settings hidden" aria-hidden="true"');
    expect(managementScript).toContain('function renderIllustrationSettingsVisibility()');
    expect(managementScript).toContain('function syncIllustrationProviderAvailability(restoreSavedState = false)');
    expect(managementScript).toContain('elements.illustrationEnabled.disabled = !selectedCampaign || !hasImageProvider');
    expect(managementScript).toContain('Add and enable an illustration provider in Provider Management before enabling images.');
    expect(managementScript).toContain('body: JSON.stringify({ imageProviderProfileId: elements.campaignImageProvider.value || null })');
  });

  it("shows durable semantic indexing progress, health, and story-provider context budgeting", () => {
    expect(managementHtml).toContain('id="semanticMemoryHealth"');
    expect(managementHtml).toContain('id="embeddingProgress" class="embedding-progress hidden"');
    expect(managementHtml).toContain('id="embeddingProgressBar"');
    expect(managementHtml).toContain('id="budgetTokensSource"');
    expect(managementScript).toContain("async function monitorEmbeddingJob(jobId, campaignId, sequence)");
    expect(managementScript).toContain("renderEmbeddingJobProgress(job)");
    expect(managementScript).toContain("await refreshCampaignMemoryMetrics()");
    expect(managementScript).toContain("function applyStoryProviderContextBudget()");
    expect(managementScript).toContain("textProvider?.contextWindowTokens");
    expect(managementScript).toContain("text provider's available input space");
    expect(managementScript).not.toContain("applyEmbeddingModelContextBudget");
    expect(managementScript).not.toContain("modelContextTokens - 512");
  });

  it("shows provider-reported turn and campaign costs without adding a reporting page", () => {
    expect(storyScript).toContain('class="pill turn-cost-pill"');
    expect(storyScript).toContain("formatReportedCost(turn.reportedCost)");
    expect(managementHtml).toContain('id="campaignCostSection"');
    expect(managementHtml).toContain('id="campaignCostMetrics"');
    expect(managementScript).toContain("async function refreshCampaignCostSummary()");
    expect(managementScript).toContain("/cost-summary");
    expect(managementScript).toContain("No provider-reported cost data");
    expect(managementScript).toContain("text generation");
    expect(managementScript).toContain("image generation");
    expect(managementScript).toContain("function modelPricingLabel(model)");
    expect(managementHtml).not.toMatch(/cost tracking page/i);
  });

  it("generates durable world covers from both new-world and edit-world workflows", () => {
    expect(managementHtml).toContain('id="newWorldGenerateCover"');
    expect(managementHtml).toContain('id="worldCoverPreview"');
    expect(managementHtml).toContain('id="worldCoverPrompt"');
    expect(managementHtml).toContain('id="generateWorldCover"');
    expect(managementScript).toContain("async function generateWorldCoverImage()");
    expect(managementScript).toContain("async function monitorWorldCoverJob(jobId, worldId)");
    expect(managementScript).toContain("/cover`");
  });

  it("places infrequent imports after the campaign workspace", () => {
    expect(managementHtml.indexOf('id="campaigns"')).toBeLessThan(managementHtml.indexOf('aria-labelledby="import-title"'));
  });

  it("tracks durable Story Engine phases and renders live phase detail", () => {
    expect(storyScript).toContain('{ id: "queued", label: "Queued" }');
    expect(storyScript).toContain('{ id: "prepare", label: "Reading state" }');
    expect(storyScript).toContain('{ id: "mechanics", label: "Resolving action" }');
    expect(storyScript).toContain('{ id: "scene", label: "Writing scene" }');
    expect(storyScript).toContain('{ id: "finalize", label: "Saving turn" }');
    expect(storyScript).toContain("updateGenerationProgress(job)");
  });

  it("asks whether an earlier turn should rewind or create a separate campaign", () => {
    expect(storyHtml).toContain('id="branchStoryDialog"');
    expect(storyHtml).toContain('value="reset" class="primary"');
    expect(storyHtml).toContain('value="copy" class="accent"');
    expect(storyScript).toContain('function promptBranchOrReset(turnIndex)');
    expect(storyScript).toContain('/rewind`');
    expect(storyScript).toContain('/branch`');
    expect(managementScript).toContain('window.location.assign("/story/" + encodeURIComponent(selectedCampaign.id));');
    expect(storyScript).toContain('async function resumePendingGeneration()');
  });

  it("uses authoritative server-side rewind for undo and retry without client-side fallback import", () => {
    expect(storyScript).toContain('async function undoLatest()');
    expect(storyScript).toContain('async function retryLatest()');
    expect(storyScript).toContain('expectedCurrentTurnNumber: currentTurnNumber');
    expect(storyScript).toContain('operationKind: "replace_latest"');
    expect(storyScript).not.toContain("client-side fallback import");
  });
});
