import { renderCastReview } from "./cast-review-queue.js";
import { buildCharacterSheet, canSaveCastEditor, createCastEditor, changeCastEditor, setCastEditorField, prepareCastSubmission,
  failCastSubmission, reapplyCastDraft, reapplyNewCastDraft, characterProvenanceLabel, recentFilterLabel, type CastEditorState } from "@infinite-quest/client-core";
import { createCharactersWorkspaceSession, type CampaignCastApi } from "@infinite-quest/client-web";
import type { CampaignCharacterProfile, CharacterFilter, CastDetail, CastDiscoveryStatus, CastField, CastCandidateList, ResolveCastCandidate, CreateCastCharacter, EditCastCharacter } from "@infinite-quest/contracts";
import { castScanRecovery, renderLegacyCastScan } from "./campaign-cast-scan-panel.js";

const fields: [CastField, string][] = [
  ["identity.pronouns", "Pronouns"], ["story.role", "Role"], ["story.background", "Background"],
  ["story.personality", "Personality"], ["story.motivations", "Motivations"], ["story.goals", "Goals"],
  ["story.voiceAndMannerisms", "Voice and mannerisms"], ["appearance.description", "Appearance"],
  ["state.location", "Last known location"], ["state.condition", "Condition"], ["state.clothing", "Clothing"]
];
type List = Awaited<ReturnType<CampaignCastApi["list"]>>;
export function createLegacyCastPanel(options: {
  api: Omit<CampaignCastApi, "scans" | "sourceTurn"> & Partial<Pick<CampaignCastApi, "scans" | "sourceTurn">>; campaignId(): string | null; generationActive(): boolean;
  getProfile?(campaign: string): Promise<CampaignCharacterProfile & { revision: number }>;
  openProtagonist(): void; navigateToTurn(turn: number): Promise<void>; confirmDiscard?: () => boolean;
}) {
  const dialog = document.createElement("dialog");
  dialog.id = "campaignCastDialog"; dialog.className = "cast-dialog";
  dialog.setAttribute("aria-labelledby", "cast-title"); document.body.append(dialog);
  let campaign = "", epoch = 0, editor: CastEditorState | null = null, list: List | null = null;
  let enabled = false, query = "", filter: CharacterFilter = "all", latest: CastDetail | null = null, returnFocus: HTMLElement | null = null;
  let latestRoster: List | null = null;
  let discovery: CastDiscoveryStatus | null = null;
  let recovery: Awaited<ReturnType<CampaignCastApi["workspaceStatus"]>>["recovery"];
  let rosterVisible = false; let autoMatch: boolean | null = null;
  let attention: { identities: number | null; details: number | null; conflicts: number | null } | null = null;
  const workspace = createCharactersWorkspaceSession<CastEditorState>({ api: options.api, onChange(next) {
    if (!dialog.open || next.campaignId !== campaign) return;
    attention = next.status?.counts ?? null; autoMatch = next.status?.capabilities.autoMatch ?? null;
    const notice = dialog.querySelector<HTMLElement>("[data-cast-attention]");
    if (notice && attention) { const count = (value: number | null) => value === null ? "unavailable" : String(value); notice.textContent = `Attention — identity matches: ${count(attention.identities)} · details: ${count(attention.details)} · conflicts: ${count(attention.conflicts)}`; }
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
  function discardAllowed() {
    return !editor?.saving && (!editor?.dirty || (options.confirmDiscard ?? (() => window.confirm("Discard unsaved character changes?")))());
  }
  function requestClose() {
    if (!discardAllowed()) return;
    epoch++; editor = null; workspace.close(); operationKeys.clear(); dialog.close(); returnFocus?.focus();
  }
  function shell(title: string) {
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
    const token = ++epoch; editor = null; latest = null; latestRoster = null; rosterVisible = true;
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
      const data = scanId ? { ...latestData, scan: await options.api.scans.get(campaign, scanId) } : latestData;
      if (!current(token)) return;
      scanData = data; list = roster; discovery = tracking;
      shell("Scan earlier story"); dialog.append(button("Back to characters", () => { void loadRoster(); }));
      renderLegacyCastScan(dialog, { api: options.api.scans, campaignId: campaign, authority: roster, data, discovery: tracking,
        current: () => current(token), generationActive: options.generationActive, refresh: () => loadScan(scanId) });
    } catch (error) {
      if (!current(token)) return;
      shell("Scan earlier story"); status(message(error));
      dialog.append(button("Refresh scan", () => { void loadScan(); }), button("Back to characters", () => { void loadRoster(); }));
    }
  }
  async function loadCandidates() { loadReview(); }
  function loadReview() {
    rosterVisible = false; const token = ++epoch; editor = null; shell("Character review");
    renderCastReview({ document, container: dialog, api: options.api, campaign, current: () => current(token),
      autoMatch, editing: () => enabled && !options.generationActive(), navigate: turn => { requestClose(); void options.navigateToTurn(turn); },
      back: () => { void loadRoster(); }, key: operationKey, clearKeys: () => operationKeys.clear() });
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
  async function loadDetails() { loadReview(); }
  function renderRoster() {
    shell("Characters");
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
    const notice = status("Attention counts are unavailable."); notice.dataset.castAttention = "";
    if (attention) { const count = (value: number | null) => value === null ? "unavailable" : String(value); notice.textContent = `Attention — identity matches: ${count(attention.identities)} · details: ${count(attention.details)} · conflicts: ${count(attention.conflicts)}`; }
    dialog.append(button("Review conflicts", () => { filter = "conflicts"; workspace.setQuery(query, filter); void loadRoster(); }));
    dialog.append(button("Refresh characters", () => { void loadRoster(); }), button("Review character changes", () => { void loadDetails(); }), button("Likely included for this input", previewContext));
    if (scanData && (scanData.capabilities.castBackfill || scanData.scan)) dialog.append(button("Scan earlier story", () => { void loadScan(); }));
    const controls = node("form"); controls.className = "cast-toolbar";
    const label = node("label", "Find a character"); label.htmlFor = "cast-search";
    const search = node("input"); search.id = "cast-search"; search.type = "search"; search.value = query; search.maxLength = 200;
    const submit = node("button", "Search"); submit.type = "submit";
    const filterLabel = node("label", "Filter characters"), filterSelect = node("select"); filterLabel.htmlFor = "cast-filter"; filterSelect.id = "cast-filter";
    for (const [value, label] of [["all", "All"], ["main", "Main"], ["recent", recentFilterLabel(list?.recentWindow)], ["pinned", "Pinned"], ["needs_review", "Needs review"], ["conflicts", "Conflicts"], ["ignored", "Ignored"]]) { const option = node("option", label); option.value = value!; option.selected = value === filter; filterSelect.append(option); }
    filterSelect.addEventListener("change", () => { filter = filterSelect.value as CharacterFilter; query = search.value; workspace.setQuery(query, filter); void loadRoster(); });
    controls.append(label, search, filterLabel, filterSelect, submit);
    controls.addEventListener("submit", (event) => { event.preventDefault(); query = search.value; workspace.setQuery(query, filter); void loadRoster(); });
    dialog.append(controls);
    if (!enabled) status("Character editing is disabled. Saved characters remain available to read.");
    else if (options.generationActive()) status("Finish or resolve the current generation before editing characters.");
    else dialog.append(button("Add character", () => { editor = createCastEditor(list!); renderEditor(); }));
    if (filter === "recent") status(recentFilterLabel(list!.recentWindow));
    const roster = node("ul"); roster.className = "cast-roster";
    for (const person of list!.characters) {
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
    if (!discardAllowed()) return;
    rosterVisible = false; workspace.select(id);
    const token = ++epoch; shell("Character"); status("Loading character…");
    try {
      const detail = await options.api.detail(campaign, id);
      if (!current(token)) return;
      enabled = detail.capabilities.castEditing;
      editor = createCastEditor(detail, detail); latest = null;
      let profile: (CampaignCharacterProfile & { revision: number }) | null = null;
      if (detail.character.origin.kind === "protagonist" && options.getProfile) profile = await options.getProfile(campaign).catch(() => null);
      if (!current(token)) return; renderSheet(detail, profile);
    } catch (error) {
      if (!current(token)) return;
      shell("Character"); status(`Could not load this character: ${message(error)}`);
      dialog.append(button("Back to characters", () => { void loadRoster(); }));
    }
  }
  function renderSheet(detail: CastDetail, profile: (CampaignCharacterProfile & { revision: number }) | null = null) {
    const sheet = profile ? buildCharacterSheet({ kind: "protagonist", profile: { name: profile.name, profile: profile.profile }, revision: profile.revision }) : buildCharacterSheet({ kind: "supporting", detail });
    shell(sheet.name); dialog.classList.add("cast-sheet-layout");
    const sidebar = node("nav"); sidebar.className = "cast-sheet-roster"; sidebar.setAttribute("aria-label", "Characters");
    for (const person of list?.characters ?? []) sidebar.append(button(person.name, () => { void openDetail(person.id); })); dialog.append(sidebar);
    dialog.append(button("Back to characters", () => { void loadRoster(); }), node("p", `Last observed turn ${detail.character.lastObservedTurn}${detail.character.lastMentionedTurn != null ? ` · Last mentioned turn ${detail.character.lastMentionedTurn}` : ""}`));
    if (detail.character.origin.kind === "protagonist") {
      status("This is your main character.");
      dialog.append(button("Edit main character", () => { requestClose(); options.openProtagonist(); }));
    } else {
      dialog.append(button("Edit character", () => { workspace.setDraft(editor); renderEditor(); }, !enabled || options.generationActive()));
    }
    for (const section of sheet.sections) {
      const group = node("section"); group.className = "cast-sheet-section"; group.append(node("h3", section.name));
      for (const field of section.fields) {
        const row = node("p"); const label = node("strong", `${field.label}: `);
        const value = Array.isArray(field.value) ? field.value.join(", ") : field.value;
        row.append(label, node("span", value || (field.origin === "conflicted" ? "Conflicting observations" : field.origin === "claim" ? "Unverified claim" : "Unknown")), node("small", field.origin === "unknown" ? "" : ` · ${field.origin}`)); group.append(row);
      }
      dialog.append(group);
    }
    for (const match of detail.autoMatches) {
      const row = node("section"); row.append(node("p", `${match.basis === "unique_world_name" ? "Unique world name" : "Unique campaign name"} · turn ${match.turnNumber}: “${match.quote}”`));
      row.append(button("Not this character", async () => {
        try { await options.api.detachAttachment(campaign, detail.character.id, match.eventId, { expectedCastRevision: detail.revision, expectedBoundary: detail.boundary, expectedCharacterRevision: detail.character.revision, idempotencyKey: operationKey("detach", [campaign, detail.character.id, match.eventId, detail.revision, detail.boundary, detail.character.revision]) }); operationKeys.clear(); await openDetail(detail.character.id); }
        catch { row.append(node("p", "Could not undo this match. Refresh and try again.")); }
      }, !enabled || options.generationActive())); dialog.append(row);
    }
    renderEvidence();
  }
  function renderEditor() {
    if (!editor) return;
    const expanded = new Map([...dialog.querySelectorAll<HTMLDetailsElement>("[data-cast-group]")].map(group => [group.dataset.castGroup!, group.open]));
    const focusId = dialog.contains(document.activeElement) ? (document.activeElement as HTMLElement).id : "";
    const protagonist = editor.loaded?.character.origin.kind === "protagonist";
    const locked = !enabled || options.generationActive() || editor.saving || protagonist;
    shell(editor.characterId ? "Character details" : "Add character");
    dialog.append(button("Back to characters", () => { if (discardAllowed()) void loadRoster(); }, editor.saving));
    if (protagonist) {
      status("This is your main character. Use its existing profile editor.");
      dialog.append(button("Edit main character", () => { requestClose(); options.openProtagonist(); }));
    } else if (!enabled) status("Character editing is disabled. Your draft is kept here until you close it.");
    else if (options.generationActive()) status("Finish or resolve the current generation before editing characters.");
    const form = node("form"); form.className = "cast-editor";
    form.append(node("p", editor.characterId ? "Saved facts are filled in. Edit only what needs changing." : "Only a name is required. Add details you know, or review story matches to fill characters from evidence."));
    const save = node("button", editor.saving ? "Saving…" : "Save character"); save.type = "submit"; save.className = "primary"; save.id = "cast-save";
    const syncSave = () => { save.disabled = Boolean(locked) || !canSaveCastEditor(editor!); };
    function textInput(label: string, id: string, value: string, max: number, changed: (value: string) => void, multiline = false) {
      const wrap = node("div"), caption = node("label", label); caption.htmlFor = id;
      const input = multiline ? node("textarea") : node("input"); input.id = id; input.value = value; input.maxLength = max;
      input.disabled = Boolean(locked); input.addEventListener("input", () => { changed(input.value); syncSave(); });
      wrap.append(caption, input); form.append(wrap); return wrap;
    }
    textInput("Name", "cast-name", editor.draft.name, 200, (name) => { editor = changeCastEditor(editor!, { name }); });
    textInput("Aliases (one per line)", "cast-aliases", editor.draft.aliases.join("\n"), 4020,
      (value) => { editor = changeCastEditor(editor!, { aliases: value.split("\n").map((v) => v.trim()).filter(Boolean) }); }, true);
    const groups = new Map<string, HTMLDetailsElement>();
    for (const [key, title] of [["story", "Story profile"], ["appearance", "Appearance details"], ["state", "Current state"]]) {
      const group = node("details"); group.className = "cast-field-group"; group.dataset.castGroup = key!;
      group.open = expanded.get(key!) ?? (key === "story" || Boolean(editor.characterId) && key === "appearance");
      group.append(node("summary", title)); groups.set(key!, group); form.append(group);
    }
    for (const [field, label] of fields) {
      const wrap = textInput(label, `cast-${field.replace(".", "-")}`, editor.draft.profile[field] ?? "", 2000,
        (value) => { editor = setCastEditorField(editor!, field, value); }, true);
      const fieldStatus = node("div"); wrap.append(fieldStatus);
      function syncFieldStatus() {
        const overriding = Object.hasOwn(editor!.setOverrides, field) || editor!.loaded?.overrides.some((o) => o.field === field);
        fieldStatus.replaceChildren(node("small", editor!.clearOverrides.includes(field) ? "Will use the discovered value after saving." : overriding ? "Your override" : Object.hasOwn(editor!.draft.profile, field) ? "From recorded evidence" : "Unknown"));
        if (editor!.characterId && !protagonist && overriding && !editor!.clearOverrides.includes(field)) fieldStatus.append(button(`Use discovered value for ${label.toLowerCase()}`, () => {
          editor = setCastEditorField(editor!, field, null); renderEditor();
        }, Boolean(locked)));
      }
      wrap.querySelector("textarea, input")!.addEventListener("input", syncFieldStatus); syncFieldStatus();
      const group = groups.get(field.split(".")[0]!); if (group) group.append(wrap);
    }
    if (editor.characterId && !protagonist) for (const [key, label] of [["pinned", "Pin character"], ["ignored", "Ignore character"]] as const) {
      const caption = node("label", label), control = node("input"); control.type = "checkbox";
      control.checked = editor.draft[key]; control.disabled = Boolean(locked);
      control.addEventListener("change", () => { editor = changeCastEditor(editor!, { [key]: control.checked }); syncSave(); });
      caption.prepend(control); form.append(caption);
    }
    if (editor.characterId && !protagonist) form.append(node("small", "Pin prioritizes this character in story context. Ignore excludes this supporting character from story context."));
    if (editor.error) { const error = node("p", editor.error); error.setAttribute("role", "alert"); form.append(error); }
    if (editor.conflict) {
      form.append(button("Compare latest", () => { void compareLatest(); }));
      if (latest) {
        const comparison = node("div");
        comparison.append(node("p", `Name: ${latest.character.name}`), node("p", `Aliases: ${latest.character.aliases.join(", ") || "None"}`));
        for (const [field, label] of fields) comparison.append(node("p", `${label}: ${latest.character.profile[field] ?? "Unknown"}`));
        comparison.className = "cast-comparison"; form.append(node("h3", "Latest saved character"), comparison);
        form.append(button("Reapply my changes", () => { editor = reapplyCastDraft(editor!, latest!); latest = null; renderEditor(); }, !enabled));
        form.append(button("Discard draft and load latest", () => { if (discardAllowed()) { editor = createCastEditor(latest!, latest!); latest = null; renderEditor(); } }));
      }
      if (latestRoster && !editor.characterId) {
        form.append(node("p", `Latest cast: ${latestRoster.characters.map((person) => person.name).join(", ") || "empty"}. Your new character has not been saved.`));
        form.append(button("Reapply my changes", () => { editor = reapplyNewCastDraft(editor!, latestRoster!); latestRoster = null; renderEditor(); }, !enabled));
      }
    }
    syncSave(); if (!protagonist && enabled) form.append(save);
    form.append(button("Cancel", () => { if (discardAllowed()) void loadRoster(); }, editor.saving));
    form.addEventListener("submit", (event) => { event.preventDefault(); void saveDraft(); }); dialog.append(form);
    renderEvidence();
    const focus = document.getElementById(focusId || "cast-name");
    if (focus instanceof HTMLElement && !focus.hasAttribute("disabled")) focus.focus({ preventScroll: true });
  }
  function renderEvidence() {
    if (!editor?.loaded) return;
    const details = node("details"), summary = node("summary", "Sources and edit history"); details.append(summary);
    for (const item of [...editor.loaded.identityEvents.map((event) => ({ label: `Name: ${event.name}`, evidence: event.evidence })),
      ...editor.loaded.observations.map((observation) => ({ label: `${observation.mode === "claim" ? "Claim" : "Observation"}: ${observation.field} — ${observation.value}`, evidence: observation.evidence })),
      ...editor.loaded.overrides.map((override) => ({ label: `Your override: ${override.field} — ${override.value || "(blank)"}`, evidence: override.evidence }))]) {
      const row = node("p", item.label); const evidence = item.evidence;
      if (evidence.kind === "turn") {
        row.append(node("span", ` — “${evidence.quote}” `));
        row.append(button(`Turn ${evidence.turnNumber}${evidence.invalidated ? " (replaced)" : ""}`, () => {
          if (discardAllowed()) { editor = null; requestClose(); void options.navigateToTurn(evidence.turnNumber); }
        }, evidence.invalidated === true));
      } else row.append(node("span", evidence.kind === "user" ? ` — Your edit at turn ${evidence.effectiveTurnNumber}` : " — World source"));
      details.append(row);
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
  async function saveDraft() {
    if (!editor || !enabled || options.generationActive() || !canSaveCastEditor(editor)) return;
    const token = epoch;
    try {
      editor = prepareCastSubmission(editor, crypto.randomUUID()); renderEditor();
      const result = editor.characterId ? await options.api.edit(campaign, editor.characterId, editor.submission as EditCastCharacter)
        : await options.api.create(campaign, editor.submission as CreateCastCharacter);
      if (!current(token)) return;
      editor = null; await openDetail(result.character.id); if (editor) renderEditor();
    } catch (error) {
      if (!current(token) || !editor) return;
      const code = (error as { statusCode?: number }).statusCode;
      editor = failCastSubmission(editor, code === 409 ? "The character or campaign changed, or generation is active. Your draft is kept. Compare the latest version before reapplying." : message(error), code === 409);
      if (code === 503) enabled = false;
      renderEditor();
    }
  }
  function message(error: unknown) { return error instanceof Error ? error.message : "The request failed. Please try again."; }
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); requestClose(); });
  window.addEventListener("beforeunload", (event) => { if (editor?.dirty) { event.preventDefault(); event.returnValue = ""; } });
  return { requestClose, async open(focusTarget?: HTMLElement | null) {
    const id = options.campaignId(); if (!id || dialog.open) return;
    campaign = id; query = ""; filter = "all"; returnFocus = focusTarget ?? document.activeElement as HTMLElement | null;
    shell("Characters"); dialog.showModal(); workspace.open(campaign); await loadRoster();
  } };
}
