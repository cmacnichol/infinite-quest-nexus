import { initializeAppTheme, renderAppShell } from "./app-shell";
import {
  generateWorldPreview as generateWorldPreviewRequest,
  loadWorldGenerationProgress as loadWorldGenerationProgressRequest,
  WorldCreationApiError,
  type WorldGenerationPreviewRequest,
  type WorldGenerationPreviewResponse,
  type WorldGenerationProgressResponse
} from "./world-creation-api";
import {
  addCreationCollectionItem,
  applyGeneratedPreview,
  createWorldCreationState,
  creationStageProgress,
  editCreationDraft,
  hasLocalWorldCreationContent,
  removeCreationCollectionItem,
  restoreCreationCollectionItem,
  selectCreationMethod,
  setCreationStage,
  updateCreationCollectionItem,
  validateCreationStage,
  type CreationCollectionName,
  type CreationStage,
  type WorldCreationState
} from "./world-creation-model";
import {
  collectionItemSummary,
  mergeStructuredFields,
  parseAdvancedJson,
  serializeAdvancedJson,
  structuredFieldsFor,
  type StructuredRecordKind
} from "./world-editor-fields";
import type { MountedPage } from "./world-library-page";

export interface WorldCreationPageDependencies {
  generateWorldPreview?: (
    request: WorldGenerationPreviewRequest,
    signal?: AbortSignal
  ) => Promise<WorldGenerationPreviewResponse>;
  loadWorldGenerationProgress?: (
    progressKey: string,
    signal?: AbortSignal
  ) => Promise<WorldGenerationProgressResponse>;
  readClipboardText?: () => Promise<string>;
  writeClipboardText?: (value: string) => Promise<void>;
  confirmGeneratedReplacement?: () => boolean;
  generationPollIntervalMs?: number;
}

type EditableStage = "canon" | "mechanics";
type EditableCollection = Exclude<CreationCollectionName, "assets">;

interface CollectionSpec {
  collection: EditableCollection;
  label: string;
  singular: string;
  kind: Exclude<StructuredRecordKind, "character" | "asset">;
}

const STAGE_ORDER: readonly CreationStage[] = ["method", "foundation", "canon", "mechanics", "cover", "review"];
const FOUNDATION_FIELDS = [
  ["title", "Title", "input", 1],
  ["genre", "Genre", "input", 1],
  ["tone", "Tone", "textarea", 2],
  ["premise", "Premise", "textarea", 4],
  ["backgroundStory", "Background story", "textarea", 7],
  ["firstAction", "First action", "textarea", 4],
  ["rules", "Rules", "textarea", 6]
] as const;
const COLLECTIONS: Record<EditableCollection, CollectionSpec> = {
  entities: { collection: "entities", label: "Entities", singular: "entity", kind: "entity" },
  relationships: { collection: "relationships", label: "Relationships", singular: "relationship", kind: "relationship" },
  rpgStats: { collection: "rpgStats", label: "Stats", singular: "stat", kind: "stat" },
  defaultTriggers: { collection: "defaultTriggers", label: "Default trackers", singular: "tracker", kind: "trigger" },
  eventTriggers: { collection: "eventTriggers", label: "Event triggers", singular: "trigger", kind: "trigger" }
};
const STAGE_COLLECTIONS: Record<EditableStage, EditableCollection[]> = {
  canon: ["entities", "relationships"],
  mechanics: ["rpgStats", "defaultTriggers", "eventTriggers"]
};
const STRUCTURED_FIELDS: Record<CollectionSpec["kind"], Array<{ name: string; label: string; textarea?: boolean }>> = {
  entity: [
    { name: "name", label: "Name" },
    { name: "type", label: "Type" },
    { name: "description", label: "Description", textarea: true }
  ],
  relationship: [
    { name: "source", label: "Source" },
    { name: "target", label: "Target" },
    { name: "type", label: "Type" },
    { name: "description", label: "Description", textarea: true }
  ],
  stat: [
    { name: "name", label: "Name" },
    { name: "value", label: "Value" },
    { name: "note", label: "Note", textarea: true }
  ],
  trigger: [
    { name: "name", label: "Name" },
    { name: "condition", label: "Condition", textarea: true },
    { name: "effect", label: "Effect", textarea: true }
  ]
};

const copyIcon = `
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="8" y="8" width="11" height="11" />
    <path d="M16 8V5H5v11h3" />
  </svg>
`;
const pasteIcon = `
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M9 5h6M9 3h6v4H9z" />
    <path d="M7 5H5v16h14V5h-2M8 12h8M8 16h6" />
  </svg>
`;
const expandIcon = `
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5" />
  </svg>
`;
const closeIcon = `
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="m6 6 12 12M18 6 6 18" />
  </svg>
`;

