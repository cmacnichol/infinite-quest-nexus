import { WORLD_EDITOR_FIELDS, type CharacterEditorDraft } from "@infinite-quest/client-core";

/** Mount the shared character controls inside the stable dialog host. */
export type CharacterEditorActions = {
  save?: (event: Event) => void;
  close?: () => void;
  generate?: () => void;
  organize?: () => void;
  delete?: () => void;
  addStat?: () => void;
  addTracker?: () => void;
  change?: (path: string, value: string | string[]) => void;
};

export function renderCharacterEditor(host: Element, draft: CharacterEditorDraft | null, actions: CharacterEditorActions): void {
  host.innerHTML = `
    <form id="characterForm" novalidate>
      <div class="character-dialog-heading">
        <div>
          <p class="eyebrow">World Library</p>
          <h2 id="characterDialogTitle">Add character</h2>
          <p id="characterDialogDescription">Playable character · Create a character for this world draft.</p>
        </div>
      </div>
      <details id="characterGenerator" class="character-generator hidden">
        <summary>Draft a character with AI</summary>
        <div class="character-generator-fields">
          <label>Character concept or prompt<textarea id="characterGeneratorPrompt" rows="3" maxlength="10000" placeholder="Describe the role, personality, background, appearance, and place in this world."></textarea></label>
          <button id="generateCharacter" class="button primary" type="button">Generate character</button>
        </div>
        <p class="field-note">Generation only fills this form. Review and apply it; save the parent world draft to persist changes.</p>
      </details>
      <p id="characterGeneratorUnavailable" class="field-note hidden">To draft with AI, choose a default text provider and model in Provider Setup. You can fill in the character manually below.</p>
      <div class="character-core-fields">
        <p id="characterPlayableContext" class="field-note character-playable-context">Playable character · This character is part of the world's playable roster.</p>
        <span data-character-profile-group="name"></span>
      </div>
      <div id="characterStatus" class="status hidden" role="status" aria-live="polite"></div>
      <fieldset class="character-profile-section">
        <legend>Story essentials</legend>
        <p class="field-note">Start with a name and at least one story detail. Everything else is optional.</p>
        <div class="character-profile-grid">
          <span data-character-profile-group="core"></span>
        </div>
      </fieldset>
      <details id="characterIdentityDetails" class="author-advanced-disclosure character-advanced-disclosure">
        <summary>Names and pronouns (optional)</summary>
        <fieldset class="character-profile-section">
          <legend>Identity</legend>
          <div class="character-profile-grid">
          <span data-character-profile-group="identity"></span>
          </div>
        </fieldset>
      </details>
      <details id="characterStoryDetails" class="author-advanced-disclosure character-advanced-disclosure">
        <summary>More story details (optional)</summary>
        <fieldset class="character-profile-section">
          <legend>Story details</legend>
          <div class="character-profile-grid">
          <span data-character-profile-group="story"></span>
          </div>
        </fieldset>
      </details>
      <details id="characterAppearance" class="author-advanced-disclosure character-advanced-disclosure">
        <summary>Appearance (optional, fiction only)</summary>
        <fieldset class="character-profile-section">
        <legend>Visual identity</legend>
        <div class="character-profile-grid">
          <span data-character-profile-group="appearance"></span>
        </div>
        </fieldset>
      </details>
      <details id="characterMechanics" class="author-advanced-disclosure character-advanced-disclosure">
        <summary>Mechanics (optional, kept separate from fiction)</summary>
        <div id="characterMechanicsFields">
          <fieldset class="character-collection">
            <legend title="Optional game-mechanics values for this character. These are kept separate from story and visual profile details.">RPG statistics</legend>
            <div id="characterStats" class="character-row-list"></div>
            <button id="addCharacterStat" class="button secondary compact-button" type="button" title="Add an RPG statistic. Mechanics are never copied into story or visual profile fields.">+ Add statistic</button>
          </fieldset>
          <fieldset class="character-collection">
            <legend title="Optional campaign-state values that can change during play. These are not character story or appearance facts.">Starting trackers</legend>
            <div id="characterTrackers" class="character-row-list"></div>
            <button id="addCharacterTracker" class="button secondary compact-button" type="button" title="Add a starting campaign tracker. Its rules remain outside the character profile.">+ Add tracker</button>
          </fieldset>
        </div>
      </details>
      <section id="characterImportedGuidance" class="character-source-section" aria-label="Notes and source material">
        <h3>Notes and source material</h3>
        <label id="characterGuidanceSource" title="Original free-form guidance retained as read-only source material. Use AI organization to sort supported details into the profile fields.">Imported source guidance
          <textarea id="characterGuidance" rows="4" maxlength="200000" readonly placeholder="Older general guidance is retained here as source material."></textarea>
        </label>
        <fieldset class="character-profile-section">
        <legend>Other notes</legend>
          <span data-character-profile-group="notes"></span>
        </fieldset>
        <button id="organizeCharacterProfile" class="button secondary" type="button" title="Asks AI to propose evidence-backed field assignments from the current profile, legacy guidance, and world lore. Nothing changes until you review and apply proposals.">Organize notes with AI…</button>
        <span id="organizeCharacterProfileProgress" class="organize-profile-progress hidden" role="status" aria-live="polite" aria-label="Organizing character profile">
          <span class="organize-profile-spinner" aria-hidden="true"></span>Organizing…
        </span>
      </section>
      <div class="button-row character-dialog-actions">
        <button id="deleteCharacter" class="button danger" type="button">Delete character</button>
        <span class="character-action-spacer"></span>
        <button id="cancelCharacter" class="button secondary" type="button">Cancel</button>
        <button id="saveCharacter" class="button primary" type="submit">Apply to world draft</button>
      </div>
    </form>
  `;
  for (const group of host.querySelectorAll<HTMLElement>("[data-character-profile-group]")) {
    const fields = WORLD_EDITOR_FIELDS.filter((field) => field.world!.group === group.dataset.characterProfileGroup).sort((a, b) => a.world!.order - b.world!.order);
    for (const field of fields) {
      const world = field.world!;
      const label = host.ownerDocument.createElement("label");
      label.title = world.title;
      label.append(world.label);
      const control = host.ownerDocument.createElement(world.input === "text" ? "input" : "textarea");
      control.id = world.id;
      if (field.path === "name") {
        control.setAttribute("required", "");
        control.setAttribute("autocomplete", "off");
      }
      control.dataset.characterProfilePath = field.path;
      control.dataset.characterProfileInput = field.input;
      control.setAttribute("placeholder", world.placeholder);
      control.setAttribute("maxlength", String(field.maxItems ? field.maxLength * field.maxItems + field.maxItems - 1 : field.maxLength));
      const value = draft?.values[field.path];
      if (value !== undefined) control.value = Array.isArray(value) ? value.join("\n") : value;
      label.append(control);
      group.before(label);
    }
    group.remove();
  }
  const form = host.querySelector("#characterForm")!;
  form.addEventListener("input", (event) => {
    const control = event.target as HTMLInputElement | HTMLTextAreaElement;
    const path = control.dataset.characterProfilePath;
    if (!path) return;
    const raw = control.value.trim();
    actions.change?.(path, control.dataset.characterProfileInput === "list" ? raw.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean) : raw);
  });
  host.querySelector("#characterForm")?.addEventListener("submit", (event) => actions.save?.(event));
  for (const [id, action] of Object.entries({
    cancelCharacter: actions.close, generateCharacter: actions.generate,
    organizeCharacterProfile: actions.organize, deleteCharacter: actions.delete,
    addCharacterStat: actions.addStat, addCharacterTracker: actions.addTracker
  })) {
    if (action) host.querySelector(`#${id}`)?.addEventListener("click", action);
  }
}
