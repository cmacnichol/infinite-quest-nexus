import { changePresetField, presetField, presetFields, type PresetDraft } from "@infinite-quest/client-core";

export function renderPresetFields(form: HTMLFormElement, state: PresetDraft, disabled: boolean, changed: () => void, expanded: Map<string, boolean>, storyLink?: string) {
  const doc = form.ownerDocument;
  const notice = doc.createElement("p");
  notice.textContent = "The story can't change World canon fields. You can edit them for this campaign.";
  form.append(notice);
  const seed = state.detail.character.originProfile, legacyText = seed?.legacyCharacterText.trim() ?? "";
  if (legacyText && legacyText !== seed?.profile.unclassifiedNotes.trim()) {
    const label = doc.createElement("label"), source = doc.createElement("textarea");
    label.textContent = "Original source text (read-only)"; label.htmlFor = "cast-legacy-source";
    source.id = "cast-legacy-source"; source.readOnly = true; source.value = legacyText;
    form.append(label, source);
  }
  const sections = new Map<string, HTMLDetailsElement>();
  const controls = new Map<string, HTMLInputElement | HTMLTextAreaElement>();
  for (const field of presetFields) {
    const { path } = field, info = presetField(state.detail, path);
    const group = field.path === "story.goals" || field.world?.placement === "core" ? "Story essentials" : field.section;
    let section = sections.get(group);
    if (!section) {
      section = doc.createElement("details"); section.open = expanded.get(group) ?? group === "Story essentials"; section.dataset.castGroup = group;
      const title = doc.createElement("summary"); title.textContent = group;
      section.append(title); sections.set(group, section); form.append(section);
    }
    const row = doc.createElement("div"), label = doc.createElement("label");
    const input = doc.createElement(field.input === "text" ? "input" : "textarea");
    const display = (value: string | string[]) => Array.isArray(value) ? value.join("\n") : value;
    input.id = "cast-" + path.replace(".", "-"); controls.set(path, input);
    input.maxLength = field.maxItems ? (field.maxLength + 1) * field.maxItems - 1 :
      path.startsWith("state.") || path === "appearance.description" ? 2000 : field.maxLength;
    input.value = display(state.draft.values[path]!); input.disabled = disabled; input.required = path === "name" || info.policy === "fixed" && Boolean(info.original.length);
    label.textContent = field.label; label.htmlFor = input.id; row.append(label, input);
    if (info.badge) { const badge = doc.createElement("small"); badge.textContent = info.badge; row.append(badge); }
    const feedback = doc.createElement("small"); feedback.setAttribute("role", "status");
    if (!info.effective.length && info.policy === "fixed") feedback.textContent = "Left blank, this can be filled from the story.";
    row.append(feedback);
    function setAction(text: string, action: "reset" | "discover" | "hide" | "restore") {
      const button = doc.createElement("button"); button.type = "button"; button.textContent = text; button.disabled = disabled;
      button.addEventListener("click", () => {
        if (info.policy === "identity") {
          for (const name of ["name", "identity.aliases"]) {
            const value = presetField(state.detail, name).original;
            changePresetField(state, name, value, "reset");
            controls.get(name)!.value = display(value);
          }
          const removed = state.detail.character.aliases.filter(alias => !state.detail.character.originProfile!.rosterAliases.includes(alias));
          feedback.textContent = removed.length ? "Saving removes campaign aliases: " + removed.join(", ") : "Canonical identity will be restored on save.";
        } else {
          const value = action === "reset" || action === "restore" ? info.original : "";
          changePresetField(state, path, value, action); input.value = display(value);
          feedback.textContent = action === "reset" && !value.length ? "Left blank, this can be filled from the story." : text + " on save.";
        }
        changed(); input.focus();
      });
      row.append(button);
    }
    input.addEventListener("invalid", () => {
      section.open = true; feedback.id = input.id + "-error";
      feedback.textContent = input.validationMessage; input.setAttribute("aria-describedby", feedback.id);
    });
    input.addEventListener("input", () => {
      input.removeAttribute("aria-describedby");
      if (info.policy === "identity" && state.actions.get(path) === "reset") {
        for (const name of ["name", "identity.aliases"]) changePresetField(state, name, state.draft.values[name]!);
      }
      changePresetField(state, path, field.input === "list" ? input.value.split(/\r?\n/u).map(s => s.trim()).filter(Boolean) : input.value);
      feedback.textContent = ""; changed();
    });
    if (info.badge === "Edited for this campaign") setAction("Reset to world value", "reset");
    if (info.badge === "Added for this campaign") setAction("Clear", "reset");
    if (info.badge === "Your edit") setAction("Use discovered value", "discover");
    if (info.policy === "observed") setAction("Clear", "hide");
    if (path === "story.goals") setAction("Restore authored goals", "restore");
    if (info.differs) {
      const link = doc.createElement("a"); link.href = storyLink ?? "#cast-sources"; link.textContent = "Story differs";
      if (!storyLink) link.addEventListener("click", event => { event.preventDefault(); const sources = doc.querySelector<HTMLDetailsElement>("#cast-sources"); if (sources) { sources.open = true; sources.querySelector("summary")?.focus(); } });
      row.append(link);
    }
    section.append(row);
  }
}
