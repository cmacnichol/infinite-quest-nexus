import type { StoryMemorySettings } from "@infinite-quest/contracts";
import type { CampaignSummary } from "../campaign-editor-api";
import { escapeCampaignText } from "../campaign-editor-model";
export type JsonRecord = Record<string, unknown>;
export interface ProviderSummary extends JsonRecord { id: string; name: string; providerType: string; providerRole: string; enabled?: boolean; isDefault?: boolean; }

export function field(label: string, control: string): string { return `<label class="campaign-field"><span>${label}</span>${control}</label>`; }
export function option(value: string, label: string, selected: string): string { return `<option value="${escapeCampaignText(value)}"${value === selected ? " selected" : ""}>${escapeCampaignText(label)}</option>`; }
export function disabledOption(value: string, label: string, selected = false): string { return `<option value="${escapeCampaignText(value)}"${selected ? " selected" : ""} disabled>${escapeCampaignText(label)}</option>`; }
export function record(value: unknown): JsonRecord { return value && typeof value === "object" ? value as JsonRecord : {}; }
export function text(value: unknown): string { return escapeCampaignText(value); }


export function providerOptions(providers: ProviderSummary[], role: string, selected: unknown, fallbackLabel: string, emptyChoice?: string): string {
  const selectedId = String(selected ?? "");
  const available = providers.filter((provider) => provider.providerRole === role && (provider.enabled !== false || provider.id === selectedId));
  const fallback = available.find((provider) => provider.isDefault);
  const emptyLabel = available.length ? (fallback ? `Use default · ${fallback.name}` : fallbackLabel) : `No ${role} provider profiles available`;
  return option("", emptyChoice ?? emptyLabel, selectedId) + (selectedId && !available.some(provider => provider.id === selectedId) ? option(selectedId,"Saved provider unavailable",selectedId) : "") + available.map((provider) => option(provider.id, `${provider.name} · ${provider.providerType}${provider.enabled === false ? " · unavailable" : provider.isDefault ? " · default" : ""}`, selectedId)).join("");
}
function embeddingProviderOptions(providers: ProviderSummary[], selected: unknown, campaignTextProviderProfileId: unknown): string {
  const selectedId = String(selected ?? "");
  const configuredProvider = selectedId ? providers.find((provider) => provider.id === selectedId) : undefined;
  const configuredTextProvider = configuredProvider?.providerRole === "text" ? configuredProvider : undefined;
  const incompatibleOptions = (eligible: ProviderSummary[], role: "embedding" | "text"): string => {
    const label = configuredTextProvider
      ? `Configured text provider is no longer eligible · ${configuredTextProvider.name}`
      : configuredProvider
        ? `Configured provider is no longer eligible · ${configuredProvider.name}`
        : "Configured provider is no longer available";
    return disabledOption("", "Choose an eligible embedding provider", true)
      + disabledOption(selectedId, label)
      + eligible.map((provider) => option(
        provider.id,
        role === "embedding"
          ? `${provider.name} · ${provider.providerType}${provider.isDefault ? " · default" : ""}`
          : `Text fallback · ${provider.name} · ${provider.providerType}${provider.isDefault ? " · default" : ""}`,
        ""
      )).join("");
  };
  const dedicated = providers.filter((provider) => provider.providerRole === "embedding" && provider.enabled !== false);
  if (dedicated.length) {
    const selectedDedicated = dedicated.find((provider) => provider.id === selectedId);
    if (selectedId && !selectedDedicated) return incompatibleOptions(dedicated, "embedding");
    const effectiveDedicated = selectedDedicated
      ?? (!selectedId ? dedicated.find((provider) => provider.isDefault) ?? (dedicated.length === 1 ? dedicated[0] : undefined) : undefined);
    return providerOptions(dedicated, "embedding", effectiveDedicated?.id ?? "", "Select an embedding provider");
  }
  const campaignTextId = String(campaignTextProviderProfileId ?? "");
  const textProviders = providers.filter((provider) => provider.providerRole === "text" && provider.enabled !== false);
  const selectedTextProvider = textProviders.find((provider) => provider.id === selectedId);
  if (selectedId && !selectedTextProvider) return incompatibleOptions(textProviders, "text");
  const textFallback = selectedTextProvider
    ?? textProviders.find((provider) => provider.id === campaignTextId)
    ?? textProviders.find((provider) => provider.isDefault)
    ?? (textProviders.length === 1 ? textProviders[0] : undefined);
  return textFallback
    ? option(textFallback.id, `Text fallback · ${textFallback.name} · ${textFallback.providerType}`, textFallback.id)
    : option("", "No text or embedding provider configured", "");
}

