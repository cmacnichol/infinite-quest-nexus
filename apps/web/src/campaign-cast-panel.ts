import { showLifecycle } from "./character-editor/cast-lifecycle.js";
import { createStoryDraftReview } from "./character-editor/story-draft.js";
import { renderPresetFields } from "./character-editor/preset-fields.js";
import { renderWorldCastPicker } from "./character-editor/world-cast-picker.js";
import { castNarratorNotice, buildPresetRequest, changePresetField, createPresetDraft, presetField, presetFields, SUPPORTING_FIELDS, type PresetDraft } from "@infinite-quest/client-core";
import { createCastTextField, listTextareaLimit, renderSupportingEditorFields } from "./character-editor/renderer.js";
import { renderCastReview } from "./cast-review-queue.js";
import { buildCharacterSheet, canSaveCastEditor, createCastEditor, changeCastEditor, setCastEditorField, prepareCastSubmission,
  failCastSubmission, reapplyCastDraft, reapplyNewCastDraft, characterProvenanceLabel, recentFilterLabel, type CastEditorState } from "@infinite-quest/client-core";
import { buildReviewQueue, createCharactersWorkspaceSession, type CampaignCastApi } from "@infinite-quest/client-web";
import type { CampaignCharacterProfile, CharacterFilter, CastDetail, CastDiscoveryStatus, CastField, CastCandidateList, ResolveCastCandidate, CreateCastCharacter, EditCastCharacter } from "@infinite-quest/contracts";
import { normalizeCastAlias } from "@infinite-quest/contracts";
import { castScanRecovery, renderLegacyCastScan } from "./campaign-cast-scan-panel.js";

