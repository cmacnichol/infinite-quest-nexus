import { buildCharacterSheet, canSaveCastEditor, createCastEditor, changeCastEditor, setCastEditorField, prepareCastSubmission,
  failCastSubmission, reapplyCastDraft, reapplyNewCastDraft, characterProvenanceLabel, recentFilterLabel, type CastEditorState } from "@infinite-quest/client-core";
import { createCharactersWorkspaceSession, type CampaignCastApi } from "@infinite-quest/client-web";
import type { CampaignCharacterProfile, CharacterFilter, CastDetail, CastDiscoveryStatus, CastField, CastCandidateList, ResolveCastCandidate, CreateCastCharacter, EditCastCharacter } from "@infinite-quest/contracts";
import { renderLegacyCastScan } from "./campaign-cast-scan-panel.js";

const fields: [CastField, string][] = [
  ["identity.pronouns", "Pronouns"], ["story.role", "Role"], ["story.background", "Background"],
  ["story.personality", "Personality"], ["story.motivations", "Motivations"], ["story.goals", "Goals"],
  ["story.voiceAndMannerisms", "Voice and mannerisms"], ["appearance.description", "Appearance"],
  ["state.location", "Last known location"], ["state.condition", "Condition"], ["state.clothing", "Clothing"]
];
type List = Awaited<ReturnType<CampaignCastApi["list"]>>;
export function createLegacyCastPanel(options: {
  api: Omit<CampaignCastApi, "scans"> & Partial<Pick<CampaignCastApi, "scans">>; campaignId(): string | null; generationActive(): boolean;
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
  let rosterVisible = false;
  let attention: { identities: number | null; details: number | null; conflicts: number | null } | null = null;
  const workspace = createCharactersWorkspaceSession<CastEditorState>({ api: options.api, onChange(next) {
    if (!dialog.open || next.campaignId !== campaign) return;
    attention = next.status?.counts ?? null;
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
      const [rosterResult, discoveryResult, scanResult] = await Promise.allSettled([
        options.api.list(campaign, { query, filter, ...(cursor ? { cursor } : {}) }), options.api.discoveryStatus(campaign),
        options.api.scans?.latest(campaign) ?? Promise.resolve(null)
      ]);
      if (!current(token)) return;
      if (rosterResult.status === "rejected") throw rosterResult.reason;
      const response = rosterResult.value;
      discovery = discoveryResult.status === "fulfilled" ? discoveryResult.value : null;
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
  async function loadScan() {
    rosterVisible = false;
    if (!options.api.scans) return;
    const token = ++epoch; editor = null; shell("Scan earlier story"); status("Loading scan…");
    try {
      const [data, roster, tracking] = await Promise.all([options.api.scans.latest(campaign), options.api.list(campaign), options.api.discoveryStatus(campaign).catch(() => null)]);
      if (!current(token)) return;
      scanData = data; list = roster; discovery = tracking;
      shell("Scan earlier story"); dialog.append(button("Back to characters", () => { void loadRoster(); }));
      renderLegacyCastScan(dialog, { api: options.api.scans, campaignId: campaign, authority: roster, data, discovery: tracking,
        current: () => current(token), generationActive: options.generationActive, refresh: loadScan });
    } catch (error) {
      if (!current(token)) return;
      shell("Scan earlier story"); status(message(error));
      dialog.append(button("Refresh scan", () => { void loadScan(); }), button("Back to characters", () => { void loadRoster(); }));
    }
  }
  async function loadCandidates(cursor?: string) {
    rosterVisible = false;
    const token = ++epoch; editor = null;
    shell("Character matches"); status("Loading matches…");
    try {
      const matches = await options.api.candidates(campaign, { view: "matches", ...(cursor ? { cursor } : {}) });
      if (!current(token)) return;
      shell("Character matches");
      dialog.append(button("Back to characters", () => { void loadRoster(); }));
      for (const candidate of matches.candidates) {
        dialog.append(button(`Review ${candidate.proposal.name}`, () => renderCandidate(matches, candidate)), node("p", `Source: turn ${candidate.source.turnNumber}`));
      }
      if (!matches.candidates.length) status("No character matches need review.");
      if (matches.nextCursor) dialog.append(button("More matches", () => { void loadCandidates(matches.nextCursor!); }));
    } catch (error) {
      if (!current(token)) return;
      shell("Character matches"); status(message(error));
      dialog.append(button("Retry loading matches", () => { void loadCandidates(); }), button("Back to characters", () => { void loadRoster(); }));
    }
  }
  function renderCandidate(matches: CastCandidateList, candidate: CastCandidateList["candidates"][number]) {
    const token = ++epoch;
    shell(`Review ${candidate.proposal.name}`);
    dialog.append(button("Back to matches", () => { void loadCandidates(); }));
    status(candidate.resolvedCharacterId
      ? "This identity is already saved. These proposed details remain unverified and have not been applied. You can enter confirmed details in the character editor; the original evidence remains pending."
      : "Decide whether this person is already in your cast or is a separate character. Only supported details will be applied; disputed details will remain pending. Existing names and your edits are preserved.");
    dialog.append(button(`Source turn ${candidate.source.turnNumber}`, () => { requestClose(); void options.navigateToTurn(candidate.source.turnNumber); }));
    for (const citation of candidate.proposal.identityEvidence) dialog.append(node("blockquote", citation.quote));
    for (const observation of candidate.proposal.observations) {
      dialog.append(node("p", `Proposed ${fields.find(([field]) => field === observation.field)?.[1] ?? "detail"}: ${observation.value}`), node("blockquote", observation.quote));
    }
    if (candidate.resolvedCharacterId) {
      dialog.append(button("Edit saved character", () => { void openDetail(candidate.resolvedCharacterId!); }));
      return;
    }
    const controls = node("fieldset"); controls.className = "cast-match-controls"; controls.disabled = !enabled || options.generationActive();
    if (controls.disabled) status(!enabled ? "Character editing is disabled." : "Finish or resolve the current generation before reviewing matches.");
    const searchLabel = node("label", "Find existing character"), search = node("input");
    searchLabel.htmlFor = "cast-match-search"; search.id = "cast-match-search"; search.type = "search"; search.maxLength = 200;
    const selectLabel = node("label", "Existing character"), select = node("select");
    selectLabel.htmlFor = "cast-match-target"; select.id = "cast-match-target";
    let busy = false, searchEpoch = 0, submitted: ResolveCastCandidate | null = null;
    const feedback = node("p"); feedback.setAttribute("role", "status");
    const preview = node("section"); preview.setAttribute("role", "region"); preview.setAttribute("aria-label", "Selected character");
    let targets: List["characters"] = [];
    const attach = button("Attach to selected character", () => { void resolve("attach"); }, true);
    const populate = (people: List["characters"]) => {
      targets = people; preview.replaceChildren();
      select.replaceChildren(); const blank = node("option", "Choose a character"); blank.value = ""; select.append(blank);
      const label = (person: List["characters"][number]) => `${person.name}${person.aliases.length ? ` (${person.aliases.join(", ")})` : ""}${person.profile["story.role"] ? ` · ${person.profile["story.role"]}` : ""} · last seen turn ${person.lastObservedTurn}`;
      for (const person of people) {
        const text = label(person), duplicate = people.some((other) => other.id !== person.id && label(other) === text);
        const option = node("option", duplicate ? `${text} · ${person.id}` : text);
        option.value = person.id; select.append(option);
      }
      attach.disabled = true;
    };
    select.addEventListener("change", () => {
      attach.disabled = !select.value; preview.replaceChildren();
      const person = targets.find((target) => target.id === select.value);
      if (!person) return;
      preview.append(node("h3", person.name), node("p", `First seen turn ${person.firstObservedTurn}; last seen turn ${person.lastObservedTurn}.`));
      for (const [field, label] of fields) if (person.profile[field] !== undefined) preview.append(node("p", `${label}: ${person.profile[field]}`));
    });
    populate(list?.characters ?? []);
    const searchButton = button("Search characters", async () => {
      const searchToken = ++searchEpoch;
      try {
        const found = await options.api.list(campaign, { query: search.value, limit: 50 });
        if (!current(token) || busy || searchToken !== searchEpoch) return;
        enabled = found.capabilities.castEditing; controls.disabled = !enabled || options.generationActive();
        populate(found.characters); feedback.textContent = found.nextCursor ? "More characters match. Refine the search to find the right person." : "";
      } catch (error) { if (current(token) && searchToken === searchEpoch) feedback.textContent = message(error); }
    });
    controls.append(searchLabel, search, searchButton, selectLabel, select, attach,
      button("Create separate character", () => { void resolve("create"); }));
    dialog.append(controls, preview, feedback);
    async function resolve(action: "attach" | "create") {
      if (busy || !enabled || options.generationActive() || action === "attach" && !select.value) return;
      const decision = action === "create" ? { action } : { action, characterId: select.value };
      if (!submitted || submitted.action !== action || action === "attach" && submitted.action === "attach" && submitted.characterId !== select.value) {
        submitted = { ...decision, expectedCastRevision: matches.revision, expectedBoundary: matches.boundary, idempotencyKey: crypto.randomUUID() };
      }
      busy = true; controls.disabled = true; feedback.textContent = "Saving identity decision…";
      try {
        const saved = await options.api.resolveCandidate(campaign, candidate.id, submitted);
        if (current(token)) {
          const pending = saved.pendingObservations?.length ?? 0;
          await loadRoster(undefined, pending ? `Identity saved. ${pending} proposed ${pending === 1 ? "detail still needs" : "details still need"} review and ${pending === 1 ? "was" : "were"} not applied.` : undefined);
        }
      } catch (error) {
        if (!current(token)) return;
        feedback.textContent = (error as { statusCode?: number }).statusCode === 409
          ? "The story or cast changed. Reload matches before deciding again." : `Could not apply the evidence: ${message(error)}`;
        dialog.append(button("Reload matches", () => { void loadCandidates(); }));
        busy = false; controls.disabled = !enabled || options.generationActive();
      }
    }
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
  async function loadDetails() {
    rosterVisible = false; const token = ++epoch; shell("Review character details"); status("Loading details…");
    try {
      const matches = await options.api.candidates(campaign, { view: "details" }); if (!current(token)) return;
      shell("Review character details"); dialog.append(button("Back to characters", () => { void loadRoster(); }));
      if (!matches.candidates.length) status("No details need review.");
      for (const candidate of matches.candidates) {
        if (!candidate.resolvedCharacterId) continue;
        for (const item of candidate.details ?? []) {
          const row = node("section"); row.append(node("h3", `${candidate.proposal.name} · ${fields.find(([path]) => path === item.field)?.[1] ?? item.field}`), node("p", item.reason), node("blockquote", item.quote));
          const label = node("label", "Confirmed value"), value = node("textarea"); value.value = item.value; label.append(value); row.append(label);
          const feedback = node("p"); feedback.setAttribute("role", "status");
          let pending: { signature: string; request: Parameters<typeof options.api.resolveDetail>[2] } | null = null;
          async function decide(action: "confirm" | "dismiss") {
            try {
              const signature = JSON.stringify([action, action === "confirm" ? value.value : null]);
              if (!pending || pending.signature !== signature) { const latest = await options.api.detail(campaign, candidate.resolvedCharacterId!);
              pending = { signature, request: { expectedCastRevision: matches.revision, expectedBoundary: matches.boundary, expectedCharacterRevision: latest.character.revision, observationIndex: item.observationIndex, sourceHash: item.sourceHash, action, ...(action === "confirm" ? { confirmedValue: value.value } : {}), idempotencyKey: operationKey("detail", [campaign, candidate.id, item.observationIndex, item.sourceHash, action, action === "confirm" ? value.value : null, matches.revision, latest.character.revision]) } }; }
              await options.api.resolveDetail(campaign, candidate.id, pending.request); pending = null; operationKeys.clear(); if (current(token)) await loadDetails();
            } catch { feedback.textContent = "Could not save this decision. Refresh the review list and try again."; }
          }
          row.append(button("Confirm detail", () => { void decide("confirm"); }, !enabled || options.generationActive()), button("Dismiss detail", () => { void decide("dismiss"); }, !enabled || options.generationActive()), feedback); dialog.append(row);
        }
      }
    } catch (error) { if (current(token)) { shell("Review character details"); status(message(error)); dialog.append(button("Retry", () => { void loadDetails(); }), button("Back to characters", () => { void loadRoster(); })); } }
  }
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
      if (discovery.unresolvedCount) status(`${discovery.unresolvedCount} character ${discovery.unresolvedCount === 1 ? "match needs" : "matches need"} review.`);
      if (discovery.unresolvedCount) dialog.append(button("Review character matches", () => { void loadCandidates(); }));
      if (discovery.state === "failed" && discovery.firstGap?.diagnosticCode === "source_requires_manual_scan") {
        status("This turn exceeds automatic tracking limits. Review or add its characters manually.");
      } else if (discovery.enabled && discovery.state === "failed" && discovery.firstGap?.jobId
        && !(scanData?.scan && !["complete", "cancelled"].includes(scanData.scan.status)
          && discovery.firstGap.turnNumber >= scanData.scan.fromTurn && discovery.firstGap.turnNumber <= scanData.scan.throughTurn)) {
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
    dialog.append(button("Refresh characters", () => { void loadRoster(); }), button("Review character details", () => { void loadDetails(); }), button("Likely included for this input", previewContext));
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
      const group = node("details"); group.className = "cast-field-group"; group.open = key === "appearance";
      group.append(node("summary", title)); groups.set(key!, group); form.append(group);
    }
    for (const [field, label] of fields) {
      const wrap = textInput(label, `cast-${field.replace(".", "-")}`, editor.draft.profile[field] ?? "", 2000,
        (value) => { editor = setCastEditorField(editor!, field, value); }, true);
      const overriding = Object.hasOwn(editor.setOverrides, field) || editor.loaded?.overrides.some((o) => o.field === field);
      wrap.append(node("small", editor.clearOverrides.includes(field) ? "Will use the discovered value after saving." : overriding ? "Your override" : Object.hasOwn(editor.draft.profile, field) ? "From recorded evidence" : "Unknown"));
      if (editor.characterId && !protagonist) wrap.append(button(`Use discovered value for ${label.toLowerCase()}`, () => {
        editor = setCastEditorField(editor!, field, null); renderEditor();
      }, Boolean(locked)));
      const group = groups.get(field.split(".")[0]!); if (group) group.append(wrap);
    }
    if (editor.characterId && !protagonist) for (const [key, label] of [["pinned", "Pin character"], ["ignored", "Ignore character"]] as const) {
      const caption = node("label", label), control = node("input"); control.type = "checkbox";
      control.checked = editor.draft[key]; control.disabled = Boolean(locked);
      control.addEventListener("change", () => { editor = changeCastEditor(editor!, { [key]: control.checked }); syncSave(); });
      caption.prepend(control); form.append(caption);
    }
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
