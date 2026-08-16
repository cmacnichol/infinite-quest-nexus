import { initializeAppTheme, renderAppShell } from "./app-shell";
import { campaignApi, loadCampaign, loadCampaigns, type CampaignSummary } from "./campaign-editor-api";
import { CAMPAIGN_SECTIONS, CAMPAIGN_SECTION_LABELS, campaignEditorPath, campaignStateInspectorMarkup, escapeCampaignText, firstNarrationSentence, narrationCorrectionDialogMarkup, withCampaignActionState, type CampaignRoute, type CampaignSection } from "./campaign-editor-model";
import type { MountedPage } from "./world-library-page";

type JsonRecord = Record<string, unknown>;
interface ProviderSummary extends JsonRecord { id: string; name: string; providerType: string; providerRole: string; enabled?: boolean; isDefault?: boolean; }
interface TransferTarget { id: string; label: string; }
const svg = (path: string) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}" /></svg>`;
const icons: Record<CampaignSection, string> = {
  overview: svg("M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"),
  character: svg("M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM5 20a7 7 0 0 1 14 0"),
  state: svg("m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Zm0 9 8-4.5M12 12 4 7.5M12 12v9"),
  history: svg("M3 12a9 9 0 1 0 3-6.7L3 8m0-5v5h5M12 7v5l3 2"),
  chronicle: svg("M4 5a3 3 0 0 1 3-2h5v17H7a3 3 0 0 0-3 2Zm16 0a3 3 0 0 0-3-2h-5v17h5a3 3 0 0 1 3 2Z"),
  illustrations: svg("M4 5h16v14H4zM7 15l3-3 3 3 2-2 3 3M16 9h.01"),
  "world-transfer": svg("M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 0c2.4 2.5 3.5 5.5 3.5 9S14.4 18.5 12 21m0-18C9.6 5.5 8.5 8.5 8.5 12s1.1 6.5 3.5 9M3 12h18"),
  data: svg("M5 6c0-1.7 3.1-3 7-3s7 1.3 7 3-3.1 3-7 3-7-1.3-7-3Zm0 0v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6")
};
const actionWorkingLabels: Record<string, string> = {
  "inspect-turn": "Loading state…", "close-turn-state": "Closing…", "edit-narration": "Loading narration…",
  "retry-turn": "Preparing retry…", "rebuild-turn-images": "Preparing rebuild…", "branch-turn": "Preparing branch…",
  "rewind-turn": "Preparing rewind…", "backfill-images": "Checking history…", "rebuild-images": "Checking history…",
  "preview-context": "Building preview…", "rebuild-memory": "Queueing rebuild…", "reindex-embeddings": "Queueing reindex…", "organize-character": "Organizing…",
  "preview-transfer": "Checking transfer…", "archive-campaign": "Archiving…", "delete-campaign": "Deleting…"
};

