import { playableCharacterSchema } from "../../../packages/contracts/src/world-library";
import { initializeAppTheme, renderAppShell } from "./app-shell";
import {
  generateCharacterPreview as generateCharacterPreviewRequest,
  loadCharacterGenerationProgress as loadCharacterGenerationProgressRequest
} from "./character-workspace-api";
import {
  applyGeneratedCharacter,
  characterHandoffCandidate,
  characterReview,
  createCharacterWorkspaceState,
  editCharacterCandidate,
  setCharacterStage,
  validateCharacterStage,
  type CharacterStage,
  type CharacterWorkspaceState
} from "./character-workspace-model";
import {
  createCharacterWorkspaceSessionStore,
  type CharacterWorkspaceSessionStore
} from "./character-workspace-session";
import { mergeStructuredFields, structuredFieldsFor } from "./world-editor-fields";
import type { MountedPage } from "./world-library-page";

export interface CharacterWorkspacePageDependencies {
  sessionStore?: CharacterWorkspaceSessionStore;
  generateCharacterPreview?: typeof generateCharacterPreviewRequest;
  loadGenerationProgress?: typeof loadCharacterGenerationProgressRequest;
  readClipboardText?: () => Promise<string>;
  writeClipboardText?: (value: string) => Promise<void>;
  confirmGeneratedReplacement?: () => boolean;
  navigate?: (path: string) => void;
  generationPollIntervalMs?: number;
}

const STAGES: readonly CharacterStage[] = ["method", "identity", "story", "appearance", "mechanics", "review"];
const STAGE_LABELS: Record<CharacterStage, string> = {
  method: "Method", identity: "Identity", story: "Story", appearance: "Appearance", mechanics: "Mechanics", review: "Review"
};
const STORY_FIELDS = [
  ["role", "Role"], ["background", "Background"], ["personality", "Personality"], ["motivations", "Motivations"],
  ["goals", "Goals"], ["fearsAndConflicts", "Fears and conflicts"], ["keyRelationships", "Key relationships"],
  ["narrativeHooks", "Narrative hooks"], ["voiceAndMannerisms", "Voice and mannerisms"], ["otherGuidance", "Other guidance"]
] as const;
const APPEARANCE_FIELDS = [
  ["ancestryOrSpecies", "Ancestry or species"], ["apparentAge", "Apparent age"], ["genderPresentation", "Gender presentation"],
  ["build", "Build"], ["skinOrComplexion", "Skin or complexion"], ["face", "Face"], ["eyes", "Eyes"], ["hair", "Hair"],
  ["clothing", "Clothing"], ["equipmentAndAccessories", "Equipment and accessories"], ["otherVisualDetails", "Other visual details"]
] as const;

const copyIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11"/><path d="M16 8V5H5v11h3"/></svg>';
const pasteIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5h6M9 3h6v4H9zM7 5H5v16h14V5h-2"/></svg>';
const expandIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5"/></svg>';
const closeIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';

function required<T extends Element>(root: ParentNode, selector: string): T {
  const result = root.querySelector<T>(selector);
  if (!result) throw new Error(`The Character Workspace is missing ${selector}.`);
  return result;
}

function unavailableMarkup(returnPath: string | null): string {
  return `<main id="main-content" class="character-unavailable" data-page="character-workspace-unavailable">
    <section><h1>Character workspace unavailable</h1><p>This character workspace is unavailable or expired. Return to the world and start again.</p>
    <a href="${returnPath ?? "/app/"}">Return to world</a></section></main>`;
}

