import { field, option, record, text, storyMemoryGuidance, storyMemorySettingsMarkup, chronicleMarkup, illustrationsMarkup, type JsonRecord } from "./settings/campaign-fields";
export { chronicleEmbeddingConfigPayload, chronicleMarkup, illustrationsMarkup, semanticRetrievalHealthView } from "./settings/campaign-fields";
import { createCharacterProfileForm } from "./character-profile-form";
import type { CampaignCharacterProfile } from "@infinite-quest/contracts";
import { mountAppShell } from "./app-shell-lifecycle";
import { buildCurrentStateUpdate, createCampaignContinuityDraft, formatChronicleRetrievalAudit, hasCampaignContinuityChanges } from "@infinite-quest/client-core";
import { createStoryMemoryApi } from "@infinite-quest/client-web";
import type { CampaignRuntimeStateResponse, CampaignRuntimeStateUpdate, CampaignSyncStatus, StoryMemorySettings } from "@infinite-quest/contracts";
import { campaignApi, CampaignEditorApiError, loadCampaign, loadCampaigns, type CampaignSummary } from "./campaign-editor-api";
import { CAMPAIGN_SECTIONS, CAMPAIGN_SECTION_LABELS, campaignEditorPath, campaignStateInspectorMarkup, escapeCampaignText, firstNarrationSentence, narrationCorrectionDialogMarkup, withCampaignActionState, type CampaignRoute, type CampaignSection } from "./campaign-editor-model";
import { storyPlayerPath } from "./story-route";
import { createCampaignContinuityEditor, type CampaignContinuityEditor } from "./campaign-continuity-editor";
import type { MountedPage } from "./world-library-page";

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

export function buildRetryLatestGenerationRequest(action: string, idempotencyKey: string, expectedCurrentTurnNumber: number) {
  return {
    action,
    requestedInputMode: "action" as const,
    resolvedInputMode: "action" as const,
    inputModeSource: "explicit" as const,
    idempotencyKey,
    context: { budgetTokens: 32_000, compression: "auto" as const, recentTurns: 8 },
    expectedCurrentTurnNumber
  };
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
  return `<main id="main-content" data-page="campaign-editor" data-section="${section}"><header class="campaign-command-row"><a href="/app/campaigns" class="campaign-back">${svg("m15 18-6-6 6-6")}<span>Back to campaigns</span></a><div class="campaign-identity"><h1>${text(campaign.title)}</h1><span class="campaign-status">${text(campaign.status)}</span><span>Turn ${campaign.activeTurnNumber}</span><span>${text(campaign.worldTitle)} v${campaign.worldVersionNumber}</span></div><a class="campaign-enter-story" href="${storyPlayerPath(campaign.id)}">Enter story ${svg("M7 17 17 7M8 7h9v9")}</a></header><div class="campaign-workspace"><aside class="campaign-spine" aria-label="Campaign editor sections"><div class="campaign-coordinate" aria-hidden="true"><span>Campaign folio</span><strong>${String(campaign.activeTurnNumber).padStart(3, "0")}</strong></div><nav>${nav}<a href="/app/settings?section=campaign&amp;campaignId=${text(campaign.id)}">Campaign settings</a></nav></aside><section class="campaign-leaf"><div id="campaign-message" class="campaign-message" role="status" aria-live="polite"></div><div id="campaign-section" aria-busy="true"><div class="campaign-loading">Loading ${CAMPAIGN_SECTION_LABELS[section]}…</div></div></section></div></main>`;
}