function field(label: string, control: string): string { return `<label class="campaign-field"><span>${label}</span>${control}</label>`; }
function option(value: string, label: string, selected: string): string { return `<option value="${escapeCampaignText(value)}"${value === selected ? " selected" : ""}>${escapeCampaignText(label)}</option>`; }
function disabledOption(value: string, label: string, selected = false): string { return `<option value="${escapeCampaignText(value)}"${selected ? " selected" : ""} disabled>${escapeCampaignText(label)}</option>`; }
function record(value: unknown): JsonRecord { return value && typeof value === "object" ? value as JsonRecord : {}; }
function text(value: unknown): string { return escapeCampaignText(value); }
function providerOptions(providers: ProviderSummary[], role: string, selected: unknown, fallbackLabel: string): string {
  const selectedId = String(selected ?? "");
  const available = providers.filter((provider) => provider.providerRole === role && (provider.enabled !== false || provider.id === selectedId));
  const fallback = available.find((provider) => provider.isDefault);
  const emptyLabel = available.length ? (fallback ? `Use default · ${fallback.name}` : fallbackLabel) : `No ${role} provider profiles available`;
  return option("", emptyLabel, selectedId) + available.map((provider) => option(provider.id, `${provider.name} · ${provider.providerType}${provider.enabled === false ? " · unavailable" : provider.isDefault ? " · default" : ""}`, selectedId)).join("");
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
function formatCost(value: unknown, currency: unknown): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "—";
  const code = typeof currency === "string" && /^[A-Z]{3}$/.test(currency) ? currency : "USD";
  return new Intl.NumberFormat(undefined, { style: "currency", currency: code, minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(amount);
}

function campaignListMarkup(): string {
  return `<main id="main-content" data-page="campaign-library" class="campaign-library-page"><header class="campaign-library-heading"><div><h1>Campaigns</h1><p>Resume, inspect, or configure every durable adventure.</p></div><a href="/nexus/#campaigns" class="secondary-action">Legacy campaign management</a></header><div class="campaign-library-tools"><label>Find a campaign<input id="campaign-search" type="search" placeholder="Campaign, world, or character"></label></div><section id="campaign-index" class="campaign-index" aria-live="polite"><p>Loading campaigns…</p></section></main>`;
}

function shellMarkup(campaign: CampaignSummary, section: CampaignSection): string {
  const nav = CAMPAIGN_SECTIONS.map((item) => `<a href="${campaignEditorPath(campaign.id, item)}"${item === section ? ' aria-current="page"' : ""}>${icons[item]}<span>${CAMPAIGN_SECTION_LABELS[item]}</span></a>`).join("");
  return `<main id="main-content" data-page="campaign-editor" data-section="${section}"><header class="campaign-command-row"><a href="/app/campaigns" class="campaign-back">${svg("m15 18-6-6 6-6")}<span>Back to campaigns</span></a><div class="campaign-identity"><h1>${text(campaign.title)}</h1><span class="campaign-status">${text(campaign.status)}</span><span>Turn ${campaign.activeTurnNumber}</span><span>${text(campaign.worldTitle)} v${campaign.worldVersionNumber}</span></div><a class="campaign-enter-story" href="/story?campaign=${encodeURIComponent(campaign.id)}">Enter story ${svg("M7 17 17 7M8 7h9v9")}</a></header><div class="campaign-workspace"><aside class="campaign-spine" aria-label="Campaign editor sections"><div class="campaign-coordinate" aria-hidden="true"><span>Campaign folio</span><strong>${String(campaign.activeTurnNumber).padStart(3, "0")}</strong></div><nav>${nav}</nav></aside><section class="campaign-leaf"><div id="campaign-message" class="campaign-message" role="status" aria-live="polite"></div><div id="campaign-section" aria-busy="true"><div class="campaign-loading">Loading ${CAMPAIGN_SECTION_LABELS[section]}…</div></div></section></div></main>`;
}

function overviewMarkup(c: CampaignSummary, providers: ProviderSummary[]): string {
  const cost = record(c.costInformation?.[0]);
  const currency = String(cost.currency ?? "USD");
  const metrics = c.costInformation?.length ? [
    [cost.amount, `Total ${currency}`], [cost.textGenerationAmount, "Story text"],
    [cost.imageGenerationAmount, "Illustrations"], [cost.memoryAmount, "Chronicle"]
  ] : [["—", "No provider-reported cost"]];
  return `<header class="campaign-section-heading"><h2>Campaign overview</h2><p>Configure campaign identity and the Story Engine defaults used for future turns.</p></header><form id="overview-form" class="campaign-form"><section><h3>Identity</h3><div class="campaign-field-grid">${field("Campaign title", `<input name="title" maxlength="200" required value="${text(c.title)}">`)}${field("Status", `<select name="status">${option("active","Active",c.status)}${option("archived","Archived",c.status)}</select>`)}</div></section><section><h3>Story Engine</h3><div class="campaign-field-grid three">${field("Text provider profile", `<select name="textProviderProfileId">${providerOptions(providers,"text",c.textProviderProfileId,"Select a text provider")}</select>`)}${field("Turn input style", `<select name="turnControlStyle">${option("action_only","Player actions only",c.turnControlStyle)}${option("flexible_auto","Flexible — Auto",c.turnControlStyle)}${option("flexible_action","Flexible — Action first",c.turnControlStyle)}${option("flexible_scene","Flexible — Scene direction first",c.turnControlStyle)}</select>`)}${field("Response length", `<select name="storyLengthProfile">${["brief","standard","long","extended"].map((v)=>option(v,v[0].toUpperCase()+v.slice(1),c.storyLengthProfile)).join("")}</select>`)}</div></section><section><h3>Reported provider cost</h3><div class="campaign-metrics">${metrics.map(([value,label]) => `<div><strong>${formatCost(value,currency)}</strong><span>${text(label)}</span></div>`).join("")}</div></section><div class="campaign-action-ledger"><span>Accepted turns and Chronicle memory are unchanged by these settings.</span><button class="primary-action" type="submit">Save campaign</button></div></form>`;
}

function characterMarkup(value: JsonRecord): string {
  return `<header class="campaign-section-heading"><h2>Character</h2><p>Edit the campaign-local character copy without changing its immutable world-version source.</p></header><form id="character-form" class="campaign-form"><div class="campaign-field-grid">${field("Character name", `<input name="name" required value="${text(value.name)}">`)}${field("Revision", `<input name="revision" readonly value="${text(value.revision)}">`)}</div>${field("Profile", `<textarea name="profile" rows="18" spellcheck="false">${text(JSON.stringify(value.profile ?? {}, null, 2))}</textarea>`)}<div class="campaign-action-ledger"><button type="button" data-action="organize-character">Organize with AI</button><button class="primary-action" type="submit">Save campaign profile</button></div></form>`;
}

function stateMarkup(value: JsonRecord): string {
  const facts = Array.isArray(value.canonicalFacts) ? value.canonicalFacts.map((x)=>record(x).content).join("\n") : "";
  return `<header class="campaign-section-heading"><h2>Current state</h2><p>Edit only the authoritative current state used by the next accepted turn.</p></header><form id="state-form" class="campaign-form"><input type="hidden" name="revision" value="${text(value.revision)}"><input type="hidden" name="turn" value="${text(value.activeTurnNumber)}">${field("Continuity summary", `<textarea name="continuitySummary" rows="7">${text(value.continuitySummary)}</textarea>`)}<div class="campaign-field-grid">${field("Open threads — one per line", `<textarea name="openThreads" rows="9">${text(Array.isArray(value.openThreads) ? value.openThreads.join("\n") : "")}</textarea>`)}${field("Canonical facts — one per line", `<textarea name="canonicalFacts" rows="9">${text(facts)}</textarea>`)}</div>${field("Private continuity scratchpad", `<textarea name="scratchpad" rows="9">${text(value.scratchpad)}</textarea>`)}${field("Trackers — JSON", `<textarea name="trackers" rows="9" spellcheck="false">${text(JSON.stringify(value.trackers ?? [], null, 2))}</textarea>`)}<details><summary>Read-only mechanics and triggers</summary><pre>${text(JSON.stringify({ rpgStats:value.rpgStats,eventTriggers:value.eventTriggers,pendingEventTriggers:value.pendingEventTriggers }, null, 2))}</pre></details><div class="campaign-action-ledger"><span>Historical state remains read-only.</span><button class="primary-action" type="submit">Save current state</button></div></form>`;
}

function historyMarkup(value: JsonRecord, campaign: CampaignSummary): string {
  const turns = Array.isArray(value.turns) ? value.turns.map(record) : [];
  return `<header class="campaign-section-heading"><h2>History</h2><p>Scan every accepted prompt and its opening story sentence. Read complete turns in Story.</p></header><div class="turn-ledger">${turns.length ? turns.map((turn)=>`<article data-turn-id="${text(turn.id)}" data-turn-number="${text(turn.turnNumber)}"><header><h3>Turn ${text(turn.turnNumber)}</h3><time datetime="${text(turn.acceptedAt)}" title="${text(turn.acceptedAt)}">${text(String(turn.acceptedAt ?? "").slice(0,10))}</time></header><div class="turn-content"><p class="turn-action"><span>Prompt</span>${text(turn.action)}</p><p class="turn-narration">${text(firstNarrationSentence(turn.narration))}</p><div class="turn-row-actions"><a href="/story?campaign=${text(value.campaignId)}&turn=${text(turn.turnNumber)}">Open in story</a><details class="turn-operations"><summary>Manage turn</summary><div class="turn-actions"><button type="button" data-action="inspect-turn">Inspect state</button><button type="button" data-action="edit-narration">Edit narration</button>${Number(turn.turnNumber)===campaign.activeTurnNumber?`<button type="button" data-action="retry-turn">Retry edited prompt</button>`:""}<button type="button" data-action="rebuild-turn-images">Rebuild illustrations</button><button type="button" data-action="branch-turn">Branch</button><button type="button" data-action="rewind-turn">Rewind</button></div></details></div><p class="turn-feedback" role="status" aria-live="polite"></p></div></article>`).join("") : `<p class="campaign-empty">No accepted turns yet.</p>`}</div><dialog id="turn-state-dialog" class="turn-state-dialog" aria-labelledby="turn-state-title"><header><h3 id="turn-state-title" tabindex="-1">Turn state</h3><button type="button" data-action="close-turn-state" aria-label="Close turn state">Close</button></header><div class="turn-state-dialog-body"></div></dialog>${narrationCorrectionDialogMarkup()}`;
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

interface ChronicleJobMonitorDependencies {
  loadJob: (jobId: string) => Promise<unknown>;
  refresh: (job: JsonRecord) => Promise<void>;
  onProgress: (job: JsonRecord) => void;
  wait: () => Promise<void>;
  maximumPolls?: number;
}

export async function monitorChronicleJob(jobId: string, dependencies: ChronicleJobMonitorDependencies): Promise<JsonRecord> {
  if (!jobId) throw new Error("Chronicle indexing did not return a job identifier.");
  const maximumPolls = Math.max(1, Math.trunc(dependencies.maximumPolls ?? 1200));
  for (let poll = 0; poll < maximumPolls; poll += 1) {
    const job = record(await dependencies.loadJob(jobId));
    dependencies.onProgress(job);
    await dependencies.refresh(job);
    if (job.status === "completed" || job.status === "failed") return job;
    await dependencies.wait();
  }
  throw new Error("Chronicle indexing is still running. Refresh this page to resume monitoring.");
}

export function chronicleMarkup(metrics: JsonRecord, config: JsonRecord, providers: ProviderSummary[], campaignTextProviderProfileId: unknown = null): string {
  const health = record(metrics.semanticHealth);
  const healthView = semanticRetrievalHealthView(health);
  const statusAttribute = healthView.status ? ` data-state="${healthView.status}"` : "";
  const enabled = typeof config.enabled === "boolean" ? String(config.enabled) : "";
  const implementation = typeof config.retrievalImplementation === "string" ? config.retrievalImplementation : "";
  const enabledOptions = `${enabled ? "" : '<option value="" selected disabled>Configuration unavailable</option>'}${option("false", "Off", enabled)}${option("true", "On", enabled)}`;
  const implementationOptions = `${implementation ? "" : '<option value="" selected disabled>Configuration unavailable</option>'}${option("legacy_hybrid", "Legacy hybrid", implementation)}${option("chunked_hybrid", "Chunked hybrid", implementation)}`;
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
  return `<header class="campaign-section-heading"><h2>Chronicle</h2><p>Manage derived memory and preview the fiction-only context selected for generation.</p></header><div class="campaign-metrics chronicle-metrics">${metricsMarkup}</div><section class="chronicle-health"${statusAttribute} role="status" aria-live="polite" aria-atomic="true"><header><span class="chronicle-health-badge">${healthView.label}</span><div><h3>${healthView.label}</h3><p>${text(health.message ?? "Semantic Retrieval status is unavailable.")}</p></div></header><dl>${healthDetails.map(([label, value]) => `<div><dt>${text(label)}</dt><dd>${text(value)}</dd></div>`).join("")}</dl><p class="chronicle-availability-note">Chronicle local memory remains available when semantic retrieval is off.</p></section><form id="chronicle-form" class="campaign-form chronicle-form"><fieldset class="chronicle-retrieval-settings"><legend>Semantic Retrieval</legend>${field("Semantic Retrieval", `<select name="enabled" required>${enabledOptions}</select>`)}${field("Production implementation", `<select name="retrievalImplementation" required>${implementationOptions}</select>`)}<label class="campaign-field chronicle-toggle"><span>Shadow comparison</span><span><input type="checkbox" name="retrievalShadowEnabled"${config.retrievalShadowEnabled === true ? " checked" : ""}> Compare retrieval implementations</span></label><p>Shadow comparison records safe diagnostics only. It never changes production selection.</p></fieldset><div class="campaign-field-grid three chronicle-provider-grid">${field("Embedding provider", `<select name="providerProfileId">${embeddingProviderOptions(providers,config.providerProfileId,campaignTextProviderProfileId)}</select>`)}${field("Embedding model", `<input name="model" value="${text(config.model ?? "")}">`)}${field("Batch size", `<input type="number" min="1" max="128" name="batchSize" value="${text(config.batchSize ?? "")}">`)}${field("Document prefix", `<input name="documentPrefix" value="${text(config.documentPrefix ?? "")}">`)}${field("Query prefix", `<input name="queryPrefix" value="${text(config.queryPrefix ?? "")}">`)}</div><section class="chronicle-preview"><h3>Context preview</h3><div class="campaign-field-grid three">${field("Budget tokens", `<input name="budgetTokens" type="number" min="512" value="32000">`)}${field("Compression", `<select name="compression">${["auto","full","balanced","compact","summary"].map(v=>option(v,v,"auto")).join("")}</select>`)}${field("Retrieval query", `<input name="query" maxlength="4000">`)}</div><pre id="context-preview" tabindex="0">Build a preview to inspect selected memory.</pre></section><div class="campaign-action-ledger chronicle-action-ledger"><button type="button" data-action="rebuild-memory">Rebuild memory</button><button type="button" data-action="reindex-embeddings"${config.enabled === true ? "" : " disabled"}>Reindex Semantic Retrieval</button><button type="button" data-action="preview-context">Build context preview</button><button class="primary-action" type="submit">Save & index</button></div></form>`;
}

export function refreshChronicleStatusProjection(target: HTMLElement, markup: string): void {
  const staging = target.ownerDocument.createElement("div");
  staging.innerHTML = markup;
  for (const selector of [".chronicle-metrics", ".chronicle-health"]) {
    const current = target.querySelector(selector);
    const replacement = staging.querySelector(selector);
    if (current && replacement) current.replaceWith(replacement);
  }
}

export function setChronicleOperationBusy(target: HTMLElement, busy: boolean, semanticEnabled: boolean): void {
  const form = target.querySelector<HTMLFormElement>("#chronicle-form");
  if (!form) return;
  form.setAttribute("aria-busy", String(busy));
  const save = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  const rebuild = form.querySelector<HTMLButtonElement>('button[data-action="rebuild-memory"]');
  const reindex = form.querySelector<HTMLButtonElement>('button[data-action="reindex-embeddings"]');
  if (save) save.disabled = busy;
  if (rebuild) rebuild.disabled = busy;
  if (reindex) reindex.disabled = busy || !semanticEnabled;
}

function illustrationsMarkup(c: JsonRecord, providers: ProviderSummary[]): string {
  const source = String(c.sourcePolicy ?? (c.enabled ? "generate_only" : "off"));
  return `<header class="campaign-section-heading"><h2>Illustrations</h2><p>Configure optional child jobs independently from accepted story turns.</p></header><form id="illustrations-form" class="campaign-form"><div class="campaign-field-grid three">${field("Automatic source", `<select name="sourcePolicy">${["off","library_only","library_then_generate","generate_only"].map(v=>option(v,v.replaceAll("_"," "),source)).join("")}</select>`)}${field("Matching scope", `<select name="matchingScope">${["campaign","world","owner_library"].map(v=>option(v,v,String(c.matchingScope))).join("")}</select>`)}${field("Confidence", `<select name="confidenceProfile">${["strict","balanced","broad"].map(v=>option(v,v,String(c.confidenceProfile))).join("")}</select>`)}${field("Repetition window", `<input name="repetitionWindow" type="number" min="0" max="100" value="${text(c.repetitionWindow ?? 5)}">`)}${field("Provider profile", `<select name="providerProfileId">${providerOptions(providers,"image",c.providerProfileId,"Select an image provider")}</select>`)}${field("Image model", `<input name="model" value="${text(c.model)}">`)}${field("Size", `<input name="size" value="${text(c.size ?? "1024x1024")}">`)}${field("Aspect ratio", `<input name="aspectRatio" value="${text(c.aspectRatio ?? "1:1")}">`)}${field("Quality", `<select name="quality">${["auto","low","medium","high"].map(v=>option(v,v,String(c.quality))).join("")}</select>`)}${field("Format", `<select name="outputFormat">${["png","jpeg","webp"].map(v=>option(v,v,String(c.outputFormat))).join("")}</select>`)}${field("Attempts", `<input name="maxAttempts" type="number" min="1" max="10" value="${text(c.maxAttempts ?? 3)}">`)}${field("Words per segment", `<input name="segmentWordCount" type="number" min="100" max="5000" value="${text(c.segmentWordCount ?? 500)}">`)}${field("Images per segment", `<input name="imagesPerSegment" type="number" min="1" max="2" value="${text(c.imagesPerSegment ?? 1)}">`)}${field("Segment prompt mode", `<select name="segmentPromptMode">${option("direct","Accepted segment text",String(c.segmentPromptMode))}${option("ai_refined","AI-refined prompt",String(c.segmentPromptMode))}</select>`)}</div>${field("AI refinement prompt", `<textarea name="refinementPrompt" rows="9">${text(c.refinementPrompt)}</textarea>`)}<div class="campaign-action-ledger"><button type="button" data-action="backfill-images">Generate missing history</button><button type="button" data-action="rebuild-images">Rebuild historical segments</button><button class="primary-action" type="submit">Save illustration settings</button></div></form>`;
}

function worldTransferMarkup(c: CampaignSummary, world: JsonRecord, targets: TransferTarget[]): string {
  const versions = Array.isArray(world.versions) ? world.versions.map(record) : [];
  return `<header class="campaign-section-heading"><h2>World & transfer</h2><p>Accepted turns remain append-only when the campaign changes its immutable world reference.</p></header><section class="campaign-reference"><h3>Pinned world</h3><strong>${text(c.worldTitle)} · Version ${c.worldVersionNumber}</strong><p>${c.worldUpdateAvailable ? `Version ${c.latestWorldVersionNumber} is available.` : "This campaign uses the latest published version."}</p></section><form id="migration-form" class="campaign-form">${field("Migrate to published version", `<select name="worldVersionId">${versions.map(v=>option(String(v.id),`Version ${v.versionNumber}`,c.worldVersionId)).join("")}</select>`)}${field("Migration note", `<textarea name="note" rows="4"></textarea>`)}<button class="primary-action" type="submit">Migrate version</button></form><form id="transfer-form" class="campaign-form"><h3>Transfer to another world</h3><div class="campaign-field-grid">${field("Target published world version", `<select name="targetWorldVersionId" required>${option("",targets.length ? "Choose a world" : "No other published worlds available","")}${targets.map(target=>option(target.id,target.label,"")).join("")}</select>`)}${field("New campaign title", `<input name="title" value="${text(c.title)}" required>`)}</div><input type="hidden" name="characterStrategy" value="preserve_source"><input type="hidden" name="stateStrategy" value="preserve"><input type="hidden" name="targetDefaultsPolicy" value="retain_source"><pre id="transfer-preview">Preview compatibility before transfer.</pre><div class="campaign-action-ledger"><button type="button" data-action="preview-transfer"${targets.length ? "" : " disabled"}>Preview transfer</button><button class="primary-action" type="submit"${targets.length ? "" : " disabled"}>Transfer campaign</button></div></form>`;
}

function dataMarkup(c: CampaignSummary): string { return `<header class="campaign-section-heading"><h2>Campaign data</h2><p>Export portable records or perform explicit lifecycle operations.</p></header><div class="campaign-data-actions"><a href="/api/v1/campaigns/${text(c.id)}/export">Export Campaign Archive</a><a href="/api/v1/campaigns/${text(c.id)}/readable-export">Export readable story</a><button data-action="archive-campaign">Archive campaign</button></div><section class="campaign-danger"><h3>Delete campaign</h3><p>Deletes this campaign and its owned operational records. Export first if the record must be recoverable.</p><button data-action="delete-campaign">Delete campaign</button></section>`; }

function formObject(form: HTMLFormElement): Record<string,string> { return Object.fromEntries(new FormData(form).entries()) as Record<string,string>; }
function parseJsonField(form: HTMLFormElement, name: string, label: string): unknown {
  const control = form.elements.namedItem(name) as HTMLTextAreaElement | null;
  if (!control) throw new Error(`${label} field is unavailable.`);
  control.removeAttribute("aria-invalid");
  control.closest("label")?.querySelector(".campaign-field-error")?.remove();
  try { return JSON.parse(control.value); }
  catch {
    control.setAttribute("aria-invalid", "true");
    const error = form.ownerDocument.createElement("span");
    error.className = "campaign-field-error"; error.textContent = `${label} must contain valid JSON.`;
    control.closest("label")?.append(error); control.focus();
    throw new Error(`${label} must contain valid JSON.`);
  }
}

export function mountCampaignEditorPage(root: HTMLElement, route: CampaignRoute): MountedPage {
  renderAppShell(root, route.campaignId ? `<main id="main-content"><p class="campaign-loading">Loading campaign…</p></main>` : campaignListMarkup(), "campaigns");
  let theme = initializeAppTheme(root); const controller = new AbortController(); let disposed = false; let campaign: CampaignSummary | null = null; let transferPreview: JsonRecord | null = null; let chronicleConfig: JsonRecord = {}; let chronicleProviders: ProviderSummary[] = []; let chronicleOperationActive = false;
  const message = (copy: string, error = false) => { const el=root.querySelector<HTMLElement>("#campaign-message"); if(el){el.textContent=copy;el.dataset.state=error?"error":"success";} };
  const confirmAction = (copy: string) => root.ownerDocument.defaultView?.confirm(copy) ?? false;
  const chroniclePollDelay = () => new Promise<void>((resolve, reject) => {
    const view = root.ownerDocument.defaultView;
    if (!view) { resolve(); return; }
    const abort = () => {
      view.clearTimeout(timeout);
      reject(new DOMException("Campaign editor closed.", "AbortError"));
    };
    const timeout = view.setTimeout(() => {
      controller.signal.removeEventListener("abort", abort);
      resolve();
    }, 1000);
    controller.signal.addEventListener("abort", abort, { once: true });
  });
  async function runChronicleOperation<T>(target: HTMLElement, operation: () => Promise<T>): Promise<T> {
    if (chronicleOperationActive) throw new Error("Chronicle indexing is already being monitored.");
    chronicleOperationActive = true;
    setChronicleOperationBusy(target, true, chronicleConfig.enabled === true);
    try { return await operation(); }
    finally {
      chronicleOperationActive = false;
      setChronicleOperationBusy(target, false, chronicleConfig.enabled === true);
    }
  }
  async function showList(): Promise<void> { const campaigns=await loadCampaigns(controller.signal); const target=root.querySelector<HTMLElement>("#campaign-index")!; const search=root.querySelector<HTMLInputElement>("#campaign-search")!; const render=()=>{const q=search.value.trim().toLowerCase();const shown=campaigns.filter(c=>[c.title,c.worldTitle,c.selectedCharacterName].some(v=>String(v??"").toLowerCase().includes(q)));target.innerHTML=shown.length?shown.map(c=>`<a href="${campaignEditorPath(c.id)}"><div><h2>${text(c.title)}</h2><p>${text(c.worldTitle)} v${c.worldVersionNumber}${c.selectedCharacterName?` · ${text(c.selectedCharacterName)}`:""}</p></div><span>${c.activeTurnNumber} turns · ${text(c.status)}</span></a>`).join(""):`<p class="campaign-empty">No campaigns match this search.</p>`;};search.addEventListener("input",render);render(); }
  async function refreshChronicleMetrics(target: HTMLElement, job?: JsonRecord): Promise<void> {
    if (!campaign) return;
    const metrics = record(await campaignApi.get<JsonRecord>(campaign.id,"/memory/metrics",controller.signal));
    if (job) {
      const health = record(metrics.semanticHealth);
      metrics.semanticHealth = {
        ...health,
        ...(job.status === "queued" || job.status === "running" ? { status: "indexing", message: "Chronicle derived-memory indexing is in progress." } : {}),
        jobStatus: job.status,
        progress: job.progress
      };
    }
    refreshChronicleStatusProjection(target, chronicleMarkup(metrics,chronicleConfig,chronicleProviders,campaign.textProviderProfileId));
  }
  async function monitorAndRefreshChronicle(jobId: unknown, label: string): Promise<void> {
    if (!campaign || typeof jobId !== "string" || !jobId) throw new Error(`${label} did not return a job identifier.`);
    const target = root.querySelector<HTMLElement>("#campaign-section")!;
    const terminal = await monitorChronicleJob(jobId, {
      loadJob: () => campaignApi.general(`/api/v1/jobs/${encodeURIComponent(jobId)}`,controller.signal),
      refresh: (job) => refreshChronicleMetrics(target,job),
      onProgress: (job) => {
        const progress = record(job.progress); const processed = Number(progress.processedParents ?? progress.embedded); const total = Number(progress.totalParents ?? progress.total);
        const suffix = Number.isFinite(processed) && Number.isFinite(total) && total > 0 ? ` · ${processed}/${total} memories` : "";
        const safeStatus = job.status === "queued" ? "Queued" : job.status === "running" ? "Running" : job.status === "completed" ? "Completed" : job.status === "failed" ? "Failed" : "Checking";
        message(`${label} · ${safeStatus}${suffix}`);
      },
      wait: chroniclePollDelay
    });
    if (terminal.status === "failed") throw new Error(`${label} failed. Chronicle local memory remains available.`);
    message(`${label} completed. Current compatible coverage is shown below.`);
  }
  async function showSection(): Promise<void> {
    if (!route.campaignId) return; campaign=await loadCampaign(route.campaignId,controller.signal); if(disposed)return; theme.dispose(); renderAppShell(root,shellMarkup(campaign,route.section),"campaigns"); theme=initializeAppTheme(root); const target=root.querySelector<HTMLElement>("#campaign-section")!;
    const loadProviders = async () => { const response=record(await campaignApi.general("/api/v1/providers",controller.signal)); return (Array.isArray(response.providers)?response.providers:[]).map(record).filter((value)=>typeof value.id==="string"&&typeof value.name==="string"&&typeof value.providerRole==="string"&&typeof value.providerType==="string") as ProviderSummary[]; };
    if(route.section==="overview") target.innerHTML=overviewMarkup(campaign,await loadProviders());
    else if(route.section==="character") target.innerHTML=characterMarkup(record(await campaignApi.get(campaign.id,"/character-profile",controller.signal)));
    else if(route.section==="state") target.innerHTML=stateMarkup(record(await campaignApi.get(campaign.id,"/state",controller.signal)));
    else if(route.section==="history") target.innerHTML=historyMarkup(record(await campaignApi.get(campaign.id,"/turns?limit=100",controller.signal)),campaign);
    else if(route.section==="chronicle") { const [m,c,p]=await Promise.all([campaignApi.get<JsonRecord>(campaign.id,"/memory/metrics",controller.signal),campaignApi.get<JsonRecord>(campaign.id,"/memory/embedding-config",controller.signal),loadProviders()]);chronicleConfig=record(c);chronicleProviders=p;target.innerHTML=chronicleMarkup(record(m),chronicleConfig,chronicleProviders,campaign.textProviderProfileId); }
    else if(route.section==="illustrations") { const [config,providers]=await Promise.all([campaignApi.get(campaign.id,"/illustration-config",controller.signal),loadProviders()]);target.innerHTML=illustrationsMarkup(record(config),providers); }
    else if(route.section==="world-transfer") { const [world,response]=await Promise.all([campaignApi.general(`/api/v1/worlds/${encodeURIComponent(campaign.worldId)}`,controller.signal),campaignApi.general("/api/v1/worlds",controller.signal)]);const worlds=record(response).worlds;const targets=(Array.isArray(worlds)?worlds:[]).map(record).filter((candidate)=>candidate.id!==campaign!.worldId&&typeof candidate.latestVersionId==="string").map((candidate)=>({id:String(candidate.latestVersionId),label:`${String(candidate.title)} · Version ${String(candidate.latestVersionNumber)}`}));target.innerHTML=worldTransferMarkup(campaign,record(world),targets); }
    else target.innerHTML=dataMarkup(campaign); target.setAttribute("aria-busy","false"); bindActions(target);
  }
  function bindActions(target: HTMLElement): void {
    target.addEventListener("submit",async(event)=>{event.preventDefault();if(!campaign)return;const form=event.target as HTMLFormElement;try{
      if(form.id==="narration-correction-form"){const dialog=form.closest<HTMLDialogElement>("dialog")!;const error=dialog.querySelector<HTMLElement>(".narration-correction-error")!;const narration=(form.elements.namedItem("narration") as HTMLTextAreaElement).value.trim();if(!narration){error.textContent="Enter the corrected narration before saving.";error.hidden=false;(form.elements.namedItem("narration") as HTMLTextAreaElement).focus();return;}const submit=form.querySelector<HTMLButtonElement>('button[type="submit"]')!;await withCampaignActionState(submit,"Saving correction…",async()=>campaignApi.patch(campaign!.id,`/turns/${encodeURIComponent(form.dataset.turnId??"")}/correction`,{narration,expectedCorrectionRevision:Number(form.dataset.correctionRevision??0),expectedActiveTurnNumber:campaign!.activeTurnNumber,source:"user_edit"}));const article=Array.from(target.querySelectorAll<HTMLElement>("article[data-turn-id]")).find((candidate)=>candidate.dataset.turnId===form.dataset.turnId);const feedback=article?.querySelector<HTMLElement>(".turn-feedback");dialog.close();message("Accepted narration corrected; dependent Chronicle context was rebuilt.");if(feedback){feedback.textContent="Narration saved. Chronicle context was rebuilt.";delete feedback.dataset.state;}return;}
      if(form.id==="overview-form"){const v=formObject(form);await campaignApi.patch(campaign.id,"",{...v,textProviderProfileId:v.textProviderProfileId||null});message("Campaign settings saved.");}
      if(form.id==="character-form"){const v=formObject(form);await campaignApi.put(campaign.id,"/character-profile",{expectedRevision:Number(v.revision),name:v.name,profile:parseJsonField(form,"profile","Profile"),editSource:"manual"});message("Campaign character profile saved.");}
      if(form.id==="state-form"){const v=formObject(form);const trackers=parseJsonField(form,"trackers","Trackers");const current=record(await campaignApi.get(campaign.id,"/state"));await campaignApi.patch(campaign.id,"/state",{...current,continuitySummary:v.continuitySummary,openThreads:v.openThreads.split("\n").map(x=>x.trim()).filter(Boolean),canonicalFacts:v.canonicalFacts.split("\n").map(x=>x.trim()).filter(Boolean).map(content=>({id:null,content})),scratchpad:v.scratchpad,trackers,expectedTurnNumber:Number(v.turn),expectedRevision:Number(v.revision)});message("Current campaign state saved.");}
      if(form.id==="chronicle-form"){await runChronicleOperation(target,async()=>{const v=formObject(form);const payload=chronicleEmbeddingConfigPayload(v);if(payload.enabled===true&&!payload.providerProfileId)throw new Error("Choose an eligible embedding provider before enabling Semantic Retrieval.");const saved=record(await campaignApi.put(campaign!.id,"/memory/embedding-config",payload));chronicleConfig=saved;if(saved.enabled===true&&!saved.jobId)throw new Error("Semantic Retrieval was enabled, but indexing did not return a job identifier.");if(saved.jobId)await monitorAndRefreshChronicle(saved.jobId, "Semantic Retrieval indexing");else{await refreshChronicleMetrics(target);message("Semantic Retrieval disabled. Chronicle local lexical retrieval and retained rollback embeddings remain available.");}});}
      if(form.id==="illustrations-form"){const v=formObject(form);await campaignApi.put(campaign.id,"/illustration-config",{...v,providerProfileId:v.providerProfileId||null,repetitionWindow:Number(v.repetitionWindow),maxAttempts:Number(v.maxAttempts),segmentWordCount:Number(v.segmentWordCount),imagesPerSegment:Number(v.imagesPerSegment)});message("Illustration settings saved.");}
      if(form.id==="migration-form"){if(!confirmAction("Migrate this campaign to the selected published world version?"))return;await campaignApi.post(campaign.id,"/migrate-world",formObject(form));message("Campaign world version migrated.");}
      if(form.id==="transfer-form"){if(!transferPreview)throw new Error("Preview compatibility before transferring this campaign.");if(!confirmAction("Transfer this campaign while preserving its character, state, and accepted history?"))return;await campaignApi.post(campaign.id,"/transfer-world",{...formObject(form),idempotencyKey:crypto.randomUUID(),expectedActiveTurnNumber:transferPreview.expectedActiveTurnNumber,expectedStateRevision:transferPreview.expectedStateRevision,sourceFingerprint:transferPreview.sourceFingerprint,note:"Explicit cross-world transfer from the Complete Campaign Editor."});message("Campaign transferred.");}
    }catch(error){const copy=error instanceof Error?error.message:String(error);message(copy,true);if(form.id==="narration-correction-form"){const modalError=form.querySelector<HTMLElement>(".narration-correction-error");if(modalError){modalError.textContent=copy;modalError.hidden=false;}(form.elements.namedItem("narration") as HTMLTextAreaElement | null)?.focus();}}});
    target.addEventListener("click",async(event)=>{const clicked=(event.target as Element).closest<HTMLButtonElement>("button");if(!clicked)return;const dialogId=clicked.dataset.dialogClose;if(dialogId){target.querySelector<HTMLDialogElement>(`#${dialogId}`)?.close();return;}const button=clicked.matches("button[data-action]")?clicked:null;if(!button||!campaign)return;const activeCampaign=campaign;const action=button.dataset.action??"";const article=button.closest<HTMLElement>("article");const feedback=article?.querySelector<HTMLElement>(".turn-feedback");try{await withCampaignActionState(button,actionWorkingLabels[action]??"Working…",async()=>{const campaign=activeCampaign;
      if(action==="preview-context"){const form=button.closest("form") as HTMLFormElement;const v=formObject(form);const q=new URLSearchParams({budgetTokens:v.budgetTokens,compression:v.compression,query:v.query,recentTurns:"8"});const result=await campaignApi.get(campaign.id,`/memory/context-preview?${q}`);root.querySelector("#context-preview")!.textContent=JSON.stringify(result,null,2);}
      if(action==="rebuild-memory"){await runChronicleOperation(target,async()=>{const queued=record(await campaignApi.post(campaign.id,"/memory/reindex"));await monitorAndRefreshChronicle(queued.jobId, "Chronicle rebuild");});}
      if(action==="reindex-embeddings"){await runChronicleOperation(target,async()=>{const queued=record(await campaignApi.post(campaign.id,"/memory/embeddings/reindex"));await monitorAndRefreshChronicle(queued.jobId, "Semantic Retrieval reindex");});}
      if(action==="organize-character"){const form=button.closest("form") as HTMLFormElement;const v=formObject(form);const profile=parseJsonField(form,"profile","Profile");const current=record(await campaignApi.get(campaign.id,"/character-profile"));const result=record(await campaignApi.post(campaign.id,"/character-profile/organize",{expectedRevision:Number(v.revision),character:{id:current.characterId??"campaign-character",name:v.name,characterText:current.legacyCharacterText??"",profile,rpgStats:current.rpgStats??[],defaultTriggers:current.defaultTriggers??[],source:{type:"campaign-character-profile"}}}));if(confirmAction("Apply every evidence-backed profile proposal to this unsaved form? Review the JSON before saving.")){const area=form.elements.namedItem("profile") as HTMLTextAreaElement;area.value=JSON.stringify(result.candidate??profile,null,2);message("AI proposals applied to the unsaved profile. Review and save to persist them.");}}
      if(action==="inspect-turn"){const article=button.closest<HTMLElement>("article")!;const state=record(await campaignApi.get(campaign.id,`/state?turnNumber=${article.dataset.turnNumber}`));const dialog=root.querySelector<HTMLDialogElement>("#turn-state-dialog")!;const heading=dialog.querySelector<HTMLElement>("h3")!;heading.textContent=`Turn ${article.dataset.turnNumber} state`;dialog.querySelector<HTMLElement>(".turn-state-dialog-body")!.innerHTML=campaignStateInspectorMarkup(state);dialog.showModal();heading.focus();}
      if(action==="close-turn-state"){button.closest<HTMLDialogElement>("dialog")?.close();}
      if(action==="edit-narration"){const article=button.closest<HTMLElement>("article")!;const correction=record(await campaignApi.get(campaign.id,`/turns/${article.dataset.turnId}/correction`));const dialog=target.querySelector<HTMLDialogElement>("#narration-correction-dialog")!;const form=dialog.querySelector<HTMLFormElement>("#narration-correction-form")!;const area=form.elements.namedItem("narration") as HTMLTextAreaElement;form.dataset.turnId=String(article.dataset.turnId??"");form.dataset.correctionRevision=String(correction.correctionRevision??0);const heading=dialog.querySelector<HTMLElement>("h3")!;heading.textContent=`Correct turn ${article.dataset.turnNumber} narration`;const modalError=dialog.querySelector<HTMLElement>(".narration-correction-error")!;modalError.textContent="";modalError.hidden=true;area.value=String(correction.effectiveNarration??correction.originalNarration??"");dialog.showModal();heading.focus();}
      if(action==="retry-turn"){const article=button.closest<HTMLElement>("article")!;const original=article.querySelector<HTMLElement>(".turn-action")!.textContent??"";const revised=root.ownerDocument.defaultView?.prompt("Edit the latest turn prompt before retrying:",original);if(revised?.trim()&&confirmAction("Retry and replace the latest accepted turn using this edited prompt?")){await campaignApi.post(campaign.id,"/generations/retry-latest",{action:revised.trim(),requestedInputMode:"action",resolvedInputMode:"action",inputModeSource:"explicit",idempotencyKey:crypto.randomUUID(),context:{budgetTokens:32000,compression:"auto",recentTurns:8},expectedCurrentTurnNumber:campaign.activeTurnNumber});message("Replacement generation queued.");}}
      if(action==="rebuild-turn-images"){const article=button.closest<HTMLElement>("article")!;if(confirmAction(`Rebuild illustration segments for turn ${article.dataset.turnNumber}? Accepted narration will not change.`)){await campaignApi.generalPost(`/api/v1/turns/${encodeURIComponent(article.dataset.turnId??"")}/illustration-segments`,{mode:"rebuild"});message("Turn illustration rebuild queued.");}}
      if(action==="branch-turn"&&confirmAction("Create a separate campaign from this accepted turn?")){const a=button.closest<HTMLElement>("article")!;await campaignApi.post(campaign.id,"/branch",{targetTurnNumber:Number(a.dataset.turnNumber),title:`${campaign.title} branch`,expectedCurrentTurnNumber:campaign.activeTurnNumber});message("Campaign branch created.");}
      if(action==="rewind-turn"&&confirmAction("Rewind this campaign and remove every later accepted turn?")){const a=button.closest<HTMLElement>("article")!;await campaignApi.post(campaign.id,"/rewind",{targetTurnNumber:Number(a.dataset.turnNumber),expectedCurrentTurnNumber:campaign.activeTurnNumber});message("Campaign rewound.");}
      if(action==="backfill-images"||action==="rebuild-images"){const mode=action==="rebuild-images"?"rebuild":"missing";const preview=record(await campaignApi.post(campaign.id,"/illustration-backfill/preview",{mode}));if(confirmAction(`Queue ${text(preview.imageCount??0)} historical image jobs?`))await campaignApi.post(campaign.id,"/illustration-backfill",{mode,idempotencyKey:crypto.randomUUID(),expectedConfigUpdatedAt:preview.configUpdatedAt,expectedTurnCount:preview.totalCampaignTurns});message("Historical illustration work queued.");}
      if(action==="preview-transfer"){const form=button.closest("form") as HTMLFormElement;transferPreview=record(await campaignApi.post(campaign.id,"/transfer-world/preview",formObject(form)));root.querySelector("#transfer-preview")!.textContent=JSON.stringify(transferPreview,null,2);}
      if(action==="archive-campaign"&&confirmAction("Archive this campaign?")){await campaignApi.patch(campaign.id,"",{status:"archived"});message("Campaign archived.");}
      if(action==="delete-campaign"&&confirmAction(`Permanently delete ${campaign.title}? Export it first if recovery may be needed.`)){await campaignApi.delete(campaign.id);root.ownerDocument.defaultView!.location.href="/app/campaigns";}
    });}catch(error){const copy=error instanceof Error?error.message:String(error);message(copy,true);if(feedback){feedback.textContent=copy;feedback.dataset.state="error";}}});
  }
  (route.campaignId?showSection():showList()).catch((error)=>{const main=root.querySelector("#main-content");if(main)main.innerHTML=`<section class="campaign-failure"><h1>Campaign editor unavailable</h1><p>${text(error instanceof Error?error.message:error)}</p><a href="/nexus/#campaigns">Open legacy campaign management</a></section>`;});
  return {dispose(){disposed=true;controller.abort();theme.dispose();}};
}