const STORY_MEMORY_LEVELS = ["off", "standard", "enhanced", "max"] as const;
const STORY_MEMORY_LEVEL_LABELS: Record<(typeof STORY_MEMORY_LEVELS)[number], string> = {
  off: "Off",
  standard: "Standard",
  enhanced: "Enhanced",
  max: "Max"
};

export function storyMemoryGuidance(settings: StoryMemorySettings | null): string {
  return settings?.reviewMode !== "off" && settings
    ? "Continuity review checks each new draft before acceptance. It adds a model request and may pause a turn for your decision."
    : "Continuity review is disabled. Story structure and safety validation still apply.";
}

export function storyMemorySettingsMarkup(settings: StoryMemorySettings | null, unavailable: boolean): string {
  const selected = settings?.level ?? "off";
  const available = new Set(settings?.availableLevels ?? []);
  const disabled = unavailable ? " disabled" : "";
  const options = STORY_MEMORY_LEVELS.map((level) => `<option value="${level}"${level === selected ? " selected" : ""}${unavailable || !available.has(level) ? " disabled" : ""}>${STORY_MEMORY_LEVEL_LABELS[level]}</option>`).join("");
  const status = unavailable
    ? '<p class="campaign-error" role="status">Campaign memory settings could not be loaded. Reload the page before changing them.</p>'
    : `<p data-story-memory-guidance class="campaign-field-hint">${storyMemoryGuidance(settings)}</p>`;
  return `<form id="memory-settings-form" class="campaign-form" aria-busy="false"><section><h3>Campaign memory</h3>${field("Memory level", `<select name="storyMemoryLevel" aria-describedby="story-memory-help"${disabled}>${options}</select>`)}<label class="campaign-checkbox"><input type="checkbox" name="continuityReviewEnabled"${settings && settings.reviewMode !== "off" ? " checked" : ""}${unavailable || selected !== "max" ? " disabled" : ""}><span>Enable continuity review</span></label><p class="campaign-field-hint">Optional with Max memory. Disabled by default.</p><p id="story-memory-help" class="campaign-field-hint">This applies to newly queued turns. Existing jobs keep their saved memory policy. Accepted turns and the current draft are unchanged.</p>${status}</section><div class="campaign-action-ledger"><span>Selection is restricted by this server's available memory levels.</span><button class="primary-action" type="submit"${disabled}>Save memory level</button></div></form>`;
}


export function storyBehaviorFields(c: CampaignSummary, providers: ProviderSummary[], includeProvider = true): string {
  const visibleTurnControlStyle = c.turnControlStyle === "flexible_scene" ? "flexible_scene" : "flexible_action";
  return `${includeProvider ? field("Text provider profile", `<select name="textProviderProfileId">${providerOptions(providers, "text", c.textProviderProfileId, "Select a text provider")}</select>`) : ""}${field("Turn input style", `<select name="turnControlStyle">${option("flexible_action", "Action", visibleTurnControlStyle)}${option("flexible_scene", "Story Direction", visibleTurnControlStyle)}</select>`)}${field("Response length", `<select name="storyLengthProfile">${["brief", "standard", "long", "extended"].map((v) => option(v, v[0].toUpperCase() + v.slice(1), c.storyLengthProfile)).join("")}</select>`)}${field("Story context", `<select name="storyContextBudgetTokens" title="Target context for future Story generation. Provider limits still apply.">${[[32000, "32k"], [64000, "64k"], [128000, "128k"], [256000, "256k"], [1000000, "1m"], [2000000, "2m"], [4000000, "4m"]].map(([value, label]) => option(String(value), String(label), String(c.storyContextBudgetTokens))).join("")}</select>`)}`;
}

