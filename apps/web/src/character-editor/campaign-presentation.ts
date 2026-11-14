import { editorSectionForPath, summarizeEditorSections, presetFields, SUPPORTING_FIELDS, type EditorValue } from "@infinite-quest/client-core";
import { mountCharacterWorkspace, type EditorPresentationPort, type EditorSectionId, type EditorCommitResult } from "./workspace.js";
import { mountQuickCharacterCreate } from "./quick-create.js";
/** Presentation adapter over the cast workflow's existing drafts and save authority. */
export function mountCampaignPresentation(form: HTMLFormElement, options: {
  context: "campaign-preset" | "campaign-supporting"; detailed: boolean; initialSection: string;
  snapshot(): { name: EditorValue; values: Record<string, EditorValue>; dirty: boolean; busy: boolean; locked: boolean; readOnly: boolean; status: string };
  commit(): Promise<EditorCommitResult>; close(): void; continued(): void;
}) {
  const document = form.ownerDocument, sections = new Map<EditorSectionId, HTMLElement>();
  const origins = new Map<HTMLElement, Comment>(), hidden = new Map<HTMLElement, HTMLElement["hidden"]>();
  form.classList.add("campaign-presentation-form");
  const auxiliary = document.createElement("div");
  const make = () => document.createElement("div");
  const section = (id: EditorSectionId) => { let result = sections.get(id); if (!result) { result = make(); form.append(result); sections.set(id, result); } return result; };
  const move = (node: HTMLElement, target: HTMLElement) => { if (!origins.has(node)) { const marker = document.createComment("campaign-field"); node.before(marker); origins.set(node, marker); } target.append(node); };
  for (const sibling of [...(form.parentElement?.children ?? [])] as HTMLElement[]) {
    if (sibling.isSameNode(form)) continue;
    if (sibling.tagName === "HEADER" || sibling instanceof HTMLButtonElement && sibling.textContent === "Back to characters") {
      hidden.set(sibling, sibling.hidden); sibling.hidden = true; sibling.style.display = "none";
    } else if (sibling.getAttribute("role") === "status" || sibling instanceof HTMLButtonElement && sibling.textContent === "Check generation status") move(sibling, auxiliary);
  }
  const duplicate = form.querySelector<HTMLElement>("[data-cast-duplicate]"); if (duplicate) move(duplicate, auxiliary);
  let validationMessage = "";
  const registry = options.context === "campaign-preset" ? presetFields : [{ path: "name" }, { path: "identity.aliases" }, ...SUPPORTING_FIELDS];
  for (const field of registry) {
    const id = field.path === "identity.aliases" && options.context === "campaign-supporting" ? "aliases" : field.path.replace(".", "-");
    const input = form.querySelector<HTMLInputElement | HTMLTextAreaElement>("#cast-" + id);
    if (input) { if (field.path === "name") input.required = true; move(input.parentElement!, section(editorSectionForPath(field.path, options.context) ?? "notes")); }
  }
  const sources = section("sources");
  for (const child of [...form.children] as HTMLElement[]) {
    if ([...sections.values()].includes(child)) continue;
    if (child instanceof HTMLButtonElement && (child.type === "submit" || child.textContent === "Cancel") || child instanceof HTMLDetailsElement && child.dataset.castGroup) { hidden.set(child, child.hidden); child.hidden = true; child.style.display = "none"; child.setAttribute("aria-hidden", "true"); }
    else move(child, sources);
  }
  const port: EditorPresentationPort = {
    snapshot() { const state = options.snapshot(); const errors = registry.filter(field => {
      const suffix = field.path === "identity.aliases" && options.context === "campaign-supporting" ? "aliases" : field.path.replace(".", "-");
      const input = form.querySelector<HTMLInputElement | HTMLTextAreaElement>("#cast-" + suffix);
      return input?.getAttribute("aria-invalid") === "true" || input?.validity && !input.validity.valid;
    }).map(field => field.path); return { ...state, status: validationMessage || state.status, name: String(state.name), destination: "Campaign character", sections: [...summarizeEditorSections(options.context, state.values, errors), { id: "sources", label: "Sources and history", detail: "Review and campaign options", populated: 0, errors: 0 }] }; },
    flush() {}, async commit() {
      const lock = form.querySelector<HTMLFieldSetElement>(".character-workspace-fields");
      const disabled = lock?.disabled; if (lock) lock.disabled = false;
      const invalid = [...form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")].find(input => !input.validity.valid || input.id === "cast-name" && !input.value.trim());
      if (lock) lock.disabled = Boolean(disabled);
      if (invalid) { validationMessage = invalid.id === "cast-name" ? "Enter a character name." : invalid.validationMessage; invalid.setAttribute("aria-invalid", "true"); invalid.addEventListener("input", () => { invalid.removeAttribute("aria-invalid"); validationMessage = ""; }, { once: true }); return "blocked"; }
      return options.commit();
    }, async requestClose() { options.close(); return false; }
  };
  let mounted: { dispose(): void; refresh?(): void } | null = null;
  const current = options.initialSection as EditorSectionId;
  const detailed = () => {
    options.continued();
    const shell = mountCharacterWorkspace(form, port, { sections, preview() { const preview = make(); for (const [path, value] of Object.entries(options.snapshot().values)) if (String(value ?? "").trim()) { const line = document.createElement("p"); line.textContent = (presetFields.find(field => field.path === path)?.label ?? path) + ": " + String(value); preview.append(line); } return preview; } });
    mounted = shell;
    form.querySelector(".character-workspace-working")?.prepend(auxiliary);
    form.addEventListener("change", event => { if (event.target instanceof HTMLInputElement && event.target.type === "checkbox") shell.refresh(); });
    if (sections.has(current)) shell.reveal(current);
    form.addEventListener('invalid', invalid, true);
    function invalid(event: Event) { const control = event.target as HTMLElement; for (const [id, container] of sections) if (container.contains(control)) shell.reveal(id, control); }

  };
  if (options.detailed) detailed();
  else {
    const quick = make(); form.append(quick);
    for (const path of ["name", "story.role", "story.personality"]) { const input = form.querySelector('#cast-' + path.replace('.', '-')); if (input) quick.append(input.parentElement!); }
    for (const content of sections.values()) content.hidden = true;
    mounted = mountQuickCharacterCreate(form, { context: "campaign-supporting", port, fields: quick, aiTools: auxiliary, onContinue() { mounted?.dispose(); section("overview").prepend(...quick.children); quick.remove(); detailed(); } });
  }
  return { refresh() { mounted?.refresh?.(); }, section: () => (form.querySelector<HTMLSelectElement>(".character-workspace-narrow select")?.value as EditorSectionId | undefined) ?? current, dispose() { mounted?.dispose(); form.classList.remove("campaign-presentation-form"); for (const [node, marker] of origins) marker.replaceWith(node); for (const [node, value] of hidden) { node.hidden = value; node.style.removeProperty("display"); node.removeAttribute("aria-hidden"); } for (const content of sections.values()) content.remove(); } };
}
