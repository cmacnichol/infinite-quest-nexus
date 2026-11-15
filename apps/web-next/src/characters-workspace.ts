import { showLifecycle } from "../../web/src/character-editor/cast-lifecycle.js";
import { renderCastRoster } from "../../web/src/character-editor/cast-roster-view.js";
import { renderWorldCastPicker } from "../../web/src/character-editor/world-cast-picker.js";
import { renderCastEditor } from "./characters-workspace-editor";
import { openCastTool } from "./characters-workspace-tools";
import { renderCharacterSheetView, type SheetFeedback } from "../../web/src/character-editor/character-sheet-view.js";
import { renderObservationReview } from "../../web/src/character-editor/observation-review.js";
import { castScanRecovery } from "./campaign-cast-scan-panel";
import { createCharacterProfileForm } from "./character-profile-form";
import { buildCharacterSheet, createCastEditor, recentFilterLabel, sheetRequest, sheetUndoOperation, sheetUndoRequest, sheetMatchesFence, retractionRequest, type SheetTarget, type SheetUndo, type SheetWriteFence, type SheetChange, type CastEditorState } from "@infinite-quest/client-core";
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
  const session = createCharactersWorkspaceSession<CastEditorState>({ api, ...(dependencies?.schedule ? { schedule: dependencies.schedule } : {}), onChange(next) {
    state = next;
    if (sheetFeedback?.undo && sheetFeedback.fence?.kind === "cast" && !sheetFeedback.refreshFailed && state.detail && state.selectedId === state.detail.character.id && !sheetMatchesFence({ kind: "cast", detail: state.detail }, sheetFeedback.fence)) {
      sheetFeedback.message += " Undo expired: the character was updated after your save."; delete sheetFeedback.undo;
    }
    if (sheetView?.active()) sheetRenderPending = true;
    else render();
  } });
  let rosterView: ReturnType<typeof renderCastRoster> | null = null;
  let searchPending = false;
  let showEmpty = false;
  let lifecycleNotice = "";
  let sheetRenderPending = false;
  let sheetView: ReturnType<typeof renderCharacterSheetView> | null = null;
  let sheetTimer: ReturnType<typeof setTimeout> | undefined;
  let sheetFeedback: { message: string; undo?: SheetUndo; fence?: SheetWriteFence; deadline: number; key: string; refreshFailed?: boolean } | null = null;
  function clearSheetFeedback() { clearTimeout(sheetTimer); sheetFeedback = null; }
  function selectCharacter(id: string | null) { if (id === state.selectedId) return; if (!discard()) return; lifecycleNotice = ""; sheetView?.dispose(); sheetView = null; clearSheetFeedback(); openEpoch++; showEmpty = false; protagonist = null; protagonistLoading = false; session.select(id); }
  const operationKeys = new Map<string, string>();
  function operationKey(operation: string, payload: unknown) { const key = `${operation}:${JSON.stringify(payload)}`; let id = operationKeys.get(key); if (!id) { id = crypto.randomUUID(); operationKeys.set(key, id); } return id; }
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "") => { const el = document.createElement(tag); el.textContent = text; return el; };
  const button = (text: string, action: () => void, disabled = false) => { const el = node("button", text); el.type = "button"; el.disabled = disabled; el.addEventListener("click", action); return el; };
  const discard = () => !(editor?.dirty || profileEditor?.form.dirty || sheetView?.dirty()) || (dependencies?.confirm?.("Discard unsaved character changes?") ?? document.defaultView?.confirm("Discard unsaved character changes?") ?? false);
  function close(): boolean { if (editor?.saving || profileEditor?.saving || !discard()) return false; clearSheetFeedback(); sheetView?.dispose(); sheetView = null; rosterView?.dispose(); rosterView = null; searchPending = false; openEpoch++; toolEpoch++; editor = null; profileEditor = null; reviewing = false; session.close(); operationKeys.clear(); dialog.close(); focus?.focus(); return true; }
  function render() {
    if (!state || !dialog.open || reviewing || profileEditor || searchPending) return;
    sheetRenderPending = false;
    const oldSearch = dialog.querySelector<HTMLInputElement>('.cast-roster-search input');
    const selection = oldSearch && document.activeElement === oldSearch ? { start: oldSearch.selectionStart, end: oldSearch.selectionEnd, direction: oldSearch.selectionDirection } : null;
    const toolsOpen = dialog.querySelector<HTMLDetailsElement>(".cast-roster-tools")?.open ?? false;
    rosterView?.dispose(); rosterView = null;
    if (editor) { if (state.changedWhileEditing && !dialog.querySelector("[data-stale]")) { const notice = node("p", "This character changed while you were editing. Your draft is preserved; compare the latest before saving."); notice.dataset.stale = ""; dialog.prepend(notice); } return; }
    const sourceOpen = dialog.querySelector("details")?.open ?? false; const scroll = dialog.scrollTop;
    dialog.classList.toggle("characters-sheet-layout", Boolean(state.selectedId));
    sheetView?.dispose(); sheetView = null;
    dialog.replaceChildren(); const head = node("header"); head.append(node("h2", state.detail?.character.name ?? "Characters"), button("Close", close)); dialog.append(head);
    if (lifecycleNotice) { const notice = node("p", lifecycleNotice); notice.setAttribute("role", "status"); dialog.append(notice); }
    if (state.error) dialog.append(node("p", "Characters could not be refreshed. Try again."), button("Retry", () => { void session.refresh(); }));
    if (!state.status) { dialog.append(node("p", "Loading characters…")); return; }
    if (state.selectedId) {
      const sidebar = node("nav"); sidebar.className = "characters-sheet-roster"; sidebar.setAttribute("aria-label", "Characters"); for (const person of state.characters) sidebar.append(button(person.name, () => selectCharacter(person.id))); dialog.append(sidebar);
      dialog.append(button("Back to characters", () => selectCharacter(null)));
      if (!state.detail) { dialog.append(node("p", "Loading character…")); return; }
      const detail = state.detail;
      if (detail.character.origin.kind === "protagonist" && !protagonist && !protagonistLoading && state.campaignId) {
        protagonistLoading = true; const campaign = state.campaignId, epoch = openEpoch;
        void getProfile(campaign).then(value => { if (epoch === openEpoch && state.campaignId === campaign && state.selectedId === detail.character.id && dialog.open) { protagonist = value; protagonistLoading = false; render(); } }).catch(() => { if (epoch === openEpoch) protagonistLoading = false; });
      }
      const sheet = protagonist && detail.character.origin.kind === "protagonist" ? buildCharacterSheet({ kind: "protagonist", profile: { name: protagonist.name, profile: protagonist.profile }, revision: protagonist.revision }) : buildCharacterSheet({ kind: "supporting", detail });
      dialog.append(node("p", `Last observed turn ${detail.character.lastObservedTurn}${detail.character.lastMentionedTurn != null ? ` · Last mentioned turn ${detail.character.lastMentionedTurn}` : ""}`));
      if (detail.character.origin.kind === "protagonist") dialog.append(button("Edit main character", () => { if (discard() && protagonist && state.campaignId) renderProfileEditor(state.campaignId, protagonist); }, generationActive() || !protagonist));
      else dialog.append(button("Edit character", () => { if (!discard()) return; editor = createCastEditor(detail, detail); session.setDraft(editor); renderEditor(); }, state.status.capabilities.editing !== true || generationActive()));
      if (detail.character.origin.kind !== "protagonist" && !detail.character.mergedIntoCharacterId) {
        if (detail.capabilities.castLifecycle === false) dialog.append(node("p", "Removing and restoring characters is disabled on this server. Character merging is disabled on this server."));
        else if (state.status.capabilities.editing !== true) dialog.append(node("p", "Removing and restoring characters is unavailable while character editing is disabled."));
        if (detail.capabilities.castLifecycle && api.lifecycle) {
          const campaign = state.campaignId!, epoch = openEpoch;
          const launch = (action: Parameters<typeof showLifecycle>[0], mergeEventId?: string) => {
            if (generationActive() || state.status?.capabilities.editing !== true || !discard()) return;
            if (sheetView?.dirty() || sheetRenderPending) { sheetView?.dispose(); sheetView = null; render(); }
            const latest = state.detail; if (!latest || latest.character.id !== detail.character.id || !latest.capabilities.castLifecycle || latest.character.mergedIntoCharacterId || (action === "restore") !== Boolean(latest.character.removed)) return;
            showLifecycle(action, { api: api.lifecycle!, list: api.list, campaign, detail: latest, lock: async () => !generationActive(), ...(mergeEventId ? { mergeEventId } : {}),
              finished(id, message) {
                if (epoch !== openEpoch || state.campaignId !== campaign || !dialog.open) return;
                sheetView?.dispose(); sheetView = null; clearSheetFeedback(); lifecycleNotice = message; openEpoch++;
                if (id === state.selectedId) { render(); void session.refresh(); } else session.select(id || null);
              } });
          };
          const actions = node("div"); actions.className = "cast-lifecycle-actions";
          const disabled = state.status.capabilities.editing !== true || generationActive();
          if (detail.character.removed) actions.append(button("Restore", () => launch("restore"), disabled));
          else {
            actions.append(button("Merge with another character", () => launch("merge"), disabled), button("Remove from cast", () => launch("remove"), disabled), button("Add to world draft", () => launch("promote"), disabled));
            for (const merge of detail.character.activeMerges ?? []) actions.append(node("p", `Merged from ${merge.sourceName}`), button("Undo merge", () => launch("unmerge", merge.mergeEventId), disabled || !merge.canUndo));
          }
          dialog.append(actions);
        }
      }
      const campaign = state.campaignId!, id = detail.character.id, epoch = openEpoch;
      const main = detail.character.origin.kind === "protagonist";
      const target: SheetTarget | null = main ? (protagonist ? { kind: "main", profile: protagonist } : null) : { kind: "cast", detail };
      const current = () => epoch === openEpoch && state.selectedId === id && state.campaignId === campaign && dialog.open;
      const editable = () => Boolean(target && state.status?.capabilities.editing === true && !generationActive() && !detail.character.removed && !detail.character.mergedIntoCharacterId);
      const dispatch = async (request: ReturnType<typeof sheetRequest>) => request.endpoint === "profile" ? saveProfile(campaign, request.body) : request.endpoint === "editAuthoredProfile" ? api.editAuthoredProfile(campaign, id, request.body) : api.edit(campaign, id, request.body);
      const refresh = async () => {
        try {
          const refreshedSession = await session.refresh();
          if (!current()) return;
          if (!refreshedSession || state.error || !state.detail) throw state.error ?? new Error("Refresh failed");
          const nextProfile = main ? await getProfile(campaign) : null;
          if (!current()) return;
          if (nextProfile) protagonist = nextProfile;
          const refreshed: SheetTarget | null = main ? (nextProfile ? { kind: "main", profile: nextProfile } : null) : { kind: "cast", detail: state.detail };
          if (sheetFeedback) {
            sheetFeedback.refreshFailed = false;
            sheetFeedback.message = sheetFeedback.message.replace(/\. Could not refresh this character\.$/, ".");
            if (sheetFeedback.undo && sheetFeedback.fence && refreshed && !sheetMatchesFence(refreshed, sheetFeedback.fence)) { sheetFeedback.message += " Undo expired: the character was updated after your save."; delete sheetFeedback.undo; }
          }
          render();
        } catch {
          if (!current()) return;
          if (sheetFeedback) { sheetFeedback.message = sheetFeedback.message.replace(/\. Could not refresh this character\.$/, ".").replace(/\.$/, "") + ". Could not refresh this character."; sheetFeedback.refreshFailed = true; }
          render();
        }
      };
      const owner = sheetFeedback;
      const feedback: SheetFeedback | undefined = owner ? { message: owner.message, ...(owner.undo && owner.fence && !owner.refreshFailed && Date.now() < owner.deadline && target && sheetMatchesFence(target, owner.fence) ? { undo: async () => {
        if (!current() || !editable() || sheetFeedback !== owner || !owner.undo || !owner.fence || Date.now() >= owner.deadline) return { ok: true as const };
        try { await dispatch(sheetUndoRequest(target, owner.undo, owner.fence, owner.key)); if (!current()) return { ok: true as const }; clearSheetFeedback(); sheetFeedback = { message: "Undone", deadline: 0, key: "" }; await refresh(); return { ok: true as const }; }
        catch (error) { if (!current()) return { ok: true as const }; if ((error as { statusCode?: number }).statusCode === 409) { clearSheetFeedback(); sheetFeedback = { message: "Could not undo. The character changed; review the latest values.", deadline: 0, key: "" }; render(); return { ok: true as const }; } return { ok: false as const, conflict: false, message: "Could not undo. Please try again." }; }
      } } : {}) } : undefined;
      const host = node("div"); dialog.append(host);
      sheetView = renderCharacterSheetView(host, { sheet, kind: main ? "main" : "supporting", editable, lockedReason: null,
        ...(!main && editable() ? { toggles: { pinned: detail.character.pinned, ignored: detail.character.ignored } } : {}),
        ...(feedback ? { feedback } : {}),
        onEditStart(path, mode) {
          clearSheetFeedback();
          if (!sheetRenderPending || !current()) return;
          render(); sheetView?.revealField(path, mode); return true;
        },
        onIdleError(result) {
          if (!sheetRenderPending || !current()) return false;
          render(); sheetView?.showError(result); return true;
        },
        onInteractionEnd(path) {
          if (!sheetRenderPending || !current()) return;
          render();
          Array.from(dialog.querySelectorAll<HTMLElement>("[data-path]")).find(row => row.dataset.path === path)?.querySelector<HTMLElement>("button")?.focus();
        }, showEmpty, onShowEmpty(value) { showEmpty = value; render(); },
        compareLabel: main ? "Load latest version" : "Compare latest", onCompareLatest() { void refresh(); },
        confirmDiscard: () => dependencies?.confirm?.("Discard unsaved character changes?") ?? document.defaultView?.confirm("Discard unsaved character changes?") ?? false, isCurrent: current,
        async onChange(change: SheetChange) {
          if (!target || !editable()) return { ok: false, conflict: false, message: "Character editing is unavailable." };
          clearSheetFeedback();
          try {
            const inverse = sheetUndoOperation(target, change), request = sheetRequest(target, change, operationKey("sheet", [id, change, detail.revision]));
            const result = await dispatch(request); if (!current()) return { ok: true };
            const fence: SheetWriteFence = request.endpoint === "profile" ? { kind: "main", revision: result.revision } : { kind: "cast", revision: result.revision, characterRevision: (result as typeof detail).character.revision, boundary: (result as typeof detail).boundary };
            const label = change.kind === "toggle" ? change.key : sheet.sections.flatMap(section => section.fields).find(field => field.path === change.path)?.label ?? change.path;
            sheetFeedback = { message: `Saved ${label}.`, undo: inverse, fence, deadline: Date.now() + 30000, key: crypto.randomUUID(), refreshFailed: true };
            if (request.endpoint === "profile") onProfileSaved(campaign);
            sheetTimer = setTimeout(() => { if (!current() || !sheetFeedback) return; delete sheetFeedback.undo; sheetView?.setFeedback({ message: sheetFeedback.message }); }, 30000);
            await refresh(); return { ok: true };
          } catch (error) { if (!current()) return { ok: true }; const conflict = (error as { statusCode?: number }).statusCode === 409; return { ok: false, conflict, message: conflict ? "This character changed. Your edit is kept; compare the latest before saving." : "Could not save. Please try again." }; }
        },
        ...(!main && state.status.capabilities.observationDecisions === true ? { retraction: {
          async preview(observationId: string) { const result = await api.previewObservationDecision(campaign, id, observationId, retractionRequest(detail, observationId, operationKey("retract", [id, observationId, detail.revision]))); const observation = detail.observations.find(item => item.id === observationId); return { currentValue: result.currentValue, projectedValue: result.projectedValue, quote: observation?.evidence.kind === "turn" ? observation.evidence.quote : "", turn: observation?.evidence.kind === "turn" ? observation.evidence.turnNumber : 0 }; },
          async apply(observationId: string) { if (!editable() || !current()) return { ok: false as const, conflict: false, message: "Character editing is unavailable." }; try { await api.applyObservationDecision(campaign, id, observationId, retractionRequest(detail, observationId, operationKey("retract", [id, observationId, detail.revision]))); if (current()) { clearSheetFeedback(); await refresh(); } return { ok: true as const }; } catch (error) { return { ok: false as const, conflict: (error as { statusCode?: number }).statusCode === 409, message: "Could not retract this observation." }; } }
        } } : {}) });
      if (sheetFeedback?.refreshFailed) dialog.append(button("Reload", () => { void refresh(); }));
      const sources = node("details"); sources.append(node("summary", "Sources and edit history"));
      renderObservationReview({ document, container: sources, detail,
        supported: state.status.capabilities.observationDecisions === true,
        editing: () => state.status?.capabilities.editing === true && !generationActive(),
        current: () => dialog.open && state.detail === detail && !editor && !reviewing,
        preview: (id, request) => api.previewObservationDecision(state.campaignId!, detail.character.id, id, request),
        apply: (id, request) => api.applyObservationDecision(state.campaignId!, detail.character.id, id, request),
        refresh: async () => { await session.refresh(); dialog.querySelector<HTMLElement>("details summary")?.focus(); }, navigate: turn => { if (close()) navigateToTurn(turn); } });
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
    const tools = node("div");
    const tracking = state.status.tracking;
    if (tracking) {
      if (tracking.firstGap) {
        const reason = castScanRecovery(tracking, state.status.boundary.turnNumber).diagnostic;
        tools.append(node("p", `First tracking gap: turn ${tracking.firstGap.turnNumber} (${tracking.firstGap.status.replaceAll("_", " ")}).${reason ? ` ${reason}` : ""}`),
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
          tools.append(retry, feedback);
        }
      }
    }
    tools.append(button("Scan earlier story", () => { void scan(); }), button("Likely included for this input", () => { void preview(); }), button("Review character changes", () => { void review("matches"); }), button("Review conflicts", () => { cancelSearch(); filter = "conflicts"; session.setQuery(query, filter); }));
    const filters: Array<[CharacterFilter, string]> = [["all", "All"], ["main", "Main"], ["recent", recentFilterLabel(state.recentWindow)], ["pinned", "Pinned"], ["needs_review", "Needs review"], ["conflicts", "Conflicts"], ["ignored", "Ignored"]];
    if (state.listCapabilities?.castLifecycle !== undefined) filters.push(["removed", "Removed"]);
    const canAdd = state.status.capabilities.editing === true && !generationActive();
    const secondaryActions: HTMLElement[] = [];
    if (state.listCapabilities?.castPresets) secondaryActions.push(button("Add from world", () => {
      if (!state.campaignId || !canAdd || generationActive()) return;
      cancelSearch(); const campaign = state.campaignId, epoch = openEpoch, tool = ++toolEpoch;
      reviewing = true;
      dialog.replaceChildren(); const head = node("header"); head.append(node("h2", "Add from world"), button("Close", close)); dialog.append(head, button("Back to characters", () => { reviewing = false; toolEpoch++; render(); }));
      const host = node("section"); dialog.append(host);
      void renderWorldCastPicker(host, api, campaign, async () => !generationActive(), id => {
        if (epoch !== openEpoch || tool !== toolEpoch || state.campaignId !== campaign || !dialog.open) return;
        reviewing = false; toolEpoch++; selectCharacter(id);
      });
    }, !canAdd));
    const counts = Object.values(state.status.counts);
    const attentionTotal = counts.every(value => value !== null) ? counts.reduce<number>((sum, value) => sum + (value ?? 0), 0) : null;
    const host = node("div"); dialog.append(host);
    rosterView = renderCastRoster(host, { characters: state.characters, attention: state.attention, tracking, attentionTotal, filters, filter, query, canAdd, secondaryActions, tools: [tools],
      addDisabledReason: state.status.capabilities.editing !== true ? "Character editing is disabled. Saved characters remain available to read." : "Finish or resolve the current generation before editing characters.",
      onInput() { searchPending = true; query = host.querySelector<HTMLInputElement>('input[type="search"]')!.value; },
      onQuery(nextQuery, nextFilter) { searchPending = false; query = nextQuery; filter = nextFilter; session.setQuery(query, filter); },
      onOpen(id) { cancelSearch(); selectCharacter(id); }, onAttention() { review("matches"); },
      onAdd() { void (async () => { if (!state.campaignId || generationActive()) return; const campaign = state.campaignId, epoch = openEpoch, tool = toolEpoch; const roster = await api.list(campaign); if (epoch !== openEpoch || tool !== toolEpoch || reviewing || state.selectedId || state.campaignId !== campaign || !dialog.open || state.status?.capabilities.editing !== true || generationActive()) return; cancelSearch(); editor = createCastEditor(roster); session.setDraft(editor); renderEditor(); })(); }
    });
    const details = host.querySelector<HTMLDetailsElement>(".cast-roster-tools"); if (details) details.open = toolsOpen;
    if (selection) { const search = host.querySelector<HTMLInputElement>('input[type="search"]')!; search.focus({ preventScroll: true }); if (selection.start !== null && selection.end !== null) search.setSelectionRange(selection.start, selection.end, selection.direction ?? undefined); }
    dialog.scrollTop = scroll;
  }
  function renderEditor() { renderCastEditor(dialog, { document, api, session, getState: () => state, getEditor: () => editor, setEditor: next => { editor = next; }, generationActive, epoch: () => openEpoch, confirm: message => dependencies?.confirm?.(message) ?? document.defaultView?.confirm(message) ?? false, saved: (id, name) => { lifecycleNotice = `Saved ${name}`; if (id === state.selectedId) { render(); void session.refresh(); } else session.select(id); }, navigate: turn => { if (close()) navigateToTurn(turn); } }); }
  function cancelSearch() { const pending = searchPending; searchPending = false; rosterView?.dispose(); rosterView = null; if (pending) session.setQuery(query, filter); }
  function openTool(kind: "scan" | "preview" | "review", scanId?: string) {
    if (!state.campaignId) return; cancelSearch(); const campaign = state.campaignId, epoch = openEpoch, tool = ++toolEpoch; reviewing = true; dialog.classList.remove("characters-sheet-layout");
    void openCastTool(kind, { api, campaignId: campaign, dialog, generationActive, current: () => reviewing && tool === toolEpoch && state.campaignId === campaign && epoch === openEpoch && dialog.open,
      back: () => { reviewing = false; toolEpoch++; render(); }, navigateToTurn: turn => { if (close()) navigateToTurn(turn); }, operationKey, clearKeys: () => operationKeys.clear(), get capabilities() { return state.status; } }, scanId);
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
  return { open(campaignId: string, returnFocus?: HTMLElement | null) { clearSheetFeedback(); openEpoch++; toolEpoch++; lifecycleNotice = ""; searchPending = false; rosterView?.dispose(); rosterView = null; protagonist = null; protagonistLoading = false; focus = returnFocus ?? document.activeElement as HTMLElement | null; editor = null; profileEditor = null; reviewing = false; dialog.showModal(); session.open(campaignId); }, dispose() { clearSheetFeedback(); sheetView?.dispose(); rosterView?.dispose(); openEpoch++; toolEpoch++; session.dispose(); dialog.remove(); } };
}

