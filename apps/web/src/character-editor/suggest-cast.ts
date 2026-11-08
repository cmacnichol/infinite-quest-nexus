import { MAX_PLAYABLE_CHARACTERS, worldCharacterNames, type CastSuggestionPreviewResponse, type PlayableCharacter, type WorldContent } from "@infinite-quest/contracts";

type Seed = CastSuggestionPreviewResponse["seeds"][number];
type Row = { seed: Seed; selected: boolean; character?: PlayableCharacter; status: string };
type Options = {
  content(): WorldContent;
  provider(): boolean;
  suggest(content: WorldContent, count: number, direction: string): Promise<CastSuggestionPreviewResponse>;
  expand(content: WorldContent, seed: Seed): Promise<{ character: PlayableCharacter }>;
  edit(character: PlayableCharacter, apply: (character: PlayableCharacter) => void): void;
  add(characters: PlayableCharacter[]): void;
};

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text = "") {
  const el = document.createElement(tag);
  el.textContent = text;
  return el;
}
function action(label: string, fn: () => void, disabled = false) {
  const el = element("button", label);
  el.className = "button secondary compact-button"; el.type = "button"; el.disabled = disabled; el.onclick = fn;
  return el;
}

export function openCastSuggestions(options: Options) {
  const dialog = element("dialog"), title = element("h2", "Suggest cast");
  dialog.className = "cast-dialog cast-suggestions"; title.id = "suggest-cast-title"; dialog.setAttribute("aria-labelledby", title.id);
  const direction = element("textarea"), count = element("input"), status = element("p"), body = element("div"), controls = element("div");
  const field = (label: string, input: HTMLElement) => { const el = element("label", label); el.append(input); return el; };
  direction.maxLength = 10000; count.type = "number"; count.min = "3"; count.max = "8"; count.value = "5"; count.required = true;
  status.setAttribute("role", "status"); controls.className = "button-row";
  const cost = element("p"); cost.className = "field-note";
  let rows: Row[] = [], busy = false, stopped = false, requested = false;
  const close = () => {
    if ((busy || rows.length) && !window.confirm("Discard unadded cast suggestions?")) return;
    stopped = true; dialog.close();
  };
  dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
  dialog.onclick = event => { if (event.target === dialog) { const bounds = dialog.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close(); } };
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  const updateCost = () => {
    const n = rows.length ? rows.filter(row => row.selected).length : count.valueAsNumber;
    cost.textContent = `Up to one provider call for seeds and ${Number.isFinite(n) ? n : 8} for selected characters, plus any repair calls. Results are lost on refresh.`;
  };
  count.oninput = updateCost;
  function draw() {
    direction.disabled = busy; count.disabled = busy; updateCost(); body.replaceChildren(); controls.replaceChildren();
    const available = options.provider();
    if (!available) status.textContent = "Configure a default text provider and model to suggest a cast. You can still add characters manually.";
    for (const [index, row] of rows.entries()) {
      const group = element("fieldset"), selection = element("input"); selection.type = "checkbox"; selection.checked = row.selected; selection.disabled = busy;
      selection.onchange = () => { row.selected = selection.checked; draw(); };
      const selectLabel = field("Select suggestion", selection); selectLabel.className = "cast-choice";
      group.append(element("legend", `Suggestion ${index + 1}`), selectLabel);
      for (const key of ["name", "role", "concept"] as const) {
        const input = key === "concept" ? element("textarea") : element("input");
        input.value = row.seed[key]; input.disabled = busy || Boolean(row.character);
        input.maxLength = key === "concept" ? 1000 : key === "role" ? 2000 : 200;
        input.oninput = () => { row.seed[key] = input.value; };
        group.append(field(key[0]!.toUpperCase() + key.slice(1), input));
      }
      group.append(element("p", row.status));
      if (row.character) group.append(action("Edit character", () => options.edit(row.character!, value => {
        row.character = value; row.seed.name = value.name; row.status = "Edited"; draw();
      }), busy), action(row.status.startsWith("Failed") ? "Retry" : "Regenerate", () => void expand([row]), busy || !available));
      else if (row.status.startsWith("Failed") || row.status === "Not generated") group.append(action("Retry", () => void expand([row]), busy || !available));
      group.append(action("Drop", () => { rows = rows.filter(item => item !== row); draw(); }, busy));
      body.append(group);
    }
    if (!rows.length) {
      if (requested) controls.append(action("Edit direction", () => direction.focus(), busy));
      controls.append(action(requested ? "Retry" : "Suggest seeds", () => void suggest(), busy || !available));
    } else {
      controls.append(action("Expand selected", () => void expand(rows.filter(row => row.selected && !row.character)), busy || !available || !rows.some(row => row.selected && !row.character)));
      if (busy) controls.append(action("Stop", () => { stopped = true; status.textContent = "Stopping after the current character…"; }));
      controls.append(action("Add selected to draft", () => {
        const ready = rows.filter(row => row.selected && row.character);
        if ((options.content().playableCharacters?.length ?? 0) + ready.length > MAX_PLAYABLE_CHARACTERS) {
          status.textContent = `The roster can contain up to ${MAX_PLAYABLE_CHARACTERS} characters. Select fewer suggestions.`; return;
        }
        const normalized = (name: string) => name.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
        const reserved = new Set(worldCharacterNames(options.content()).map(normalized));
        for (const row of ready) {
          const name = normalized(row.character!.name);
          if (reserved.has(name)) {
            status.textContent = `A character named ${row.character!.name} already exists. Edit the suggestion or clear its selection.`;
            status.scrollIntoView({ block: "nearest" }); return;
          }
          reserved.add(name);
        }
        options.add(ready.map(row => row.character!)); rows = rows.filter(row => !ready.includes(row));
        if (rows.length) { status.textContent = `Added ${ready.length} to the world draft.`; draw(); } else dialog.close();
      }, busy || !rows.some(row => row.selected && row.character)));
    }
    controls.append(action("Close", close));
  }
  async function suggest() {
    if (busy || !count.reportValidity()) return;
    busy = true; requested = true; draw(); status.textContent = "Requesting cast suggestions…";
    try {
      const result = await options.suggest(options.content(), count.valueAsNumber, direction.value.trim());
      rows = result.seeds.map(seed => ({ seed: { ...seed }, selected: true, status: "Ready for expansion" }));
      status.textContent = rows.length ? "Review the seeds before expanding." : "No new names were suggested. Edit the direction or retry.";
    } catch { status.textContent = "Seed request failed. Edit the direction or retry."; }
    finally { busy = false; if (dialog.open) draw(); }
  }
  async function expand(selected: Row[]) {
    if (busy) return;
    busy = true; stopped = false;
    for (const [index, row] of selected.entries()) {
      if (stopped || !dialog.open) { if (!row.character) row.status = "Not generated"; continue; }
      if (![row.seed.name, row.seed.role, row.seed.concept].every(value => value.trim())) {
        row.status = "Failed: enter a name, role and concept before retrying."; continue;
      }
      status.textContent = `Generating ${index + 1} of ${selected.length}…`; row.status = "Generating…"; draw();
      try {
        const result = await options.expand(options.content(), row.seed);
        row.character = { ...result.character, name: result.character.name, id: row.character?.id ?? crypto.randomUUID(),
          campaignUse: "supporting", startingCastDefault: true, alwaysInContext: false, rpgStats: [], defaultTriggers: [] };
        row.status = "Generated";
      } catch { row.status = "Failed to generate. Retry this suggestion."; }
    }
    busy = false; status.textContent = stopped ? "Stopped. Finished characters are ready to review." : "Expansion finished. Review the results.";
    if (dialog.open) draw();
  }
  dialog.append(title, field("Direction (optional)", direction), field("Number of characters", count), cost, status, body, controls);
  document.body.append(dialog); draw(); dialog.showModal(); direction.focus();
}