export function semanticRetrievalHealthView(health: JsonRecord): Record<string, string> {
  const labels: Record<string, string> = {
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
  const status = typeof health.status === "string" && Object.hasOwn(labels, health.status) ? health.status : "";
  const coverageValue = Number(health.coveragePercent);
  const coveragePercent = Number.isFinite(coverageValue) ? Math.min(100, Math.max(0, Math.round(coverageValue))) : null;
  const implementations: Record<string, string> = { legacy_hybrid: "Legacy hybrid", chunked_hybrid: "Chunked hybrid" };
  const implementation = typeof health.retrievalImplementation === "string" ? implementations[health.retrievalImplementation] : undefined;
  const shadow = typeof health.retrievalShadowEnabled === "boolean" ? health.retrievalShadowEnabled ? "On" : "Off" : "Unavailable";
  const fallbackCode = typeof health.fallbackCode === "string" && /^[a-z0-9][a-z0-9_.:-]{0,199}$/u.test(health.fallbackCode)
    ? health.fallbackCode.replace(/[_:.-]+/gu, " ")
    : health.fallbackCode ? "Unavailable" : "None";
  const jobStatuses: Record<string, string> = { queued: "Queued", running: "Running", completed: "Completed", failed: "Failed" };
  const jobStatus = typeof health.jobStatus === "string" && Object.hasOwn(jobStatuses, health.jobStatus) ? jobStatuses[health.jobStatus] : "No active job";
  const progress = record(health.progress);
  const processedParents = Number(progress.processedParents ?? progress.embedded);
  const totalParents = Number(progress.totalParents ?? progress.total);
  const embeddedChunks = Number(progress.embeddedChunks);
  const skippedChunks = Number(progress.skippedChunks);
  const progressParts: string[] = [];
  if (Number.isFinite(processedParents) && Number.isFinite(totalParents) && totalParents >= 0) progressParts.push(`${Math.max(0, processedParents)} of ${Math.max(0, totalParents)} memories`);
  if (Number.isFinite(embeddedChunks) || Number.isFinite(skippedChunks)) progressParts.push(`${Math.max(0, Number.isFinite(embeddedChunks) ? embeddedChunks : 0)} embedded chunks · ${Math.max(0, Number.isFinite(skippedChunks) ? skippedChunks : 0)} skipped`);
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

export function chronicleEmbeddingConfigPayload(values: Record<string, string>): Record<string, unknown> {
  return {
    enabled: values.enabled === "true",
    providerProfileId: values.providerProfileId || null,
    model: values.model,
    batchSize: Number(values.batchSize),
    documentPrefix: values.documentPrefix || null,
    queryPrefix: values.queryPrefix || null,
    retrievalImplementation: values.retrievalImplementation,
    retrievalShadowEnabled: values.retrievalShadowEnabled === "on"
  };
}


export function chronicleFields(config: JsonRecord, providers: ProviderSummary[], campaignTextProviderProfileId: unknown): string {
  const enabled = typeof config.enabled === "boolean" ? String(config.enabled) : "";
  const implementation = typeof config.retrievalImplementation === "string" ? config.retrievalImplementation : "";
  const enabledOptions = `${enabled ? "" : '<option value="" selected disabled>Configuration unavailable</option>'}${option("false", "Off", enabled)}${option("true", "On", enabled)}`;
  const implementationOptions = `${implementation ? "" : '<option value="" selected disabled>Configuration unavailable</option>'}${option("legacy_hybrid", "Legacy hybrid", implementation)}${option("chunked_hybrid", "Chunked hybrid", implementation)}`;
  return `<fieldset class="chronicle-retrieval-settings"><legend>Semantic Retrieval</legend>${field("Semantic Retrieval", `<select name="enabled" required>${enabledOptions}</select>`)}${field("Production implementation", `<select name="retrievalImplementation" required>${implementationOptions}</select>`)}<label class="campaign-field chronicle-toggle"><span>Shadow comparison</span><span><input type="checkbox" name="retrievalShadowEnabled"${config.retrievalShadowEnabled === true ? " checked" : ""}> Compare retrieval implementations</span></label><p>Shadow comparison records safe diagnostics only. It never changes production selection.</p></fieldset><div class="campaign-field-grid three chronicle-provider-grid">${field("Embedding provider", `<select name="providerProfileId">${embeddingProviderOptions(providers,config.providerProfileId,campaignTextProviderProfileId)}</select>`)}${field("Embedding model", `<input name="model" value="${text(config.model ?? "")}">`)}${field("Batch size", `<input type="number" min="1" max="128" name="batchSize" value="${text(config.batchSize ?? "")}">`)}${field("Document prefix", `<input name="documentPrefix" value="${text(config.documentPrefix ?? "")}">`)}${field("Query prefix", `<input name="queryPrefix" value="${text(config.queryPrefix ?? "")}">`)}</div>`;
}

export function chronicleMarkup(metrics: JsonRecord, config: JsonRecord, providers: ProviderSummary[], campaignTextProviderProfileId: unknown = null, operationsOnly = false): string {
  const health = record(metrics.semanticHealth);
  const healthView = semanticRetrievalHealthView(health);
  const statusAttribute = healthView.status ? ` data-state="${healthView.status}"` : "";
  const healthDetails = [
    ["Coverage", healthView.coverageLabel],
    ["Production", healthView.productionLabel],
    ["Shadow comparison", healthView.shadowLabel],
    ["Index job", healthView.jobLabel],
    ...(health.providerName ? [["Provider", `${String(health.providerName)} · ${String(health.providerHealth ?? "unknown")}${health.model ? ` · ${String(health.model)}` : ""}`]] : []),
    ...(health.fallbackCode ? [["Fallback reason", healthView.fallbackLabel]] : [])
  ];
  const metricsMarkup = [
    [metrics.turns, "Accepted turns"],
    [metrics.estimatedCompleteHistoryTokens, "Complete-history tokens"],
    [metrics.memoryCount, "Chronicle memories"],
    [health.indexedMemories ?? metrics.embeddedMemories, "Current embeddings"]
  ].map(([value, label]) => `<div><strong>${text(value ?? "—")}</strong><span>${label}</span></div>`).join("");
  return `<header class="campaign-section-heading"><h2>Chronicle</h2><p>Manage derived memory and preview the fiction-only context selected for generation.</p></header><div class="campaign-metrics chronicle-metrics">${metricsMarkup}</div><section class="chronicle-health"${statusAttribute} role="status" aria-live="polite" aria-atomic="true"><header><span class="chronicle-health-badge">${healthView.label}</span><div><h3>${healthView.label}</h3><p>${text(health.message ?? "Semantic Retrieval status is unavailable.")}</p></div></header><dl>${healthDetails.map(([label, value]) => `<div><dt>${text(label)}</dt><dd>${text(value)}</dd></div>`).join("")}</dl><p class="chronicle-availability-note">Chronicle local memory remains available when semantic retrieval is off.</p></section><form id="chronicle-form" class="campaign-form chronicle-form">${operationsOnly ? "" : chronicleFields(config,providers,campaignTextProviderProfileId)}<section class="chronicle-preview"><h3>Context preview</h3><div class="campaign-field-grid three">${field("Budget tokens", `<input name="budgetTokens" type="number" min="512" value="32000">`)}${field("Compression", `<select name="compression">${["auto","full","balanced","compact","summary"].map(v=>option(v,v,"auto")).join("")}</select>`)}${field("Retrieval query", `<input name="query" maxlength="4000">`)}</div><pre id="context-preview" tabindex="0">Build a preview to inspect selected memory.</pre></section><div class="campaign-action-ledger chronicle-action-ledger"><button type="button" data-action="rebuild-memory" title="Reconstruct derived Chronicle memories from accepted turns and campaign state, then queue semantic indexing. Use only when memory is stale or inconsistent.">Rebuild memory</button><button type="button" data-action="reindex-embeddings" title="Re-run the legacy memory-vector embedding job using the saved provider and model. This does not save form changes or rebuild chunked vectors."${config.enabled === true ? "" : " disabled"}>Reindex Semantic Retrieval</button><button type="button" data-action="preview-context">Build context preview</button>${operationsOnly ? "" : '<button class="primary-action" type="submit" title="Save these Semantic Retrieval settings and queue the chunked vector index. Use this after changing the provider, model, prefixes, or retrieval implementation.">Save & index</button>'}</div></form>`;
}


export function illustrationFields(c: JsonRecord, providers: ProviderSummary[], segmentEditor = false): string {
  const source = String(c.sourcePolicy ?? (c.enabled ? "generate_only" : "off"));
  return `<div class="campaign-field-grid three">${field("Automatic source", `<select name="sourcePolicy">${["off","library_only","library_then_generate","generate_only"].map(v=>option(v,v.replaceAll("_"," "),source)).join("")}</select>`)}${field("Matching scope", `<select name="matchingScope">${["campaign","world","owner_library"].map(v=>option(v,v,String(c.matchingScope))).join("")}</select>`)}${field("Confidence", `<select name="confidenceProfile">${["strict","balanced","broad"].map(v=>option(v,v,String(c.confidenceProfile))).join("")}</select>`)}${field("Repetition window", `<input name="repetitionWindow" type="number" min="0" max="100" value="${text(c.repetitionWindow ?? 5)}">`)}${field(segmentEditor ? "Segment image provider" : "Provider profile", `<select name="providerProfileId">${providerOptions(providers,"image",c.providerProfileId,"Select an image provider",segmentEditor ? "No segment override" : undefined)}</select>`)}${field("Image model", `<input name="model" value="${text(c.model)}">`)}${field("Size", `<input name="size" value="${text(c.size ?? "1024x1024")}">`)}${field("Aspect ratio", `<input name="aspectRatio" value="${text(c.aspectRatio ?? "1:1")}">`)}${field("Quality", `<select name="quality">${["auto","low","medium","high"].map(v=>option(v,v,String(c.quality))).join("")}</select>`)}${field("Format", `<select name="outputFormat">${["png","jpeg","webp"].map(v=>option(v,v,String(c.outputFormat))).join("")}</select>`)}${field("Attempts", `<input name="maxAttempts" type="number" min="1" max="10" value="${text(c.maxAttempts ?? 3)}">`)}${field("Words per segment", `<input name="segmentWordCount" type="number" min="100" max="5000" value="${text(c.segmentWordCount ?? 500)}">`)}${field("Images per segment", `<input name="imagesPerSegment" type="number" min="1" max="2" value="${text(c.imagesPerSegment ?? 1)}">`)}${field("Segment prompt mode", `<select name="segmentPromptMode">${option("direct","Accepted segment text",String(c.segmentPromptMode))}${option("ai_refined","AI-refined prompt",String(c.segmentPromptMode))}</select>`)}${field("Art style", `<input name="artStyle" maxlength="500" value="${text(c.artStyle ?? "")}">`)}${field("Exclude from images", `<input name="negativePrompt" maxlength="500" value="${text(c.negativePrompt ?? c.defaultNegativePrompt ?? "")}">`)}</div><p class="campaign-field-note">The art style is added to every generated image. Exclusions are sent as a negative prompt when the image provider supports one. The AI refinement prompt is edited in the Prompt Library (Illustration refinement), where campaign overrides apply to every segment job.</p>`;
}

export function illustrationsMarkup(c: JsonRecord, providers: ProviderSummary[], operationsOnly = false): string {
  return `<header class="campaign-section-heading"><h2>Illustrations</h2><p>Configure optional child jobs independently from accepted story turns.</p></header><form id="illustrations-form" class="campaign-form">${operationsOnly ? "" : illustrationFields(c,providers)}<div class="campaign-action-ledger"><button type="button" data-action="backfill-images">Generate missing history</button><button type="button" data-action="rebuild-images">Rebuild historical segments</button>${operationsOnly ? "" : '<button class="primary-action" type="submit">Save illustration settings</button>'}</div></form>`;
}




export function illustrationPayload(values: Record<string,string>, refinementPrompt: unknown) {
  return {
    ...values,
    providerProfileId: values.providerProfileId || null,
    repetitionWindow: Number(values.repetitionWindow),
    maxAttempts: Number(values.maxAttempts),
    segmentWordCount: Number(values.segmentWordCount),
    imagesPerSegment: Number(values.imagesPerSegment),
    refinementPrompt
  };
}
