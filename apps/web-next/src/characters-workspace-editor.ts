import { createStoryDraftReview } from "../../web/src/character-editor/story-draft.js";
import { renderStoryDraftPanel } from "../../web/src/character-editor/story-draft-panel.js";
import { createCastTextField, renderSupportingEditorFields } from "../../web/src/character-editor/renderer.js";
import { changeCastEditor, setCastEditorField, canSaveCastEditor, prepareCastSubmission, failCastSubmission, reapplyCastDraft, reapplyNewCastDraft, SUPPORTING_FIELDS, type CastEditorState } from "@infinite-quest/client-core";
import { createCharactersWorkspaceSession, type CharactersWorkspaceState, type CampaignCastApi } from "@infinite-quest/client-web";
import type { CreateCastCharacter, EditCastCharacter } from "@infinite-quest/contracts";
export type CastEditorContext = { document: Document; api: CampaignCastApi; session: ReturnType<typeof createCharactersWorkspaceSession<CastEditorState>>; getState(): CharactersWorkspaceState<CastEditorState>; getEditor(): CastEditorState | null; setEditor(next: CastEditorState | null): void; generationActive(): boolean; epoch(): number; confirm(message: string): boolean; saved(id: string, name: string): void; navigate(turn: number): void };
export function renderCastEditor(dialog: HTMLDialogElement, context: CastEditorContext): void {
  const { document, api, session, generationActive } = context;
  const review = createStoryDraftReview();
  const holder = { get editor() { return context.getEditor(); }, set editor(value: CastEditorState | null) { context.setEditor(value); } };
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "") => { const el = document.createElement(tag); el.textContent = text; return el; };
  const button = (text: string, action: () => void, disabled = false) => { const el = node("button", text); el.type = "button"; el.disabled = disabled; el.addEventListener("click", action); return el; };
  function renderEditor() {
    if (!holder.editor) return;
    const expanded = new Map([...dialog.querySelectorAll<HTMLDetailsElement>("[data-cast-group]")].map(group => [group.dataset.castGroup!, group.open]));
    dialog.classList.remove("characters-sheet-layout"); dialog.replaceChildren(); dialog.append(node("h2", holder.editor.characterId ? "Edit character" : "Add character")); const form = node("form"), save = node("button", "Save character"); save.type = "submit";
    form.append(node("p", holder.editor.characterId ? "Saved facts are filled in. Edit only what needs changing." : "Only a name is required. Add details you know, or review story matches to fill characters from evidence."));
    const syncSave = () => { save.disabled = !canSaveCastEditor(holder.editor!) || generationActive() || context.getState().changedWhileEditing; };
    const input = (label: string, value: string, change: (value: string) => void, multiline = true) => { const wrap = node("label", label), control = multiline ? node("textarea") : node("input"); control.id = label === "Name" ? "characters-name" : "characters-aliases"; wrap.setAttribute("for", control.id); control.value = value; control.maxLength = label === "Name" ? 200 : label.startsWith("Aliases") ? 4020 : 2000; control.setAttribute("aria-label", label); control.disabled = generationActive() || holder.editor!.saving; control.addEventListener("input", () => { change(control.value); syncSave(); }); wrap.append(control); form.append(wrap); return wrap; };
    input("Name", holder.editor.draft.name, value => { holder.editor = changeCastEditor(holder.editor!, { name: value }); }, false);
    input("Aliases (one per line)", holder.editor.draft.aliases.join("\n"), value => { holder.editor = changeCastEditor(holder.editor!, { aliases: value.split("\n").map(v => v.trim()).filter(Boolean) }); });
    renderSupportingEditorFields(form, { expanded, existing: Boolean(holder.editor.characterId), field(pathValue, label) {
      const field = SUPPORTING_FIELDS.find(item => item.path === pathValue)!;
      const path = pathValue as Parameters<typeof setCastEditorField>[1];
      const wrap = createCastTextField(document, { label, id: `characters-${path.replace(".", "-")}`, value: holder.editor!.draft.profile[path] ?? "", maxLength: 2000, multiline: field.input !== "text", disabled: generationActive() || holder.editor!.saving, onInput(value) { holder.editor = setCastEditorField(holder.editor!, path, value); syncSave(); } });
      const fieldStatus = node("span"); wrap.append(fieldStatus);
      function syncFieldStatus() {
        const overriding = Object.hasOwn(holder.editor!.setOverrides, path) || holder.editor!.loaded?.overrides.some(override => override.field === path);
        fieldStatus.replaceChildren();
        if (holder.editor!.clearOverrides.includes(path)) fieldStatus.append(node("small", "Will use the discovered value after saving."));
        else if (overriding) fieldStatus.append(node("small", "Your override"));
        if (holder.editor!.characterId && overriding && !holder.editor!.clearOverrides.includes(path)) fieldStatus.append(button(`Use discovered value for ${label.toLowerCase()}`, () => { holder.editor = setCastEditorField(holder.editor!, path, null); renderEditor(); }, generationActive() || holder.editor!.saving));
      }
      wrap.querySelector("textarea, input")!.addEventListener("input", syncFieldStatus); syncFieldStatus();
      return wrap;
    } });
    const detail = holder.editor.loaded, campaign = context.getState().campaignId;
    if (detail && campaign && detail.character.origin.kind !== "protagonist" && api.draftPreview) {
      renderStoryDraftPanel(form, { detail, campaign, draftPreview: api.draftPreview, review,
        readonly: generationActive() || holder.editor.saving || Boolean(holder.editor.conflict) || context.getState().changedWhileEditing || (context.getState().status?.capabilities.editing !== true || context.getState().detail?.capabilities.castEditing !== true),
        current(path) { return SUPPORTING_FIELDS.some(field => field.path === path) ? holder.editor?.draft.profile[path as keyof typeof holder.editor.draft.profile] ?? "" : undefined; },
        apply(path, value) { if (!generationActive() && typeof value === "string") holder.editor = setCastEditorField(holder.editor!, path as Parameters<typeof setCastEditorField>[1], value); },
        changed: renderEditor, turn: context.navigate,
        async fetch(direction) {
          if (generationActive() || !holder.editor || context.getState().changedWhileEditing || context.getState().campaignId !== campaign || (context.getState().status?.capabilities.editing !== true || context.getState().detail?.capabilities.castEditing !== true)) throw new Error("Character editing is unavailable");
          const epoch = context.epoch();
          const result = await api.draftPreview!(campaign, detail.character.id, { expectedCastRevision: detail.revision, expectedBoundary: detail.boundary, expectedCharacterRevision: detail.character.revision, ...(direction ? { direction } : {}) });
          if (epoch !== context.epoch() || context.getState().campaignId !== campaign || !holder.editor || generationActive()) throw new Error("Character selection changed");
          return result;
        }
      });
    }
    if (holder.editor.error) form.append(node("p", holder.editor.error));
    if (holder.editor.conflict || context.getState().changedWhileEditing) {
      form.append(node("p", "The saved character changed. Your edits are still here."));
      form.append(button("Compare latest", async () => {
        if (!holder.editor || !context.getState().campaignId) return;
        const draft = holder.editor, campaign = context.getState().campaignId!, epoch = context.epoch();
        try {
        if (!draft.characterId) {
          const latest = await api.list(campaign);
          if (epoch !== context.epoch() || holder.editor !== draft || context.getState().campaignId !== campaign) return;
          const comparison = node("section");
          comparison.append(node("p", "Your new character has not been saved. Your draft is preserved."));
          comparison.append(node("p", `Latest characters: ${latest.characters.map(person => person.name).join(", ") || "None"}`));
          comparison.append(button("Reapply my changes", () => {
            if (holder.editor !== draft || generationActive()) return;
            holder.editor = reapplyNewCastDraft(holder.editor, latest); session.setDraft(null); session.setDraft(holder.editor); renderEditor();
          }, !latest.capabilities.castEditing || generationActive()));
          form.append(comparison); return;
        }
        const latest = await api.detail(campaign, draft.characterId);
        if (epoch !== context.epoch() || holder.editor !== draft || context.getState().campaignId !== campaign) return;
        const comparison = node("section"); comparison.append(node("h3", "Latest saved character"), node("p", `Name: ${latest.character.name}`));
        for (const field of SUPPORTING_FIELDS) comparison.append(node("p", `${field.label}: ${latest.character.profile[field.path as keyof typeof latest.character.profile] ?? "Unknown"}`));
        comparison.append(button("Reapply my changes", () => { if (holder.editor !== draft || generationActive()) return; holder.editor = reapplyCastDraft(holder.editor!, latest); session.setDraft(null); session.setDraft(holder.editor); renderEditor(); }, !latest.capabilities.castEditing || generationActive())); form.append(comparison);
        } catch { if (epoch === context.epoch() && holder.editor === draft) form.append(node("p", "Could not load the latest characters. Your draft is kept; try Compare latest again.")); }
      }));
    }
    save.disabled = !canSaveCastEditor(holder.editor) || generationActive() || context.getState().changedWhileEditing; form.append(save, button("Cancel", () => { if (!(holder.editor?.dirty ? context.confirm("Discard unsaved character changes?") : true)) return; review.reset(); holder.editor = null; session.setDraft(null); }));
    form.addEventListener("submit", async event => { event.preventDefault(); if (!holder.editor || !context.getState().campaignId || generationActive() || !canSaveCastEditor(holder.editor) || context.getState().changedWhileEditing) return; const campaign = context.getState().campaignId!, id = holder.editor.characterId; try { holder.editor = prepareCastSubmission(holder.editor, crypto.randomUUID()); renderEditor(); const fences = review.fences().filter(fence => holder.editor?.setOverrides[fence.path as keyof typeof holder.editor.setOverrides] === fence.value); const result = id ? await api.edit(campaign, id, { ...holder.editor.submission as EditCastCharacter, ...(fences.length ? { draftEvidenceFences: fences } : {}) }) : await api.create(campaign, holder.editor.submission as CreateCastCharacter); review.reset(); holder.editor = null; session.setDraft(null); context.saved(result.character.id, result.character.name); } catch (error) { if (!holder.editor) return; holder.editor = failCastSubmission(holder.editor, error instanceof Error ? error.message : "Could not save character.", (error as { statusCode?: number }).statusCode === 409); renderEditor(); } }); dialog.append(form);
  }
  renderEditor();
}
