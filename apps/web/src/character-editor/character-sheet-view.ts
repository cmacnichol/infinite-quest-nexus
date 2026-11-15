import { castEvidenceOrder } from "@infinite-quest/contracts";
import { CHARACTER_FIELD_DESCRIPTORS } from "../../../../packages/client-core/src/characters/profile-fields.js";
import { clearEditLabel, conflictChoices, type SheetChange } from "../../../../packages/client-core/src/characters/sheet-changes.js";
import type { CharacterField, CharacterSheet } from "../../../../packages/client-core/src/characters/sheet.js";

export type SheetResult = { ok: true } | { ok: false; conflict: boolean; message: string };
export type SheetFeedback = { message: string; undo?: () => Promise<SheetResult> };
export type RetractionPreview = { currentValue: string | null; projectedValue: string | null; quote: string; turn: number };
export type CharacterSheetViewOptions = {
  sheet: CharacterSheet; kind: "main" | "supporting";
  editable(path: string): boolean; lockedReason: string | null;
  onChange(change: SheetChange): Promise<SheetResult>;
  onEditStart?(path: string, mode: "edit" | "conflict"): boolean | void;
  onInteractionEnd?(path: string): void;
  onIdleError?(result: SheetResult): boolean | void;
  feedback?: SheetFeedback;
  retraction?: { preview(observationId: string): Promise<RetractionPreview>; apply(observationId: string): Promise<SheetResult> };
  toggles?: { pinned: boolean; ignored: boolean };
  onCompareLatest(): void; compareLabel: "Compare latest" | "Load latest version";
  showEmpty: boolean; onShowEmpty(value: boolean): void;
  confirmDiscard(): boolean; isCurrent(): boolean;
};