function workspaceMarkup(returnPath: string): string {
  return `<main id="main-content" class="character-main" data-page="character-workspace">
    <header class="character-command-row"><div><a href="${returnPath}" data-character-return>Return to world</a><h1>Character workspace</h1><p>Build one reviewed character for this world draft.</p></div><button type="button" data-action="cancel-character">Cancel</button></header>
    <div class="character-workspace">
      <nav class="character-stage-index" aria-label="Character creation stages">${STAGES.map((stage) => `<button type="button" data-character-stage="${stage}">${STAGE_LABELS[stage]}</button>`).join("")}</nav>
      <section class="character-canvas" data-character-canvas></section>
    </div>
    <dialog class="character-prompt-dialog" role="dialog" aria-modal="true" aria-labelledby="character-dialog-title">
      <header><h2 id="character-dialog-title">Character concept</h2><button type="button" data-action="close-character-prompt" aria-label="Close expanded character concept">${closeIcon}</button></header>
      <label class="character-field"><span>Concept prompt</span><textarea rows="14" data-character-prompt="expanded"></textarea></label>
      <div class="character-prompt-tools"><button type="button" data-action="copy-character-prompt" aria-label="Copy character concept">${copyIcon}</button><button type="button" data-action="paste-character-prompt" aria-label="Paste character concept">${pasteIcon}</button></div>
      <p data-character-dialog-clipboard-status aria-live="polite"></p>
    </dialog>
  </main>`;
}

function textControl(document: Document, name: string, labelText: string, value: string, textarea = false): HTMLLabelElement {
  const label = document.createElement("label");
  label.className = "character-field";
  const caption = document.createElement("span");
  caption.textContent = labelText;
  const control: HTMLInputElement | HTMLTextAreaElement = textarea
    ? document.createElement("textarea")
    : document.createElement("input");
  control.name = name;
  control.value = value;
  if (control instanceof document.defaultView!.HTMLTextAreaElement) control.rows = 4;
  const error = document.createElement("small");
  error.className = "character-field-error";
  error.dataset.fieldError = name;
  error.id = `character-${name.replaceAll(".", "-")}-error`;
  control.setAttribute("aria-describedby", error.id);
  label.append(caption, control, error);
  return label;
}

