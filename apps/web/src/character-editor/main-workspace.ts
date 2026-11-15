import { editorSectionForPath, sectionsForContext, WORLD_EDITOR_FIELDS, type EditorSectionId } from "@infinite-quest/client-core";
import { mountCharacterWorkspace, type EditorPresentationPort } from "./workspace.js";

/** Move the incumbent protagonist controls; the campaign controller still owns every write. */
export function mountMainCharacterWorkspace(form: HTMLElement, port: EditorPresentationPort) {
  const doc = form.ownerDocument;
  const storage = doc.createElement("div"); storage.className = "character-presentation-storage";
  while (form.firstChild) storage.append(form.firstChild);
  form.append(storage);
  const origins = new Map<HTMLElement, Comment>();
  const move = (node: HTMLElement, destination: HTMLElement) => {
    const marker = doc.createComment("main-character-control"); node.before(marker); origins.set(node, marker); destination.append(node);
  };
  const sections = new Map<EditorSectionId, HTMLElement>();
  for (const id of sectionsForContext("campaign-main")) {
    const section = doc.createElement("div"); section.hidden = true; form.append(section); sections.set(id, section);
  }
  for (const control of storage.querySelectorAll<HTMLElement>("[data-character-profile-path]")) {
    const id = editorSectionForPath(control.dataset.characterProfilePath!, "campaign-main");
    if (id) move(control.closest("label")!, sections.get(id)!);
  }
  move(storage.querySelector<HTMLElement>("#characterImportedGuidance")!, sections.get("notes")!);
  const workspace = mountCharacterWorkspace(form, port, { sections, preview() {
    const preview = doc.createElement("div");
    for (const field of WORLD_EDITOR_FIELDS) {
      const control = form.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${field.world!.id}`);
      if (!control?.value.trim()) continue;
      const line = doc.createElement("p"); line.textContent = `${field.world!.label}: ${control.value}`; preview.append(line);
    }
    return preview;
  } });
  // Recovery controls must remain available even when fields are locked, in every section.
  const working = form.querySelector<HTMLElement>(".character-workspace-working")!;
  for (const id of ["characterStatus", "campaignCharacterFeedback", "recheckCampaignCharacterGeneration"]) {
    const node = storage.querySelector<HTMLElement>(`#${id}`)!; move(node, working);
  }
  const originalSave = storage.querySelector<HTMLButtonElement>("#saveCharacter")!;
  const originalCancel = storage.querySelector<HTMLButtonElement>("#cancelCharacter")!;
  originalSave.id = "legacySaveCharacter"; originalCancel.id = "legacyCancelCharacter";
  const footer = form.querySelector(".character-workspace-footer")!;
  footer.querySelector("button.primary")!.id = "saveCharacter";
  [...footer.querySelectorAll("button")].find(button => button.textContent === "Cancel")!.id = "cancelCharacter";
  const input = (event: Event) => {
    if (event.target instanceof HTMLElement && event.target.closest(".character-workspace-fields")) workspace.refresh();
  };
  form.addEventListener("input", input);
  return { ...workspace, dispose() {
    form.removeEventListener("input", input);
    workspace.dispose();
    for (const [node, marker] of origins) marker.replaceWith(node);
    for (const section of sections.values()) section.remove();
    while (storage.firstChild) form.append(storage.firstChild);
    storage.remove(); originalSave.id = "saveCharacter"; originalCancel.id = "cancelCharacter";
  } };
}
