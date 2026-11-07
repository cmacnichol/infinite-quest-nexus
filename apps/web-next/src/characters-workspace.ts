import { renderCastReview } from "../../web/src/cast-review-queue.js";
import { castScanRecovery, renderLegacyCastScan } from "./campaign-cast-scan-panel";
import { createCharacterProfileForm } from "./character-profile-form";
import { buildCharacterSheet, createCastEditor, changeCastEditor, setCastEditorField, canSaveCastEditor, prepareCastSubmission, failCastSubmission, reapplyCastDraft, reapplyNewCastDraft, SUPPORTING_FIELDS, characterProvenanceLabel, recentFilterLabel, type CastEditorState } from "@infinite-quest/client-core";
import { createCampaignCastApi, createCharactersWorkspaceSession, type CharactersWorkspaceState } from "@infinite-quest/client-web";
import type { CampaignCharacterProfile, CampaignCharacterProfileUpdate, CastCharacter, CharacterFilter, CreateCastCharacter, EditCastCharacter } from "@infinite-quest/contracts";

type ProtagonistProfile = CampaignCharacterProfile & { revision: number };

export function createCharactersWorkspace(document: Document, generationActive: () => boolean,
  saveProfile: (campaign: string, update: CampaignCharacterProfileUpdate) => Promise<ProtagonistProfile>,
  navigateToTurn: (turn: number) => void, getProfile: (campaign: string) => Promise<ProtagonistProfile>,
  onProfileSaved: (campaign: string) => void = () => {}) {
  const api = createCampaignCastApi();
  const dialog = document.createElement("dialog"); dialog.className = "characters-workspace"; document.body.append(dialog);
  let openEpoch = 0; let toolEpoch = 0; let protagonist: ProtagonistProfile | null = null; let protagonistLoading = false;
  let profileEditor: { form: ReturnType<typeof createCharacterProfileForm>; saving: boolean } | null = null;
  let state: CharactersWorkspaceState<CastEditorState>, editor: CastEditorState | null = null, filter: CharacterFilter = "all", query = "", focus: HTMLElement | null = null, reviewing = false;
  const session = createCharactersWorkspaceSession<CastEditorState>({ api, onChange(next) { state = next; render(); } });
  const operationKeys = new Map<string, string>();
  function operationKey(operation: string, payload: unknown) { const key = `${operation}:${JSON.stringify(payload)}`; let id = operationKeys.get(key); if (!id) { id = crypto.randomUUID(); operationKeys.set(key, id); } return id; }
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "") => { const el = document.createElement(tag); el.textContent = text; return el; };
  const button = (text: string, action: () => void, disabled = false) => { const el = node("button", text); el.type = "button"; el.disabled = disabled; el.addEventListener("click", action); return el; };
  const discard = () => !(editor?.dirty || profileEditor?.form.dirty) || (document.defaultView?.confirm("Discard unsaved character changes?") ?? false);
  function close() { if (editor?.saving || profileEditor?.saving || !discard()) return; openEpoch++; toolEpoch++; editor = null; profileEditor = null; reviewing = false; session.close(); operationKeys.clear(); dialog.close(); focus?.focus(); }
  function render() {
    if (!state || !dialog.open || reviewing || profileEditor) return;
    if (editor) { if (state.changedWhileEditing && !dialog.querySelector("[data-stale]")) { const notice = node("p", "This character changed while you were editing. Your draft is preserved; compare the latest before saving."); notice.dataset.stale = ""; dialog.prepend(notice); } return; }
    const sourceOpen = dialog.querySelector("details")?.open ?? false; const scroll = dialog.scrollTop;
    dialog.classList.toggle("characters-sheet-layout", Boolean(state.selectedId));
    dialog.replaceChildren(); const head = node("header"); head.append(node("h2", state.detail?.character.name ?? "Characters"), button("Close", close)); dialog.append(head);
    if (state.error) dialog.append(node("p", "Characters could not be refreshed. Try again."), button("Retry", () => { void session.refresh(); }));
    if (!state.status) { dialog.append(node("p", "Loading characters…")); return; }
    if (state.selectedId) {
      const sidebar = node("nav"); sidebar.className = "characters-sheet-roster"; sidebar.setAttribute("aria-label", "Characters"); for (const person of state.characters) sidebar.append(button(person.name, () => session.select(person.id))); dialog.append(sidebar);
      dialog.append(button("Back to characters", () => session.select(null)));
      if (!state.detail) { dialog.append(node("p", "Loading character…")); return; }
      const detail = state.detail;
      if (detail.character.origin.kind === "protagonist" && !protagonist && !protagonistLoading && state.campaignId) {
        protagonistLoading = true; const campaign = state.campaignId, epoch = openEpoch;
        void getProfile(campaign).then(value => { if (epoch === openEpoch && state.campaignId === campaign) { protagonist = value; protagonistLoading = false; render(); } }).catch(() => { protagonistLoading = false; });
      }
      const sheet = protagonist && detail.character.origin.kind === "protagonist" ? buildCharacterSheet({ kind: "protagonist", profile: { name: protagonist.name, profile: protagonist.profile }, revision: protagonist.revision }) : buildCharacterSheet({ kind: "supporting", detail });
      dialog.append(node("p", `Last observed turn ${detail.character.lastObservedTurn}${detail.character.lastMentionedTurn != null ? ` · Last mentioned turn ${detail.character.lastMentionedTurn}` : ""}`));
      if (detail.character.origin.kind === "protagonist") dialog.append(button("Edit main character", () => { if (protagonist && state.campaignId) renderProfileEditor(state.campaignId, protagonist); }, generationActive() || !protagonist));
      else dialog.append(button("Edit character", () => { editor = createCastEditor(detail, detail); session.setDraft(editor); renderEditor(); }, state.status.capabilities.editing !== true || generationActive()));
      for (const section of sheet.sections) { const group = node("section"); group.append(node("h3", section.name)); for (const field of section.fields) { const value = Array.isArray(field.value) ? field.value.join(", ") : field.value; group.append(node("p", `${field.label}: ${value || (field.origin === "conflicted" ? "Conflicting observations" : field.origin === "claim" ? "Unverified claim" : "Unknown")} ${field.origin === "unknown" ? "" : `· ${field.origin}`}`)); } dialog.append(group); }
      const sources = node("details"); sources.append(node("summary", "Sources and edit history"));
      for (const observation of detail.observations) {
        const row = node("p", `${observation.mode === "claim" ? "Claim" : "Observation"}: ${observation.field} — ${observation.value}`);
        if (observation.evidence.kind === "turn") { const evidence = observation.evidence; row.append(node("span", ` — “${evidence.quote}” `), button(`Turn ${evidence.turnNumber}${evidence.invalidated ? " (replaced)" : ""}`, () => { close(); navigateToTurn(evidence.turnNumber); }, evidence.invalidated === true)); }
        sources.append(row);
      } dialog.append(sources);
      for (const match of detail.autoMatches) {
        const row = node("section"); row.append(node("p", `${match.basis === "unique_world_name" ? "Unique world name" : "Unique campaign name"} · turn ${match.turnNumber}: “${match.quote}”`));
        row.append(button("Not this character", async () => {
          if (!state.campaignId || generationActive()) return;
          try { await api.detachAttachment(state.campaignId, detail.character.id, match.eventId, { expectedCastRevision: detail.revision, expectedBoundary: detail.boundary, expectedCharacterRevision: detail.character.revision, idempotencyKey: operationKey("detach", [state.campaignId, detail.character.id, match.eventId, detail.revision, detail.boundary, detail.character.revision]) }); operationKeys.clear(); await session.refresh(); }
          catch { row.append(node("p", "Could not undo this match. Refresh and try again.")); }
        }, state.status.capabilities.editing !== true || generationActive())); dialog.append(row);
      }
      const expanded = dialog.querySelector("details"); if (expanded) expanded.open = sourceOpen; dialog.scrollTop = scroll;
      return;
    }
    const tracking = state.status.tracking;
    if (!tracking) dialog.append(node("p", "Character tracking status is unavailable. Saved characters are still available."));
    else {
      const messages = { disabled: "Automatic character tracking is disabled.", not_enrolled: "Character tracking starts with the next accepted turn.", catching_up: "Character tracking is catching up.", failed: "Character tracking stopped. Your story is saved.", complete: "Character tracking is up to date." };
      dialog.append(node("p", messages[tracking.state]));
      if (tracking.coverageStartTurn !== null) dialog.append(node("p", tracking.trackedThroughTurn !== null && tracking.trackedThroughTurn >= tracking.coverageStartTurn ? `Tracked turns ${tracking.coverageStartTurn}–${tracking.trackedThroughTurn}. Earlier turns are not included.` : `Tracking starts at turn ${tracking.coverageStartTurn}.`));
      if (tracking.unresolvedCount) dialog.append(node("p", `${tracking.unresolvedCount} character matches need review.`));
      if (tracking.firstGap) {
        const reason = castScanRecovery(tracking, state.status.boundary.turnNumber).diagnostic;
        dialog.append(node("p", `First tracking gap: turn ${tracking.firstGap.turnNumber} (${tracking.firstGap.status.replaceAll("_", " ")}).${reason ? ` ${reason}` : ""}`),
          ...(state.status.recovery?.kind === "scan" && state.status.recovery.scanId && state.status.recovery.scanStatus !== "cancelled"
            ? [button("Open tracking recovery", () => { void scan(state.status!.recovery!.scanId!); })] : []));
        if (tracking.state === "failed" && tracking.enabled && tracking.firstGap.jobId && state.status.recovery?.kind === "forward" && state.status.recovery.jobId === tracking.firstGap.jobId) {
          const job = tracking.firstGap.jobId, campaign = state.campaignId!, status = state.status;
          const feedback = node("p"); feedback.setAttribute("role", "status");
          const retry = button("Retry character tracking", async () => {
            retry.disabled = true;
            try {
              await api.retryDiscovery(campaign, job, { expectedCastRevision: status.revision, expectedBoundary: status.boundary, idempotencyKey: operationKey("retry", [campaign, job, status.revision, status.boundary]) });
              operationKeys.clear(); await session.refresh();
            } catch (error) {
              if (state.campaignId !== campaign || !dialog.open) return;
              const conflict = (error as { statusCode?: number }).statusCode === 409;
              feedback.textContent = conflict ? "The story or cast changed. Refresh characters before retrying." : "Could not confirm the retry. Try again to check the same request.";
              retry.disabled = conflict || generationActive();
            }
          }, status.capabilities.editing !== true || generationActive());
          dialog.append(retry, feedback);
        }
      }
    }
    const counts = state.status.counts;
    const count = (value: number | null) => value === null ? "unavailable" : String(value);
    dialog.append(node("p", `Attention — identity matches: ${count(counts.identities)} · details: ${count(counts.details)} · conflicts: ${count(counts.conflicts)}`),
      button("Review conflicts", () => { filter = "conflicts"; session.setQuery(query, filter); }));
    dialog.append(button("Scan earlier story", () => { void scan(); }), button("Likely included for this input", () => { void preview(); }), button("Review character changes", () => { void review("matches"); }));
    const form = node("form"), search = node("input"), select = node("select"); search.type = "search"; search.value = query; search.setAttribute("aria-label", "Find a character");
    for (const [value, label] of [["all", "All"], ["main", "Main"], ["recent", recentFilterLabel(state.recentWindow)], ["pinned", "Pinned"], ["needs_review", "Needs review"], ["conflicts", "Conflicts"], ["ignored", "Ignored"]]) { const option = node("option", label); option.value = value!; select.append(option); } select.value = filter; select.setAttribute("aria-label", "Filter characters");
    form.append(search, select, button("Search", () => { query = search.value; filter = select.value as CharacterFilter; session.setQuery(query, filter); })); form.addEventListener("submit", event => { event.preventDefault(); query = search.value; filter = select.value as CharacterFilter; session.setQuery(query, filter); }); select.addEventListener("change", () => { query = search.value; filter = select.value as CharacterFilter; session.setQuery(query, filter); }); dialog.append(form);
    dialog.append(button("Add character", async () => {
      if (!state.campaignId) return; const campaign = state.campaignId, epoch = openEpoch; const roster = await api.list(campaign); if (epoch !== openEpoch || state.campaignId !== campaign || !dialog.open) return; editor = createCastEditor(roster); session.setDraft(editor); renderEditor();
    }, state.status.capabilities.editing !== true || generationActive()));
    const roster = node("ul"); for (const person of state.characters) {
      const item = node("li"), attention = state.attention[person.id];
      const facts = [person.profile["story.role"], characterProvenanceLabel(person), person.pinned ? "Pinned" : "", person.ignored ? "Ignored" : "",
        attention?.review ? `Needs review${attention.reviewCount != null ? ` (${attention.reviewCount})` : ""}` : "", attention?.conflict ? `Conflicting details${attention.conflictCount != null ? ` (${attention.conflictCount})` : ""}` : "", `Last observed turn ${person.lastObservedTurn}`,
        person.lastMentionedTurn != null ? `Last mentioned turn ${person.lastMentionedTurn}` : ""].filter(Boolean).join(" · ");
      item.append(button(person.name, () => session.select(person.id)), node("span", ` ${facts}`)); roster.append(item);
    }
    if (filter === "recent") dialog.append(node("p", recentFilterLabel(state.recentWindow))); dialog.append(roster); if (!state.characters.length) dialog.append(node("p", "No characters match."));
  }
  async function scan(scanId?: string) {
    if (!state.campaignId) return; const campaign = state.campaignId, tool = ++toolEpoch; reviewing = true; dialog.classList.remove("characters-sheet-layout");
    try {
      const [latestData, authority, discovery] = await Promise.all([api.scans.latest(campaign), api.list(campaign), api.discoveryStatus(campaign)]);
      const data = scanId ? { ...latestData, scan: await api.scans.get(campaign, scanId) } : latestData;
      if (!reviewing || tool !== toolEpoch || state.campaignId !== campaign || !dialog.open) return;
      dialog.replaceChildren(node("h2", "Scan earlier story"), button("Back to characters", () => { reviewing = false; toolEpoch++; render(); }));
      renderLegacyCastScan(dialog, { api: api.scans, campaignId: campaign, authority, data, discovery, current: () => reviewing && tool === toolEpoch && state.campaignId === campaign && dialog.open, generationActive, refresh: () => scan(scanId) });
    } catch { if (!reviewing || tool !== toolEpoch || state.campaignId !== campaign || !dialog.open) return; dialog.replaceChildren(node("p", "Could not load scan."), button("Retry", () => { void scan(); }), button("Back to characters", () => { reviewing = false; toolEpoch++; render(); })); }
  }
  async function preview() {
    if (!state.campaignId) return; const campaign = state.campaignId, tool = ++toolEpoch; reviewing = true; dialog.classList.remove("characters-sheet-layout");
    dialog.replaceChildren(node("h2", "Likely included for this input"), button("Back to characters", () => { reviewing = false; toolEpoch++; render(); }));
    const label = node("label", "Story input"), input = node("textarea"), result = node("section"); label.append(input);
    dialog.append(label, button("Refresh estimate", async () => { try { const data = await api.contextPreview(campaign, { query: input.value }); if (!reviewing || tool !== toolEpoch || state.campaignId !== campaign || !dialog.open) return; result.replaceChildren(node("p", `Estimate at turn ${data.boundary.turnNumber}, cast revision ${data.castRevision}. Refresh after your story or characters change.`)); result.append(node("p", `Estimated usage: ${data.usedTokens.toLocaleString()} of ${data.budgetTokens.toLocaleString()} tokens.`));
      if (data.note) result.append(node("p", data.note)); if (data.disabledReason) result.append(node("p", data.disabledReason));
      if (!data.selected.length && !data.omitted.length && !data.disabledReason) result.append(node("p", "No characters are likely to be included for this input."));
      for (const item of data.selected) result.append(node("p", `Included: ${item.name} · ${item.reason.replaceAll("_", " ")}`));
      if (data.omitted.length) {
        const names = new Map<string, string>(); let cursor: string | undefined;
        try { do { const page = await api.list(campaign, { limit: 50, ...(cursor ? { cursor, expectedRevision: data.castRevision } : {}) }); if (page.revision !== data.castRevision) break; for (const person of page.characters) names.set(person.id, person.name); cursor = page.nextCursor ?? undefined; } while (cursor); } catch { /* The estimate is still useful if names cannot be loaded. */ }
        if (!(reviewing && tool === toolEpoch && state.campaignId === campaign && dialog.open)) return;
        for (const item of data.omitted) result.append(node("p", `Omitted: ${names.get(item.characterId) ?? "Character unavailable"} · ${item.reason.replaceAll("_", " ")}`));
      } } catch { if (reviewing && tool === toolEpoch && state.campaignId === campaign && dialog.open) result.replaceChildren(node("p", "Estimate unavailable.")); } }), result);
  }
  async function review(_view: "matches" | "details") {
    if (!state.campaignId) return; const campaign = state.campaignId, epoch = openEpoch, tool = ++toolEpoch; reviewing = true; dialog.classList.remove("characters-sheet-layout");
    renderCastReview({ document, container: dialog, api, campaign, current: () => reviewing && tool === toolEpoch && state.campaignId === campaign && epoch === openEpoch && dialog.open,
      autoMatch: state.status?.capabilities.autoMatch, editing: () => state.status?.capabilities.editing === true && !generationActive(), navigate: turn => { close(); navigateToTurn(turn); },
      back: () => { reviewing = false; toolEpoch++; render(); }, key: operationKey, clearKeys: () => operationKeys.clear() });
  }
  function renderEditor() {
    if (!editor) return;
    const expanded = new Map([...dialog.querySelectorAll<HTMLDetailsElement>("[data-cast-group]")].map(group => [group.dataset.castGroup!, group.open]));
    dialog.classList.remove("characters-sheet-layout"); dialog.replaceChildren(); dialog.append(node("h2", editor.characterId ? "Edit character" : "Add character")); const form = node("form"), save = node("button", "Save character"); save.type = "submit";
    form.append(node("p", editor.characterId ? "Saved facts are filled in. Edit only what needs changing." : "Only a name is required. Add details you know, or review story matches to fill characters from evidence."));
    const syncSave = () => { save.disabled = !canSaveCastEditor(editor!) || generationActive() || state.changedWhileEditing; };
    const input = (label: string, value: string, change: (value: string) => void, multiline = true) => { const wrap = node("label", label), control = multiline ? node("textarea") : node("input"); control.value = value; control.maxLength = label === "Name" ? 200 : label.startsWith("Aliases") ? 4020 : 2000; control.setAttribute("aria-label", label); control.disabled = generationActive() || editor!.saving; control.addEventListener("input", () => { change(control.value); syncSave(); }); wrap.append(control); form.append(wrap); return wrap; };
    input("Name", editor.draft.name, value => { editor = changeCastEditor(editor!, { name: value }); }, false);
    input("Aliases (one per line)", editor.draft.aliases.join("\n"), value => { editor = changeCastEditor(editor!, { aliases: value.split("\n").map(v => v.trim()).filter(Boolean) }); });
    const groups = new Map<string, HTMLDetailsElement>();
    for (const [key, title] of [["story", "Story profile"], ["appearance", "Appearance details"], ["state", "Current state"]]) {
      const group = node("details"); group.className = "characters-editor-group"; group.dataset.castGroup = key!;
      group.open = expanded.get(key!) ?? (key === "story" || Boolean(editor.characterId) && key === "appearance");
      group.append(node("summary", title)); groups.set(key!, group); form.append(group);
    }
    for (const field of SUPPORTING_FIELDS) {
      const path = field.path as Parameters<typeof setCastEditorField>[1];
      const wrap = input(field.label, editor.draft.profile[path] ?? "", value => { editor = setCastEditorField(editor!, path, value); }, field.input !== "text");
      const fieldStatus = node("span"); wrap.append(fieldStatus);
      function syncFieldStatus() {
        const overriding = Object.hasOwn(editor!.setOverrides, path) || editor!.loaded?.overrides.some(override => override.field === path);
        fieldStatus.replaceChildren();
        if (editor!.clearOverrides.includes(path)) fieldStatus.append(node("small", "Will use the discovered value after saving."));
        else if (overriding) fieldStatus.append(node("small", "Your override"));
        if (editor!.characterId && overriding && !editor!.clearOverrides.includes(path)) fieldStatus.append(button(`Use discovered value for ${field.label.toLowerCase()}`, () => { editor = setCastEditorField(editor!, path, null); renderEditor(); }, generationActive() || editor!.saving));
      }
      wrap.querySelector("textarea, input")!.addEventListener("input", syncFieldStatus); syncFieldStatus();
      groups.get(field.path.split(".")[0]!)?.append(wrap);
    }
    if (editor.characterId) for (const [key, label] of [["pinned", "Pin character"], ["ignored", "Ignore character"]] as const) {
      const wrap = node("label", label), control = node("input"); control.type = "checkbox"; control.checked = editor.draft[key]; control.disabled = generationActive() || editor.saving; control.addEventListener("change", () => { editor = changeCastEditor(editor!, { [key]: control.checked }); syncSave(); }); wrap.prepend(control); form.append(wrap);
    }
    if (editor.characterId) form.append(node("small", "Pin prioritizes this character in story context. Ignore excludes this supporting character from story context."));
    if (editor.error) form.append(node("p", editor.error));
    if (editor.conflict || state.changedWhileEditing) {
      form.append(node("p", "The saved character changed. Your edits are still here."));
      form.append(button("Compare latest", async () => {
        if (!editor || !state.campaignId) return;
        const draft = editor, campaign = state.campaignId, epoch = openEpoch;
        try {
        if (!draft.characterId) {
          const latest = await api.list(campaign);
          if (epoch !== openEpoch || editor !== draft || state.campaignId !== campaign) return;
          const comparison = node("section");
          comparison.append(node("p", "Your new character has not been saved. Your draft is preserved."));
          comparison.append(node("p", `Latest characters: ${latest.characters.map(person => person.name).join(", ") || "None"}`));
          comparison.append(button("Reapply my changes", () => {
            if (editor !== draft || generationActive()) return;
            editor = reapplyNewCastDraft(editor, latest); session.setDraft(null); session.setDraft(editor); renderEditor();
          }, !latest.capabilities.castEditing || generationActive()));
          form.append(comparison); return;
        }
        const latest = await api.detail(campaign, draft.characterId);
        if (epoch !== openEpoch || editor !== draft || state.campaignId !== campaign) return;
        const comparison = node("section"); comparison.append(node("h3", "Latest saved character"), node("p", `Name: ${latest.character.name}`));
        for (const field of SUPPORTING_FIELDS) comparison.append(node("p", `${field.label}: ${latest.character.profile[field.path as keyof typeof latest.character.profile] ?? "Unknown"}`));
        comparison.append(button("Reapply my changes", () => { if (editor !== draft || generationActive()) return; editor = reapplyCastDraft(editor!, latest); session.setDraft(null); session.setDraft(editor); renderEditor(); }, !latest.capabilities.castEditing || generationActive())); form.append(comparison);
        } catch { if (epoch === openEpoch && editor === draft) form.append(node("p", "Could not load the latest characters. Your draft is kept; try Compare latest again.")); }
      }));
    }
    save.disabled = !canSaveCastEditor(editor) || generationActive() || state.changedWhileEditing; form.append(save, button("Cancel", () => { if (!discard()) return; editor = null; session.setDraft(null); }));
    form.addEventListener("submit", async event => { event.preventDefault(); if (!editor || !state.campaignId || generationActive() || !canSaveCastEditor(editor) || state.changedWhileEditing) return; const campaign = state.campaignId, id = editor.characterId; try { editor = prepareCastSubmission(editor, crypto.randomUUID()); renderEditor(); const result = id ? await api.edit(campaign, id, editor.submission as EditCastCharacter) : await api.create(campaign, editor.submission as CreateCastCharacter); editor = null; session.setDraft(null); session.select(result.character.id); } catch (error) { if (!editor) return; editor = failCastSubmission(editor, error instanceof Error ? error.message : "Could not save character.", (error as { statusCode?: number }).statusCode === 409); renderEditor(); } }); dialog.append(form);
  }
  /** Edit the main character in the sheet through the existing revisioned profile endpoint. */
  function renderProfileEditor(campaign: string, profile: ProtagonistProfile, message = "") {
    const epoch = openEpoch;
    dialog.classList.remove("characters-sheet-layout"); dialog.replaceChildren(); const head = node("header"); const closeButton = button("Close", close); head.append(node("h2", `Edit ${profile.name}`), closeButton); dialog.append(head);
    dialog.append(node("p", `Revision ${profile.revision}. Profile edits apply to future turns only.`));
    const form = node("form"), fields = node("div"); fields.className = "characters-profile-fields";
    const editing = { form: createCharacterProfileForm(fields, profile), saving: false }; profileEditor = editing;
    const status = node("p", message); status.setAttribute("aria-live", "polite");
    const save = node("button", "Save character profile"); save.type = "submit"; save.disabled = generationActive();
    const cancel = button("Cancel", () => { if (editing.saving || !discard()) return; profileEditor = null; render(); });
    const setBusy = (busy: boolean) => { editing.saving = busy; save.disabled = busy || generationActive(); cancel.disabled = busy; closeButton.disabled = busy; const reload = form.querySelector<HTMLButtonElement>("[data-load-latest]"); if (reload) reload.disabled = busy; fields.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea").forEach(control => { control.disabled = busy; }); };
    form.append(fields, status, save, cancel); dialog.append(form);
    form.addEventListener("submit", async event => {
      event.preventDefault(); if (profileEditor !== editing || editing.saving) return;
      if (generationActive()) { status.textContent = "Story generation is active. Your edits are kept; save when it finishes."; return; }
      setBusy(true); status.textContent = "Saving…";
      try {
        const saved = await saveProfile(campaign, editing.form.update());
        if (epoch !== openEpoch || state.campaignId !== campaign || profileEditor !== editing) return;
        protagonist = { name: saved.name, profile: saved.profile, revision: saved.revision }; profileEditor = null;
        onProfileSaved(campaign); render();
      } catch (error) {
        if (epoch !== openEpoch || profileEditor !== editing) return;
        setBusy(false);
        const code = (error as { statusCode?: number; status?: number }).statusCode ?? (error as { status?: number }).status;
        status.textContent = code === 409 ? "The main character changed elsewhere. Your edits are kept here; load the latest version to start again from it."
          : "Could not save the main character. Your edits are kept.";
        if (code === 409 && !form.querySelector("[data-load-latest]")) {
          const reload = button("Load latest version", async () => {
            if (editing.saving || !discard()) return;
            setBusy(true); reload.disabled = true;
            try { const latest = await getProfile(campaign); if (epoch !== openEpoch || profileEditor !== editing || state.campaignId !== campaign) return; protagonist = latest; renderProfileEditor(campaign, latest, "Loaded the latest version."); }
            catch { if (epoch !== openEpoch || profileEditor !== editing) return; setBusy(false); reload.disabled = false; status.textContent = "Could not load the latest version. Try again."; }
          }); reload.dataset.loadLatest = ""; form.append(reload);
        }
      }
    });
    fields.querySelector<HTMLElement>("input, textarea")?.focus();
  }
  dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
  return { open(campaignId: string, returnFocus?: HTMLElement | null) { openEpoch++; toolEpoch++; protagonist = null; protagonistLoading = false; focus = returnFocus ?? document.activeElement as HTMLElement | null; editor = null; profileEditor = null; reviewing = false; dialog.showModal(); session.open(campaignId); }, dispose() { openEpoch++; toolEpoch++; session.dispose(); dialog.remove(); } };
}

