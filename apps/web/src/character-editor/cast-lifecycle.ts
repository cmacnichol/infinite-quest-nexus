import type { CampaignCastApi } from "@infinite-quest/client-web";
import type { CastDetail, CastMergePreview, CastPromotionPreview, CastMergeRequest, CastPromote } from "@infinite-quest/contracts";
import { CHARACTER_FIELD_DESCRIPTORS } from "@infinite-quest/client-core";

type Action = "remove" | "restore" | "merge" | "unmerge" | "promote";
function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = "") {
  const element = document.createElement(tag); element.textContent = text; return element;
}
const fieldName = (path: string) => CHARACTER_FIELD_DESCRIPTORS.find(field => field.path === path)?.label ?? path;
const promotionSource = (path: string) => path.startsWith("authored.") ? "Authored profile"
  : path.startsWith("observed.") ? "Observed in story" : path.startsWith("current.") ? "Current campaign value" : path === "name" ? "Current name"
    : path === "identity.aliases" ? "Current aliases" : "Character detail";
const display = (value: string | string[] | null) => Array.isArray(value) ? value.join(", ") : value === null ? "Unknown" : value || "Intentionally blank";

export function showLifecycle(action: Action, options: {
  api: NonNullable<CampaignCastApi["lifecycle"]>; list: CampaignCastApi["list"]; campaign: string; detail: CastDetail;
  lock(): Promise<boolean>; finished(id: string, message: string): void; mergeEventId?: string;
}) {
  const { api, campaign, detail } = options, person = detail.character;
  if (person.origin.kind === "protagonist" || person.mergedIntoCharacterId) return;
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const dialog = el("dialog"), heading = el("h2"), body = el("div"), status = el("p"), footer = el("div");
  dialog.className = "cast-dialog cast-lifecycle"; heading.id = "cast-lifecycle-title";
  dialog.setAttribute("aria-labelledby", heading.id); status.setAttribute("role", "status");
  let epoch = 0, saving = false;
  const keys = new Map<string, string>();
  function key(payload: unknown) { const signature = JSON.stringify(payload); if (!keys.has(signature)) keys.set(signature, crypto.randomUUID()); return keys.get(signature)!; }
  function button(label: string, fn: () => void) { const b = el("button", label); b.type = "button"; b.onclick = fn; return b; }
  const cancel = button("Cancel", () => { if (!saving) dialog.close(); });
  dialog.append(heading, body, status, footer); document.body.append(dialog);
  // Story installs a document-level Escape handler for managed dialogs. This
  // transient dialog owns its own cancellation and has no managed baseline.
  dialog.addEventListener("keydown", event => { if (event.key === "Escape") event.stopPropagation(); });
  dialog.oncancel = event => { if (saving) event.preventDefault(); };
  dialog.onclose = () => { epoch++; dialog.remove(); if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  function screen(title: string) { heading.textContent = title; body.replaceChildren(); footer.replaceChildren(cancel); status.textContent = ""; }
  function fail(error: unknown) { status.textContent = error instanceof Error ? error.message.replaceAll("_", " ") : "Request failed. Please try again."; }
  async function write(run: () => Promise<{id: string; message: string}>, refresh: () => void) {
    if (saving) return;
    saving = true; const disabled = [...dialog.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>("button,input,select")].filter(control => !control.disabled);
    disabled.forEach(control => { control.disabled = true; });
    try {
      if (!await options.lock()) throw new Error("Finish or resolve generation before changing the cast.");
      const result = await run(); dialog.close(); options.finished(result.id, result.message);
    } catch (error) {
      fail(error); disabled.forEach(control => { control.disabled = false; });
      if ((error as {statusCode?: number}).statusCode === 409) {
        status.textContent = "The campaign or world draft changed. Review fresh values before confirming.";
        footer.replaceChildren(button("Refresh preview", refresh), cancel);
      }
    } finally { saving = false; }
  }
  const fence = { expectedBoundary: detail.boundary, expectedCastRevision: detail.revision, expectedCharacterRevision: person.revision };
  function removal() {
    screen((action === "remove" ? "Remove " : "Restore ") + person.name);
    body.append(el("p", action === "remove" ? "This character will leave the roster, narrator context and Chronicle catalog. You can restore them from the Removed filter." : "Restore this character, their history, and their valid pending review items to the cast?"));
    footer.prepend(button(action === "remove" ? "Confirm remove" : "Restore character", () => void write(async () => {
      const result = await api.changeRemoval(campaign, person.id, action === "remove" ? "remove" : "restore", { ...fence, idempotencyKey: key(fence) });
      return { id: action === "remove" ? "" : result.character.id, message: person.name + (action === "remove" ? " removed. Use the Removed filter to restore them." : " restored.") };
    }, () => { dialog.close(); options.finished(person.id, "Review the latest character before continuing."); })));
  }
  async function chooseSource() {
    screen("Merge with another character"); const token = ++epoch;
    const search = el("input"), label = el("label", "Find a character"), list = el("div"); label.append(search); body.append(label,list);
    try {
      const people = []; let cursor: string | undefined;
      do {
        const page = await options.list(campaign, { limit: 50, ...(cursor ? { cursor } : {}) });
        if (!dialog.open || epoch !== token) return;
        people.push(...page.characters); cursor = page.nextCursor ?? undefined;
      } while (cursor);
      const eligible = people.filter(row => row.id !== person.id && row.origin.kind !== "protagonist" && !row.removed && !row.mergedIntoCharacterId);
      function render() {
        const q = search.value.trim().toLowerCase();
        list.replaceChildren(...eligible.filter(row => [row.name,...row.aliases].some(term => term.toLowerCase().includes(q))).map(row =>
          button(row.name, () => void merge(person.id, row.id))));
        if (!list.childElementCount) list.append(el("p","No matching supporting characters."));
      }
      search.oninput = render; render(); search.focus();
    } catch (error) { if (epoch === token) fail(error); }
  }
  async function merge(targetId: string, sourceId: string) {
    const token = ++epoch; screen("Review merge"); status.textContent = "Loading both characters…";
    try {
      const preview = await api.mergePreview(campaign, targetId, sourceId);
      if (token !== epoch || !dialog.open) return;
      renderMerge(preview);
    } catch (error) { if (token === epoch) { fail(error); footer.prepend(button("Choose another character", () => void chooseSource())); } }
  }
  function renderMerge(p: CastMergePreview) {
    const source = p.source.character, target = p.target.character;
    screen("Review merge"); body.append(el("p", `Merge ${source.name} into ${target.name}. The target keeps its name, origin, pin and ignore settings.`));
    const group = el("fieldset"); group.append(el("legend", "Aliases to keep (up to 20)"));
    const aliases = p.aliasCandidates.map(alias => {
      const input = el("input"); input.type = "checkbox"; input.checked = true; const label = el("label", alias);
      label.className = "cast-choice"; label.prepend(input); group.append(label); return { alias, input };
    });
    const choices: CastMergeRequest["choices"] = {};
    const emptyFields: string[] = [];
    const fields = p.fields.flatMap(field => {
      const name = fieldName(field.path);
      if (field.target === null && field.source === null) {
        emptyFields.push(name);
        return [];
      }
      const row = el("fieldset"), comparison = el("div");
      row.className = "cast-merge-field";
      comparison.className = "cast-merge-comparison";
      for (const [character, value] of [[target, field.target], [source, field.source]] as const) {
        const column = el("div");
        column.append(el("strong", character.name), el("p", display(value)));
        comparison.append(column);
      }
      row.append(el("legend", name), comparison);
      body.append(row);
      if (!field.allowedChoices.length) {
        const winner = field.defaultChoice === "source" ? source : target;
        row.append(el("p", "Keeps " + winner.name + "’s value."));
        return [];
      }
      const select = el("select");
      select.setAttribute("aria-label", name + " after merge");
      if (field.choiceRequired) select.append(new Option("Choose a value", ""));
      for (const side of field.allowedChoices) {
        select.append(new Option("Keep " + (side === "source" ? source.name : target.name) + "’s value", side));
      }
      select.value = field.choiceRequired ? "" : field.defaultChoice ?? "";
      row.append(select);
      return [{ field, select }];
    });
    if (emptyFields.length) {
      const empty = el("details");
      empty.append(el("summary", "Fields with no value (" + emptyFields.length + ")"), el("p", emptyFields.join(", ")));
      body.append(empty);
    }
    body.append(group);
    footer.prepend(button("Confirm merge", () => {
      const reviewedAliases = aliases.filter(row => row.input.checked).map(row => row.alias);
      if (reviewedAliases.length > 20) { status.textContent = "Select at most 20 aliases."; return; }
      for (const { field, select } of fields) {
        if (field.choiceRequired && !select.value) { status.textContent = "Choose a value for " + fieldName(field.path) + "."; select.focus(); return; }
        if (select.value) choices[field.path] = select.value as "source" | "target"; else delete choices[field.path];
      }
      const payload = { expectedBoundary: p.target.boundary, expectedCastRevision: p.target.revision, expectedCharacterRevision: target.revision,
        sourceCharacterId: source.id, expectedSourceCharacterRevision: source.revision, reviewedAliases, choices };
      void write(async () => { const result = await api.merge(campaign, target.id, { ...payload, idempotencyKey: key(payload) });
        return { id: result.character.id, message: source.name + " merged into " + target.name + "." }; }, () => void merge(target.id, source.id));
    }));
  }
  async function undo() {
    screen("Review undo merge"); const token = ++epoch, event = options.mergeEventId!;
    try {
      const p = await api.unmergePreview(campaign, person.id, event); if (epoch !== token || !dialog.open) return;
      for (const row of [p.target,p.source]) body.append(el("h3", row.name), el("p", "Aliases: " + (row.aliases.join(", ") || "None")),
        ...Object.entries(row.profile).map(([path,value]) => el("p", fieldName(path) + ": " + display(value))));
      footer.prepend(button("Confirm undo merge", () => void write(async () => {
        const payload = { expectedBoundary: p.boundary, expectedCastRevision: p.revision, expectedCharacterRevision: p.expectedCharacterRevision,
          expectedSourceCharacterRevision: p.expectedSourceCharacterRevision, mergeEventId: event };
        const result = await api.unmerge(campaign, person.id, { ...payload, idempotencyKey: key(payload) });
        return { id: result.character.id, message: "Merge undone." };
      }, () => void undo())));
    } catch (error) { if (epoch === token) fail(error); }
  }
  async function worlds() {
    screen("Add to world draft"); const token = ++epoch;
    try {
      const data = await api.worlds(campaign); if (epoch !== token || !dialog.open) return;
      const select = el("select"), label = el("label","World draft");
      select.setAttribute("aria-label", "World draft");
      for (const world of data.worlds) select.append(new Option(world.title,world.id));
      if (data.worlds.some(world => world.id === data.sourceWorldId)) select.value = data.sourceWorldId!;
      label.append(select); body.append(label);
      if (data.worlds.length) footer.prepend(button("Review fields", () => void promotion(select.value)));
      else status.textContent = "No active world drafts are available.";
    } catch (error) { if (epoch === token) fail(error); }
  }
  async function promotion(worldId: string) {
    screen("Review world draft fields"); const token = ++epoch;
    try {
      const p = await api.promotionPreview(campaign, person.id, worldId); if (epoch !== token || !dialog.open) return;
      renderPromotion(p);
    } catch (error) { if (epoch === token) fail(error); }
  }
  function renderPromotion(p: CastPromotionPreview) {
    const mode = el("select"), label = el("label","Destination"); mode.append(new Option("Add as new",""));
    for (const match of p.matches) mode.append(new Option("Replace " + match.name,match.characterId)); label.append(mode); body.append(label);
    const rows = p.destinations.map(d => {
      const group = el("fieldset"), check = el("input"), caption = el("label",fieldName(d.path)), select = el("select");
      check.type = "checkbox"; caption.className = "cast-choice"; caption.prepend(check);
      select.setAttribute("aria-label", "Source for " + fieldName(d.path)); group.append(caption,select); body.append(group);
      const selectable = d.candidates.filter(c => !c.unselectableReason);
      if (selectable.length > 1) select.append(new Option("Choose one source",""));
      for (const c of d.candidates) {
        const option = new Option(promotionSource(c.sourcePath) + " · " + display(c.value) + (c.unselectableReason ? " (contains game mechanics, cannot be copied)" : ""),c.sourcePath);
        option.disabled = Boolean(c.unselectableReason); select.append(option);
      }
      if (!selectable.length) { check.disabled = true; select.disabled = true; group.append(el("small","This text contains game mechanics, so it cannot be copied to the world.")); }
      return { d, check, select, blocked: !selectable.length };
    });
    function defaults() { for (const row of rows) { const required = !mode.value && row.d.requiredOnAdd; row.check.checked = !row.blocked && (required || row.d.tickedByDefault && !(mode.value && row.d.path === "name")); row.check.disabled = required || row.blocked; } }
    mode.onchange = defaults; defaults();
    footer.prepend(button("Confirm draft change", () => {
      const selections = [];
      for (const row of rows.filter(row => row.check.checked)) {
        if (!row.select.value) { status.textContent = "Choose one source for " + fieldName(row.d.path) + "."; row.select.focus(); return; }
        selections.push({ destinationPath: row.d.path, sourcePath: row.select.value });
      }
      if (!selections.length) { status.textContent = "Select at least one field."; return; }
      const payload: Omit<CastPromote,"idempotencyKey"> = { worldId:p.worldId, expectedDraftRevision:p.draftRevision, expectedBoundary:p.boundary,
        expectedCastRevision:p.castRevision, expectedCharacterRevision:p.characterRevision, mode:mode.value ? "replace" : "add", ...(mode.value ? {targetCharacterId:mode.value}:{}), selections };
      void write(async () => { await api.promote(campaign,person.id,{...payload,idempotencyKey:key(payload)});
        return {id:person.id,message:"Saved to the world draft. Publish the draft to use this change in future campaigns."}; }, () => void promotion(p.worldId));
    }));
  }
  dialog.showModal();
  if (action === "merge") void chooseSource(); else if (action === "unmerge") void undo(); else if (action === "promote") void worlds(); else removal();
}