const fields = SUPPORTING_FIELDS.map(field => [field.path as CastField, field.label] as const);
export function mainProfileSourceLabel(profile: { inheritedFromSnapshot?: boolean; storedProfile?: unknown } | null): string {
  if (profile?.inheritedFromSnapshot === true) return "World snapshot";
  if (profile?.storedProfile != null) return "Campaign profile";
  return "Source unavailable";
}
type List = Awaited<ReturnType<CampaignCastApi["list"]>>;
export function createLegacyCastPanel(options: {
  api: Omit<CampaignCastApi, "worldChoices" | "scans" | "sourceTurn" | "fromWorld" | "fromWorldPreview" | "editAuthoredProfile" | "draftPreview" | "lifecycle"> & Partial<Pick<CampaignCastApi, "worldChoices" | "scans" | "sourceTurn" | "fromWorld" | "fromWorldPreview" | "editAuthoredProfile" | "draftPreview" | "lifecycle">>; campaignId(): string | null; generationActive(): boolean;
  campaignPage?: boolean;
  checkLock?(campaign: string): Promise<boolean>;
  getProfile?(campaign: string): Promise<CampaignCharacterProfile & { revision: number; inheritedFromSnapshot?: boolean; storedProfile?: unknown }>;
  openProtagonist(onClose?: (saved: boolean) => void): void; navigateToTurn(turn: number): Promise<void>;
}) {
  const dialog = document.createElement("dialog");
  dialog.id = "campaignCastDialog"; dialog.className = "cast-dialog";
  dialog.setAttribute("aria-labelledby", "cast-title"); document.body.append(dialog);
  let campaign = "", epoch = 0, editor: CastEditorState | null = null, list: List | null = null;
  let enabled = false, query = "", filter: CharacterFilter = "all", latest: CastDetail | null = null, returnFocus: HTMLElement | null = null;
  const storyReview = createStoryDraftReview();
  let preset: PresetDraft | null = null;
  let lockedByServer = false, editingForm = false, saving = false;
  let lockCheck = 0;
  let lockPoll: ReturnType<typeof setInterval> | undefined;
  const locked = () => lockedByServer || options.generationActive();
  const dirty = () => Boolean(editor?.dirty || preset && (preset.changes.size || preset.pinned !== preset.detail.character.pinned || preset.ignored !== preset.detail.character.ignored));
  async function syncLock() {
    if (!options.checkLock) return !locked();
    const token = epoch, check = ++lockCheck;
    let active: boolean;
    try { active = await options.checkLock(campaign); } catch { active = true; }
    if (!current(token) || check !== lockCheck || !dialog.open) return false;
    const changed = lockedByServer !== active;
    lockedByServer = active;
    if (changed && editingForm && !saving) renderEditor();
    return !locked();
  }
  function showEditorLock() {
    status("Finish or resolve the current generation before editing characters. Your draft is preserved.");
    if (options.campaignPage) dialog.append(button("Check generation status", () => { void syncLock(); }));
  }
  let latestRoster: List | null = null;
  let discovery: CastDiscoveryStatus | null = null;
  let narratorState: import("@infinite-quest/contracts").CastNarratorState | undefined;
  let recovery: Awaited<ReturnType<CampaignCastApi["workspaceStatus"]>>["recovery"];
  let rosterVisible = false; let autoMatch: boolean | null = null;
  let attention: { identities: number | null; details: number | null; conflicts: number | null } | null = null;
  function attentionSummary() {
    if (!attention) return "Attention counts are unavailable.";
    return `Attention — identity matches: ${attention.identities ?? "unavailable"} · details: ${attention.details ?? "unavailable"} · conflicts: ${attention.conflicts ?? "unavailable"}`;
  }
  const workspace = createCharactersWorkspaceSession<CastEditorState>({ api: options.api, onChange(next) {
    if (!dialog.open || next.campaignId !== campaign) return;
    attention = next.status?.counts ?? null; autoMatch = next.status?.capabilities.autoMatch ?? null;
    const notice = dialog.querySelector<HTMLElement>("[data-cast-attention]");
    if (notice) notice.textContent = attentionSummary();
    if (editor?.dirty && next.changedWhileEditing && !dialog.querySelector("[data-cast-stale]")) {
      const warning = node("p", "This character changed while you were editing. Your draft is preserved. Compare the latest version before saving."); warning.dataset.castStale = ""; dialog.prepend(warning);
    }
    if (rosterVisible && list && next.status && next.status.revision !== list.revision) void loadRoster();
  } });
  let scanData: Awaited<ReturnType<CampaignCastApi["scans"]["latest"]>> | null = null;
  const operationKeys = new Map<string, string>();
  function operationKey(operation: string, payload: unknown) { const key = `${operation}:${JSON.stringify(payload)}`; let id = operationKeys.get(key); if (!id) { id = crypto.randomUUID(); operationKeys.set(key, id); } return id; }
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "") => {
    const result = document.createElement(tag); result.textContent = text; return result;
  };
  function button(text: string, action: () => void, disabled = false) {
    const result = node("button", text); result.type = "button"; result.disabled = disabled;
    result.addEventListener("click", action); return result;
  }
  function closePanel() {
    storyReview.reset(); epoch++; clearInterval(lockPoll); preset = null; editor = null; workspace.close(); operationKeys.clear(); dialog.close(); returnFocus?.focus();
  }
  function requestNavigation(action: () => void) {
    if (saving || editor?.saving || dialog.querySelector("[data-cast-confirm]")) return;
    if (!dirty()) { action(); return; }
    const previous = document.activeElement as HTMLElement | null;
    const prompt = node("section"); prompt.dataset.castConfirm = ""; prompt.setAttribute("role", "alertdialog"); prompt.setAttribute("aria-modal", "true"); prompt.setAttribute("aria-label", "Unsaved character changes");
    prompt.className = "cast-unsaved-confirm";
    prompt.append(node("p", "Save changes before leaving this character?"));
    const background = [...dialog.children] as HTMLElement[];
    for (const child of background) child.setAttribute("inert", "");
    const dismiss = () => { prompt.remove(); for (const child of background) child.removeAttribute("inert"); };
    const keep = button("Keep editing", () => { dismiss(); previous?.focus(); });
    const discard = button("Discard changes", () => { dismiss(); editor = null; preset = null; action(); });
    const save = button("Save changes", () => { dismiss(); void saveDraft(action); }, !enabled || locked() || (!preset && (!editor || !canSaveCastEditor(editor) || Boolean(dialog.querySelector<HTMLButtonElement>("#cast-save")?.disabled))));
    prompt.addEventListener("keydown", event => {
      if (event.key !== "Tab") return;
      const choices = [keep, discard, save].filter(item => !item.disabled);
      const index = choices.indexOf(document.activeElement as HTMLButtonElement);
      event.preventDefault(); choices[(index + (event.shiftKey ? choices.length - 1 : 1)) % choices.length]!.focus();
    });
    prompt.append(keep, discard, save); dialog.append(prompt); keep.focus();
  }
  function requestClose() { requestNavigation(closePanel); }
  function shell(title: string) {
    editingForm = false;
    dialog.classList.remove("cast-sheet-layout"); dialog.replaceChildren();
    const heading = node("header"); heading.className = "cast-heading";
    const h = node("h2", title); h.id = "cast-title";
    heading.append(h, button("Close", requestClose)); dialog.append(heading);
  }
  function status(message: string) {
    const p = node("p", message); p.setAttribute("role", "status"); dialog.append(p); return p;
  }
  const current = (token: number) => token === epoch && campaign === options.campaignId();
  async function loadRoster(cursor?: string, notice?: string) {
    storyReview.reset();
    const token = ++epoch; preset = null; editor = null; latest = null; latestRoster = null; rosterVisible = true;
    shell("Characters"); status("Loading characters…");
    try {
      const [rosterResult, discoveryResult, scanResult, workspaceResult] = await Promise.allSettled([
        options.api.list(campaign, { query, filter, ...(cursor ? { cursor } : {}) }), options.api.discoveryStatus(campaign),
        options.api.scans?.latest(campaign) ?? Promise.resolve(null), options.api.workspaceStatus(campaign)
      ]);
      if (!current(token)) return;
      if (rosterResult.status === "rejected") throw rosterResult.reason;
      const response = rosterResult.value;
      discovery = discoveryResult.status === "fulfilled" ? discoveryResult.value : null;
      if (workspaceResult.status === "fulfilled") {
        attention = workspaceResult.value.counts;
        autoMatch = workspaceResult.value.capabilities.autoMatch;
      }
      narratorState = workspaceResult.status === "fulfilled" ? workspaceResult.value.narratorState : undefined;
      recovery = workspaceResult.status === "fulfilled" ? workspaceResult.value.recovery : undefined;
      scanData = scanResult.status === "fulfilled" ? scanResult.value : null;
      list = cursor && list ? { ...response, characters: [...list.characters, ...response.characters] } : response;
      enabled = response.capabilities.castEditing; renderRoster();
      if (notice) status(notice);
    } catch (error) {
      if (!current(token)) return;
      shell("Characters"); status(`Could not load characters: ${message(error)}`);
      dialog.append(button("Retry loading", () => { void loadRoster(); }));
    }
  }
  async function loadScan(scanId?: string) {
    rosterVisible = false;
    if (!options.api.scans) return;
    const token = ++epoch; editor = null; shell("Scan earlier story"); status("Loading scan…");
    try {
      const [latestData, roster, tracking] = await Promise.all([options.api.scans.latest(campaign), options.api.list(campaign), options.api.discoveryStatus(campaign).catch(() => null)]);
      const data = scanId && scanId !== latestData.scan?.id ? { ...latestData, scan: await options.api.scans.get(campaign, scanId) } : latestData;
      if (!current(token)) return;
      scanData = data; list = roster; discovery = tracking;
      shell("Scan earlier story"); dialog.append(button("Back to characters", () => { void loadRoster(); }));
      renderLegacyCastScan(dialog, { api: options.api.scans, readDiscovery: () => options.api.discoveryStatus(campaign), campaignId: campaign, authority: roster, data, discovery: tracking,
        current: () => current(token), generationActive: options.generationActive, refresh: (id = scanId) => loadScan(id) });
    } catch (error) {
      if (!current(token)) return;
      shell("Scan earlier story"); status(message(error));
      dialog.append(button("Refresh scan", () => { void loadScan(); }), button("Back to characters", () => { void loadRoster(); }));
    }
  }
  async function loadAttention() {
    rosterVisible = false; const token = ++epoch; editor = null; shell("Needs attention");
    dialog.append(button("Back to characters", () => { void loadRoster(); }));
    const count = (value: number | null | undefined) => value == null ? "unavailable" : String(value);
    const identities = node("div"), details = node("div");
    dialog.append(node("h3", `Identity questions (${count(attention?.identities)})`), identities,
      node("h3", `Withheld details (${count(attention?.details)})`), details,
      button("Review identity questions and details", () => loadReview()),
      node("h3", `Conflicts (${count(attention?.conflicts)})`));
    identities.textContent = "Loading identity questions…"; details.textContent = "Loading withheld details…";
    void (async () => {
      try {
        const pages = async (view: "review" | "matches" | "details") => {
          let cursor: string | undefined; let first: CastCandidateList | undefined;
          do {
            const page = await options.api.candidates(campaign, { view, limit: 50, ...(cursor ? { cursor } : {}) });
            if (!current(token)) return null;
            if (first && (page.revision !== first.revision || JSON.stringify(page.boundary) !== JSON.stringify(first.boundary))) throw new Error("changed");
            if (!first) first = { ...page, candidates: [...page.candidates] }; else first.candidates.push(...page.candidates);
            cursor = page.nextCursor ?? undefined;
          } while (cursor);
          return first!;
        };
        let matches: CastCandidateList | null, pendingDetails: CastCandidateList | null;
        try { const combined = await pages("review"); if (!combined) return; matches = { ...combined, candidates: combined.candidates.filter(item => !item.resolvedCharacterId) }; pendingDetails = { ...combined, candidates: combined.candidates.filter(item => item.resolvedCharacterId) }; }
        catch (error) { if ((error as { statusCode?: number }).statusCode !== 400) throw error; matches = await pages("matches"); pendingDetails = await pages("details"); }
        if (!matches || !pendingDetails || !current(token)) return;
        if (matches.revision !== pendingDetails.revision || JSON.stringify(matches.boundary) !== JSON.stringify(pendingDetails.boundary)) throw new Error("changed");
        identities.replaceChildren(); details.replaceChildren();
        for (const item of buildReviewQueue(matches.candidates, pendingDetails.candidates)) {
          if (item.kind === "identity") identities.append(button(`${item.candidate.proposal.name} · turn ${item.candidate.source.turnNumber}`, () => loadReview(`identity:${item.candidate.id}`)));
          else for (const entry of item.entries) details.append(button(`${entry.candidate.proposal.name} · ${fields.find(([path]) => path === item.field)?.[1] ?? item.field} · turn ${entry.candidate.source.turnNumber}`, () => loadReview(`detail:${item.characterId}:${item.field}:${entry.candidate.id}`)));
        }
        if (!identities.children.length) identities.textContent = "No identity questions.";
        if (!details.children.length) details.textContent = "No withheld details.";
      } catch { if (current(token)) { identities.textContent = "Could not load identity questions."; details.textContent = "Could not load withheld details."; } }
    })();
    const results = node("div"); results.setAttribute("aria-live", "polite"); results.textContent = "Loading conflicts…"; dialog.append(results);
    try {
      const conflicts: CastDetail[] = []; let cursor: string | undefined; let revision: number | undefined; let boundary: string | undefined;
      do {
        const page = await options.api.list(campaign, { filter: "conflicts", limit: 50, ...(revision === undefined ? {} : { expectedRevision: revision }), ...(cursor ? { cursor } : {}) });
        if (!current(token)) return;
        if (revision !== undefined && (page.revision !== revision || JSON.stringify(page.boundary) !== boundary)) throw new Error("changed");
        revision = page.revision; boundary = JSON.stringify(page.boundary);
        for (const person of page.characters) {
          const detail = await options.api.detail(campaign, person.id);
          if (!current(token)) return;
          if (detail.revision !== revision || JSON.stringify(detail.boundary) !== boundary) throw new Error("changed");
          conflicts.push(detail);
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor && current(token));
      if (!current(token)) return; results.replaceChildren();
      for (const detail of conflicts) for (const section of buildCharacterSheet({ kind: "supporting", detail }).sections) for (const field of section.fields) {
        if (field.origin !== "conflicted") continue;
        results.append(button(`${detail.character.name} · ${field.label}`, () => { void openConflict(detail.character.id, field.path); }, !enabled || options.generationActive()));
      }
      if (!results.children.length) results.textContent = "No conflicting fields.";
    } catch { if (current(token)) results.textContent = "Could not load conflicts. Refresh and try again."; }
  }
  async function openConflict(id: string, field: string) {
    await openDetail(id);
    if (!editor || editor.characterId !== id) return;
    if (editor.loaded?.character.originProfile) preset = createPresetDraft(editor.loaded);
    renderEditor();
    const input = dialog.querySelector<HTMLElement>(`#cast-${field.replace(".", "-")}`);
    const group = input?.closest("details"); if (group) group.open = true;
    input?.focus();
  }
  function loadReview(initialItem?: string) {
    rosterVisible = false; const token = ++epoch; editor = null; shell("Character review");
    renderCastReview({ document, container: dialog, api: options.api, campaign, current: () => current(token),
      ...(options.campaignPage ? { checkWrite: syncLock } : {}),
      autoMatch, ...(initialItem ? { initialItem } : {}), editing: () => enabled && !options.generationActive(), navigate: turn => { requestClose(); void options.navigateToTurn(turn); },
      back: () => { void loadAttention(); }, key: operationKey, clearKeys: () => operationKeys.clear() });
  }
  function previewContext() {
    rosterVisible = false; const token = ++epoch; shell("Likely included for this input"); dialog.append(button("Back to characters", () => { void loadRoster(); }));
    const label = node("label", "Story input"), input = node("textarea"), result = node("section"); label.append(input);
    dialog.append(label, button("Refresh estimate", async () => { try { const data = await options.api.contextPreview(campaign, { query: input.value }); if (!current(token)) return; result.replaceChildren(node("p", `Estimate at turn ${data.boundary.turnNumber}, cast revision ${data.castRevision}. Refresh after your story or characters change.`)); result.append(node("p", `Estimated usage: ${data.usedTokens.toLocaleString()} of ${data.budgetTokens.toLocaleString()} tokens.`));
      if (data.note) result.append(node("p", data.note)); if (data.disabledReason) result.append(node("p", data.disabledReason));
      if (!data.selected.length && !data.omitted.length && !data.disabledReason) result.append(node("p", "No characters are likely to be included for this input."));
      for (const item of data.selected) result.append(node("p", `Included: ${item.name} · ${item.reason.replaceAll("_", " ")}`));
      if (data.omitted.length) {
        const names = new Map<string, string>(); let cursor: string | undefined;
        try { do { const page = await options.api.list(campaign, { limit: 50, ...(cursor ? { cursor, expectedRevision: data.castRevision } : {}) }); if (page.revision !== data.castRevision) break; for (const person of page.characters) names.set(person.id, person.name); cursor = page.nextCursor ?? undefined; } while (cursor); } catch { /* The estimate is still useful if names cannot be loaded. */ }
        if (!(current(token))) return;
        for (const item of data.omitted) result.append(node("p", `Omitted: ${names.get(item.characterId) ?? "Character unavailable"} · ${item.reason.replaceAll("_", " ")}`));
      } } catch { result.replaceChildren(node("p", "Estimate unavailable.")); } }), result);
  }
  function renderRoster() {
    shell("Characters");
    const narrator = castNarratorNotice(narratorState, campaign);
    if (narrator) {
      const note = status(narrator.text);
      if (narrator.href) { const link = node("a", narrator.label); link.href = narrator.href; note.append(" ", link); }
    }
    if (!options.campaignPage) renderStoryTools();
    status(attentionSummary()).dataset.castAttention = "";
    dialog.append(button("Needs attention", () => { void loadAttention(); }));
    function renderStoryTools() {
      if (!discovery) status("Character tracking status is unavailable. Saved characters are still available.");
      else {
        const messages = { disabled: "Automatic character tracking is disabled.", not_enrolled: "Character tracking starts with the next accepted turn.",
          catching_up: "Character tracking is catching up.", failed: `Character tracking stopped at turn ${discovery.firstGap?.turnNumber}. Your story is saved.`,
          complete: "Character tracking is up to date." };
        status(messages[discovery.state]);
        if (discovery.coverageStartTurn !== null) status(discovery.trackedThroughTurn! >= discovery.coverageStartTurn
          ? `Tracked turns ${discovery.coverageStartTurn}–${discovery.trackedThroughTurn}. Earlier turns are not included.`
          : `Tracking starts at turn ${discovery.coverageStartTurn}; no turns in this range are complete yet.`);
        if (discovery.firstGap) {
          const reason = castScanRecovery(discovery, list!.boundary.turnNumber).diagnostic;
          status(`First tracking gap: turn ${discovery.firstGap.turnNumber} (${discovery.firstGap.status.replaceAll("_", " ")}).${reason ? ` ${reason}` : ""}`);
          if (recovery?.kind === "scan" && recovery.scanId && recovery.scanStatus !== "cancelled") dialog.append(button("Open tracking recovery", () => { void loadScan(recovery!.scanId!); }));
        }
        if (discovery.unresolvedCount) status(`${discovery.unresolvedCount} character ${discovery.unresolvedCount === 1 ? "match needs" : "matches need"} review.`);

        if (discovery.state === "failed" && discovery.firstGap?.diagnosticCode === "source_requires_manual_scan") {
          status("This turn exceeds automatic tracking limits. Review or add its characters manually.");
        } else if (discovery.enabled && discovery.state === "failed" && discovery.firstGap?.jobId && recovery?.kind === "forward" && recovery.jobId === discovery.firstGap.jobId) {
          const jobId = discovery.firstGap.jobId, token = epoch;
          const request = { expectedCastRevision: list!.revision, expectedBoundary: list!.boundary, idempotencyKey: crypto.randomUUID() };
          const feedback = node("p"); feedback.setAttribute("role", "status");
          const retry = button("Retry character tracking", () => { void submitRetry(); }, !enabled || options.generationActive());
          async function submitRetry() {
            if (!current(token) || !enabled || options.generationActive() || retry.disabled) return;
            retry.disabled = true; feedback.textContent = "Preparing character tracking retry…";
            try {
              await options.api.retryDiscovery(campaign, jobId, request);
              if (current(token)) await loadRoster();
            } catch (error) {
              if (!current(token)) return;
              const code = (error as { statusCode?: number }).statusCode;
              feedback.textContent = code === 409
                ? "The story or cast changed, or generation is active. Refresh characters before retrying."
                : code === 503 ? "Character tracking could not restart. Check the text provider settings and tracking availability, then try again. Your story is saved."
                  : "Could not confirm the character tracking retry. Try again to check the same request. Your story is saved.";
              retry.disabled = code === 409 || !enabled || options.generationActive();
            }
          }
          dialog.append(retry, feedback);
        }
      }
      dialog.append(button("Refresh characters", () => { void loadRoster(); }), button("Likely included for this input", previewContext));
      if (scanData && (scanData.capabilities.castBackfill || scanData.scan)) dialog.append(button("Scan earlier story", () => { void loadScan(); }));
    }
    if (list?.capabilities.castPresets && options.api.worldChoices && options.api.fromWorldPreview && options.api.fromWorld) {
      dialog.append(button("Add from world", async () => {
        rosterVisible = false; const token = ++epoch;
        await syncLock(); if (!current(token)) return;
        shell("Add from world"); dialog.append(button("Back to characters", () => void loadRoster()));
        if (locked()) { status("Finish or resolve the current generation before editing characters."); return; }
        const host = node("section"); dialog.append(host);
        await renderWorldCastPicker(host, { worldChoices: options.api.worldChoices!, fromWorldPreview: options.api.fromWorldPreview!, fromWorld: options.api.fromWorld! },
          campaign, syncLock, id => void openDetail(id));
      }, !enabled));
    }
    const controls = node("form"); controls.className = "cast-toolbar";
    const label = node("label", "Find a character"); label.htmlFor = "cast-search";
    const search = node("input"); search.id = "cast-search"; search.type = "search"; search.value = query; search.maxLength = 200;
    const submit = node("button", "Search"); submit.type = "submit";
    const filterLabel = node("label", "Filter characters"), filterSelect = node("select"); filterLabel.htmlFor = "cast-filter"; filterSelect.id = "cast-filter";
    for (const [value, label] of [["all", "All"], ["main", "Main"], ["recent", recentFilterLabel(list?.recentWindow)], ["pinned", "Pinned"], ["needs_review", "Needs review"], ["conflicts", "Conflicts"], ["ignored", "Ignored"], ...(list?.capabilities.castLifecycle !== undefined ? [["removed", "Removed"]] : [])]) { const option = node("option", label); option.value = value!; option.selected = value === filter; filterSelect.append(option); }
    filterSelect.addEventListener("change", () => { filter = filterSelect.value as CharacterFilter; query = search.value; workspace.setQuery(query, filter); void loadRoster(); });
    controls.append(label, search, filterLabel, filterSelect, submit);
    controls.addEventListener("submit", (event) => { event.preventDefault(); query = search.value; workspace.setQuery(query, filter); void loadRoster(); });
    dialog.append(controls);
    if (!enabled) status("Character editing is disabled. Saved characters remain available to read.");
    else if (!options.campaignPage && locked()) status("Finish or resolve the current generation before editing characters.");
    else dialog.append(button("Add character", async () => {
      const token = epoch;
      if (options.checkLock) await syncLock();
      if (!current(token)) return;
      rosterVisible = false; editor = createCastEditor(list!); renderEditor();
    }));
    if (filter === "recent") status(recentFilterLabel(list!.recentWindow));
    const roster = node("ul"); roster.className = "cast-roster";
    for (const person of [...list!.characters].sort((a, b) => Number(b.origin.kind === "protagonist") - Number(a.origin.kind === "protagonist"))) {
      const li = node("li"), title = button(person.name, () => { void openDetail(person.id); });
      const attention = list!.attention?.find((item) => item.characterId === person.id);
      li.append(title, node("p", [person.profile["story.role"], characterProvenanceLabel(person), `Last observed turn ${person.lastObservedTurn}${person.lastMentionedTurn != null ? ` · Last mentioned turn ${person.lastMentionedTurn}` : ""}`,
        person.pinned ? "Pinned" : "", person.ignored ? "Ignored" : "", attention?.review ? "Needs review" : "", attention?.conflict ? "Conflicting details" : ""].filter(Boolean).join(" · ")));
      roster.append(li);
    }
    dialog.append(roster);
    if (!list!.characters.length) status(query ? "No characters match this search." : "No supporting characters yet. Add someone from your story.");
    if (list!.nextCursor) dialog.append(button("Load more characters", () => { void loadRoster(list!.nextCursor!); }));
  }
  async function openDetail(id: string) {
    if (dirty() || editor?.saving || saving) { requestNavigation(() => { void openDetail(id); }); return; }
    storyReview.reset(); rosterVisible = false; workspace.select(id);
    const token = ++epoch; shell("Character"); status("Loading character…");
    try {
      const [detail] = await Promise.all([options.api.detail(campaign, id), syncLock()]);
      if (!current(token)) return;
      enabled = detail.capabilities.castEditing;
      editor = createCastEditor(detail, detail); preset = null; latest = null;
      let profile: (CampaignCharacterProfile & { revision: number; inheritedFromSnapshot?: boolean; storedProfile?: unknown }) | null = null;
      if (detail.character.origin.kind === "protagonist" && options.getProfile) profile = await options.getProfile(campaign).catch(() => null);
      if (!current(token)) return; renderSheet(detail, profile);
      const heading = dialog.querySelector<HTMLElement>("#cast-title"); if (heading) { heading.tabIndex = -1; heading.focus(); }
    } catch (error) {
      if (!current(token)) return;
      shell("Character"); status(`Could not load this character: ${message(error)}`);
      dialog.append(button("Back to characters", () => { void loadRoster(); }));
    }
  }
  function renderSheet(detail: CastDetail & { capabilities?: List["capabilities"] }, profile: (CampaignCharacterProfile & { revision: number; inheritedFromSnapshot?: boolean; storedProfile?: unknown }) | null = null) {
    const sheet = profile ? buildCharacterSheet({ kind: "protagonist", profile: { name: profile.name, profile: profile.profile }, revision: profile.revision }) : buildCharacterSheet({ kind: "supporting", detail });
    shell(sheet.name); dialog.classList.add("cast-sheet-layout");
    const sidebar = node("nav"); sidebar.className = "cast-sheet-roster"; sidebar.setAttribute("aria-label", "Characters");
    const switcher = node("details");
    switcher.open = window.matchMedia?.("(min-width: 900px)").matches ?? true;
    switcher.append(node("summary", "Switch character"));
    sidebar.append(switcher);
    const visible = list?.characters ?? [];
    const people = visible.some(person => person.id === detail.character.id) ? visible : [...visible, detail.character];
    for (const person of people) {
      const entry = button(person.name, () => { void openDetail(person.id); });
      if (person.id === detail.character.id) entry.setAttribute("aria-current", "true");
      switcher.append(entry);
    }
    dialog.append(sidebar);
    dialog.append(button("Back to characters", () => { void loadRoster(); }), node("p", `Last observed turn ${detail.character.lastObservedTurn}${detail.character.lastMentionedTurn != null ? ` · Last mentioned turn ${detail.character.lastMentionedTurn}` : ""}`));
    if (options.campaignPage) {
      const link = node("a", "Open in Story"); link.href = "/story/" + encodeURIComponent(campaign) + "?character=" + encodeURIComponent(detail.character.id); dialog.append(link);
    }
    if (detail.character.origin.kind === "protagonist") {
      status(`This is your main character. ${mainProfileSourceLabel(profile)}.`);
      const opener = button("Edit main character", () => { options.openProtagonist(saved => {
        if (saved && dialog.open) { void openDetail(detail.character.id).then(() => dialog.querySelector<HTMLButtonElement>("[data-edit-protagonist]")?.focus()); }
        else if (dialog.open && opener.isConnected) opener.focus();
      }); });
      opener.dataset.editProtagonist = ""; dialog.append(opener);
    } else if (!detail.character.mergedIntoCharacterId) {
      const lifecycle = options.api.lifecycle;
      const lifecycleEnabled = (detail.capabilities ?? list?.capabilities)?.castLifecycle;
      if (enabled && lifecycleEnabled === false && !detail.character.removed) status("Character merging is disabled on this server.");
      if (lifecycle && lifecycleEnabled) {
        const launch = (action: Parameters<typeof showLifecycle>[0], mergeEventId?: string) => showLifecycle(action, {
          api: lifecycle, campaign, detail, list: options.api.list, lock: syncLock, ...(mergeEventId ? { mergeEventId } : {}),
          finished(id, notice) {
            if (!id) void loadRoster(undefined, notice);
            else void openDetail(id).then(() => { if (dialog.open) status(notice); });
          }
        });
        const actions = node("div"); actions.className = "cast-lifecycle-actions";
        if (detail.character.removed) actions.append(button("Restore", () => launch("restore"), locked()));
        else {
          actions.append(button("Merge with another character", () => launch("merge"), locked()),
            button("Remove from cast", () => launch("remove"), locked()), button("Add to world draft", () => launch("promote"), locked()));
          for (const merge of detail.character.activeMerges ?? []) {
            actions.append(node("p", "Merged from " + merge.sourceName), button("Undo merge", () => launch("unmerge", merge.mergeEventId), locked() || !merge.canUndo));
          }
        }
        dialog.append(actions);
      }
      if (!detail.character.removed) dialog.append(button("Edit character", async () => {
        const token = epoch; if (options.checkLock) await syncLock(); if (!current(token)) return;
        if (detail.character.originProfile) preset = createPresetDraft(detail);
        workspace.setDraft(editor); renderEditor();
      }, !enabled || options.generationActive()));
    }
    let showEmpty = false;
    const fieldGroups = node("div"), toggle = button("Show empty fields", () => {
      showEmpty = !showEmpty; toggle.textContent = showEmpty ? "Hide empty fields" : "Show empty fields";
      toggle.setAttribute("aria-pressed", String(showEmpty)); renderFields();
    });
    toggle.setAttribute("aria-pressed", "false"); dialog.append(toggle, fieldGroups);
    function renderFields() {
      fieldGroups.replaceChildren();
      if (detail.character.originProfile) {
        for (const field of presetFields) {
          const info = presetField(detail, field.path);
          if (!showEmpty && !info.effective.length) continue;
          const row = node("p"); row.append(node("strong", field.label + ": "), node("span", Array.isArray(info.effective) ? info.effective.join(", ") : info.effective || "Unknown"), node("small", " " + info.badge));
          if (!options.campaignPage && (info.differs || field.path === "appearance.description" && Boolean(info.effective.length))) {
            const source = node("a", info.differs ? "Story differs" : "View source"); source.href = "#cast-sources";
            source.onclick = event => { event.preventDefault(); const details = dialog.querySelector<HTMLDetailsElement>("#cast-sources"); if (details) { details.open = true; details.querySelector("summary")?.focus(); } };
            row.append(" ", source);
          }
          fieldGroups.append(row);
        }
        return;
      }
      for (const section of sheet.sections) {
        const group = node("section"); group.className = "cast-sheet-section"; group.append(node("h3", section.name));
        for (const field of section.fields) {
          const value = Array.isArray(field.value) ? field.value.join(", ") : field.value;
          if (!showEmpty && !value && field.origin === "unknown") continue;
          const row = node("p"), label = node("strong", `${field.label}: `);
          const origin = sheet.kind === "protagonist" ? "" : ({ unknown: "", observed: "From story", claim: "Unverified claim", user: "Your edit", conflicted: "Conflicting observations" })[field.origin];
          row.append(label, node("span", value || (field.origin === "conflicted" ? "Conflicting observations" : field.origin === "claim" ? "Unverified claim" : "Unknown")), node("small", origin ? ` · ${origin}` : "")); group.append(row);
        }
        if (group.children.length > 1) fieldGroups.append(group);
      }
    }
    renderFields();
    for (const match of detail.autoMatches) {
      const row = node("section"); row.append(node("p", `${match.basis === "unique_world_name" ? "Unique world name" : "Unique campaign name"} · turn ${match.turnNumber}: “${match.quote}”`));
      row.append(button("Not this character", async () => {
        if (options.campaignPage && !await syncLock()) {
          row.append(node("p", "Finish or resolve generation before changing this match."));
          return;
        }
        try { await options.api.detachAttachment(campaign, detail.character.id, match.eventId, { expectedCastRevision: detail.revision, expectedBoundary: detail.boundary, expectedCharacterRevision: detail.character.revision, idempotencyKey: operationKey("detach", [campaign, detail.character.id, match.eventId, detail.revision, detail.boundary, detail.character.revision]) }); operationKeys.clear(); await openDetail(detail.character.id); }
        catch { row.append(node("p", "Could not undo this match. Refresh and try again.")); }
      }, !enabled || options.generationActive())); dialog.append(row);
    }
    renderEvidence();
  }
  function renderStoryDraft(form: HTMLElement, readonly: boolean) {
    const detail = editor?.loaded, api = options.api.draftPreview;
    if (!detail || detail.character.origin.kind === "protagonist") return;
    const state = preset;
    const availableFields = state ? presetFields : SUPPORTING_FIELDS;
    const value = (path: string) => {
      if (!availableFields.some(field => field.path === path)) return undefined;
      const current = state ? state.draft.values[path] : editor?.draft.profile[path as CastField];
      return Array.isArray(current) ? current.join("\n") : current ?? "";
    };
    storyReview.render(form, {
      eligible: Boolean(api && detail.draftFromStoryEligible), locked: readonly || Boolean(editor?.conflict),
      value, label: path => availableFields.find(field => field.path === path)?.label ?? path,
      fetch: async direction => {
        const token = epoch, activeCampaign = campaign;
        if (!await syncLock() || !current(token)) throw new Error("Character editing is unavailable");
        if (editor?.error === staleEvidenceMessage) {
          const fresh = await options.api.detail(activeCampaign, detail.character.id);
          if (!current(token) || !editor) throw new Error("Character selection changed");
          if (fresh.revision !== detail.revision || fresh.character.revision !== detail.character.revision ||
            fresh.boundary.turnNumber !== detail.boundary.turnNumber || fresh.boundary.timelineRevision !== detail.boundary.timelineRevision) {
            latest = fresh;
            editor = failCastSubmission(editor, "The campaign changed. Compare the latest values below, reapply your edits, then run Draft from story again.", true);
            throw new Error("Review the latest character before retrying");
          }
        }
        return api!(campaign, detail.character.id, { expectedCastRevision: detail.revision, expectedBoundary: detail.boundary,
          expectedCharacterRevision: detail.character.revision, ...(direction ? { direction } : {}) });
      },
      apply: (path, text) => {
        if (state) changePresetField(state, path, text);
        else editor = setCastEditorField(editor!, path as CastField, text);
      },
      turn: turn => requestNavigation(() => { closePanel(); void options.navigateToTurn(turn); }), refresh: renderEditor
    });
  }
  function collectedFences() {
    return storyReview.fences().filter(fence => preset ? preset.changes.has(fence.path) && preset.draft.values[fence.path] === fence.value && !preset.actions.has(fence.path)
      : editor?.setOverrides[fence.path as CastField] === fence.value);
  }
  function staleEvidence(error: unknown) {
    return (error as { domainCode?: string })?.domainCode === "cast_draft_evidence_changed";
  }
  const staleEvidenceMessage = "The cited story evidence changed. Your draft is kept. Run Draft from story again to review fresh evidence.";
  function renderPresetEditor(state: PresetDraft) {
    const expanded = new Map([...dialog.querySelectorAll<HTMLDetailsElement>("[data-cast-group]")].map(group => [group.dataset.castGroup!, group.open]));
    const focusId = (document.activeElement as HTMLElement | null)?.id;
    shell("Character details"); editingForm = true;
    const form = node("form"); form.className = "cast-editor"; form.dataset.characterContext = "campaign-preset";
    const readonly = locked() || !enabled || saving;
    if (locked()) showEditorLock();
    const save = node("button", saving ? "Saving…" : "Save character"); save.type = "submit"; save.id = "cast-save";
    const changed = () => { save.disabled = readonly || !dirty() || Boolean(editor?.conflict); };
    renderPresetFields(form, state, readonly, changed, expanded, options.campaignPage
      ? "/story/" + encodeURIComponent(campaign) + "?character=" + encodeURIComponent(state.detail.character.id) : undefined);
    for (const [key, text] of [["pinned", "Pin character"], ["ignored", "Ignore character"]] as const) {
      const label = node("label", text), checkbox = node("input"); checkbox.type = "checkbox"; checkbox.checked = state[key]; checkbox.disabled = readonly;
      checkbox.onchange = () => { state[key] = checkbox.checked; changed(); }; label.prepend(checkbox); form.append(label);
    }
    if (editor?.error) { const notice = node("p", editor.error); notice.setAttribute("role", "alert"); notice.tabIndex = -1; form.append(notice); }
    if (editor?.conflict) {
      form.append(button("Compare latest", () => void compareLatest()));
      if (latest) {
        for (const path of state.changes) form.append(node("p", (presetFields.find(f => f.path === path)?.label ?? path) + ": " +
          (latest.character.originProfile ? presetField(latest, path).effective : "World profile detached")));
        const sameSeed = latest.character.originProfile?.seedEventId === state.detail.character.originProfile!.seedEventId;
        form.append(button("Reapply my changes", () => {
          const next = createPresetDraft(latest!);
          for (const path of state.changes) changePresetField(next, path, state.draft.values[path]!, state.actions.get(path));
          if (state.pinned !== state.detail.character.pinned) next.pinned = state.pinned;
          if (state.ignored !== state.detail.character.ignored) next.ignored = state.ignored;
          preset = next; editor = createCastEditor(latest!, latest!); latest = null; renderEditor();
        }, !sameSeed || readonly), button("Discard draft and load latest", () => { preset = null; editor = null; void openDetail(state.detail.character.id); }));
      }
    }
    renderStoryDraft(form, readonly);
    changed(); form.append(save, button("Cancel", () => requestNavigation(() => void loadRoster()), saving));
    form.onsubmit = event => { event.preventDefault(); void saveDraft(); }; dialog.append(form);
    if (!options.campaignPage) renderEvidence();
    const focus = form.querySelector<HTMLElement>('[role="alert"]') ?? document.getElementById(focusId || "cast-name") ?? document.getElementById("cast-name");
    focus?.focus({ preventScroll: true });
  }
  function renderEditor() {
    if (preset) { renderPresetEditor(preset); return; }
    if (!editor) return;
    const expanded = new Map([...dialog.querySelectorAll<HTMLDetailsElement>("[data-cast-group]")].map(group => [group.dataset.castGroup!, group.open]));
    const focusId = dialog.contains(document.activeElement) ? (document.activeElement as HTMLElement).id : "";
    const protagonist = editor.loaded?.character.origin.kind === "protagonist";
    const locked = !enabled || lockedByServer || options.generationActive() || editor.saving || protagonist;
    shell(editor.characterId ? "Character details" : "Add character");
    editingForm = true;
    dialog.append(button("Back to characters", () => requestNavigation(() => { void loadRoster(); }), editor.saving));
    if (protagonist) {
      status("This is your main character. Use its existing profile editor.");
      const opener = button("Edit main character", () => { options.openProtagonist(() => { if (dialog.open && opener.isConnected) opener.focus(); }); });
      dialog.append(opener);
    } else if (!enabled) status("Character editing is disabled. Your draft is kept here until you close it.");
    else if (lockedByServer || options.generationActive()) showEditorLock();
    const form = node("form"); form.className = "cast-editor";
    form.dataset.characterContext = "campaign-supporting";
    form.append(node("p", editor.characterId ? "Saved facts are filled in. Edit only what needs changing." : "Only a name is required. Add details you know, or review story matches to fill characters from evidence."));
    const save = node("button", editor.saving ? "Saving…" : "Save character"); save.type = "submit"; save.className = "primary"; save.id = "cast-save";
    const syncSave = () => { save.disabled = Boolean(locked) || !canSaveCastEditor(editor!) || heldMatches().length > 0; };
    function textInput(label: string, id: string, value: string, max: number, changed: (value: string) => void, multiline = false) {
      const wrap = createCastTextField(document, { label, id, value, maxLength: max, multiline, disabled: Boolean(locked), onInput(text) { changed(text); syncSave(); } });
      form.append(wrap); return wrap;
    }
    const nameWrap = textInput("Name", "cast-name", editor.draft.name, 200, (name) => { editor = changeCastEditor(editor!, { name }); updateDuplicateWarning(); });
    const duplicateWarning = node("p"); duplicateWarning.setAttribute("role", "status"); nameWrap.append(duplicateWarning);
    let duplicateRoster = list?.characters ?? [];
    void (async () => {
      try {
        const people: List["characters"] = []; let cursor: string | undefined; let revision: number | undefined;
        do {
          const page = await options.api.list(campaign, { limit: 50, ...(revision === undefined ? {} : { expectedRevision: revision }), ...(cursor ? { cursor } : {}) });
          revision ??= page.revision; if (page.revision !== revision) return;
          people.push(...page.characters); cursor = page.nextCursor ?? undefined;
        } while (cursor);
        if (!dialog.contains(duplicateWarning)) return;
        if (!editor?.characterId) {
          let removedCursor: string | undefined;
          do {
            const removed = await options.api.list(campaign, { filter: "removed", limit: 50, ...(revision === undefined ? {} : { expectedRevision: revision }), ...(removedCursor ? { cursor: removedCursor } : {}) });
            if (removed.revision !== revision) return;
            people.push(...removed.characters); removedCursor = removed.nextCursor ?? undefined;
          } while (removedCursor && dialog.contains(duplicateWarning));
        }
        if (!dialog.contains(duplicateWarning)) return;
        duplicateRoster = people; updateDuplicateWarning();
      } catch { /* The server checks held names under the campaign lock. */ }
    })();
    function heldMatches() {
      if (editor!.characterId) return [];
      const terms = new Set([editor!.draft.name, ...editor!.draft.aliases].map(normalizeCastAlias).filter(Boolean));
      return duplicateRoster.filter(person => person.removed && [person.name, ...person.aliases].some(value => terms.has(normalizeCastAlias(value))));
    }
    function updateDuplicateWarning() {
      const name = normalizeCastAlias(editor!.draft.name), held = heldMatches();
      const duplicate = name && duplicateRoster.some(person => !person.removed && person.id !== editor!.characterId && [person.name, ...person.aliases].some(value => normalizeCastAlias(value) === name));
      duplicateWarning.textContent = held.length ? "A removed character holds this name. Restore them instead." : duplicate ? "A character with this name already exists. You can still save." : "";
      for (const person of held) {
        duplicateWarning.append(button("Restore " + person.name, () => requestNavigation(() => void openDetail(person.id)), !options.api.lifecycle || !list?.capabilities.castLifecycle));
      }
      syncSave();
    }
    updateDuplicateWarning();
    textInput("Aliases (one per line)", "cast-aliases", editor.draft.aliases.join("\n"), listTextareaLimit(200, 20),
      (value) => { editor = changeCastEditor(editor!, { aliases: value.split("\n").map((v) => v.trim()).filter(Boolean) }); updateDuplicateWarning(); }, true);
    renderSupportingEditorFields(form, { expanded, existing: Boolean(editor.characterId), field(path, label) {
      const field = path as CastField;
      const wrap = textInput(label, `cast-${field.replace(".", "-")}`, editor!.draft.profile[field] ?? "", 2000,
        (value) => { editor = setCastEditorField(editor!, field, value); }, true);
      const fieldStatus = node("div"); fieldStatus.setAttribute("role", "status"); wrap.append(fieldStatus);
      function syncFieldStatus() {
        const overriding = Object.hasOwn(editor!.setOverrides, field) || editor!.loaded?.overrides.some((o) => o.field === field);
        fieldStatus.replaceChildren(node("small", editor!.clearOverrides.includes(field) ? "Will use the discovered value after saving." : overriding ? "Your override" : Object.hasOwn(editor!.draft.profile, field) ? "From recorded evidence" : "Unknown"));
        if (editor!.characterId && !protagonist && overriding && !editor!.clearOverrides.includes(field)) fieldStatus.append(button(`Use discovered value for ${label.toLowerCase()}`, () => {
          editor = setCastEditorField(editor!, field, null);
          const input = wrap.querySelector<HTMLTextAreaElement | HTMLInputElement>("textarea, input")!;
          input.value = editor!.draft.profile[field] ?? ""; syncFieldStatus(); syncSave(); input.focus();
        }, Boolean(locked)));
      }
      wrap.querySelector("textarea, input")!.addEventListener("input", syncFieldStatus); syncFieldStatus();
      return wrap;
    } });
    if (editor.characterId && !protagonist) for (const [key, label] of [["pinned", "Pin character"], ["ignored", "Ignore character"]] as const) {
      const caption = node("label", label), control = node("input"); control.type = "checkbox";
      control.checked = editor.draft[key]; control.disabled = Boolean(locked);
      control.addEventListener("change", () => { editor = changeCastEditor(editor!, { [key]: control.checked }); syncSave(); });
      caption.prepend(control); form.append(caption);
    }
    if (editor.characterId && !protagonist) form.append(node("small", "Pin prioritizes this character in story context. Ignore excludes this supporting character from story context."));
    if (editor.error) { const error = node("p", editor.error); error.setAttribute("role", "alert"); error.tabIndex = -1; form.append(error); }
    if (editor.conflict) {
      form.append(button("Compare latest", () => { void compareLatest(); }));
      if (latest) {
        const comparison = node("div");
        comparison.append(node("p", `Name: ${latest.character.name}`), node("p", `Aliases: ${latest.character.aliases.join(", ") || "None"}`));
        for (const [field, label] of fields) comparison.append(node("p", `${label}: ${latest.character.profile[field] ?? "Unknown"}`));
        comparison.className = "cast-comparison"; form.append(node("h3", "Latest saved character"), comparison);
        form.append(button("Reapply my changes", () => { editor = reapplyCastDraft(editor!, latest!); latest = null; renderEditor(); }, !enabled));
        form.append(button("Discard draft and load latest", () => { storyReview.reset(); editor = createCastEditor(latest!, latest!); latest = null; renderEditor(); }));
      }
      if (latestRoster && !editor.characterId) {
        form.append(node("p", `Latest cast: ${latestRoster.characters.map((person) => person.name).join(", ") || "empty"}. Your new character has not been saved.`));
        form.append(button("Reapply my changes", () => { editor = reapplyNewCastDraft(editor!, latestRoster!); latestRoster = null; renderEditor(); }, !enabled));
      }
    }
    renderStoryDraft(form, Boolean(locked));
    syncSave(); if (!protagonist && enabled) form.append(save);
    form.append(button("Cancel", () => requestNavigation(() => { void loadRoster(); }), editor.saving));
    form.addEventListener("submit", (event) => { event.preventDefault(); void saveDraft(); }); dialog.append(form);
    renderEvidence();
    const focus = form.querySelector<HTMLElement>('[role="alert"]') ?? document.getElementById(focusId) ?? document.getElementById("cast-name");
    if (focus instanceof HTMLElement && !focus.hasAttribute("disabled")) focus.focus({ preventScroll: true });
  }
  function fieldLabel(path: string) { return fields.find(([field]) => field === path)?.[1] ?? path; }
  function renderEvidence() {
    if (!editor?.loaded || options.campaignPage) return;
    const details = node("details"), summary = node("summary", "Sources and edit history"); details.id = "cast-sources"; details.append(summary);
    for (const item of [...editor.loaded.identityEvents.map((event) => ({ label: `Name: ${event.name}`, evidence: event.evidence })),
      ...editor.loaded.observations.map((observation) => ({ label: `${observation.mode === "claim" ? "Claim" : "Observation"}: ${fieldLabel(observation.field)} — ${observation.value}`, evidence: observation.evidence })),
      ...editor.loaded.overrides.map((override) => ({ label: `Your override: ${fieldLabel(override.field)} — ${override.value || "(blank)"}`, evidence: override.evidence }))]) {
      const row = node("p", item.label); const evidence = item.evidence;
      if (evidence.kind === "turn") {
        row.append(node("span", ` — “${evidence.quote}” `));
        row.append(button(`Turn ${evidence.turnNumber}${evidence.invalidated ? " (replaced)" : ""}`, () => {
          requestNavigation(() => { closePanel(); void options.navigateToTurn(evidence.turnNumber); });
        }, evidence.invalidated === true));
      } else row.append(node("span", evidence.kind === "user" ? ` — Your edit at turn ${evidence.effectiveTurnNumber}` : " — World source"));
      details.append(row);
    }
    for (const edit of editor.loaded.authoredHistory ?? []) {
      for (const [path, value] of Object.entries(edit.set)) details.append(node("p", `Campaign edit at turn ${edit.effectiveTurnNumber}: ${presetFields.find(field => field.path === path)?.label ?? path} — ${Array.isArray(value) ? value.join(", ") : value}`));
      for (const path of edit.reset) details.append(node("p", `Reset at turn ${edit.effectiveTurnNumber}: ${presetFields.find(field => field.path === path)?.label ?? path}`));
    }
    if (editor.loaded.unresolvedCandidateIds.length) details.append(node("p", `${editor.loaded.unresolvedCandidateIds.length} identity decisions pending.`));
    dialog.append(details);
  }
  async function compareLatest() {
    const token = epoch;
    try {
      if (!editor!.characterId) {
        const value = await options.api.list(campaign);
        if (!current(token)) return;
        latestRoster = value; enabled = value.capabilities.castEditing; renderEditor(); return;
      }
      const value = await options.api.detail(campaign, editor!.characterId!);
      if (!current(token)) return;
      latest = value; enabled = value.capabilities.castEditing; renderEditor();
    } catch (error) { if (current(token) && editor) { editor = { ...editor, error: message(error) }; renderEditor(); } }
  }
  async function saveDraft(afterSave?: () => void) {
    if (!editor || !enabled || saving || (!preset && !canSaveCastEditor(editor))) return;
    const identity = editor, authority = epoch;
    saving = true;
    if (!await syncLock() || !current(authority) || identity !== editor) {
      saving = false; if (current(authority)) renderEditor(); return;
    }
    if (preset) {
      try {
        const state = preset;
        if (!options.api.editAuthoredProfile) throw new Error("Character editing is unavailable.");
        if (dialog.querySelector("form")?.reportValidity() === false) { saving = false; return; }
        const payload = buildPresetRequest(state, crypto.randomUUID());
        const fences = collectedFences();
        if (fences.length) payload.draftEvidenceFences = fences;
        payload.idempotencyKey = operationKey("authored", { ...payload, idempotencyKey: null, characterId: state.detail.character.id });
        renderEditor();
        const result = await options.api.editAuthoredProfile(campaign, state.detail.character.id, payload);
        saving = false;
        if (!current(authority)) return;
        editor = null; preset = null; operationKeys.clear();
        if (afterSave) afterSave(); else await openDetail(result.character.id);
      } catch (error) {
        saving = false; if (!current(authority) || !editor) return;
        if (staleEvidence(error)) { editor = failCastSubmission(editor, staleEvidenceMessage, false); renderEditor(); return; }
        const issue = error as { statusCode?: number; details?: { fields?: { path: string }[] } };
        editor = failCastSubmission(editor, issue.statusCode === 409 ? "The campaign or character changed. Compare the latest version to reapply your draft." : message(error), issue.statusCode === 409); renderEditor();
        const rawPath = issue.details?.fields?.[0]?.path;
        const field = presetFields.find(item => rawPath === item.path || rawPath?.endsWith("." + item.path));
        if (field) {
          const input = document.getElementById("cast-" + field.path.replace(".", "-")), alert = dialog.querySelector<HTMLElement>('[role="alert"]');
          const section = input?.closest("details"); if (section) section.open = true;
          if (alert && input) { alert.id = "cast-field-error"; input.setAttribute("aria-describedby", alert.id); input.focus(); }
        }
      }
      return;
    }
    saving = false;
    const token = epoch;
    try {
      editor = prepareCastSubmission(editor, crypto.randomUUID()); renderEditor();
      const fences = collectedFences();
      const result = editor.characterId ? await options.api.edit(campaign, editor.characterId, { ...editor.submission as EditCastCharacter, ...(fences.length ? { draftEvidenceFences: fences } : {}) })
        : await options.api.create(campaign, editor.submission as CreateCastCharacter);
      if (!current(token)) return;
      editor = null; if (afterSave) { afterSave(); return; }
      await openDetail(result.character.id);
      const heading = dialog.querySelector<HTMLElement>("#cast-title"); if (heading) { heading.tabIndex = -1; heading.focus(); }
    } catch (error) {
      if (!current(token) || !editor) return;
      if (staleEvidence(error)) { editor = failCastSubmission(editor, staleEvidenceMessage, false); renderEditor(); return; }
      const code = (error as { statusCode?: number }).statusCode;
      editor = failCastSubmission(editor, code === 409 ? "The character or campaign changed, or generation is active. Your draft is kept. Compare the latest version before reapplying." : message(error), code === 409);
      if (code === 503) enabled = false;
      renderEditor();
    }
  }
  function message(error: unknown) { return error instanceof Error ? error.message : "The request failed. Please try again."; }
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); const keep = dialog.querySelector<HTMLButtonElement>("[data-cast-confirm] button"); if (keep) keep.click(); else requestClose(); });
  window.addEventListener("beforeunload", (event) => { if (dirty()) { event.preventDefault(); event.returnValue = ""; } });
  return { requestClose, async open(characterOrOpener?: string | HTMLElement | null, opener?: HTMLElement | null) {
    const id = options.campaignId(); if (!id || dialog.open) return;
    const characterId = typeof characterOrOpener === "string" ? characterOrOpener : null;
    const focusTarget = typeof characterOrOpener === "string" ? opener : characterOrOpener;
    campaign = id; query = ""; filter = "all"; returnFocus = focusTarget ?? document.activeElement as HTMLElement | null;
    shell("Characters"); dialog.showModal(); workspace.open(campaign); await loadRoster();
    if (!dialog.open || campaign !== id) return;
    if (characterId) await openDetail(characterId);
    if (!options.campaignPage && options.checkLock && dialog.open) lockPoll = setInterval(() => { if (editingForm && !saving) void syncLock(); }, 2000);
  } };
}