let viewSequence = 0;
export function renderCharacterSheetView(host: HTMLElement, options: CharacterSheetViewOptions): { revealField(path: string, mode?: "edit" | "conflict"): void; dirty(): boolean; active(): boolean; setFeedback(feedback?: SheetFeedback): void; showError(result: SheetResult): void; dispose(): void } {
  const doc = host.ownerDocument, idPrefix = `character-sheet-${++viewSequence}`;
  let disposed = false, pending = false, feedbackVisible = true, editor: { path: string; input: HTMLInputElement | HTMLTextAreaElement; initial: string } | null = null;
  let activePath: string | null = null, mode: "edit" | "conflict" = "edit", error: SheetResult | null = null;
  let preview: { field: CharacterField; id: string; data: RetractionPreview } | null = null;
  const current = () => !disposed && options.isCurrent();
  const dirty = () => Boolean(editor && editor.input.value !== editor.initial);
  const allowRefresh = () => !dirty() || options.confirmDiscard();
  const rowFor = (path: string) => Array.from(host.querySelectorAll<HTMLElement>("[data-path]")).find(row => row.dataset.path === path);
  const focusField = (path: string, selector: string) => rowFor(path)?.querySelector<HTMLElement>(selector)?.focus();
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => { const node = doc.createElement(tag); if (text !== undefined) node.textContent = text; return node; };
  const button = (text: string, action: () => void) => { const node = el("button", text); node.type = "button"; node.disabled = pending; node.addEventListener("click", action); return node; };
  const setPending = (value: boolean) => { pending = value; host.querySelectorAll("button, input, textarea").forEach(node => { (node as HTMLButtonElement).disabled = value; }); };
  const showError = (result: SheetResult) => { if (!current() || result.ok) return; error = result; const region = host.querySelector(".character-sheet-error"); if (region) { region.replaceChildren(); region.append(el("span", result.conflict ? "This character changed. Your edit is kept; compare the latest before saving." : result.message)); region.append(button(options.compareLabel, () => { if (allowRefresh()) options.onCompareLatest(); })); } };
  const run = async (operation: () => Promise<SheetResult>) => { if (pending || !current()) return; setPending(true); let result: SheetResult; try { result = await operation(); } catch { result = { ok: false, conflict: false, message: "Could not save. Please try again." }; } if (!current()) return; setPending(false); if (!result.ok && (dirty() || preview || !options.onIdleError?.(result))) showError(result); };
  const open = (path: string, next: "edit" | "conflict") => { if (!current() || pending || !options.editable(path)) return; if (activePath !== path && dirty() && !options.confirmDiscard()) return; if (options.onEditStart) { feedbackVisible = false; if (options.onEditStart(path, next)) return; } activePath = path; mode = next; editor = null; preview = null; error = null; render(); focusField(path, next === "edit" ? "input, textarea" : ".character-sheet-choice button, .character-sheet-write-own"); };
  const startRetraction = async (field: CharacterField, id: string) => { if (!options.retraction || pending || !current()) return; if (dirty() && !options.confirmDiscard()) return; setPending(true); try { const data = await options.retraction.preview(id); if (!current()) return; setPending(false); activePath = null; editor = null; preview = { field, id, data }; render(); focusField(field.path, ".character-sheet-confirm button"); } catch { if (!current()) return; setPending(false); const result: SheetResult = { ok: false, conflict: false, message: "Could not preview this change. Please try again." }; if (dirty() || preview || !options.onIdleError?.(result)) showError(result); } };
  function render() {
    if (!current()) return;
    host.replaceChildren(); const root = el("div"); root.className = "character-sheet-view"; host.append(root);
    if (options.lockedReason) root.append(el("p", options.lockedReason));
    if (feedbackVisible && options.feedback) { const notice = el("div"); notice.setAttribute("role", "status"); notice.append(el("span", options.feedback.message)); const undo = options.feedback.undo; if (undo) notice.append(button("Undo", () => { if (allowRefresh()) void run(undo); })); root.append(notice); }
    const errorRegion = el("div"); errorRegion.className = "character-sheet-error"; errorRegion.setAttribute("role", "alert"); root.append(errorRegion); if (error && !error.ok) showError(error);
    if (options.toggles && options.kind === "supporting") {
      const group = el("div"); group.className = "character-sheet-toggles";
      for (const key of ["pinned", "ignored"] as const) { const b = button(key === "pinned" ? "Pin" : "Ignore", () => { if (allowRefresh()) void run(() => options.onChange({ kind: "toggle", key, value: !options.toggles![key] })); }); b.setAttribute("aria-pressed", String(options.toggles[key])); group.append(b); }
      group.append(el("p", "Pin prioritizes this character in story context. Ignore excludes this supporting character from story context.")); root.append(group);
    }
    const show = button(options.showEmpty ? "Hide empty fields" : "Show empty fields", () => { if (allowRefresh()) options.onShowEmpty(!options.showEmpty); }); root.append(show);
    for (const section of options.sheet.sections) {
      const visible = section.fields.filter(field => options.showEmpty || field.value !== null && (Array.isArray(field.value) ? field.value.length > 0 : field.value.trim().length > 0) || field.origin === "conflicted" || field.origin === "claim" || field.path === activePath);
      if (!visible.length) continue;
      const sectionNode = el("section"); sectionNode.append(el("h3", section.name)); root.append(sectionNode);
      for (const field of visible) {
        const row = el("div"); row.className = "character-sheet-field"; row.dataset.path = field.path; sectionNode.append(row);
        row.append(el("strong", field.label)); const value = Array.isArray(field.value) ? field.value.join(", ") : field.value; row.append(el("p", value || "Unknown"));
        if (options.kind === "supporting") {
          const badge = field.origin === "user" && field.editTurn !== null ? `Your edit · turn ${field.editTurn}` : field.origin === "observed" && field.observedTurn !== null ? `From story · turn ${field.observedTurn}` : field.origin === "claim" ? "Unverified claim" : field.origin === "conflicted" ? "Conflict" : "";
          if (badge) row.append(el("span", badge));
          if (field.replacedEditTurn !== null) row.append(el("p", `Replaced your edit from turn ${field.replacedEditTurn}`));
          if (field.storyDiffers) row.append(el("p", `Story differs: ${field.storyDiffers.value} · turn ${field.storyDiffers.turn}`));
        }
        if (!options.editable(field.path)) continue;
        if (activePath === field.path && mode === "edit") {
          const descriptor = CHARACTER_FIELD_DESCRIPTORS.find(item => item.path === field.path); const label = el("label", field.label); const input = descriptor?.input === "text" ? el("input") : el("textarea"); input.id = `${idPrefix}-${field.path.replace(/[^a-zA-Z0-9_-]/g, "-")}`; label.htmlFor = input.id; input.value = Array.isArray(field.value) ? field.value.join("\n") : field.value ?? ""; if (descriptor) input.maxLength = descriptor.maxLength;
          editor = { path: field.path, input, initial: input.value }; row.append(label, input);
          input.addEventListener("keydown", event => { if ((event as KeyboardEvent).key === "Escape") { event.stopPropagation(); activePath = null; editor = null; render(); focusField(field.path, "button"); options.onInteractionEnd?.(field.path); } });
          row.append(button("Save", () => { const raw = input.value; const next = descriptor?.input === "list" ? raw.split(/\r?\n/).map(item => item.trim()).filter(Boolean) : raw.trim(); void run(() => options.onChange({ kind: "field", path: field.path, value: next })); }), button("Cancel", () => { if (dirty() && !options.confirmDiscard()) return; activePath = null; editor = null; render(); focusField(field.path, "button"); options.onInteractionEnd?.(field.path); }));
        } else {
          row.append(button(`Edit ${field.label}`, () => open(field.path, "edit")));
          if (options.kind === "supporting" && field.origin === "user" && field.editTurn !== null && field.path !== "name" && field.path !== "identity.aliases") row.append(button(field.storyDiffers ? "Use story value" : clearEditLabel(field, field.override ? "plain" : "startingCast"), () => { if (allowRefresh()) void run(() => options.onChange({ kind: "field", path: field.path, value: null })); }));
          if (field.origin === "conflicted") row.append(button("Resolve conflict", () => open(field.path, "conflict")));
          if (options.retraction && field.retractable && field.retractableObservationIds.includes(field.retractable.id)) row.append(button("This is wrong", () => { void startRetraction(field, field.retractable!.id); }));
        }
        if (activePath === field.path && mode === "conflict") {
          for (const choice of conflictChoices(field)) {
            const item = el("div"); item.className = "character-sheet-choice"; item.append(el("span", `${choice.value}${choice.latestTurn === null ? "" : ` · turn ${choice.latestTurn}`}${choice.quote === null ? "" : ` · “${choice.quote}”`}`));
            if (!options.retraction) item.append(button("Use this", () => { void run(() => options.onChange({ kind: "field", path: field.path, value: choice.value })); }));
            else { const candidates = field.observations.filter(obs => choice.observationIds.includes(obs.id)).sort((a, b) => { const x = castEvidenceOrder(a.evidence), y = castEvidenceOrder(b.evidence); return y[0] - x[0] || y[1] - x[1]; }); if (choice.retractableObservationId && candidates[0]?.id === choice.retractableObservationId && field.retractableObservationIds.includes(choice.retractableObservationId)) item.append(button("This is wrong", () => { void startRetraction(field, choice.retractableObservationId!); })); }
            row.append(item);
          }
          const writeOwn = button("Write my own", () => open(field.path, "edit")); writeOwn.className = "character-sheet-write-own"; row.append(writeOwn);
        }
        if (preview?.field.path === field.path) { const region = el("div"); region.className = "character-sheet-confirm"; region.append(el("p", `After this, ${field.label} will read: ${preview.data.projectedValue || "Unknown"}`), el("p", `“${preview.data.quote}” · turn ${preview.data.turn}`), button("Confirm", () => { const id = preview!.id; void run(() => options.retraction!.apply(id)); }), button("Cancel", () => { preview = null; render(); focusField(field.path, "button"); options.onInteractionEnd?.(field.path); })); row.append(region); }
      }
    }
  }
  render();
  return { revealField(path, next = "edit") { open(path, next); Array.from(host.querySelectorAll<HTMLElement>("[data-path]")).find(row => row.dataset.path === path)?.scrollIntoView?.({ block: "nearest" }); }, dirty, active: () => Boolean(activePath || preview || pending), setFeedback(feedback) { if (feedback) options.feedback = feedback; else delete options.feedback; render(); }, showError, dispose() { disposed = true; } };
}
