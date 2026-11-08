import {
  type CharacterEditorDraft,
  WORLD_EDITOR_FIELDS,
  buildEditorPayload,
  createEditorDraft,
  markEditorConflict,
  reapplyEditorDraft,
  setEditorDraftField
} from "@infinite-quest/client-core";
import { campaignCharacterProfileUpdateSchema, type CampaignCharacterProfile } from "@infinite-quest/contracts";
import { characterFieldsForGroup, createCharacterField } from "./renderer.js";

type Profile = CampaignCharacterProfile & { revision: number };
const groups = [
  ["name", "Character"],
  ["core", "Story essentials"],
  ["identity", "Names and pronouns (optional)", "characterIdentityDetails"],
  ["story", "More story details (optional)", "characterStoryDetails"],
  ["appearance", "Appearance (optional)", "characterAppearance"],
  ["notes", "Other notes (optional)"]
] as const;

export function buildCampaignProfileUpdate(draft: CharacterEditorDraft, revision: number) {
  return campaignCharacterProfileUpdateSchema.parse(buildEditorPayload(draft, { expectedRevision: revision }));
}

export function createCharacterProfileForm(root: HTMLElement, profile: Profile) {
  const document = root.ownerDocument;
  let draft = createEditorDraft("campaign-main", profile);
  let revision = profile.revision;
  const controls = new Map<string, HTMLInputElement | HTMLTextAreaElement>();
  root.replaceChildren();

  for (const [group, title, id] of groups) {
    const collapsible = group !== "name" && group !== "core";
    const section = document.createElement(collapsible ? "details" : "fieldset");
    if (id) section.id = id;
    const heading = document.createElement(collapsible ? "summary" : "legend");
    heading.textContent = title;
    section.append(heading);
    root.append(section);

    for (const field of characterFieldsForGroup(group)) {
      const { label, control } = createCharacterField(document, field);
      label.className = "character-profile-field";
      control.name = `profile.${field.path}`;
      control.addEventListener("input", () => {
        control.removeAttribute("aria-describedby");
        const value = field.input === "list"
          ? control.value.split(/\r?\n/).map(item => item.trim()).filter(Boolean)
          : control.value;
        draft = setEditorDraftField(draft, field.path, value);
      });
      section.append(label);
      controls.set(field.path, control);
    }
  }

  function syncFields() {
    for (const [path, control] of controls) {
      const value = draft.values[path];
      control.value = Array.isArray(value) ? value.join("\n") : value ?? "";
    }
  }
  syncFields();

  return {
    get dirty() { return draft.changedPaths.length > 0; },
    get draft() { return draft; },
    update: () => buildCampaignProfileUpdate(draft, revision),
    reapply(latest: Profile) {
      draft = reapplyEditorDraft(draft, latest);
      revision = latest.revision;
      syncFields();
    },
    load(latest: Profile) {
      draft = createEditorDraft("campaign-main", latest);
      revision = latest.revision;
      syncFields();
    },
    markConflict() { draft = markEditorConflict(draft); },
    setLocked(locked: boolean) { controls.forEach(control => { control.disabled = locked; }); },
    focus() { controls.get("name")?.focus(); },
    fieldControl(path: string) { return controls.get(path) ?? controls.get("name"); }
  };
}

type Form = ReturnType<typeof createCharacterProfileForm>;
type Options = {
  host: HTMLElement;
  saveButton?: HTMLButtonElement | null;
  load: () => Promise<Profile>;
  save: (payload: ReturnType<Form["update"]>) => Promise<Profile>;
  isCurrent: () => boolean;
  isLocked: () => boolean;
  onSaved: (profile: Profile) => void;
  onDiscard: () => void;
};

function displayValue(value: string | string[] | undefined) {
  return (Array.isArray(value) ? value.join(", ") : value) || "(empty)";
}