function overviewMarkup(c: CampaignSummary, storyMemorySettings: StoryMemorySettings | null, storyMemoryUnavailable: boolean): string {
  const cost = record(c.costInformation?.[0]);
  const currency = String(cost.currency ?? "USD");
  const metrics = c.costInformation?.length ? [
    [cost.amount, `Total ${currency}`], [cost.textGenerationAmount, "Story text"],
    [cost.imageGenerationAmount, "Illustrations"], [cost.memoryAmount, "Chronicle"]
  ] : [["—", "No provider-reported cost"]];
  return `<header class="campaign-section-heading"><h2>Campaign overview</h2><p>Manage campaign identity and review reported costs.</p></header><form id="overview-form" class="campaign-form"><section><h3>Identity</h3><div class="campaign-field-grid">${field("Campaign title", `<input name="title" maxlength="200" required value="${text(c.title)}">`)}${field("Status", `<select name="status">${option("active", "Active", c.status)}${option("archived", "Archived", c.status)}</select>`)}</div></section><section><h3>Reported provider cost</h3><div class="campaign-metrics">${metrics.map(([value, label]) => `<div><strong>${formatCost(value, currency)}</strong><span>${text(label)}</span></div>`).join("")}</div></section><div class="campaign-action-ledger"><span>Accepted turns and Chronicle memory are unchanged by these settings.</span><button class="primary-action" type="submit">Save campaign</button></div></form>${storyMemorySettingsMarkup(storyMemorySettings, storyMemoryUnavailable)}`;
}

function characterMarkup(value: JsonRecord): string {
  return `<header class="campaign-section-heading"><h2>Character</h2><p>Edit the campaign-local character copy without changing its immutable world-version source.</p></header><form id="character-form" class="campaign-form"><div data-character-profile-fields></div><div class="campaign-action-ledger"><button class="primary-action" type="submit">Save campaign profile</button></div></form>`;
}

function stateMarkup(value: CampaignRuntimeStateResponse, generationLocked = false): string {
  const disabled = generationLocked ? " disabled" : "";
  const generationStatus = generationLocked
    ? '<p class="campaign-error" role="status">Current-state editing is unavailable while a story generation needs attention.</p>'
    : "";
  return `<header class="campaign-section-heading"><h2>Current state</h2><p>Edit only the authoritative current state used by the next accepted turn.</p></header>${generationStatus}<form id="state-form" class="campaign-form" aria-busy="false"><div data-campaign-continuity-editor></div>${field("Trackers — JSON", `<textarea name="trackers" rows="9" spellcheck="false"${disabled}>${text(JSON.stringify(value.trackers ?? [], null, 2))}</textarea>`)}<details><summary>Read-only mechanics and triggers</summary><pre>${text(JSON.stringify({ rpgStats:value.rpgStats,eventTriggers:value.eventTriggers,pendingEventTriggers:value.pendingEventTriggers }, null, 2))}</pre></details><div class="campaign-action-ledger"><span>Historical state remains read-only.</span><button type="button" data-action="reload-current-state"${disabled}>Reload current state</button><button class="primary-action" type="submit"${disabled}>Save current state</button></div></form>`;
}

function chronicleRetrievalAuditMarkup(audit: unknown): string {
  const presentation = formatChronicleRetrievalAudit((audit ?? null) as Parameters<typeof formatChronicleRetrievalAudit>[0]);
  const rows: ReadonlyArray<readonly [string, string]> = [
    ["Search", presentation.searchPath],
    ["Provider", presentation.provider],
    ["Query vector", presentation.queryVector],
    ...(presentation.fallback ? [["Fallback", presentation.fallback] as const] : [])
  ];
  return `<dl class="turn-chronicle-audit" aria-label="Chronicle retrieval">${rows.map(([label, detail]) => `<div><dt>${text(label)}</dt><dd>${text(detail)}</dd></div>`).join("")}</dl>`;
}