const creationMarkup = `
  <main id="main-content" class="editor-main creation-main" data-page="world-creation">
    <header class="editor-command-row creation-command-row">
      <div class="editor-identity">
        <a href="/app/">Back to World Library</a>
        <h1 id="creation-title">Create world</h1>
        <div class="editor-readonly-context" aria-label="Creation context">
          <p>New reusable world draft</p>
          <p>Characters are added after the world is created.</p>
        </div>
      </div>
    </header>
    <div class="editor-workspace creation-workspace">
      <nav class="editor-section-index creation-stage-index" aria-label="World creation stages">
        <span data-stage="method" aria-current="step">Method</span>
        <span data-stage="foundation" aria-disabled="true">Foundation</span>
        <span data-stage="canon" aria-disabled="true">Canon</span>
        <span data-stage="mechanics" aria-disabled="true">Mechanics</span>
        <span data-stage="cover" aria-disabled="true">Cover</span>
        <span data-stage="review" aria-disabled="true">Review</span>
      </nav>
      <section class="editor-canvas creation-canvas" data-creation-stage="method" aria-labelledby="method-heading">
        <div class="overview-editor creation-method-stage">
          <header><div><h2 id="method-heading">Choose how to begin</h2></div><p>Start from a blank structured draft, or describe a world for the Story Engine to organize.</p></header>
          <fieldset class="creation-method-controls">
            <legend>Creation method</legend>
            <label class="creation-method-control"><input type="radio" name="creationMethod" value="manual" /><span>Manual</span></label>
            <label class="creation-method-control"><input type="radio" name="creationMethod" value="ai" /><span>AI-assisted</span></label>
          </fieldset>
          <section class="creation-prompt-authoring" data-ai-prompt hidden aria-labelledby="concept-heading">
            <div class="creation-prompt-heading">
              <div><h3 id="concept-heading">World concept</h3><p>Describe the setting, mood, conflicts, and rules that make this world distinct.</p></div>
              <div class="creation-prompt-tools" aria-label="Prompt tools">
                <button type="button" data-action="copy-prompt" aria-label="Copy world concept">${copyIcon}</button>
                <button type="button" data-action="paste-prompt" aria-label="Paste into world concept">${pasteIcon}</button>
                <button type="button" data-action="expand-prompt">${expandIcon}<span>Expand</span></button>
              </div>
            </div>
            <label class="editor-field creation-prompt-field"><span>Concept prompt</span><textarea rows="7" data-concept-prompt="compact" aria-describedby="creation-clipboard-status creation-generation-status" placeholder="A glass city follows a migrating star…"></textarea></label>
            <p id="creation-clipboard-status" data-clipboard-status aria-live="polite"></p>
            <div id="creation-generation-status" data-generation-status aria-live="polite"></div>
            <div class="creation-generation-actions">
              <button type="button" data-action="generate-world" disabled>Generate world draft</button>
              <button type="button" data-action="cancel-generation" hidden>Cancel generation</button>
            </div>
          </section>
          <div class="creation-manual-action" data-manual-action hidden><p>Begin with an empty world and author each section directly.</p><button type="button" data-action="continue-manual">Continue manually</button></div>
        </div>
        <div class="overview-editor creation-foundation-stage" data-foundation-stage data-editing-stage hidden></div>
      </section>
    </div>
    <dialog class="creation-prompt-dialog" data-prompt-dialog aria-labelledby="expanded-prompt-title">
      <div class="creation-prompt-dialog-header"><h2 id="expanded-prompt-title">World concept</h2><button type="button" data-action="close-prompt-dialog" aria-label="Close expanded world concept">${closeIcon}</button></div>
      <label class="editor-field creation-prompt-dialog-field"><span>Concept prompt</span><textarea rows="14" data-concept-prompt="expanded" aria-describedby="creation-dialog-clipboard-status"></textarea></label>
      <div class="creation-prompt-tools" aria-label="Expanded prompt tools"><button type="button" data-action="copy-prompt" aria-label="Copy world concept">${copyIcon}</button><button type="button" data-action="paste-prompt" aria-label="Paste into world concept">${pasteIcon}</button></div>
      <p id="creation-dialog-clipboard-status" data-dialog-clipboard-status aria-live="polite"></p>
    </dialog>
  </main>
`;

function requiredElement<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`The World Creation interface is missing ${selector}.`);
  return element;
}

function textValue(value: unknown): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : "";
}