export function mountCharacterWorkspacePage(
  root: HTMLElement,
  sessionKey: string,
  dependencies: CharacterWorkspacePageDependencies = {}
): MountedPage {
  const document = root.ownerDocument;
  const view = document.defaultView;
  if (!view) throw new Error("The Character Workspace could not be initialized.");
  const pageView = view;
  let defaultStore: CharacterWorkspaceSessionStore | null = null;
  if (!dependencies.sessionStore) {
    try { defaultStore = createCharacterWorkspaceSessionStore(pageView.sessionStorage); } catch { defaultStore = null; }
  }
  const sessionStore = dependencies.sessionStore ?? defaultStore;
  const session = sessionStore?.load(sessionKey) ?? null;
  const returnPath = sessionStore?.returnPath(sessionKey) ?? session?.parentRoute ?? null;
  if (!session) {
    renderAppShell(root, unavailableMarkup(returnPath), "world-library");
    const theme = initializeAppTheme(root);
    return { dispose: () => theme.dispose() };
  }

  const activeSession = session;
  renderAppShell(root, workspaceMarkup(activeSession.parentRoute), "world-library");
  const theme = initializeAppTheme(root);
  const canvas = required<HTMLElement>(root, "[data-character-canvas]");
  const stageButtons = [...root.querySelectorAll<HTMLButtonElement>("[data-character-stage]")];
  const dialog = required<HTMLDialogElement>(root, ".character-prompt-dialog");
  const expandedPrompt = required<HTMLTextAreaElement>(root, '[data-character-prompt="expanded"]');
  const expandButtonSelector = '[data-action="expand-character-prompt"]';
  const generatePreview = dependencies.generateCharacterPreview ?? generateCharacterPreviewRequest;
  const loadProgress = dependencies.loadGenerationProgress ?? loadCharacterGenerationProgressRequest;
  const navigate = dependencies.navigate ?? ((path: string) => pageView.location.assign(path));
  const confirmReplacement = dependencies.confirmGeneratedReplacement ?? (() => pageView.confirm("Replace fields already entered with this generated character?"));
  const readClipboard = dependencies.readClipboardText ?? (() => pageView.navigator.clipboard.readText());
  const writeClipboard = dependencies.writeClipboardText ?? ((value: string) => pageView.navigator.clipboard.writeText(value));
  const pollInterval = Math.max(1, dependencies.generationPollIntervalMs ?? 500);
  const roster = activeSession.worldContext.playableCharacters.flatMap((value) => {
    const parsed = playableCharacterSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
  let state = createCharacterWorkspaceState({
    roster,
    candidate: activeSession.candidate ?? undefined,
    method: activeSession.candidate ? "ai" : null
  });
  let prompt = "";
  let dirty = false;
  let candidateDirty = activeSession.candidate !== null;
  let disposed = false;
  let completed = false;
  let generationSequence = 0;
  let generationController: AbortController | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let mechanicsCollection: "rpgStats" | "defaultTriggers" = "rpgStats";
  let mechanicsIndex = 0;

  const beforeUnload = (event: Event) => event.preventDefault();
  function markDirty(): void {
    if (dirty) return;
    dirty = true;
    pageView.addEventListener("beforeunload", beforeUnload);
  }
  function clearDirty(): void {
    dirty = false;
    pageView.removeEventListener("beforeunload", beforeUnload);
  }

  function stopGeneration(): void {
    generationSequence += 1;
    generationController?.abort();
    generationController = null;
    if (pollTimer !== null) clearTimeout(pollTimer);
    pollTimer = null;
  }

  function updateStageIndex(): void {
    stageButtons.forEach((button, index) => {
      const stage = button.dataset.characterStage as CharacterStage;
      const current = stage === state.stage;
      if (current) button.setAttribute("aria-current", "step"); else button.removeAttribute("aria-current");
      const unavailable = index > state.furthestStageIndex;
      button.disabled = unavailable;
      button.dataset.stageState = current ? "current" : index < state.furthestStageIndex ? "completed" : unavailable ? "upcoming" : "revisitable";
      if (unavailable) button.setAttribute("aria-disabled", "true"); else button.removeAttribute("aria-disabled");
    });
  }

  function fieldChanged(path: string[], value: unknown): void {
    state = editCharacterCandidate(state, path, value);
    candidateDirty = true;
    markDirty();
  }

  function bindCandidateInputs(): void {
    canvas.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[name]").forEach((control) => {
      control.addEventListener("input", () => {
        const path = control.name.split(".");
        if (path[0] !== "candidate") return;
        fieldChanged(path.slice(1), control.value);
      });
    });
  }

  function actions(final = false): HTMLElement {
    const ledger = document.createElement("div");
    ledger.className = "character-progress-ledger";
    const progress = document.createElement("p");
    progress.textContent = `${STAGES.indexOf(state.stage) + 1} of ${STAGES.length} · ${STAGE_LABELS[state.stage]}`;
    const back = document.createElement("button");
    back.type = "button"; back.dataset.action = "back-character"; back.textContent = "Back";
    const next = document.createElement("button");
    next.type = "button"; next.dataset.action = final ? "accept-character" : "continue-character"; next.textContent = final ? "Use character" : "Continue";
    ledger.append(progress, back, next);
    return ledger;
  }

  function renderMethod(): void {
    canvas.innerHTML = `<div class="character-stage character-method-stage"><header><h2>Choose how to begin</h2><p>Author each field manually or ask the Story Engine for an editable preview.</p></header>
      <fieldset class="character-method-controls"><legend>Character method</legend><label class="character-method-control"><input type="radio" name="characterMethod" value="manual"><span>Manual</span></label><label class="character-method-control"><input type="radio" name="characterMethod" value="ai"><span>AI-assisted</span></label></fieldset>
      <section class="character-prompt-authoring" data-character-ai-prompt hidden><div class="character-prompt-heading"><div><h3>Character concept</h3><p>Describe this character's role, personality, history, and visual identity.</p></div><div class="character-prompt-tools"><button type="button" data-action="copy-character-prompt" aria-label="Copy character concept">${copyIcon}</button><button type="button" data-action="paste-character-prompt" aria-label="Paste character concept">${pasteIcon}</button><button type="button" data-action="expand-character-prompt">${expandIcon}<span>Expand</span></button></div></div>
      <label class="character-field"><span>Concept prompt</span><textarea rows="7" data-character-prompt="compact"></textarea></label><p data-character-clipboard-status aria-live="polite"></p><div data-character-generation-status aria-live="polite"></div><div class="character-generation-actions"><button type="button" data-action="generate-character" disabled>Generate character</button><button type="button" data-action="cancel-character-generation" hidden>Cancel generation</button></div></section>
      <div data-character-manual hidden><p>Begin with an empty character and complete each stage.</p></div></div>`;
    const aiSection = required<HTMLElement>(canvas, "[data-character-ai-prompt]");
    const manual = required<HTMLElement>(canvas, "[data-character-manual]");
    const compact = required<HTMLTextAreaElement>(canvas, '[data-character-prompt="compact"]');
    const generate = required<HTMLButtonElement>(canvas, '[data-action="generate-character"]');
    compact.value = prompt;
    expandedPrompt.value = prompt;
    canvas.querySelectorAll<HTMLInputElement>('[name="characterMethod"]').forEach((radio) => {
      radio.checked = state.method === radio.value;
      radio.addEventListener("change", () => {
        if (!radio.checked) return;
        state = { ...state, method: radio.value as "manual" | "ai" };
        markDirty();
        aiSection.hidden = state.method !== "ai";
        manual.hidden = state.method !== "manual";
        generate.disabled = !prompt.trim();
        if (!canvas.querySelector(".character-progress-ledger")) canvas.append(actions());
      });
    });
    aiSection.hidden = state.method !== "ai";
    manual.hidden = state.method !== "manual";
    generate.disabled = !prompt.trim();
    if (state.method !== null) canvas.append(actions());
  }

  function renderIdentity(): void {
    const stage = document.createElement("div"); stage.className = "character-stage";
    stage.innerHTML = "<header><h2>Identity</h2><p>Name the character and record the identity readers will recognize.</p></header>";
    const form = document.createElement("div"); form.className = "character-fields";
    const id = textControl(document, "candidate.id", "Character ID", state.candidate.id);
    required<HTMLInputElement>(id, "input").readOnly = true;
    form.append(id, textControl(document, "candidate.name", "Name", state.candidate.name),
      textControl(document, "candidate.profile.identity.pronouns", "Pronouns", state.candidate.profile?.identity.pronouns ?? ""),
      textControl(document, "candidate.profile.identity.aliases", "Aliases (one per line)", state.candidate.profile?.identity.aliases.join("\n") ?? "", true));
    stage.append(form); canvas.replaceChildren(stage, actions()); bindCandidateInputs();
    const aliases = required<HTMLTextAreaElement>(canvas, '[name="candidate.profile.identity.aliases"]');
    aliases.addEventListener("input", () => fieldChanged(["profile", "identity", "aliases"], aliases.value.split("\n").map((v) => v.trim()).filter(Boolean)));
  }

  function renderStory(): void {
    const stage = document.createElement("div"); stage.className = "character-stage";
    stage.innerHTML = "<header><h2>Story</h2><p>Define how this character acts inside the fiction.</p></header>";
    const form = document.createElement("div"); form.className = "character-fields";
    form.append(textControl(document, "candidate.characterText", "Narrative guidance", state.candidate.characterText, true));
    for (const [name, label] of STORY_FIELDS) form.append(textControl(document, `candidate.profile.story.${name}`, label, state.candidate.profile?.story[name] ?? "", true));
    form.append(textControl(document, "candidate.profile.unclassifiedNotes", "Additional notes", state.candidate.profile?.unclassifiedNotes ?? "", true));
    stage.append(form); canvas.replaceChildren(stage, actions()); bindCandidateInputs();
  }

  function renderAppearance(): void {
    const stage = document.createElement("div"); stage.className = "character-stage";
    stage.innerHTML = "<header><h2>Appearance</h2><p>Record concrete visual facts without requiring a portrait.</p></header>";
    const form = document.createElement("div"); form.className = "character-fields";
    for (const [name, label] of APPEARANCE_FIELDS) form.append(textControl(document, `candidate.profile.appearance.${name}`, label, state.candidate.profile?.appearance[name] ?? "", true));
    form.append(textControl(document, "candidate.profile.appearance.distinguishingFeatures", "Distinguishing features (one per line)", state.candidate.profile?.appearance.distinguishingFeatures.join("\n") ?? "", true));
    stage.append(form); canvas.replaceChildren(stage, actions()); bindCandidateInputs();
    const features = required<HTMLTextAreaElement>(canvas, '[name="candidate.profile.appearance.distinguishingFeatures"]');
    features.addEventListener("input", () => fieldChanged(["profile", "appearance", "distinguishingFeatures"], features.value.split("\n").map((v) => v.trim()).filter(Boolean)));
  }

  function renderMechanics(): void {
    const stage = document.createElement("div"); stage.className = "character-stage";
    stage.innerHTML = `<header><h2>Mechanics</h2><p>Edit optional stats and default trackers using the same structured field adapters as the world editor.</p></header><div class="character-mechanics"><aside class="character-mechanics-master"><div role="group" aria-label="Mechanics collection"><button type="button" data-mechanics-collection="rpgStats">Stats</button><button type="button" data-mechanics-collection="defaultTriggers">Trackers</button></div><ol data-mechanics-list></ol><button type="button" data-action="add-character-mechanic">Add item</button></aside><section class="character-mechanics-detail" aria-label="Selected mechanic"></section></div>`;
    canvas.replaceChildren(stage, actions());
    const list = required<HTMLOListElement>(canvas, "[data-mechanics-list]");
    const detail = required<HTMLElement>(canvas, ".character-mechanics-detail");
    const items = state.candidate[mechanicsCollection];
    items.forEach((item, index) => {
      const fields = structuredFieldsFor(mechanicsCollection === "rpgStats" ? "stat" : "trigger", item);
      const button = document.createElement("button"); button.type = "button"; button.textContent = String(fields.name || `Item ${index + 1}`); button.dataset.mechanicsIndex = String(index);
      const row = document.createElement("li"); row.append(button); list.append(row);
    });
    mechanicsIndex = Math.min(mechanicsIndex, Math.max(0, items.length - 1));
    if (items.length === 0) detail.innerHTML = "<p>No item selected.</p>";
    else {
      const kind = mechanicsCollection === "rpgStats" ? "stat" : "trigger";
      const fields = structuredFieldsFor(kind, items[mechanicsIndex]);
      const names = kind === "stat" ? [["name", "Name"], ["value", "Value"], ["note", "Note"]] : [["name", "Name"], ["condition", "Condition"], ["effect", "Effect"]];
      for (const [name, label] of names) {
        const field = textControl(document, `mechanic.${name}`, label, String(fields[name] ?? ""), name === "note" || name === "condition" || name === "effect");
        detail.append(field);
      }
      detail.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[name]").forEach((control) => control.addEventListener("input", () => {
        const changed = { [control.name.split(".")[1]!]: control.value };
        const next = [...state.candidate[mechanicsCollection]];
        next[mechanicsIndex] = mergeStructuredFields(kind, next[mechanicsIndex], changed);
        fieldChanged([mechanicsCollection], next);
      }));
    }
  }

  function renderReview(): void {
    const review = characterReview(state);
    const provenance = review.provenance === "ai" ? "AI-assisted" : "Manual";
    const plural = (count: number, singular: string) => `${count} ${singular}${count === 1 ? "" : "s"}`;
    canvas.innerHTML = `<div class="character-stage character-review" data-character-review><header><h2>Review character</h2><p>Confirm the facts that will return to the world draft.</p></header><dl><div><dt>Name</dt><dd>${state.candidate.name || "Not provided"}</dd></div><div><dt>Method</dt><dd>${provenance}</dd></div><div><dt>Story fields</dt><dd>${review.counts.completedStoryFields}</dd></div><div><dt>Appearance facts</dt><dd>${review.counts.completedAppearanceFields}</dd></div><div><dt>Mechanics</dt><dd>${plural(review.counts.stats, "stat")} · ${plural(review.counts.triggers, "tracker")}</dd></div><div><dt>Warnings</dt><dd>${review.warningCount}</dd></div></dl><a href="${activeSession.parentRoute}">Return without using this character</a><p data-character-acceptance-status aria-live="polite"></p></div>`;
    canvas.append(actions(true));
  }

  function render(): void {
    canvas.dataset.characterCanvas = state.stage;
    if (state.stage === "method") renderMethod();
    if (state.stage === "identity") renderIdentity();
    if (state.stage === "story") renderStory();
    if (state.stage === "appearance") renderAppearance();
    if (state.stage === "mechanics") renderMechanics();
    if (state.stage === "review") renderReview();
    updateStageIndex();
  }

  function showValidation(): boolean {
    const issues = validateCharacterStage(state).issues.filter((issue) => issue.severity === "error");
    canvas.querySelectorAll<HTMLElement>("[aria-invalid]").forEach((element) => element.removeAttribute("aria-invalid"));
    canvas.querySelectorAll<HTMLElement>("[data-field-error]").forEach((element) => { element.textContent = ""; });
    for (const issue of issues) {
      const name = issue.path;
      const control = canvas.querySelector<HTMLElement>(`[name="${name}"]`);
      control?.setAttribute("aria-invalid", "true");
      const error = canvas.querySelector<HTMLElement>(`[data-field-error="${name}"]`);
      if (error) error.textContent = issue.message;
    }
    if (issues.length > 0) canvas.querySelector<HTMLElement>(`[name="${issues[0]!.path}"]`)?.focus();
    return issues.length === 0;
  }

  async function clipboard(action: "copy" | "paste", trigger: HTMLElement): Promise<void> {
    const active = dialog.hasAttribute("open") ? expandedPrompt : required<HTMLTextAreaElement>(canvas, '[data-character-prompt="compact"]');
    const start = active.selectionStart; const end = active.selectionEnd;
    const status = dialog.hasAttribute("open") ? required<HTMLElement>(dialog, "[data-character-dialog-clipboard-status]") : required<HTMLElement>(canvas, "[data-character-clipboard-status]");
    try {
      if (action === "copy") { await writeClipboard(active.value); status.textContent = "Character concept copied."; }
      else { prompt = await readClipboard(); active.value = prompt; expandedPrompt.value = prompt; const compact = canvas.querySelector<HTMLTextAreaElement>('[data-character-prompt="compact"]'); if (compact) compact.value = prompt; status.textContent = "Character concept pasted."; markDirty(); }
    } catch { status.textContent = action === "copy" ? "Copy unavailable. Select the text and copy it manually." : "Paste unavailable. Paste into the field manually."; }
    if (!disposed) { active.focus(); if (action === "copy") active.setSelectionRange(start, end); }
    void trigger;
  }

  function closeDialog(): void {
    dialog.removeAttribute("open");
    root.removeAttribute("inert");
    canvas.querySelector<HTMLButtonElement>(expandButtonSelector)?.focus();
  }

  function poll(progressKey: string, sequence: number, signal: AbortSignal): void {
    if (disposed || sequence !== generationSequence || signal.aborted) return;
    void loadProgress(progressKey, signal).then((progress) => {
      if (disposed || sequence !== generationSequence || signal.aborted) return;
      const status = canvas.querySelector<HTMLElement>("[data-character-generation-status]");
      if (status) status.textContent = `${Math.round(progress.progressPercent)}% · ${progress.errorMessage ?? progress.message}`;
      if (progress.status === "processing") pollTimer = setTimeout(() => poll(progressKey, sequence, signal), pollInterval);
    }).catch((error: unknown) => { if (!(error instanceof Error && error.name === "AbortError")) { const status = canvas.querySelector<HTMLElement>("[data-character-generation-status]"); if (status) status.textContent = "Progress is temporarily unavailable."; } });
  }

  function startGeneration(): void {
    const compact = required<HTMLTextAreaElement>(canvas, '[data-character-prompt="compact"]');
    prompt = compact.value;
    if (!prompt.trim() || generationController !== null) return;
    stopGeneration();
    const sequence = generationSequence;
    const controller = new AbortController(); generationController = controller;
    const progressKey = `${activeSession.key}:${sequence}:${Date.now()}`.slice(0, 512);
    const generate = required<HTMLButtonElement>(canvas, '[data-action="generate-character"]');
    const cancel = required<HTMLButtonElement>(canvas, '[data-action="cancel-character-generation"]');
    generate.disabled = true; cancel.hidden = false;
    poll(progressKey, sequence, controller.signal);
    void generatePreview({ content: activeSession.worldContext, prompt, ...(activeSession.mode === "edit" ? { characterId: state.candidate.id } : {}), progressKey }, controller.signal)
      .then(({ character }) => {
        if (disposed || sequence !== generationSequence || controller.signal.aborted) return;
        if (candidateDirty && !confirmReplacement()) return;
        state = applyGeneratedCharacter(state, character);
        candidateDirty = true;
        state = setCharacterStage(state, "identity");
        markDirty(); render();
      })
      .catch((error: unknown) => {
        if (disposed || sequence !== generationSequence || (error instanceof Error && error.name === "AbortError")) return;
        const status = canvas.querySelector<HTMLElement>("[data-character-generation-status]");
        if (status) status.textContent = "Character generation failed. Review the prompt and retry.";
      })
      .finally(() => {
        if (sequence !== generationSequence) return;
        generationController = null;
        if (pollTimer !== null) clearTimeout(pollTimer);
        pollTimer = null;
        if (canvas.contains(generate)) { generate.disabled = !prompt.trim(); cancel.hidden = true; }
      });
  }

  root.addEventListener("input", (event) => {
    const source = event.target;
    if (!(source instanceof view.HTMLTextAreaElement) || !source.matches("[data-character-prompt]")) return;
    prompt = source.value;
    expandedPrompt.value = prompt;
    const compact = canvas.querySelector<HTMLTextAreaElement>('[data-character-prompt="compact"]');
    if (compact && compact !== source) compact.value = prompt;
    const generate = canvas.querySelector<HTMLButtonElement>('[data-action="generate-character"]');
    if (generate) generate.disabled = generationController !== null || !prompt.trim();
    markDirty();
  });

  root.addEventListener("click", (event) => {
    const target = (event.target as Element).closest<HTMLElement>("button, a");
    if (!target || disposed) return;
    const action = target.dataset.action;
    if (target.dataset.characterStage) { state = setCharacterStage(state, target.dataset.characterStage as CharacterStage); render(); return; }
    if (action === "continue-character") { if (!showValidation()) return; const index = STAGES.indexOf(state.stage); if (index < STAGES.length - 1) { state = setCharacterStage(state, STAGES[index + 1]!); render(); } }
    if (action === "back-character") { const index = STAGES.indexOf(state.stage); if (index > 0) { state = setCharacterStage(state, STAGES[index - 1]!); render(); } }
    if (action === "generate-character") startGeneration();
    if (action === "cancel-character-generation") { stopGeneration(); render(); }
    if (action === "expand-character-prompt") { expandedPrompt.value = prompt; dialog.setAttribute("open", ""); expandedPrompt.focus(); }
    if (action === "close-character-prompt") closeDialog();
    if (action === "copy-character-prompt") void clipboard("copy", target);
    if (action === "paste-character-prompt") void clipboard("paste", target);
    if (action === "add-character-mechanic") { fieldChanged([mechanicsCollection], [...state.candidate[mechanicsCollection], {}]); mechanicsIndex = state.candidate[mechanicsCollection].length - 1; render(); }
    if (target.dataset.mechanicsCollection) { mechanicsCollection = target.dataset.mechanicsCollection as typeof mechanicsCollection; mechanicsIndex = 0; render(); }
    if (target.dataset.mechanicsIndex) { mechanicsIndex = Number(target.dataset.mechanicsIndex); render(); }
    if (action === "accept-character" && !completed) {
      const candidate = characterHandoffCandidate(state);
      const status = canvas.querySelector<HTMLElement>("[data-character-acceptance-status]");
      if (!candidate || !sessionStore?.complete(activeSession.key, activeSession.workflowId, { status: "accepted", candidate })) { if (status) status.textContent = "This character could not be accepted. Return to the world and try again."; return; }
      completed = true; clearDirty(); navigate(activeSession.parentRoute);
    }
    if (action === "cancel-character" && !completed && sessionStore?.complete(activeSession.key, activeSession.workflowId, { status: "cancelled" })) { completed = true; clearDirty(); navigate(activeSession.parentRoute); }
  });

  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); closeDialog(); return; }
    if (event.key !== "Tab") return;
    const controls = [...dialog.querySelectorAll<HTMLElement>("button, textarea")].filter((control) => !control.hasAttribute("disabled"));
    const first = controls[0]; const last = controls.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });

  render();
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      stopGeneration();
      clearDirty();
      theme.dispose();
    }
  };
}