export function historyMarkup(value: JsonRecord, campaign: CampaignSummary): string {
  const turns = Array.isArray(value.turns) ? value.turns.map(record) : [];
  return `<header class="campaign-section-heading"><h2>History</h2><p>Scan every accepted prompt and its opening story sentence. Read complete turns in Story.</p></header><div class="turn-ledger">${turns.length ? turns.map((turn)=>`<article data-turn-id="${text(turn.id)}" data-turn-number="${text(turn.turnNumber)}"><header><h3>Turn ${text(turn.turnNumber)}</h3><time datetime="${text(turn.acceptedAt)}" title="${text(turn.acceptedAt)}">${text(String(turn.acceptedAt ?? "").slice(0,10))}</time></header><div class="turn-content"><p class="turn-action"><span>Prompt</span>${text(turn.action)}</p><p class="turn-narration">${text(firstNarrationSentence(turn.narration))}</p>${chronicleRetrievalAuditMarkup(turn.chronicleRetrieval)}<div class="turn-row-actions"><a href="${storyPlayerPath(String(value.campaignId ?? ""), Number(turn.turnNumber))}">Open in story</a><details class="turn-operations"><summary>Manage turn</summary><div class="turn-actions"><button type="button" data-action="inspect-turn">Inspect state</button><button type="button" data-action="edit-narration">Edit narration</button>${Number(turn.turnNumber)===campaign.activeTurnNumber?`<button type="button" data-action="retry-turn">Retry edited prompt</button>`:""}<button type="button" data-action="rebuild-turn-images">Rebuild illustrations</button><button type="button" data-action="branch-turn">Branch</button><button type="button" data-action="rewind-turn">Rewind</button></div></details></div><p class="turn-feedback" role="status" aria-live="polite"></p></div></article>`).join("") : `<p class="campaign-empty">No accepted turns yet.</p>`}</div><dialog id="turn-state-dialog" class="turn-state-dialog" aria-labelledby="turn-state-title"><header><h3 id="turn-state-title" tabindex="-1">Turn state</h3><button type="button" data-action="close-turn-state" aria-label="Close turn state">Close</button></header><div class="turn-state-dialog-body"></div></dialog>${narrationCorrectionDialogMarkup()}`;
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

function worldTransferMarkup(c: CampaignSummary, world: JsonRecord, targets: TransferTarget[]): string {
  const versions = Array.isArray(world.versions) ? world.versions.map(record) : [];
  return `<header class="campaign-section-heading"><h2>World & transfer</h2><p>Accepted turns remain append-only when the campaign changes its immutable world reference.</p></header><section class="campaign-reference"><h3>Pinned world</h3><strong>${text(c.worldTitle)} · Version ${c.worldVersionNumber}</strong><p>${c.worldUpdateAvailable ? `Version ${c.latestWorldVersionNumber} is available.` : "This campaign uses the latest published version."}</p></section><form id="migration-form" class="campaign-form">${field("Migrate to published version", `<select name="worldVersionId">${versions.map(v=>option(String(v.id),`Version ${v.versionNumber}`,c.worldVersionId)).join("")}</select>`)}${field("Migration note", `<textarea name="note" rows="4"></textarea>`)}<button class="primary-action" type="submit">Migrate version</button></form><form id="transfer-form" class="campaign-form"><h3>Transfer to another world</h3><div class="campaign-field-grid">${field("Target published world version", `<select name="targetWorldVersionId" required>${option("",targets.length ? "Choose a world" : "No other published worlds available","")}${targets.map(target=>option(target.id,target.label,"")).join("")}</select>`)}${field("New campaign title", `<input name="title" value="${text(c.title)}" required>`)}</div><input type="hidden" name="characterStrategy" value="preserve_source"><input type="hidden" name="stateStrategy" value="preserve"><input type="hidden" name="targetDefaultsPolicy" value="retain_source"><pre id="transfer-preview">Preview compatibility before transfer.</pre><div class="campaign-action-ledger"><button type="button" data-action="preview-transfer"${targets.length ? "" : " disabled"}>Preview transfer</button><button class="primary-action" type="submit"${targets.length ? "" : " disabled"}>Transfer campaign</button></div></form>`;
}

function dataMarkup(c: CampaignSummary): string { return `<header class="campaign-section-heading"><h2>Campaign data</h2><p>Export portable records or perform explicit lifecycle operations.</p></header><div class="campaign-data-actions"><a href="/api/v1/campaigns/${text(c.id)}/export">Export Campaign Archive</a><a href="/api/v1/campaigns/${text(c.id)}/readable-export">Export readable story</a><button data-action="archive-campaign">Archive campaign</button></div><section class="campaign-danger"><h3>Delete campaign</h3><p>Deletes this campaign and its owned operational records. Export first if the record must be recoverable.</p><button data-action="delete-campaign">Delete campaign</button></section>`; }

function formObject(form: HTMLFormElement): Record<string,string> { return Object.fromEntries(new FormData(form).entries()) as Record<string,string>; }
function parseJsonField(form: HTMLFormElement, name: string, label: string): unknown {
  const control = (form.elements?.namedItem(name) ?? form.querySelector(`[name="${name}"]`)) as HTMLTextAreaElement | null;
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
  let shell = mountAppShell(root, route.campaignId ? `<main id="main-content"><p class="campaign-loading">Loading campaign…</p></main>` : campaignListMarkup(), "campaigns"); const controller = new AbortController(); const storyMemoryApi = createStoryMemoryApi(); let disposed = false; let campaign: CampaignSummary | null = null; let storyMemorySettings: StoryMemorySettings | null = null; let storyMemoryUnavailable = false; let transferPreview: JsonRecord | null = null; let chronicleConfig: JsonRecord = {}; let chronicleOperationActive = false; let stateBase: CampaignRuntimeStateResponse | null = null; let continuityEditor: CampaignContinuityEditor | null = null; let stateGenerationLocked = false; let stateConflictLocked = false; let stateReloadInFlight = false; let stateSaveInFlight = false; let stateSessionId = 0; let profileForm: ReturnType<typeof createCharacterProfileForm> | null = null;
  const setStateFormBusy = (form: HTMLFormElement, busy: boolean) => {
    form.setAttribute("aria-busy", String(busy));
    form.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement | HTMLInputElement | HTMLSelectElement>("button, textarea, input, select")
      .forEach((control) => {
        const reload = control.matches("button[data-action='reload-current-state']");
        control.disabled = busy || stateGenerationLocked || (stateConflictLocked && !reload);
      });
  };
  const message = (copy: string, error = false) => { const el=root.querySelector<HTMLElement>("#campaign-message"); if(el){el.textContent=copy;el.dataset.state=error?"error":"success";} };
  const confirmAction = (copy: string) => root.ownerDocument.defaultView?.confirm(copy) ?? false;
  const hasCurrentStateDraftChanges = (form: HTMLFormElement) => {
    if (!stateBase || !continuityEditor) return false;
    if (hasCampaignContinuityChanges(stateBase, continuityEditor.readDraft())) return true;
    const trackers = form.querySelector<HTMLTextAreaElement>("textarea[name='trackers']");
    return (trackers?.value ?? "") !== JSON.stringify(stateBase.trackers ?? [], null, 2);
  };
  const loadCurrentState = async (): Promise<[CampaignRuntimeStateResponse, CampaignSyncStatus]> => {
    if (!campaign) throw new Error("Campaign is unavailable.");
    return Promise.all([
      campaignApi.get<CampaignRuntimeStateResponse>(campaign.id, "/state", controller.signal),
      campaignApi.get<CampaignSyncStatus>(campaign.id, "/sync-status", controller.signal)
    ]);
  };
  const replaceCurrentStateEditor = (target: HTMLElement, loadedState: CampaignRuntimeStateResponse, sync: CampaignSyncStatus) => {
    stateBase = loadedState;
    stateGenerationLocked = Boolean(sync.pendingGeneration || sync.generationRecovery);
    stateConflictLocked = false;
    stateReloadInFlight = false;
    stateSaveInFlight = false;
    stateSessionId += 1;
    continuityEditor?.dispose();
    continuityEditor = createCampaignContinuityEditor(root.ownerDocument, createCampaignContinuityDraft(loadedState), { idPrefix: "campaign-current-state", onChange: () => undefined });
    continuityEditor.setDisabled(stateGenerationLocked);
    target.innerHTML = stateMarkup(loadedState, stateGenerationLocked);
    target.querySelector("[data-campaign-continuity-editor]")?.append(continuityEditor.element);
  };
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
    refreshChronicleStatusProjection(target, chronicleMarkup(metrics,chronicleConfig,[],null,true));
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
    if (!route.campaignId) return; campaign=await loadCampaign(route.campaignId,controller.signal); if(disposed)return; shell.dispose(); shell=mountAppShell(root,shellMarkup(campaign,route.section),"campaigns"); const target=root.querySelector<HTMLElement>("#campaign-section")!;
    if (route.section === "overview") {
      const memory = await storyMemoryApi.get(campaign.id, controller.signal).catch(() => null);
      if (disposed) return;
      storyMemorySettings = memory;
      storyMemoryUnavailable = !memory;
      target.innerHTML = overviewMarkup(campaign, memory, !memory);
    }
    else if(route.section==="character") { const profile = await campaignApi.get<CampaignCharacterProfile & { revision: number }>(campaign.id,"/character-profile",controller.signal); if (disposed) return; target.innerHTML=characterMarkup(record(profile)); profileForm=createCharacterProfileForm(target.querySelector<HTMLElement>("[data-character-profile-fields]")!, profile); }
    else if(route.section==="state") { const [loadedState,sync]=await loadCurrentState(); if(disposed)return; replaceCurrentStateEditor(target,loadedState,sync); }
    else if(route.section==="history") target.innerHTML=historyMarkup(record(await campaignApi.get(campaign.id,"/turns?limit=100",controller.signal)),campaign);
    else if (route.section === "chronicle") {
      const [metrics, config] = await Promise.all([campaignApi.get<JsonRecord>(campaign.id,"/memory/metrics",controller.signal), campaignApi.get<JsonRecord>(campaign.id,"/memory/embedding-config",controller.signal)]);
      if (disposed) return;
      chronicleConfig = config;
      target.innerHTML = chronicleMarkup(metrics, config, [], null, true);
    }
    else if (route.section === "illustrations") target.innerHTML = illustrationsMarkup({},[],true);
    else if(route.section==="world-transfer") { const [world,response]=await Promise.all([campaignApi.general(`/api/v1/worlds/${encodeURIComponent(campaign.worldId)}`,controller.signal),campaignApi.general("/api/v1/worlds",controller.signal)]);const worlds=record(response).worlds;const targets=(Array.isArray(worlds)?worlds:[]).map(record).filter((candidate)=>candidate.id!==campaign!.worldId&&typeof candidate.latestVersionId==="string").map((candidate)=>({id:String(candidate.latestVersionId),label:`${String(candidate.title)} · Version ${String(candidate.latestVersionNumber)}`}));target.innerHTML=worldTransferMarkup(campaign,record(world),targets); }
    else target.innerHTML=dataMarkup(campaign); target.setAttribute("aria-busy","false"); bindActions(target);
  }
  function bindActions(target: HTMLElement): void {
    if (campaign && ["overview","chronicle","illustrations"].includes(route.section)) {
      const group = route.section === "overview" ? "story" : route.section;
      const link = root.ownerDocument.createElement("a");
      link.dataset.campaignSettingsGroup = group;
      const params = new URLSearchParams({section:"campaign",campaignId:campaign.id,returnTo:campaignEditorPath(campaign.id,route.section)});
      link.href = "/app/settings?" + params + "#" + group;
      link.textContent = "Open " + (group === "story" ? "Story behavior" : group === "chronicle" ? "Chronicle" : "illustration") + " settings";
      target.prepend(link);
    }
    target.querySelector<HTMLSelectElement>("select[name='storyMemoryLevel']")?.addEventListener("change", (event) => {
      const select = event.target as HTMLSelectElement;
      const checkbox = target.querySelector<HTMLInputElement>("input[name='continuityReviewEnabled']");
      if (checkbox) { checkbox.disabled = select.value !== "max"; if (checkbox.disabled) checkbox.checked = false; }
    });
    target.addEventListener("submit",async(event)=>{event.preventDefault();if(!campaign)return;const form=event.target as HTMLFormElement;try{
      if(form.id==="narration-correction-form"){const dialog=form.closest<HTMLDialogElement>("dialog")!;const error=dialog.querySelector<HTMLElement>(".narration-correction-error")!;const narration=(form.elements.namedItem("narration") as HTMLTextAreaElement).value.trim();if(!narration){error.textContent="Enter the corrected narration before saving.";error.hidden=false;(form.elements.namedItem("narration") as HTMLTextAreaElement).focus();return;}const submit=form.querySelector<HTMLButtonElement>('button[type="submit"]')!;await withCampaignActionState(submit,"Saving correction…",async()=>campaignApi.patch(campaign!.id,`/turns/${encodeURIComponent(form.dataset.turnId??"")}/correction`,{narration,expectedCorrectionRevision:Number(form.dataset.correctionRevision??0),expectedActiveTurnNumber:campaign!.activeTurnNumber,source:"user_edit"}));const article=Array.from(target.querySelectorAll<HTMLElement>("article[data-turn-id]")).find((candidate)=>candidate.dataset.turnId===form.dataset.turnId);const feedback=article?.querySelector<HTMLElement>(".turn-feedback");dialog.close();message("Accepted narration corrected; dependent Chronicle context was rebuilt.");if(feedback){feedback.textContent="Narration saved. Chronicle context was rebuilt.";delete feedback.dataset.state;}return;}
      if (form.id === "overview-form") {
        const {title,status} = formObject(form);
        await campaignApi.saveSettings(campaign.id,"behavior",{title,status},controller.signal);
        if (!disposed) message("Campaign settings saved.");
      }
      if (form.id === "memory-settings-form") {
        const select = form.querySelector<HTMLSelectElement>("select[name='storyMemoryLevel']");
        const checkbox = form.querySelector<HTMLInputElement>("input[name='continuityReviewEnabled']");
        if (!select || !checkbox) throw new Error("Campaign memory settings need to be reloaded before saving.");
        const submit = form.querySelector<HTMLButtonElement>("button[type='submit']");
        const enabled = select.value === "max" && checkbox.checked;
        select.disabled = checkbox.disabled = true;
        if (submit) submit.disabled = true;
        form.setAttribute("aria-busy", "true");
        try {
          const saved = await storyMemoryApi.update(campaign.id, { level: select.value as StoryMemorySettings["level"], continuityReviewEnabled: enabled }, controller.signal);
          if (disposed || campaign.id !== route.campaignId) return;
          storyMemorySettings = saved; storyMemoryUnavailable = false;
          checkbox.checked = saved.reviewMode !== "off";
          const guidance = form.querySelector<HTMLElement>("[data-story-memory-guidance]");
          if (guidance) guidance.textContent = storyMemoryGuidance(saved);
          for (const candidate of select.options) {
            candidate.disabled = !saved.availableLevels.includes(candidate.value as StoryMemorySettings["level"]);
            candidate.selected = candidate.value === saved.level;
          }
          message("Campaign memory level saved.");
        } finally {
          if (!disposed) {
            select.disabled = storyMemoryUnavailable;
            checkbox.disabled = storyMemoryUnavailable || select.value !== "max";
            if (submit) submit.disabled = storyMemoryUnavailable;
            form.setAttribute("aria-busy", "false");
          }
        }
      }
      if(form.id==="character-form"){if(!profileForm)throw new Error("Profile unavailable.");const saved=await campaignApi.put<CampaignCharacterProfile & { revision: number }>(campaign.id,"/character-profile",profileForm.update());const fields=target.querySelector<HTMLElement>("[data-character-profile-fields]")!;fields.replaceChildren();profileForm=createCharacterProfileForm(fields,saved);message("Campaign character profile saved.");}
      if(form.id==="state-form"){if(stateSaveInFlight||stateReloadInFlight)return;if(stateGenerationLocked)throw new Error("Current-state editing is unavailable while a story generation needs attention.");if(stateConflictLocked)throw new Error("Current state changed while you were editing. Reload before saving; your draft is still available.");const base=stateBase;const editor=continuityEditor;if(!base||!editor)throw new Error("Current campaign state is unavailable. Reload before saving.");const sessionId=stateSessionId;const trackers=parseJsonField(form,"trackers","Trackers") as CampaignRuntimeStateUpdate["trackers"];const request=buildCurrentStateUpdate(base,editor.readDraft(),{trackers});stateSaveInFlight=true;setStateFormBusy(form,true);editor.setDisabled(true);try{const saved=await campaignApi.patch<CampaignRuntimeStateResponse>(campaign.id,"/state",request);if(disposed||sessionId!==stateSessionId||stateBase!==base||continuityEditor!==editor)return;stateBase=saved;editor.dispose();continuityEditor=createCampaignContinuityEditor(root.ownerDocument,createCampaignContinuityDraft(saved),{idPrefix:"campaign-current-state",onChange:()=>undefined});target.querySelector("[data-campaign-continuity-editor]")?.replaceChildren(continuityEditor.element);message("Current campaign state saved.");}catch(error){if(error instanceof CampaignEditorApiError&&error.status===409)stateConflictLocked=true;throw error;}finally{if(!disposed&&sessionId===stateSessionId){stateSaveInFlight=false;setStateFormBusy(form,false);if(continuityEditor===editor)editor.setDisabled(stateGenerationLocked||stateConflictLocked);}}}
      if(form.id==="migration-form"){if(!confirmAction("Migrate this campaign to the selected published world version?"))return;await campaignApi.post(campaign.id,"/migrate-world",formObject(form));message("Campaign world version migrated.");}
      if(form.id==="transfer-form"){if(!transferPreview)throw new Error("Preview compatibility before transferring this campaign.");if(!confirmAction("Transfer this campaign while preserving its character, state, and accepted history?"))return;await campaignApi.post(campaign.id,"/transfer-world",{...formObject(form),idempotencyKey:crypto.randomUUID(),expectedActiveTurnNumber:transferPreview.expectedActiveTurnNumber,expectedStateRevision:transferPreview.expectedStateRevision,sourceFingerprint:transferPreview.sourceFingerprint,note:"Explicit cross-world transfer from the Complete Campaign Editor."});message("Campaign transferred.");}
    }catch(error){const copy=form.id==="state-form"&&error instanceof CampaignEditorApiError&&error.status===409?"Current state changed while you were editing. Reload before saving; your draft is still available.":error instanceof Error?error.message:String(error);message(copy,true);if(form.id==="narration-correction-form"){const modalError=form.querySelector<HTMLElement>(".narration-correction-error");if(modalError){modalError.textContent=copy;modalError.hidden=false;}(form.elements.namedItem("narration") as HTMLTextAreaElement | null)?.focus();}}});
    target.addEventListener("click",async(event)=>{const clicked=(event.target as Element).closest<HTMLButtonElement>("button");if(!clicked)return;const dialogId=clicked.dataset.dialogClose;if(dialogId){target.querySelector<HTMLDialogElement>(`#${dialogId}`)?.close();return;}const button=clicked.matches("button[data-action]")?clicked:null;if(!button||!campaign)return;const activeCampaign=campaign;const action=button.dataset.action??"";const article=button.closest<HTMLElement>("article");const feedback=article?.querySelector<HTMLElement>(".turn-feedback");try{await withCampaignActionState(button,actionWorkingLabels[action]??"Working…",async()=>{const campaign=activeCampaign;
      if(action==="reload-current-state"){const form=button.closest<HTMLFormElement>("#state-form");if(stateSaveInFlight||stateReloadInFlight||stateGenerationLocked||!form)return;if(hasCurrentStateDraftChanges(form)&&!confirmAction("Discard unsaved current state changes and reload?"))return;const sessionId=stateSessionId;const base=stateBase;const editor=continuityEditor;if(!base||!editor)return;stateReloadInFlight=true;setStateFormBusy(form,true);editor.setDisabled(true);try{const [loadedState,sync]=await loadCurrentState();if(disposed||sessionId!==stateSessionId||stateBase!==base||continuityEditor!==editor)return;replaceCurrentStateEditor(target,loadedState,sync);message("Current campaign state reloaded.");}finally{if(!disposed&&sessionId===stateSessionId&&stateBase===base&&continuityEditor===editor){stateReloadInFlight=false;setStateFormBusy(form,false);editor.setDisabled(stateGenerationLocked||stateConflictLocked);}}return;}
      if(action==="preview-context"){const form=button.closest("form") as HTMLFormElement;const v=formObject(form);const q=new URLSearchParams({budgetTokens:v.budgetTokens,compression:v.compression,query:v.query,recentTurns:"8"});const result=await campaignApi.get(campaign.id,`/memory/context-preview?${q}`);root.querySelector("#context-preview")!.textContent=JSON.stringify(result,null,2);}
      if(action==="rebuild-memory"){await runChronicleOperation(target,async()=>{const queued=record(await campaignApi.post(campaign.id,"/memory/reindex"));await monitorAndRefreshChronicle(queued.jobId, "Chronicle rebuild");});}
      if(action==="reindex-embeddings"){await runChronicleOperation(target,async()=>{const queued=record(await campaignApi.post(campaign.id,"/memory/embeddings/reindex"));await monitorAndRefreshChronicle(queued.jobId, "Semantic Retrieval reindex");});}
      if(action==="organize-character"){const form=button.closest("form") as HTMLFormElement;const v=formObject(form);const profile=parseJsonField(form,"profile","Profile");const current=record(await campaignApi.get(campaign.id,"/character-profile"));const result=record(await campaignApi.post(campaign.id,"/character-profile/organize",{expectedRevision:Number(v.revision),character:{id:current.characterId??"campaign-character",name:v.name,characterText:current.legacyCharacterText??"",profile,rpgStats:current.rpgStats??[],defaultTriggers:current.defaultTriggers??[],source:{type:"campaign-character-profile"}}}));if(confirmAction("Apply every evidence-backed profile proposal to this unsaved form? Review the JSON before saving.")){const area=form.elements.namedItem("profile") as HTMLTextAreaElement;area.value=JSON.stringify(result.candidate??profile,null,2);message("AI proposals applied to the unsaved profile. Review and save to persist them.");}}
      if(action==="inspect-turn"){const article=button.closest<HTMLElement>("article")!;const state=record(await campaignApi.get(campaign.id,`/state?turnNumber=${article.dataset.turnNumber}`));const dialog=root.querySelector<HTMLDialogElement>("#turn-state-dialog")!;const heading=dialog.querySelector<HTMLElement>("h3")!;heading.textContent=`Turn ${article.dataset.turnNumber} state`;dialog.querySelector<HTMLElement>(".turn-state-dialog-body")!.innerHTML=campaignStateInspectorMarkup(state);dialog.showModal();heading.focus();}
      if(action==="close-turn-state"){button.closest<HTMLDialogElement>("dialog")?.close();}
      if(action==="edit-narration"){const article=button.closest<HTMLElement>("article")!;const correction=record(await campaignApi.get(campaign.id,`/turns/${article.dataset.turnId}/correction`));const dialog=target.querySelector<HTMLDialogElement>("#narration-correction-dialog")!;const form=dialog.querySelector<HTMLFormElement>("#narration-correction-form")!;const area=form.elements.namedItem("narration") as HTMLTextAreaElement;form.dataset.turnId=String(article.dataset.turnId??"");form.dataset.correctionRevision=String(correction.correctionRevision??0);const heading=dialog.querySelector<HTMLElement>("h3")!;heading.textContent=`Correct turn ${article.dataset.turnNumber} narration`;const modalError=dialog.querySelector<HTMLElement>(".narration-correction-error")!;modalError.textContent="";modalError.hidden=true;area.value=String(correction.effectiveNarration??correction.originalNarration??"");dialog.showModal();heading.focus();}
      if(action==="retry-turn"){const article=button.closest<HTMLElement>("article")!;const original=article.querySelector<HTMLElement>(".turn-action")!.textContent??"";const revised=root.ownerDocument.defaultView?.prompt("Edit the latest turn prompt before retrying:",original);if(revised?.trim()&&confirmAction("Retry and replace the latest accepted turn using this edited prompt?")){await campaignApi.post(campaign.id,"/generations/retry-latest",buildRetryLatestGenerationRequest(revised.trim(),crypto.randomUUID(),campaign.activeTurnNumber));message("Replacement generation queued.");}}
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
  const win = root.ownerDocument.defaultView;
  function dispose() {
    if (disposed) return;
    disposed = true;
    controller.abort();
    continuityEditor?.dispose();
    shell.dispose();
    win?.removeEventListener("app-identity-changed", identityChanged);
  }
  function identityChanged() {
    dispose();
    root.replaceChildren();
    const notice = root.ownerDocument.createElement("p");
    notice.textContent = "Your account changed. Reload the campaign editor to continue.";
    root.append(notice);
  }
  win?.addEventListener("app-identity-changed", identityChanged);
  return {dispose};
}