export function createCampaignMainController(form: Form, options: Options) {
  const document = options.host.ownerDocument;
  const region = document.createElement("div");
  const messageId = "campaign-character-editor-message";
  let clearFieldError: (() => void) | undefined;
  region.className = "campaign-character-feedback";
  options.host.append(region);
  let busy = false;
  let locked = false;
  let latest: Profile | null = null;

  function setLocked(value: boolean) {
    locked = value;
    form.setLocked(locked || busy);
    if (options.saveButton) options.saveButton.disabled = locked || busy || form.draft.conflict;
    for (const button of region.querySelectorAll("button")) {
      button.disabled = busy || (locked && button.dataset.dismiss !== "true")
        || (button.dataset.save === "true" && form.draft.conflict);
    }
  }

  function message(text: string) {
    const status = document.createElement("p");
    status.id = messageId;
    status.tabIndex = -1;
    status.setAttribute("role", "status");
    status.textContent = text;
    region.replaceChildren(status);
    status.focus();
  }

  function addButton(label: string, action: () => void, purpose?: "dismiss" | "save") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "button secondary";
    button.textContent = label;
    if (purpose) button.dataset[purpose] = "true";
    button.addEventListener("click", action);
    region.append(button);
    button.disabled = busy || (locked && purpose !== "dismiss") || (purpose === "save" && form.draft.conflict);
  }

  function showConflict(text = "The character profile changed. Compare the latest version before saving.") {
    message(text);
    addButton("Compare latest", compare);
  }

  async function save() {
    if (busy || locked || options.isLocked() || !options.isCurrent() || form.draft.conflict) return;
    clearFieldError?.();
    let payload: ReturnType<Form["update"]>;
    try {
      payload = form.update();
    } catch (error) {
      const issue = (error as { issues?: { path: (string | number)[]; message: string }[] }).issues?.[0];
      const path = issue?.path.filter(part => typeof part === "string" && part !== "profile").join(".") || "name";
      const control = form.fieldControl(path);
      if (!control) {
        message(issue?.message ?? "Check the character profile before saving.");
        return;
      }
      const feedback = document.createElement("p");
      feedback.className = "character-field-error";
      feedback.id = "campaign-character-field-error";
      feedback.setAttribute("role", "alert");
      feedback.textContent = path === "name" && !control.value.trim() ? "Enter a character name." : issue?.message ?? "Check this field.";
      region.replaceChildren();
      const details = control.closest("details");
      if (details) details.open = true;
      (control.closest("label") ?? control).after(feedback);
      control.setAttribute("aria-describedby", feedback.id);
      control.setAttribute("aria-invalid", "true");
      control.focus();
      const clear = () => {
        feedback.remove();
        control.removeAttribute("aria-describedby");
        control.removeAttribute("aria-invalid");
        control.removeEventListener("input", clear);
        clearFieldError = undefined;
      };
      clearFieldError = clear;
      control.addEventListener("input", clear);
      return;
    }

    busy = true;
    setLocked(locked);
    try {
      const saved = await options.save(payload);
      if (options.isCurrent()) options.onSaved(saved);
    } catch (error) {
      if (!options.isCurrent()) return;
      const problem = error as { status?: number; statusCode?: number; domainCode?: string; details?: { code?: string }; message?: string };
      const code = problem.details?.code ?? problem.domainCode;
      if ((problem.statusCode ?? problem.status) === 409 && (!code || code === "state_revision_changed")) {
        form.markConflict();
        showConflict();
      } else if ((problem.statusCode ?? problem.status) === 409 && (code === "invalid_transition" || code === "generation_in_progress")) {
        setLocked(true);
        message("Finish or resolve generation before saving the character profile.");
      } else {
        message(`Profile could not be saved: ${problem.message || String(error)}`);
      }
    } finally {
      busy = false;
      if (options.isCurrent()) setLocked(locked);
    }
  }

  function resolveConflict(reapply: boolean) {
    if (!latest || locked) return;
    if (reapply) form.reapply(latest);
    else form.load(latest);
    latest = null;
    setLocked(locked);
    message(reapply ? "Your changes were reapplied to the latest profile." : "Latest profile loaded.");
    form.focus();
  }

  function showComparison() {
    if (!latest) return;
    message("Latest profile loaded. Reapply your changes or discard your draft.");
    const remote = createEditorDraft("campaign-main", latest);
    const original = createEditorDraft("campaign-main", form.draft.loaded);
    const list = document.createElement("ul");
    for (const field of WORLD_EDITOR_FIELDS) {
      const path = field.path;
      if (!form.draft.changedPaths.includes(path) && JSON.stringify(original.values[path]) === JSON.stringify(remote.values[path])) continue;
      const item = document.createElement("li");
      item.textContent = `${field.world?.label ?? path}: Latest: ${displayValue(remote.values[path])}; Yours: ${displayValue(form.draft.values[path])}`;
      list.append(item);
    }
    region.append(list);
    addButton("Reapply my changes", () => resolveConflict(true));
    addButton("Discard draft and load latest", () => resolveConflict(false));
  }

  async function compare() {
    if (busy || locked || options.isLocked()) return;
    busy = true;
    setLocked(locked);
    try {
      const result = await options.load();
      if (!options.isCurrent()) return;
      latest = result;
      showComparison();
    } catch (error) {
      if (options.isCurrent()) showConflict(`Latest profile could not be loaded: ${(error as Error).message}`);
    } finally {
      busy = false;
      if (options.isCurrent()) setLocked(locked);
    }
  }

  function keepEditing() {
    if (form.draft.conflict) {
      if (latest) showComparison();
      else showConflict();
    } else {
      region.replaceChildren();
      form.focus();
    }
  }

  function requestClose() {
    if (busy) return;
    if (!form.dirty) {
      options.onDiscard();
      return;
    }
    message("You have unsaved changes.");
    addButton("Keep editing", keepEditing, "dismiss");
    addButton("Save changes", save, "save");
    addButton("Discard changes", options.onDiscard, "dismiss");
  }

  return {
    save, setLocked, requestClose,
    dispose() { clearFieldError?.(); region.remove(); },
    get saving() { return busy; },
    get draft() { return form.draft; }
  };
}
