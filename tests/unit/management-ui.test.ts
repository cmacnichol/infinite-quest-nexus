import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const playerHtml = readFileSync("index.html", "utf8");
const managementHtml = readFileSync("apps/web/public/index.html", "utf8");
const managementScript = readFileSync("apps/web/public/nexus.js", "utf8");
const managementCss = readFileSync("apps/web/public/nexus.css", "utf8");

describe("Nexus management UI contracts", () => {
  it("leaves fiction-boundary validation exclusively to the Nexus Story Engine", () => {
    expect(playerHtml).not.toContain("STORY_RPG_MECHANIC_PATTERNS");
    expect(playerHtml).not.toContain("storyRpgMechanicLeakFields");
    expect(playerHtml).not.toContain("repairStatelessStoryRpgLeak");
    expect(playerHtml).not.toContain("sanitizeFullHistoryRpgMechanics");
  });

  it("uses Nexus branding and focused management navigation", () => {
    expect(playerHtml).toContain("<h1>Infinite Quest Nexus</h1>");
    expect(playerHtml).not.toMatch(/single-page AI-powered choose-your-own-adventure story engine/i);
    expect(playerHtml).toContain('id="btnOpenNexusImport" type="button" role="menuitem">World Management');
    expect(playerHtml).toContain('id="btnOpenProviderManagement" type="button" role="menuitem">Provider Management');
    expect(playerHtml).not.toContain("Active Text Provider &amp; Context");
    expect(playerHtml).not.toContain("btnOpenModelSettings");
    expect(playerHtml).not.toContain("modelSettingsDialog");
    expect(playerHtml).not.toContain("openModelSettingsDialog");
    expect(playerHtml).not.toContain("btnOpenInfiniteWorldsImport");
    expect(playerHtml).not.toContain("infiniteWorldsImportDialog");
    expect(playerHtml).not.toContain("Load Story File");
    expect(playerHtml).not.toContain('id="importFile"');
    expect(playerHtml).not.toContain("function loadStory(file)");
  });

  it("autosaves before leaving the story for Nexus management", () => {
    const navigationHelper = playerHtml.match(/function navigateFromStory\(url\) \{[\s\S]*?\n    \}/)?.[0] || "";
    expect(navigationHelper).toContain("syncFormToState();");
    expect(navigationHelper).toContain("syncInlineWorldEditorState();");
    expect(navigationHelper).toContain("saveState();");
    expect(navigationHelper.indexOf("saveState();")).toBeLessThan(navigationHelper.indexOf("navigatingAfterAutosave = true;"));
    expect(navigationHelper.indexOf("navigatingAfterAutosave = true;")).toBeLessThan(navigationHelper.indexOf("window.location.assign(url);"));
    expect(playerHtml).toContain("if (navigatingAfterAutosave) return;");
    expect(playerHtml).toContain('navigateFromStory("/nexus/#world-library")');
    expect(playerHtml).toContain('navigateFromStory("/nexus/#providers")');
    expect(playerHtml).not.toContain('closeMenu(); window.location.assign("/nexus/');
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

  it("uses structured playable-character rosters for manual, imported, and generated worlds", () => {
    expect(managementHtml).toContain('id="playableCharacterRoster"');
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
    expect(managementHtml).toContain('value="brief">Brief — 250–450 words');
    expect(managementHtml).toContain('value="extended">Extended — 1,200–2,000 words');
    expect(managementScript).toContain('storyLengthProfile: elements.campaignStoryLengthProfile.value');
    expect(managementScript).toContain('document.body.dataset.managementView = providerView ? "providers" : "worlds"');
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
    expect(playerHtml).toContain('/provider-text/generate');
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
    expect(playerHtml).toContain("async function maybeAutoStartResumedCampaign()");
    expect(playerHtml).toContain("await startAdventure({ skipExistingTurnsConfirm: true });");
    expect(playerHtml).toContain("const startedResumedCampaign = await maybeAutoStartResumedCampaign();");
    expect(managementScript).toContain("function parseImportJson(sourceText)");
    expect(managementScript).not.toContain("window.prompt");
  });

  it("documents compression and locks only API-supplied context", () => {
    expect(managementHtml.match(/option value="(?:auto|full|balanced|compact|summary)" title=/g)).toHaveLength(5);
    expect(managementScript).toContain("providerContextTokens.readOnly = true");
    expect(managementScript).toContain("providerContextTokens.readOnly = false");
    expect(managementScript).toContain("did not advertise a context length");
    expect(managementScript).toContain('selectedProvider?.providerRole === "text"');
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

  it("shows durable semantic indexing progress, health, and model-derived context budgeting", () => {
    expect(managementHtml).toContain('id="semanticMemoryHealth"');
    expect(managementHtml).toContain('id="embeddingProgress" class="embedding-progress hidden"');
    expect(managementHtml).toContain('id="embeddingProgressBar"');
    expect(managementHtml).toContain('id="budgetTokensSource"');
    expect(managementScript).toContain("async function monitorEmbeddingJob(jobId, campaignId, sequence)");
    expect(managementScript).toContain("renderEmbeddingJobProgress(job)");
    expect(managementScript).toContain("await refreshCampaignMemoryMetrics()");
    expect(managementScript).toContain("function applyEmbeddingModelContextBudget(model)");
    expect(managementScript).toContain("modelContextTokens - 512");
  });

  it("shows provider-reported turn and campaign costs without adding a reporting page", () => {
    expect(playerHtml).toContain('class="pill turn-cost-pill"');
    expect(playerHtml).toContain("formatReportedCost(turn.reportedCost)");
    expect(playerHtml).toContain("refreshNexusTurnReportedCost(turn)");
    expect(managementHtml).toContain('id="campaignCostSection"');
    expect(managementHtml).toContain('id="campaignCostMetrics"');
    expect(managementScript).toContain("async function refreshCampaignCostSummary()");
    expect(managementScript).toContain("/cost-summary");
    expect(managementScript).toContain("No provider-reported cost data");
    expect(managementHtml).not.toMatch(/cost tracking page/i);
  });

  it("places infrequent imports after the campaign workspace", () => {
    expect(managementHtml.indexOf('id="campaigns"')).toBeLessThan(managementHtml.indexOf('aria-labelledby="import-title"'));
  });

  it("tracks durable Story Engine phases and renders live phase detail", () => {
    expect(playerHtml).toContain('{ id: "queue", label: "Queueing turn" }');
    expect(playerHtml).toContain('{ id: "assess", label: "Preparing context" }');
    expect(playerHtml).toContain('{ id: "validate", label: "Validating turn" }');
    expect(playerHtml).toContain('committing: { id: "finalize", detail: "Atomically accepting the turn');
    expect(playerHtml).toContain('progress.detail = loggedDetail');
    expect(playerHtml).toContain('class="turn-progress-detail"');
    expect(playerHtml).toContain("updateNexusGenerationProgress(job)");
    expect(playerHtml).not.toContain('indexing: { id:');
  });

  it("asks whether an earlier turn should rewind or create a separate campaign", () => {
    expect(playerHtml).toContain('id="branchStoryDialog"');
    expect(playerHtml).toContain('value="reset" class="primary"');
    expect(playerHtml).toContain('value="copy" class="accent"');
    expect(playerHtml).toContain('async function branchIfNeeded()');
    expect(playerHtml).toContain('/rewind');
    expect(playerHtml).toContain('expectedCurrentTurnNumber: state.turns.length');
    expect(playerHtml).toContain('state.settings.nexusCampaignWorldVersionId = String(status.worldVersionId');
    expect(playerHtml).toContain('async function resolveNexusCampaignForEarlierTurn(targetTurnNumber)');
    expect(playerHtml).toContain('state.storyImportProvenance?.worldVersionId');
    expect(managementScript).toContain('window.location.assign("/story/" + encodeURIComponent(selectedCampaign.id));');
    expect(playerHtml).toContain('An exhausted pending generation was released.');
    expect(playerHtml).toContain('state.settings.nexusPendingGeneration = null;');
    expect(playerHtml).not.toContain('Taking an action here will branch the story and delete later turns. Continue?');
  });

  it("uses authoritative server-side rewind for undo and retry without client-side fallback import", () => {
    expect(playerHtml).toContain('async function undoLatest()');
    expect(playerHtml).toContain('async function retryLatest()');
    expect(playerHtml).toContain('expectedCurrentTurnNumber: currentTurnNumber');
    expect(playerHtml).toContain('restoreAuthoritativeTurnState(rewind.stateSnapshot || {})');
    expect(playerHtml).toContain('Browser and campaign history have diverged. Reload to resync.');
  });
});
