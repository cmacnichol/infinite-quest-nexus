import { castRosterRow, trackingSummary, type CastAttention } from "@infinite-quest/client-core";
import type { CastCharacter, CastDiscoveryStatus, CharacterFilter } from "@infinite-quest/contracts";

export type CastRosterViewOptions = {
  characters: CastCharacter[]; attention: Record<string, CastAttention | undefined>;
  tracking: CastDiscoveryStatus | null; attentionTotal: number | null;
  filters: Array<[CharacterFilter, string]>; filter: CharacterFilter; query: string;
  canAdd: boolean; addDisabledReason?: string; secondaryActions: HTMLElement[]; tools: HTMLElement[];
  onQuery(query: string, filter: CharacterFilter): void; onOpen(id: string): void; onAdd(): void; onAttention(): void;
  debounceMs?: number; schedule?: (fn: () => void, ms: number) => () => void;
};

export function renderCastRoster(host: HTMLElement, options: CastRosterViewOptions): { focusSearch(): void; dispose(): void } {
  const doc = host.ownerDocument;
  const root = doc.createElement("section"); root.className = "cast-roster-view";
  const status = doc.createElement("section"); status.className = "cast-roster-status";
  const summary = trackingSummary(options.tracking); status.dataset.tone = summary.tone;
  const headline = doc.createElement("p"); headline.textContent = summary.headline; status.append(headline);
  const tools = doc.createElement("details"); tools.className = "cast-roster-tools";
  const toolsTitle = doc.createElement("summary"); toolsTitle.textContent = "Tracking and tools"; tools.append(toolsTitle);
  for (const detail of summary.details) { const line = doc.createElement("p"); line.textContent = detail; tools.append(line); }
  tools.append(...options.tools); status.append(tools);
  const toolbar = doc.createElement("section"); toolbar.className = "cast-roster-toolbar";
  const button = (text: string, action: () => void) => { const el = doc.createElement("button"); el.type = "button"; el.textContent = text; el.addEventListener("click", action); return el; };
  const form = doc.createElement("form"); form.className = "cast-roster-search";
  const searchLabel = doc.createElement("label"); searchLabel.textContent = "Search characters";
  const search = doc.createElement("input"); search.type = "search"; search.value = options.query; searchLabel.append(search);
  const filterLabel = doc.createElement("label"); filterLabel.textContent = "Filter characters";
  const filter = doc.createElement("select");
  for (const [value, label] of options.filters) { const option = doc.createElement("option"); option.value = value; option.textContent = label; if (value === options.filter) option.setAttribute("selected", ""); filter.append(option); }
  filterLabel.append(filter);
  const submit = doc.createElement("button"); submit.type = "submit"; submit.textContent = "Search"; form.append(searchLabel, filterLabel, submit);
  const actions = doc.createElement("div"); actions.className = "cast-roster-actions";
  const attention = button(options.attentionTotal === null ? "Needs attention" : `Needs attention (${options.attentionTotal})`, options.onAttention);
  const add = button("Add character", options.onAdd); add.disabled = !options.canAdd;
  actions.append(attention, ...options.secondaryActions, add);
  if (!options.canAdd && options.addDisabledReason) { const reason = doc.createElement("p"); reason.className = "cast-roster-add-reason"; reason.textContent = options.addDisabledReason; actions.append(reason); }
  toolbar.append(form, actions);
  const list = doc.createElement("section"); list.className = "cast-roster-list";
  const characters = [...options.characters.filter(person => person.origin.kind === "protagonist"), ...options.characters.filter(person => person.origin.kind !== "protagonist")];
  if (!characters.length) { const empty = doc.createElement("p"); empty.textContent = options.query.trim() || options.filter !== "all" ? "No characters match this search." : "No supporting characters yet. Add someone from your story."; list.append(empty); }
  for (const person of characters) {
    const row = castRosterRow(person, options.attention[person.id]); const item = doc.createElement("article"); item.className = "cast-roster-row";
    item.append(button(row.name, () => options.onOpen(row.id)));
    for (const [className, value] of [["cast-roster-provenance", row.provenance], ["cast-roster-summary", row.summary], ["cast-roster-last-seen", row.lastSeen]]) {
      if (value) { const line = doc.createElement("p"); line.className = className!; line.textContent = value!; item.append(line); }
    }
    const badges = doc.createElement("div"); badges.className = "cast-roster-badges";
    for (const badge of row.badges) { const el = doc.createElement("span"); el.className = "cast-badge"; el.dataset.kind = badge.kind; el.textContent = badge.label; badges.append(el); }
    item.append(badges); list.append(item);
  }
  root.append(status, toolbar, list); host.replaceChildren(root);
  const schedule = options.schedule ?? ((fn: () => void, ms: number) => { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); });
  let cancel: (() => void) | undefined; let disposed = false;
  const run = () => { cancel?.(); cancel = undefined; if (!disposed) options.onQuery(search.value, filter.value as CharacterFilter); };
  search.addEventListener("input", () => { cancel?.(); cancel = schedule(() => { cancel = undefined; if (!disposed) options.onQuery(search.value, filter.value as CharacterFilter); }, options.debounceMs ?? 250); });
  filter.addEventListener("change", run); form.addEventListener("submit", event => { event.preventDefault(); run(); });
  return { focusSearch: () => search.focus(), dispose: () => { disposed = true; cancel?.(); cancel = undefined; } };
}
