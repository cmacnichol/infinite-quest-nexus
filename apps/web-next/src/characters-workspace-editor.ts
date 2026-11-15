import { changeCastEditor, setCastEditorField, canSaveCastEditor, prepareCastSubmission, failCastSubmission, reapplyCastDraft, reapplyNewCastDraft, SUPPORTING_FIELDS, type CastEditorState } from "@infinite-quest/client-core";
import { createCharactersWorkspaceSession, type CharactersWorkspaceState, type CampaignCastApi } from "@infinite-quest/client-web";
import type { CreateCastCharacter, EditCastCharacter } from "@infinite-quest/contracts";
export type CastEditorContext = { document: Document; api: CampaignCastApi; session: ReturnType<typeof createCharactersWorkspaceSession<CastEditorState>>; getState(): CharactersWorkspaceState<CastEditorState>; getEditor(): CastEditorState | null; setEditor(next: CastEditorState | null): void; generationActive(): boolean; epoch(): number; confirm(message: string): boolean };
export function renderCastEditor(dialog: HTMLDialogElement, context: CastEditorContext): void {
  const { document, api, session, generationActive } = context;
  const holder = { get editor() { return context.getEditor(); }, set editor(value: CastEditorState | null) { context.setEditor(value); } };
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "") => { const el = document.createElement(tag); el.textContent = text; return el; };
  const button = (text: string, action: () => void, disabled = false) => { const el = node("button", text); el.type = "button"; el.disabled = disabled; el.addEventListener("click", action); return el; };
  function renderEditor() {
    if (!holder.editor) return;
    const expanded = new Map([...dialog.querySelectorAll<HTMLDetailsElement>("[data-cast-group]")].map(group => [group.dataset.castGroup!, group.open]));
    dialog.classList.remove("characters-sheet-layout"); dialog.replaceChildren(); dialog.append(node("h2", holder.editor.characterId ? "Edit character" : "Add character")); const form = node("form"), save = node("button", "Save character"); save.type = "submit";
    form.append(node("p", holder.editor.characterId ? "Saved facts are filled in. Edit only what needs changing." : "Only a name is required. Add details you know, or review story matches to fill characters from evidence."));
    const syncSave = () => { save.disabled = !canSaveCastEditor(holder.editor!) || generationActive() || context.getState().changedWhileEditing; };
    const input = (label: string, value: string, change: (value: string) => void, multiline = true) => { const wrap = node("label", label), control = multiline ? node("textarea") : node("input"); control.value = value; control.maxLength = label === "Name" ? 200 : label.startsWith("Aliases") ? 4020 : 2000; control.setAttribute("aria-label", label); control.disabled = generationActive() || holder.editor!.saving; control.addEventListener("input", () => { change(control.value); syncSave(); }); wrap.append(control); form.append(wrap); return wrap; };
    input("Name", holder.editor.draft.name, value => { holder.editor = changeCastEditor(holder.editor!, { name: value }); }, false);
    input("Aliases (one per line)", holder.editor.draft.aliases.join("\n"), value => { holder.editor = changeCastEditor(holder.editor!, { aliases: value.split("\n").map(v => v.trim()).filter(Boolean) }); });
    const groups = new Map<string, HTMLDetailsElement>();
    for (const [key, title] of [["story", "Story profile"], ["appearance", "Appearance details"], ["state", "Current state"]]) {
      const group = node("details"); group.className = "characters-editor-group"; group.dataset.castGroup = key!;
      group.open = expanded.get(key!) ?? (key === "story" || Boolean(holder.editor.characterId) && key === "appearance");
      group.append(node("summary", title)); groups.set(key!, group); form.append(group);
    }
    for (const field of SUPPORTING_FIELDS) {
      const path = field.path as Parameters<typeof setCastEditorField>[1];
      const wrap = input(field.label, holder.editor.draft.profile[path] ?? "", value => { holder.editor = setCastEditorField(holder.editor!, path, value); }, field.input !== "text");
      const fieldStatus = node("span"); wrap.append(fieldStatus);
      function syncFieldStatus() {
        const overriding = Object.hasOwn(holder.editor!.setOverrides, path) || holder.editor!.loaded?.overrides.some(override => override.field === path);
        fieldStatus.replaceChildren();
        if (holder.editor!.clearOverrides.includes(path)) fieldStatus.append(node("small", "Will use the discovered value after saving."));
        else if (overriding) fieldStatus.append(node("small", "Your override"));
        if (holder.editor!.characterId && overriding && !holder.editor!.clearOverrides.includes(path)) fieldStatus.append(button(`Use discovered value for ${field.label.toLowerCase()}`, () => { holder.editor = setCastEditorField(holder.editor!, path, null); renderEditor(); }, generationActive() || holder.editor!.saving));
      }
      wrap.querySelector("textarea, input")!.addEventListener("input", syncFieldStatus); syncFieldStatus();
      groups.get(field.path.split(".")[0]!)?.append(wrap);
    }
    if (holder.editor.characterId) for (const [key, label] of [["pinned", "Pin character"], ["ignored", "Ignore character"]] as const) {
      const wrap = node("label", label), control = node("input"); control.type = "checkbox"; control.checked = holder.editor.draft[key]; control.disabled = generationActive() || holder.editor.saving; control.addEventListener("change", () => { holder.editor = changeCastEditor(holder.editor!, { [key]: control.checked }); syncSave(); }); wrap.prepend(control); form.append(wrap);
    }
    if (holder.editor.characterId) form.append(node("small", "Pin prioritizes this character in story context. Ignore excludes this supporting character from story context."));
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
    save.disabled = !canSaveCastEditor(holder.editor) || generationActive() || context.getState().changedWhileEditing; form.append(save, button("Cancel", () => { if (!(holder.editor?.dirty ? context.confirm("Discard unsaved character changes?") : true)) return; holder.editor = null; session.setDraft(null); }));
    form.addEventListener("submit", async event => { event.preventDefault(); if (!holder.editor || !context.getState().campaignId || generationActive() || !canSaveCastEditor(holder.editor) || context.getState().changedWhileEditing) return; const campaign = context.getState().campaignId!, id = holder.editor.characterId; try { holder.editor = prepareCastSubmission(holder.editor, crypto.randomUUID()); renderEditor(); const result = id ? await api.edit(campaign, id, holder.editor.submission as EditCastCharacter) : await api.create(campaign, holder.editor.submission as CreateCastCharacter); holder.editor = null; session.setDraft(null); session.select(result.character.id); } catch (error) { if (!holder.editor) return; holder.editor = failCastSubmission(holder.editor, error instanceof Error ? error.message : "Could not save character.", (error as { statusCode?: number }).statusCode === 409); renderEditor(); } }); dialog.append(form);
  }
  renderEditor();
}