export function mountWorldCreationPage(
  root: HTMLElement,
  dependencies: WorldCreationPageDependencies = {}
): MountedPage {
  renderAppShell(root, creationMarkup, "world-library");
  const theme = initializeAppTheme(root);
  const document = root.ownerDocument;
  const view = document.defaultView;
  if (!view) {
    theme.dispose();
    throw new Error("The World Creation interface could not be initialized.");
  }
  const pageView = view;
  const canvas = requiredElement<HTMLElement>(root, "[data-creation-stage]");
  const methodStage = requiredElement<HTMLElement>(root, ".creation-method-stage");
  const editingStage = requiredElement<HTMLElement>(root, "[data-editing-stage]");
  const stageItems = [...root.querySelectorAll<HTMLElement>("[data-stage]")];
  const aiPrompt = requiredElement<HTMLElement>(root, "[data-ai-prompt]");
  const manualAction = requiredElement<HTMLElement>(root, "[data-manual-action]");
  const compactPrompt = requiredElement<HTMLTextAreaElement>(root, '[data-concept-prompt="compact"]');
  const expandedPrompt = requiredElement<HTMLTextAreaElement>(root, '[data-concept-prompt="expanded"]');
  const generateButton = requiredElement<HTMLButtonElement>(root, '[data-action="generate-world"]');
  const cancelButton = requiredElement<HTMLButtonElement>(root, '[data-action="cancel-generation"]');
  const expandButton = requiredElement<HTMLButtonElement>(root, '[data-action="expand-prompt"]');
  const dialog = requiredElement<HTMLDialogElement>(root, "[data-prompt-dialog]");
  const clipboardStatus = requiredElement<HTMLElement>(root, "[data-clipboard-status]");
  const dialogClipboardStatus = requiredElement<HTMLElement>(root, "[data-dialog-clipboard-status]");
  const generationStatus = requiredElement<HTMLElement>(root, "[data-generation-status]");

  const generateWorldPreview = dependencies.generateWorldPreview ?? generateWorldPreviewRequest;
  const loadWorldGenerationProgress = dependencies.loadWorldGenerationProgress ?? loadWorldGenerationProgressRequest;
  const pollInterval = Math.max(50, dependencies.generationPollIntervalMs ?? 500);
  const confirmGeneratedReplacement = dependencies.confirmGeneratedReplacement ?? (() => pageView.confirm(
    "Replace the fields already entered with the generated draft?"
  ));
  const readClipboardText = dependencies.readClipboardText ?? (async () => {
    if (!pageView.navigator.clipboard?.readText) throw new Error("Clipboard permission is unavailable.");
    return pageView.navigator.clipboard.readText();
  });
  const writeClipboardText = dependencies.writeClipboardText ?? (async (value: string) => {
    if (!pageView.navigator.clipboard?.writeText) throw new Error("Clipboard permission is unavailable.");
    await pageView.navigator.clipboard.writeText(value);
  });

  let state = createWorldCreationState();
  let concept = "";
  let disposed = false;
  let generationSequence = 0;
  let generationController: AbortController | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let activeCollection: EditableCollection = "entities";
  const selectedIndexes = new Map<EditableCollection, number>();
  const searches = new Map<EditableCollection, string>();

  function button(action: string, label: string): HTMLButtonElement {
    const result = document.createElement("button");
    result.type = "button";
    result.dataset.action = action;
    result.textContent = label;
    return result;
  }

  function labelledControl(labelText: string, control: HTMLInputElement | HTMLTextAreaElement): HTMLLabelElement {
    const label = document.createElement("label");
    label.className = "editor-field";
    const text = document.createElement("span");
    text.textContent = labelText;
    label.append(text, control);
    return label;
  }

  function dialogIsOpen(): boolean {
    return dialog.hasAttribute("open");
  }

  function activePrompt(): HTMLTextAreaElement {
    return dialogIsOpen() ? expandedPrompt : compactPrompt;
  }

  function syncPrompt(source: HTMLTextAreaElement): void {
    concept = source.value;
    const other = source === compactPrompt ? expandedPrompt : compactPrompt;
    if (other.value !== concept) other.value = concept;
    generateButton.disabled = generationController !== null || !concept.trim();
  }

  function renderStageIndex(): void {
    for (const progress of creationStageProgress(state)) {
      const item = stageItems.find((candidate) => candidate.dataset.stage === progress.stage);
      if (!item) continue;
      item.dataset.stageState = progress.state;
      const label = item.textContent?.trim() || progress.stage;
      item.setAttribute("aria-label", `${label}, ${progress.state}`);
      if (progress.state === "current") item.setAttribute("aria-current", "step");
      else item.removeAttribute("aria-current");
      if (progress.state === "upcoming") item.setAttribute("aria-disabled", "true");
      else item.removeAttribute("aria-disabled");
    }
  }

  function stageActions(): HTMLElement {
    const actions = document.createElement("div");
    actions.className = "creation-stage-actions";
    actions.append(button("back-stage", "Back"), button("continue-stage", "Continue"));
    return actions;
  }

  function renderFoundation(): void {
    editingStage.replaceChildren();
    const header = document.createElement("header");
    const heading = document.createElement("h2");
    heading.id = "foundation-heading";
    heading.textContent = "Foundation";
    const guidance = document.createElement("p");
    guidance.textContent = "Define the world identity and opening premise. Review every field before continuing.";
    header.append(heading, guidance);
    const form = document.createElement("div");
    form.className = "overview-form";
    for (const [name, label, kind, rows] of FOUNDATION_FIELDS) {
      const control = kind === "input" ? document.createElement("input") : document.createElement("textarea");
      control.name = `world.${name}`;
      control.value = state.draft.world[name];
      if (control instanceof pageView.HTMLTextAreaElement) control.rows = rows;
      const error = document.createElement("small");
      error.className = "field-error";
      error.dataset.fieldError = `world.${name}`;
      error.id = `creation-world-${name}-error`;
      control.setAttribute("aria-describedby", error.id);
      const wrapper = labelledControl(label, control);
      wrapper.append(error);
      form.append(wrapper);
    }
    editingStage.append(header, form, stageActions());
  }

  function renderCollectionResults(master: HTMLElement): void {
    const spec = COLLECTIONS[activeCollection];
    const items = state.draft[activeCollection];
    const selected = selectedIndexes.get(activeCollection) ?? 0;
    const query = (searches.get(activeCollection) ?? "").trim().toLocaleLowerCase();
    const matches = items.map((value, index) => ({ index, summary: collectionItemSummary(spec.kind, value, index) }))
      .filter(({ summary }) => summary.toLocaleLowerCase().includes(query));
    const visible = matches.slice(0, 100);
    const count = requiredElement<HTMLElement>(master, "[data-result-count]");
    const list = requiredElement<HTMLOListElement>(master, "[data-collection-list]");
    count.textContent = `${visible.length} of ${items.length} items shown${matches.length !== items.length ? ` · ${matches.length} match` : ""}`;
    list.replaceChildren();
    for (const item of visible) {
      const row = document.createElement("li");
      row.dataset.collectionRow = "";
      const select = button("select-item", item.summary);
      select.dataset.itemIndex = String(item.index);
      select.setAttribute("aria-current", String(item.index === selected));
      row.append(select);
      list.append(row);
    }
  }

  function renderPendingRemovals(host: HTMLElement): void {
    const region = document.createElement("div");
    region.className = "pending-removals";
    region.dataset.pendingRemovals = "";
    for (const removal of state.pendingRemovals.filter((candidate) => candidate.collection === activeCollection)) {
      const row = document.createElement("p");
      row.textContent = `${collectionItemSummary(COLLECTIONS[activeCollection].kind, removal.value, removal.originalIndex)} removed. `;
      const undo = button("undo-removal", "Undo removal");
      undo.dataset.removalId = removal.id;
      row.append(undo);
      region.append(row);
    }
    host.append(region);
  }

  function renderRecordDetail(host: HTMLElement): void {
    const spec = COLLECTIONS[activeCollection];
    const index = Math.min(selectedIndexes.get(activeCollection) ?? 0, Math.max(state.draft[activeCollection].length - 1, 0));
    selectedIndexes.set(activeCollection, index);
    const record = state.draft[activeCollection][index];
    if (record === undefined) {
      const empty = document.createElement("p");
      empty.className = "collection-empty";
      empty.textContent = `No ${spec.label.toLowerCase()} yet. Add one to begin.`;
      host.append(empty);
      renderPendingRemovals(host);
      return;
    }
    const detail = document.createElement("div");
    detail.className = "collection-detail";
    detail.dataset.recordDetail = "";
    const heading = document.createElement("h3");
    heading.textContent = collectionItemSummary(spec.kind, record, index);
    detail.append(heading);
    const fields = structuredFieldsFor(spec.kind, record);
    for (const definition of STRUCTURED_FIELDS[spec.kind]) {
      const control = definition.textarea ? document.createElement("textarea") : document.createElement("input");
      control.dataset.structuredField = definition.name;
      control.value = textValue(fields[definition.name]);
      if (control instanceof pageView.HTMLTextAreaElement) control.rows = 3;
      detail.append(labelledControl(definition.label, control));
    }
    const advanced = document.createElement("details");
    advanced.className = "advanced-json";
    const summary = document.createElement("summary");
    summary.textContent = "Advanced JSON";
    const json = document.createElement("textarea");
    json.dataset.advancedJson = "";
    json.rows = 10;
    json.value = serializeAdvancedJson(record);
    json.setAttribute("aria-label", `Advanced JSON for selected ${spec.singular}`);
    const error = document.createElement("p");
    error.className = "field-error";
    error.dataset.advancedJsonError = "";
    advanced.append(summary, json, button("apply-advanced-json", "Apply JSON"), error);
    detail.append(advanced, button("remove-item", `Remove ${spec.singular}`));
    host.append(detail);
    renderPendingRemovals(host);
  }

  function renderDefaults(host: HTMLElement): void {
    const details = document.createElement("details");
    details.className = "advanced-json defaults-json";
    const summary = document.createElement("summary");
    summary.textContent = "World defaults JSON";
    const textarea = document.createElement("textarea");
    textarea.dataset.defaultsJson = "";
    textarea.rows = 10;
    textarea.value = serializeAdvancedJson(state.draft.defaults);
    textarea.setAttribute("aria-label", "World defaults JSON");
    const error = document.createElement("p");
    error.className = "field-error";
    error.dataset.defaultsError = "";
    details.append(summary, textarea, button("apply-defaults-json", "Apply defaults JSON"), error);
    host.append(details);
  }

  function renderCollectionEditor(): void {
    const stage = state.stage as EditableStage;
    const validCollections = STAGE_COLLECTIONS[stage];
    if (!validCollections.includes(activeCollection)) activeCollection = validCollections[0]!;
    const spec = COLLECTIONS[activeCollection];
    editingStage.replaceChildren();
    const header = document.createElement("header");
    const heading = document.createElement("h2");
    heading.id = `${stage}-heading`;
    heading.textContent = stage === "canon" ? "Canon" : "Mechanics";
    const guidance = document.createElement("p");
    guidance.textContent = stage === "canon"
      ? "Maintain the people, places, and relationships that define this world."
      : "Set stats, trackers, triggers, and world defaults without mixing mechanics into narration.";
    header.append(heading, guidance);
    const editor = document.createElement("div");
    editor.className = "collection-editor";
    editor.dataset.collectionEditor = "";
    editor.dataset.activeCollection = activeCollection;
    const toolbar = document.createElement("div");
    toolbar.className = "collection-toolbar";
    const name = document.createElement("h3");
    name.textContent = spec.label;
    const switches = document.createElement("div");
    switches.className = "collection-switches";
    for (const collection of validCollections) {
      const control = button("switch-collection", COLLECTIONS[collection].label);
      control.dataset.collectionTarget = collection;
      control.setAttribute("aria-pressed", String(collection === activeCollection));
      switches.append(control);
    }
    toolbar.append(name, switches, button("add-item", `Add ${spec.singular}`));
    const master = document.createElement("div");
    master.className = "collection-master";
    const search = document.createElement("input");
    search.type = "search";
    search.dataset.collectionSearch = "";
    search.value = searches.get(activeCollection) ?? "";
    search.setAttribute("aria-label", `Search ${spec.label.toLowerCase()}`);
    const count = document.createElement("p");
    count.dataset.resultCount = "";
    const list = document.createElement("ol");
    list.dataset.collectionList = "";
    master.append(search, count, list);
    renderCollectionResults(master);
    const detailHost = document.createElement("div");
    detailHost.className = "collection-detail-host";
    renderRecordDetail(detailHost);
    editor.append(toolbar, master, detailHost);
    editingStage.append(header, editor);
    if (stage === "mechanics") renderDefaults(editingStage);
    editingStage.append(stageActions());
  }

  function renderUnsupportedStage(): void {
    editingStage.replaceChildren();
    const heading = document.createElement("h2");
    heading.id = `${state.stage}-heading`;
    heading.textContent = state.stage === "cover" ? "Cover" : "Review";
    editingStage.append(heading, stageActions());
  }

  function renderStage(): void {
    canvas.dataset.creationStage = state.stage;
    methodStage.hidden = state.stage !== "method";
    editingStage.hidden = state.stage === "method";
    renderStageIndex();
    if (state.stage === "foundation") renderFoundation();
    else if (state.stage === "canon" || state.stage === "mechanics") renderCollectionEditor();
    else if (state.stage !== "method") renderUnsupportedStage();
    canvas.setAttribute("aria-labelledby", state.stage === "method" ? "method-heading" : `${state.stage}-heading`);
  }

  function updateMethod(method: "manual" | "ai"): void {
    if (generationController) cancelGeneration();
    state = selectCreationMethod(state, method);
    aiPrompt.hidden = method !== "ai";
    manualAction.hidden = method !== "manual";
    generationStatus.replaceChildren();
  }

  function openDialog(): void {
    expandedPrompt.value = concept;
    const nativeDialog = dialog as HTMLDialogElement & { showModal?: () => void };
    if (typeof nativeDialog.showModal === "function") nativeDialog.showModal();
    else {
      dialog.setAttribute("open", "");
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");
    }
    expandedPrompt.focus();
  }

  function closeDialog(): void {
    const nativeDialog = dialog as HTMLDialogElement & { close?: () => void };
    if (typeof nativeDialog.close === "function") nativeDialog.close();
    else dialog.removeAttribute("open");
    expandButton.focus();
  }

  function clipboardAnnouncement(message: string): void {
    clipboardStatus.textContent = message;
    dialogClipboardStatus.textContent = message;
  }

  async function copyPrompt(): Promise<void> {
    const editor = activePrompt();
    const focusBeforeClipboard = document.activeElement;
    try {
      await writeClipboardText(concept);
      clipboardAnnouncement("Copied world concept.");
    } catch {
      clipboardAnnouncement("We could not copy the world concept. Select the text and copy it manually.");
    }
    if (!disposed && document.activeElement === focusBeforeClipboard) editor.focus();
  }

  async function pastePrompt(): Promise<void> {
    const editor = activePrompt();
    const focusBeforeClipboard = document.activeElement;
    const start = editor.selectionStart ?? editor.value.length;
    const end = editor.selectionEnd ?? start;
    try {
      const pasted = await readClipboardText();
      editor.value = `${editor.value.slice(0, start)}${pasted}${editor.value.slice(end)}`;
      const caret = start + pasted.length;
      editor.selectionStart = caret;
      editor.selectionEnd = caret;
      syncPrompt(editor);
      clipboardAnnouncement("Pasted into world concept.");
    } catch {
      clipboardAnnouncement("Clipboard permission was denied. Paste with your browser or keyboard instead.");
    }
    if (!disposed && document.activeElement === focusBeforeClipboard) editor.focus();
  }

  function clearPollTimer(): void {
    if (pollTimer !== null) clearTimeout(pollTimer);
    pollTimer = null;
  }

  function renderProgress(progress: WorldGenerationProgressResponse): void {
    generationStatus.replaceChildren();
    const meter = document.createElement("progress");
    meter.dataset.generationProgress = "";
    meter.max = 100;
    meter.value = Math.max(0, Math.min(100, progress.progressPercent));
    meter.setAttribute("aria-label", "World draft generation progress");
    const message = document.createElement("p");
    message.textContent = `${progress.message} · ${Math.round(meter.value)}%`;
    generationStatus.append(meter, message);
  }

  function scheduleProgressPoll(controller: AbortController, progressKey: string): void {
    clearPollTimer();
    pollTimer = setTimeout(async () => {
      pollTimer = null;
      if (disposed || generationController !== controller || controller.signal.aborted) return;
      try {
        const progress = await loadWorldGenerationProgress(progressKey, controller.signal);
        if (disposed || generationController !== controller || controller.signal.aborted) return;
        renderProgress(progress);
        if (progress.status === "processing" || progress.status === "unknown") scheduleProgressPoll(controller, progressKey);
      } catch {
        if (!disposed && generationController === controller && !controller.signal.aborted) {
          scheduleProgressPoll(controller, progressKey);
        }
      }
    }, pollInterval);
  }

  function cancelGeneration(): void {
    const controller = generationController;
    if (!controller) return;
    generationSequence += 1;
    generationController = null;
    clearPollTimer();
    controller.abort(new DOMException("World generation cancelled", "AbortError"));
    generationStatus.textContent = "World generation cancelled. Your concept and local fields are unchanged.";
    generateButton.disabled = !concept.trim();
    cancelButton.hidden = true;
  }

  async function generate(): Promise<void> {
    if (!concept.trim() || generationController) return;
    if (hasLocalWorldCreationContent(state.draft) && !confirmGeneratedReplacement()) return;
    const requestStart = {
      concept,
      draft: JSON.stringify(state.draft),
      method: state.method,
      stage: state.stage
    };
    const controller = new AbortController();
    generationController = controller;
    generationSequence += 1;
    const requestSequence = generationSequence;
    const progressKey = `world-gen:${Date.now()}-${requestSequence}`;
    generateButton.disabled = true;
    cancelButton.hidden = false;
    generationStatus.textContent = "Generating a structured world draft…";
    scheduleProgressPoll(controller, progressKey);
    try {
      const preview = await generateWorldPreview({ title: "", prompt: concept, progressKey }, controller.signal);
      if (disposed || generationController !== controller || controller.signal.aborted || generationSequence !== requestSequence) return;
      const requestContextUnchanged = concept === requestStart.concept &&
        JSON.stringify(state.draft) === requestStart.draft &&
        state.method === requestStart.method && state.stage === requestStart.stage;
      if (!requestContextUnchanged) return;
      state = applyGeneratedPreview(state, preview);
      state = setCreationStage(state, "foundation");
      generationStatus.textContent = "World draft generated. Please review every field before continuing.";
      renderStage();
    } catch (error) {
      if (disposed || generationController !== controller || controller.signal.aborted) return;
      if (error instanceof WorldCreationApiError && error.kind === "unavailable") {
        generationStatus.innerHTML = 'The text provider is unavailable. Check <a href="/nexus/?view=setup">Provider Setup</a>, then try again.';
      } else {
        generationStatus.textContent = "The world draft could not be generated. Your concept and local fields are safe; try again.";
      }
    } finally {
      if (generationController === controller) {
        generationController = null;
        clearPollTimer();
        if (!disposed) {
          generateButton.disabled = !concept.trim();
          cancelButton.hidden = true;
        }
      }
    }
  }

  function validateAndContinue(): void {
    const validation = validateCreationStage(state);
    if (validation.issues.length > 0) {
      const issue = validation.issues[0]!;
      const control = editingStage.querySelector<HTMLElement>(`[name="${issue.path}"]`);
      const error = editingStage.querySelector<HTMLElement>(`[data-field-error="${issue.path}"]`);
      control?.setAttribute("aria-invalid", "true");
      if (error) error.textContent = issue.message;
      control?.focus();
      return;
    }
    const index = STAGE_ORDER.indexOf(state.stage);
    const next = STAGE_ORDER[index + 1];
    if (!next) return;
    state = setCreationStage(state, next);
    if (state.stage === "canon") activeCollection = "entities";
    if (state.stage === "mechanics") activeCollection = "rpgStats";
    renderStage();
  }

  function goBack(): void {
    const index = STAGE_ORDER.indexOf(state.stage);
    if (index <= 0) return;
    state = setCreationStage(state, STAGE_ORDER[index - 1]!);
    renderStage();
  }

  function updateStructuredField(target: HTMLInputElement | HTMLTextAreaElement): void {
    if (state.stage !== "canon" && state.stage !== "mechanics") return;
    const index = selectedIndexes.get(activeCollection) ?? 0;
    const original = state.draft[activeCollection][index];
    if (original === undefined) return;
    const field = target.dataset.structuredField;
    if (!field) return;
    let value: unknown = target.value;
    if (COLLECTIONS[activeCollection].kind === "stat" && field === "value" &&
      typeof structuredFieldsFor("stat", original).value === "number") {
      const numeric = Number(target.value);
      if (Number.isFinite(numeric)) value = numeric;
    }
    const merged = mergeStructuredFields(COLLECTIONS[activeCollection].kind, original, { [field]: value });
    state = updateCreationCollectionItem(state, activeCollection, index, merged);
    const advanced = editingStage.querySelector<HTMLTextAreaElement>("[data-advanced-json]");
    if (advanced) advanced.value = serializeAdvancedJson(merged);
  }

  function applyAdvancedJson(): void {
    const textarea = editingStage.querySelector<HTMLTextAreaElement>("[data-advanced-json]");
    const error = editingStage.querySelector<HTMLElement>("[data-advanced-json-error]");
    if (!textarea) return;
    const parsed = parseAdvancedJson(textarea.value, "object");
    if (parsed.error) {
      textarea.setAttribute("aria-invalid", "true");
      if (error) error.textContent = parsed.error;
      textarea.focus();
      return;
    }
    const index = selectedIndexes.get(activeCollection) ?? 0;
    state = updateCreationCollectionItem(state, activeCollection, index, parsed.value);
    renderCollectionEditor();
  }

  function applyDefaultsJson(): void {
    const textarea = editingStage.querySelector<HTMLTextAreaElement>("[data-defaults-json]");
    const error = editingStage.querySelector<HTMLElement>("[data-defaults-error]");
    if (!textarea) return;
    const parsed = parseAdvancedJson<Record<string, unknown>>(textarea.value, "object");
    if (parsed.error) {
      textarea.setAttribute("aria-invalid", "true");
      if (error) error.textContent = parsed.error;
      textarea.focus();
      return;
    }
    state = editCreationDraft(state, ["defaults"], parsed.value);
    renderCollectionEditor();
  }

  function trapDialogFocus(event: KeyboardEvent): void {
    if (event.key !== "Tab" || !dialogIsOpen()) return;
    const focusable = [...dialog.querySelectorAll<HTMLElement>("textarea, button:not([disabled])")];
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (!(document.activeElement instanceof pageView.Node) || !dialog.contains(document.activeElement)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function onInput(event: Event): void {
    const target = event.target;
    if (target === compactPrompt || target === expandedPrompt) {
      syncPrompt(target as HTMLTextAreaElement);
      return;
    }
    if (!(target instanceof pageView.HTMLInputElement) && !(target instanceof pageView.HTMLTextAreaElement)) return;
    if (target.dataset.collectionSearch !== undefined && (state.stage === "canon" || state.stage === "mechanics")) {
      searches.set(activeCollection, target.value);
      const master = target.closest<HTMLElement>(".collection-master");
      if (master) renderCollectionResults(master);
      return;
    }
    if (target.dataset.structuredField) {
      updateStructuredField(target);
      return;
    }
    const match = /^world\.(.+)$/.exec(target.name);
    if (match?.[1]) {
      state = editCreationDraft(state, ["world", match[1]], target.value);
      target.removeAttribute("aria-invalid");
      const error = editingStage.querySelector<HTMLElement>(`[data-field-error="world.${match[1]}"]`);
      if (error) error.textContent = "";
    }
  }

  function onChange(event: Event): void {
    const target = event.target;
    if (!(target instanceof pageView.HTMLInputElement) || target.name !== "creationMethod" || !target.checked) return;
    if (target.value === "manual" || target.value === "ai") updateMethod(target.value);
  }

  function onClick(event: Event): void {
    const target = event.target;
    if (!(target instanceof pageView.Element)) return;
    const actionButton = target.closest<HTMLButtonElement>("[data-action]");
    const action = actionButton?.dataset.action;
    if (action === "expand-prompt") openDialog();
    else if (action === "close-prompt-dialog") closeDialog();
    else if (action === "copy-prompt") void copyPrompt();
    else if (action === "paste-prompt") void pastePrompt();
    else if (action === "generate-world") void generate();
    else if (action === "cancel-generation") cancelGeneration();
    else if (action === "continue-manual") {
      if (generationController) cancelGeneration();
      state = setCreationStage(state, "foundation");
      renderStage();
    } else if (action === "continue-stage") validateAndContinue();
    else if (action === "back-stage") goBack();
    else if (action === "switch-collection" && actionButton?.dataset.collectionTarget) {
      activeCollection = actionButton.dataset.collectionTarget as EditableCollection;
      renderCollectionEditor();
    } else if (action === "select-item" && actionButton?.dataset.itemIndex) {
      selectedIndexes.set(activeCollection, Number(actionButton.dataset.itemIndex));
      renderCollectionEditor();
    } else if (action === "add-item" && (state.stage === "canon" || state.stage === "mechanics")) {
      state = addCreationCollectionItem(state, activeCollection, {});
      selectedIndexes.set(activeCollection, state.draft[activeCollection].length - 1);
      renderCollectionEditor();
    } else if (action === "remove-item" && (state.stage === "canon" || state.stage === "mechanics")) {
      const index = selectedIndexes.get(activeCollection) ?? 0;
      state = removeCreationCollectionItem(state, activeCollection, index);
      selectedIndexes.set(activeCollection, Math.min(index, Math.max(state.draft[activeCollection].length - 1, 0)));
      renderCollectionEditor();
    } else if (action === "undo-removal" && actionButton?.dataset.removalId) {
      state = restoreCreationCollectionItem(state, actionButton.dataset.removalId);
      renderCollectionEditor();
    } else if (action === "apply-advanced-json") applyAdvancedJson();
    else if (action === "apply-defaults-json") applyDefaultsJson();
  }

  function onKeyDown(event: Event): void {
    const keyboardEvent = event as KeyboardEvent;
    if (!dialogIsOpen()) return;
    if (keyboardEvent.key === "Escape") {
      keyboardEvent.preventDefault();
      closeDialog();
      return;
    }
    trapDialogFocus(keyboardEvent);
  }

  root.addEventListener("input", onInput);
  root.addEventListener("change", onChange);
  root.addEventListener("click", onClick);
  document.addEventListener("keydown", onKeyDown);
  renderStage();

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      clearPollTimer();
      generationController?.abort(new DOMException("World creation closed", "AbortError"));
      generationController = null;
      root.removeEventListener("input", onInput);
      root.removeEventListener("change", onChange);
      root.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKeyDown);
      theme.dispose();
    }
  };
}
