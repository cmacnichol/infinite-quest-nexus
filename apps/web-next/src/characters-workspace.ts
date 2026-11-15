import { renderCastEditor } from "./characters-workspace-editor";
import { openCastTool } from "./characters-workspace-tools";
import { renderObservationReview } from "../../web/src/character-editor/observation-review.js";
import { castScanRecovery } from "./campaign-cast-scan-panel";
import { createCharacterProfileForm } from "./character-profile-form";
import { buildCharacterSheet, createCastEditor, characterProvenanceLabel, recentFilterLabel, type CastEditorState } from "@infinite-quest/client-core";
import { createCampaignCastApi, createCharactersWorkspaceSession, type CharactersWorkspaceState, type CampaignCastApi, type CharactersWorkspaceSessionOptions } from "@infinite-quest/client-web";
import type { CampaignCharacterProfile, CampaignCharacterProfileUpdate, CharacterFilter } from "@infinite-quest/contracts";

type ProtagonistProfile = CampaignCharacterProfile & { revision: number };

export function createCharactersWorkspace(document: Document, generationActive: () => boolean,
  saveProfile: (campaign: string, update: CampaignCharacterProfileUpdate) => Promise<ProtagonistProfile>,
  navigateToTurn: (turn: number) => void, getProfile: (campaign: string) => Promise<ProtagonistProfile>,
  onProfileSaved: (campaign: string) => void = () => {}, dependencies?: { api?: CampaignCastApi; confirm?: (message: string) => boolean; schedule?: CharactersWorkspaceSessionOptions<CastEditorState>["schedule"] }) {
  const api = dependencies?.api ?? createCampaignCastApi();
  const dialog = document.createElement("dialog"); dialog.className = "characters-workspace"; document.body.append(dialog);
  let openEpoch = 0; let toolEpoch = 0; let protagonist: ProtagonistProfile | null = null; let protagonistLoading = false;
  let profileEditor: { form: ReturnType<typeof createCharacterProfileForm>; saving: boolean } | null = null;
  let state: CharactersWorkspaceState<CastEditorState>, editor: CastEditorState | null = null, filter: CharacterFilter = "all", query = "", focus: HTMLElement | null = null, reviewing = false;
  const session = createCharactersWorkspaceSession<CastEditorState>({ api, ...(dependencies?.schedule ? { schedule: dependencies.schedule } : {}), onChange(next) { state = next; render(); } });
  const operationKeys = new Map<string, string>();
  function operationKey(operation: string, payload: unknown) { const key = `${operation}:${JSON.stringify(payload)}`; let id = operationKeys.get(key); if (!id) { id = crypto.randomUUID(); operationKeys.set(key, id); } return id; }
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "") => { const el = document.createElement(tag); el.textContent = text; return el; };
  const button = (text: string, action: () => void, disabled = false) => { const el = node("button", text); el.type = "button"; el.disabled = disabled; el.addEventListener("click", action); return el; };
  const discard = () => !(editor?.dirty || profileEditor?.form.dirty) || (dependencies?.confirm?.("Discard unsaved character changes?") ?? document.defaultView?.confirm("Discard unsaved character changes?") ?? false);
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
      if (detail.character.origin.kind !== "protagonist" && !detail.character.mergedIntoCharacterId && detail.capabilities.castLifecycle === false) dialog.append(node("p", "Removing and restoring characters is disabled on this server."));
      else if (detail.character.origin.kind !== "protagonist" && state.status.capabilities.editing !== true) dialog.append(node("p", "Removing and restoring characters is unavailable while character editing is disabled."));
      for (const section of sheet.sections) { const group = node("section"); group.append(node("h3", section.name)); for (const field of section.fields) { const value = Array.isArray(field.value) ? field.value.join(", ") : field.value; group.append(node("p", `${field.label}: ${value || (field.origin === "conflicted" ? "Conflicting observations" : field.origin === "claim" ? "Unverified claim" : "Unknown")} ${field.origin === "unknown" ? "" : `· ${field.origin}`}`)); } dialog.append(group); }
      const sources = node("details"); sources.append(node("summary", "Sources and edit history"));
      renderObservationReview({ document, container: sources, detail,
        supported: state.status.capabilities.observationDecisions === true,
        editing: () => state.status?.capabilities.editing === true && !generationActive(),
        current: () => dialog.open && state.detail === detail && !editor && !reviewing,
        preview: (id, request) => api.previewObservationDecision(state.campaignId!, detail.character.id, id, request),
        apply: (id, request) => api.applyObservationDecision(state.campaignId!, detail.character.id, id, request),
        refresh: async () => { await session.refresh(); dialog.querySelector<HTMLElement>("details summary")?.focus(); }, navigate: turn => { close(); navigateToTurn(turn); } });
      dialog.append(sources);
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
  function renderEditor() { renderCastEditor(dialog, { document, api, session, getState: () => state, getEditor: () => editor, setEditor: next => { editor = next; }, generationActive, epoch: () => openEpoch, confirm: message => dependencies?.confirm?.(message) ?? document.defaultView?.confirm(message) ?? false }); }
  function openTool(kind: "scan" | "preview" | "review", scanId?: string) {
    if (!state.campaignId) return; const campaign = state.campaignId, epoch = openEpoch, tool = ++toolEpoch; reviewing = true; dialog.classList.remove("characters-sheet-layout");
    void openCastTool(kind, { api, campaignId: campaign, dialog, generationActive, current: () => reviewing && tool === toolEpoch && state.campaignId === campaign && epoch === openEpoch && dialog.open,
      back: () => { reviewing = false; toolEpoch++; render(); }, navigateToTurn: turn => { close(); navigateToTurn(turn); }, operationKey, clearKeys: () => operationKeys.clear(), get capabilities() { return state.status; } }, scanId);
  }
  function scan(scanId?: string) { openTool("scan", scanId); }
  function preview() { openTool("preview"); }
  function review(_view: "matches" | "details") { openTool("review"); }
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

