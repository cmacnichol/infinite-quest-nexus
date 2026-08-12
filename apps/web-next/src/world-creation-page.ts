import { initializeAppTheme, renderAppShell } from "./app-shell";
import {
  attachCreatedWorldCover as attachCreatedWorldCoverRequest,
  createWorld as createWorldRequest,
  generateCreatedWorldCover as generateCreatedWorldCoverRequest,
  generateWorldPreview as generateWorldPreviewRequest,
  loadWorldGenerationProgress as loadWorldGenerationProgressRequest,
  WorldCreationApiError,
  type CreatedWorldCoverResponse,
  type CreatedWorldResponse,
  type GeneratedWorldCoverResponse,
  type WorldGenerationPreviewRequest,
  type WorldGenerationPreviewResponse,
  type WorldGenerationProgressResponse
} from "./world-creation-api";
import {
  addCreationCollectionItem,
  appendCreationCharacter,
  applyGeneratedPreview,
  beginCreation,
  completeCreation,
  createWorldCreationState,
  creationStageProgress,
  creationReview,
  editCreationDraft,
  failCreation,
  hasLocalWorldCreationContent,
  removeCreationCharacter,
  removeCreationCollectionItem,
  replaceCreationCharacter,
  restoreCreationCharacter,
  restoreCreationCollectionItem,
  selectCreationMethod,
  setCreationCoverIntent,
  setCreationStage,
  updateCreationCollectionItem,
  validateCreationStage,
  worldCreationSubmissionSnapshot,
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
import {
  renderWorldCreationCharacterRoster
} from "./world-creation-character-roster.js";
import {
  characterWorkspacePath,
  createCharacterWorkspaceSessionStore,
  type CharacterWorkspaceSession,
  type CharacterWorkspaceSessionStore
} from "./character-workspace-session.js";
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
  createWorld?: (draft: WorldCreationState["draft"], signal?: AbortSignal) => Promise<CreatedWorldResponse>;
  attachCreatedWorldCover?: (
    worldId: string,
    assetId: string,
    signal?: AbortSignal
  ) => Promise<CreatedWorldCoverResponse>;
  generateCreatedWorldCover?: (
    worldId: string,
    prompt: string,
    signal?: AbortSignal
  ) => Promise<GeneratedWorldCoverResponse>;
  navigate?: (path: string) => void;
  characterSessionStore?: CharacterWorkspaceSessionStore;
  characterWorkflowIdFactory?: () => string;
  initialState?: WorldCreationState;
}

type EditableStage = "canon" | "mechanics";
type EditableCollection = Exclude<CreationCollectionName, "assets">;
type CreationCoverHandoff = "none" | "pending" | "completed" | "recovery";

interface CollectionSpec {
  collection: EditableCollection;
  label: string;
  singular: string;
  kind: Exclude<StructuredRecordKind, "character" | "asset">;
}

const STAGE_ORDER: readonly CreationStage[] = ["method", "foundation", "canon", "mechanics", "cover", "characters", "review"];

function createdWorldDestination(worldId: string, cover: CreationCoverHandoff): string {
  return `/app/worlds/${encodeURIComponent(worldId)}?creation=created&cover=${cover}`;
}
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
          <p>Review world details and an optional character roster before creation.</p>
        </div>
      </div>
    </header>
    <div class="editor-workspace creation-workspace">
      <nav class="editor-section-index creation-stage-index" aria-label="World creation stages">
        <button type="button" data-stage="method" aria-current="step">Method</button>
        <button type="button" data-stage="foundation" aria-disabled="true" disabled>Foundation</button>
        <button type="button" data-stage="canon" aria-disabled="true" disabled>Canon</button>
        <button type="button" data-stage="mechanics" aria-disabled="true" disabled>Mechanics</button>
        <button type="button" data-stage="cover" aria-disabled="true" disabled>Cover</button>
        <button type="button" data-stage="characters" aria-disabled="true" disabled>Characters</button>
        <button type="button" data-stage="review" aria-disabled="true" disabled>Review</button>
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
            <label class="editor-field creation-prompt-field"><span>Concept prompt</span><textarea rows="7" data-concept-prompt="compact" aria-describedby="creation-clipboard-status creation-generation-status" placeholder="Describe your world concept"></textarea></label>
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
  const stageItems = [...root.querySelectorAll<HTMLButtonElement>("[data-stage]")];
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
  const createWorld = dependencies.createWorld ?? createWorldRequest;
  const attachCreatedWorldCover = dependencies.attachCreatedWorldCover ?? attachCreatedWorldCoverRequest;
  const generateCreatedWorldCover = dependencies.generateCreatedWorldCover ?? generateCreatedWorldCoverRequest;
  const navigate = dependencies.navigate ?? ((path: string) => pageView.location.assign(path));
  let defaultCharacterSessionStore: CharacterWorkspaceSessionStore | null = null;
  if (!dependencies.characterSessionStore) {
    try {
      defaultCharacterSessionStore = createCharacterWorkspaceSessionStore(pageView.sessionStorage);
    } catch {
      defaultCharacterSessionStore = null;
    }
  }
  const characterSessionStore = dependencies.characterSessionStore ?? defaultCharacterSessionStore;
  const characterWorkflowIdFactory = dependencies.characterWorkflowIdFactory ?? (() => crypto.randomUUID());
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

  let state = dependencies.initialState
    ? structuredClone(dependencies.initialState)
    : createWorldCreationState();
  let concept = "";
  let disposed = false;
  let generationSequence = 0;
  let generationController: AbortController | null = null;
  let creationController: AbortController | null = null;
  let createdWorld: CreatedWorldResponse | null = null;
  let coverError: WorldCreationApiError | Error | null = null;
  let coverStatus: string | null = null;
  let coverHandoff: Exclude<CreationCoverHandoff, "none" | "recovery"> | null = null;
  let assetsJsonInvalid = false;
  let unloadInstalled = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let activeCollection: EditableCollection = "entities";
  let activeCharacterHandoff: Pick<CharacterWorkspaceSession, "key" | "workflowId"> | null = null;
  let characterHandoffError: string | null = null;
  const selectedIndexes = new Map<EditableCollection, number>();
  const searches = new Map<EditableCollection, string>();

  const beforeUnload = (event: Event) => event.preventDefault();

  function setDirtyGuard(dirty: boolean): void {
    if (dirty && !unloadInstalled) {
      pageView.addEventListener("beforeunload", beforeUnload);
      unloadInstalled = true;
    } else if (!dirty && unloadInstalled) {
      pageView.removeEventListener("beforeunload", beforeUnload);
      unloadInstalled = false;
    }
  }

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
      item.querySelector("[data-stage-completion]")?.remove();
      item.removeAttribute("aria-label");
      if (progress.state === "completed") {
        const completion = document.createElement("span");
        completion.className = "visually-hidden";
        completion.dataset.stageCompletion = "";
        completion.textContent = "Completed: ";
        item.prepend(completion);
      }
      if (progress.state === "current") item.setAttribute("aria-current", "step");
      else item.removeAttribute("aria-current");
      const unavailable = progress.state === "upcoming";
      item.disabled = unavailable;
      if (unavailable) item.setAttribute("aria-disabled", "true");
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

  function renderCover(): void {
    editingStage.replaceChildren();
    const header = document.createElement("header");
    const heading = document.createElement("h2");
    heading.id = "cover-heading";
    heading.textContent = "Cover";
    const guidance = document.createElement("p");
    guidance.dataset.coverGuidance = "";
    guidance.textContent = "Cover work is optional and runs independently after the world draft is created.";
    header.append(heading, guidance);

    const modes = document.createElement("fieldset");
    const legend = document.createElement("legend");
    legend.textContent = "Cover choice";
    modes.append(legend);
    for (const [mode, labelText] of [
      ["none", "No cover"],
      ["retained_asset", "Use a retained asset"],
      ["generated", "Generate a cover"]
    ] as const) {
      const label = document.createElement("label");
      label.className = "creation-cover-control";
      const control = document.createElement("input");
      control.type = "radio";
      control.name = "coverMode";
      control.value = mode;
      control.checked = state.coverIntent.mode === mode;
      label.append(control, document.createTextNode(labelText));
      modes.append(label);
    }
    editingStage.append(header, modes);

    if (state.coverIntent.mode === "retained_asset") {
      const control = document.createElement("input");
      control.name = "cover.assetId";
      control.value = state.coverIntent.assetId;
      control.id = "creation-cover-asset";
      const error = document.createElement("small");
      error.className = "field-error";
      error.dataset.fieldError = "cover.assetId";
      error.id = "creation-cover-asset-error";
      control.setAttribute("aria-describedby", error.id);
      const field = labelledControl("Retained asset ID", control);
      field.append(error);
      editingStage.append(field);
    } else if (state.coverIntent.mode === "generated") {
      const control = document.createElement("textarea");
      control.name = "cover.prompt";
      control.value = state.coverIntent.prompt;
      control.rows = 5;
      control.id = "creation-cover-prompt";
      const error = document.createElement("small");
      error.className = "field-error";
      error.dataset.fieldError = "cover.prompt";
      error.id = "creation-cover-prompt-error";
      control.setAttribute("aria-describedby", `${error.id} creation-cover-provider-guidance`);
      const field = labelledControl("Fiction-only cover prompt", control);
      field.append(error);
      const providerGuidance = document.createElement("p");
      providerGuidance.id = "creation-cover-provider-guidance";
      providerGuidance.dataset.coverProviderGuidance = "";
      providerGuidance.textContent = "If the image provider is unavailable, the world can still be created and the cover can be retried.";
      editingStage.append(field, providerGuidance);
    }

    const assets = document.createElement("details");
    assets.className = "advanced-json creation-assets-editor";
    const assetsSummary = document.createElement("summary");
    assetsSummary.textContent = "World assets JSON";
    const assetsJson = document.createElement("textarea");
    assetsJson.dataset.assetsJson = "";
    assetsJson.rows = 10;
    assetsJson.value = serializeAdvancedJson(state.draft.assets);
    assetsJson.setAttribute("aria-label", "World assets JSON");
    assetsJson.setAttribute("aria-describedby", "creation-assets-error");
    const assetsError = document.createElement("p");
    assetsError.id = "creation-assets-error";
    assetsError.className = "field-error";
    assetsError.dataset.assetsError = "";
    assets.append(assetsSummary, assetsJson, button("apply-assets-json", "Apply assets JSON"), assetsError);
    editingStage.append(assets, stageActions());
  }

  function renderCharacters(): void {
    editingStage.replaceChildren(renderWorldCreationCharacterRoster({
      document,
      state,
      sessionStore: characterSessionStore,
      workflowIdFactory: characterWorkflowIdFactory,
      navigate,
      onSessionCreated: (session) => {
        activeCharacterHandoff = { key: session.key, workflowId: session.workflowId };
        characterHandoffError = null;
      },
      onRemove: (characterId) => {
        state = removeCreationCharacter(state, characterId);
        renderCharacters();
        renderStageIndex();
        setDirtyGuard(state.navigationDirty);
      },
      onRestore: (removalId) => {
        state = restoreCreationCharacter(state, removalId);
        renderCharacters();
        renderStageIndex();
        setDirtyGuard(state.navigationDirty);
      },
      ...(characterHandoffError && activeCharacterHandoff ? {
        handoffRecovery: {
          message: characterHandoffError,
          returnPath: characterWorkspacePath(activeCharacterHandoff.key),
          onRetry: () => consumeCharacterHandoff(true)
        }
      } : {})
    }));
    editingStage.append(stageActions());
  }

  function stageForIssue(path: string): CreationStage {
    if (path === "method") return "method";
    if (path === "world" || path.startsWith("world.")) return "foundation";
    if (path === "entities" || path === "relationships") return "canon";
    if (["rpgStats", "defaultTriggers", "eventTriggers", "defaults"].includes(path)) return "mechanics";
    return "cover";
  }

  function renderReview(): void {
    editingStage.replaceChildren();
    const review = creationReview(state);
    const heading = document.createElement("h2");
    heading.id = "review-heading";
    heading.textContent = "Review";
    const provenance = document.createElement("p");
    provenance.dataset.reviewProvenance = "";
    provenance.textContent = `${review.provenance === "ai" ? "AI-assisted" : "Manual"} creation`;
    const readiness = document.createElement("p");
    readiness.dataset.reviewReadiness = "";
    readiness.textContent = review.ready ? "Ready to create" : "Needs attention before creation";
    const warningCount = document.createElement("p");
    warningCount.dataset.reviewWarningCount = "";
    warningCount.textContent = `Warnings ${review.warningCount}`;
    const coverIntent = document.createElement("p");
    coverIntent.dataset.reviewCoverIntent = "";
    coverIntent.textContent = review.coverIntent.mode === "none"
      ? "Cover intent: No cover"
      : review.coverIntent.mode === "retained_asset"
        ? `Cover intent: Retained asset ${review.coverIntent.assetId}`
        : `Cover intent: Generate cover — ${review.coverIntent.prompt}`;
    const readinessList = document.createElement("ul");
    readinessList.dataset.reviewStageReadiness = "";
    for (const stageReadiness of review.readiness) {
      const item = document.createElement("li");
      item.dataset.reviewStage = stageReadiness.stage;
      const label = stageReadiness.stage[0]!.toUpperCase() + stageReadiness.stage.slice(1);
      item.textContent = `${label}: ${stageReadiness.ready ? "ready" : `needs attention · ${stageReadiness.issueCount} issue${stageReadiness.issueCount === 1 ? "" : "s"}`}`;
      readinessList.append(item);
    }
    editingStage.append(heading, provenance, readiness, warningCount, coverIntent, readinessList);

    const validation = validateCreationStage(state, "review");
    if (validation.issues.length > 0) {
      const summary = document.createElement("nav");
      summary.dataset.reviewErrors = "";
      summary.tabIndex = -1;
      summary.setAttribute("aria-label", "Creation errors");
      const list = document.createElement("ul");
      for (const issue of validation.issues) {
        const item = document.createElement("li");
        const link = document.createElement("a");
        const issueStage = stageForIssue(issue.path);
        link.href = `#${issueStage}-heading`;
        link.dataset.reviewIssueStage = issueStage;
        link.dataset.reviewIssuePath = issue.path;
        link.textContent = issue.message;
        item.append(link);
        list.append(item);
      }
      summary.append(list);
      editingStage.append(summary);
    }

    for (const warningText of review.warnings) {
      const warning = document.createElement("p");
      warning.dataset.reviewWarning = "";
      warning.textContent = warningText;
      editingStage.append(warning);
    }
    if (state.creationError) {
      const error = document.createElement("div");
      error.dataset.creationError = "";
      error.tabIndex = -1;
      error.setAttribute("role", "alert");
      error.textContent = `The world was not created. ${state.creationError.message} Your local work is unchanged; try again.`;
      editingStage.append(error);
    }
    if (createdWorld && coverError) {
      const error = document.createElement("div");
      error.dataset.coverError = "";
      error.tabIndex = -1;
      error.setAttribute("role", "alert");
      if (state.coverIntent.mode === "generated" && coverError instanceof WorldCreationApiError && coverError.kind === "unavailable") {
        error.innerHTML = 'The world was created, but the image provider is unavailable. Check <a href="/nexus/?view=setup">Provider Setup</a> or retry the cover.';
      } else {
        error.textContent = "The world was created, but its cover could not be completed. Retry the cover or open the world.";
      }
      editingStage.append(error);
    } else if (createdWorld && coverStatus) {
      const status = document.createElement("p");
      status.dataset.coverStatus = "";
      status.setAttribute("role", "status");
      status.textContent = coverStatus;
      editingStage.append(status);
    }
    const counts = document.createElement("dl");
    for (const [name, count] of Object.entries(review.counts)) {
      const term = document.createElement("dt");
      term.textContent = name[0]!.toUpperCase() + name.slice(1);
      const value = document.createElement("dd");
      value.dataset.reviewCount = name;
      value.textContent = String(count);
      counts.append(term, value);
    }
    const serialized = document.createElement("pre");
    serialized.dataset.reviewSerialized = "";
    serialized.textContent = JSON.stringify(review.draft, null, 2);
    const actions = document.createElement("div");
    actions.className = "creation-stage-actions";
    if (createdWorld) {
      actions.append(button("open-created-world", "Open world"));
      if (coverError) actions.append(button("retry-cover", "Retry cover"));
    } else {
      const create = button("create-world", state.status === "creating" ? "Creating world…" : "Create world");
      create.disabled = state.status === "creating";
      actions.append(button("back-stage", "Back"), create);
    }
    editingStage.append(counts, serialized, actions);
  }

  function renderStage(): void {
    canvas.dataset.creationStage = state.stage;
    methodStage.hidden = state.stage !== "method";
    editingStage.hidden = state.stage === "method";
    renderStageIndex();
    if (state.stage === "foundation") renderFoundation();
    else if (state.stage === "canon" || state.stage === "mechanics") renderCollectionEditor();
    else if (state.stage === "cover") renderCover();
    else if (state.stage === "characters") renderCharacters();
    else if (state.stage === "review") renderReview();
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
    try {
      await writeClipboardText(concept);
      clipboardAnnouncement("Copied world concept.");
    } catch {
      clipboardAnnouncement("We could not copy the world concept. Select the text and copy it manually.");
    }
  }

  async function pastePrompt(): Promise<void> {
    const editor = activePrompt();
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
        if (progress.status === "failed") {
          generationSequence += 1;
          generationController = null;
          clearPollTimer();
          controller.abort(new DOMException("World generation failed", "AbortError"));
          generationStatus.textContent = progress.errorMessage?.trim() || progress.message ||
            "World generation failed. Your concept and local fields are unchanged; try again.";
          generateButton.disabled = !concept.trim();
          cancelButton.hidden = true;
          return;
        }
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

  async function performCover(
    world: CreatedWorldResponse,
    intent: WorldCreationState["coverIntent"],
    controller: AbortController
  ): Promise<boolean> {
    try {
      if (intent.mode === "retained_asset") {
        await attachCreatedWorldCover(world.id, intent.assetId, controller.signal);
        if (disposed || creationController !== controller || controller.signal.aborted) return false;
        coverStatus = "The retained cover was attached successfully.";
        coverHandoff = "completed";
      } else if (intent.mode === "generated") {
        const result = await generateCreatedWorldCover(world.id, intent.prompt, controller.signal);
        if (disposed || creationController !== controller || controller.signal.aborted) return false;
        if (["recoverable", "failed", "cancelled", "expired"].includes(result.status)) {
          coverStatus = null;
          coverError = new Error(`Cover generation ended with status ${result.status}.`);
          renderReview();
          editingStage.querySelector<HTMLElement>("[data-cover-error]")?.focus();
          return false;
        }
        coverStatus = result.status === "completed"
          ? "Cover generation completed successfully."
          : result.status === "queued"
            ? "Cover generation was queued and will continue in the background."
            : "Cover generation is in progress and will continue in the background.";
        coverHandoff = result.status === "completed" ? "completed" : "pending";
      }
      if (disposed || creationController !== controller || controller.signal.aborted) return false;
      coverError = null;
      renderReview();
      return true;
    } catch (error) {
      if (disposed || creationController !== controller || controller.signal.aborted) return false;
      coverStatus = null;
      coverError = error instanceof Error ? error : new Error("Cover operation failed.");
      renderReview();
      editingStage.querySelector<HTMLElement>("[data-cover-error]")?.focus();
      return false;
    }
  }

  async function submitCreation(): Promise<void> {
    if (creationController || createdWorld) return;
    const validation = validateCreationStage(state, "review");
    if (validation.issues.length > 0) {
      renderReview();
      editingStage.querySelector<HTMLElement>("[data-review-errors]")?.focus();
      return;
    }

    const snapshot = worldCreationSubmissionSnapshot(state.draft);
    const coverIntent = structuredClone(state.coverIntent);
    const controller = new AbortController();
    creationController = controller;
    state = beginCreation(state);
    renderReview();
    try {
      const result = await createWorld(snapshot, controller.signal);
      if (disposed || creationController !== controller || controller.signal.aborted) return;
      createdWorld = result;
      state = completeCreation(state, result.id);
      setDirtyGuard(false);
      if (coverIntent.mode === "none") {
        navigate(createdWorldDestination(result.id, "none"));
      } else if (await performCover(result, coverIntent, controller) &&
        !disposed && creationController === controller && !controller.signal.aborted && coverHandoff) {
        navigate(createdWorldDestination(result.id, coverHandoff));
      }
    } catch (error) {
      if (disposed || creationController !== controller || controller.signal.aborted || createdWorld) return;
      const kind = error instanceof WorldCreationApiError ? error.kind : "request_failed";
      const message = error instanceof Error ? error.message : "World creation failed.";
      state = failCreation(state, kind, message);
      renderReview();
      editingStage.querySelector<HTMLElement>("[data-creation-error]")?.focus();
    } finally {
      if (creationController === controller) creationController = null;
    }
  }

  async function retryCover(): Promise<void> {
    if (!createdWorld || creationController || state.coverIntent.mode === "none") return;
    const controller = new AbortController();
    creationController = controller;
    coverError = null;
    coverStatus = null;
    renderReview();
    try {
      if (await performCover(createdWorld, structuredClone(state.coverIntent), controller) &&
        !disposed && creationController === controller && !controller.signal.aborted) {
        navigate(createdWorldDestination(createdWorld.id, coverHandoff ?? "completed"));
      }
    } finally {
      if (creationController === controller) creationController = null;
    }
  }

  function focusStageIssue(): boolean {
    if (state.stage === "cover" && assetsJsonInvalid) {
      editingStage.querySelector<HTMLTextAreaElement>("[data-assets-json]")?.focus();
      return true;
    }
    const issue = validateCreationStage(state).issues[0];
    if (!issue) return false;
    const control = editingStage.querySelector<HTMLElement>(`[name="${issue.path}"]`);
    const error = editingStage.querySelector<HTMLElement>(`[data-field-error="${issue.path}"]`);
    control?.setAttribute("aria-invalid", "true");
    if (error) error.textContent = issue.message;
    control?.focus();
    return true;
  }

  function validateAndContinue(): void {
    if (focusStageIssue()) return;
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

  function pendingAssetsJsonIsValid(): boolean {
    if (state.stage !== "cover") return true;
    const textarea = editingStage.querySelector<HTMLTextAreaElement>("[data-assets-json]");
    const error = editingStage.querySelector<HTMLElement>("[data-assets-error]");
    if (!textarea) return true;
    const parsed = parseAdvancedJson<unknown[]>(textarea.value, "array");
    if (parsed.error) {
      assetsJsonInvalid = true;
      textarea.setAttribute("aria-invalid", "true");
      if (error) error.textContent = parsed.error;
      textarea.focus();
      return false;
    }
    assetsJsonInvalid = false;
    textarea.removeAttribute("aria-invalid");
    if (error) error.textContent = "";
    return true;
  }

  function applyAssetsJson(): void {
    const textarea = editingStage.querySelector<HTMLTextAreaElement>("[data-assets-json]");
    const error = editingStage.querySelector<HTMLElement>("[data-assets-error]");
    if (!textarea) return;
    const parsed = parseAdvancedJson<unknown[]>(textarea.value, "array");
    if (parsed.error) {
      assetsJsonInvalid = true;
      textarea.setAttribute("aria-invalid", "true");
      if (error) error.textContent = parsed.error;
      textarea.focus();
      return;
    }
    assetsJsonInvalid = false;
    state = editCreationDraft(state, ["assets"], parsed.value);
    renderCover();
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
    if (target.name === "cover.assetId" && state.coverIntent.mode === "retained_asset") {
      state = setCreationCoverIntent(state, { mode: "retained_asset", assetId: target.value });
      target.removeAttribute("aria-invalid");
      const error = editingStage.querySelector<HTMLElement>('[data-field-error="cover.assetId"]');
      if (error) error.textContent = "";
      return;
    }
    if (target.name === "cover.prompt" && state.coverIntent.mode === "generated") {
      state = setCreationCoverIntent(state, { mode: "generated", prompt: target.value });
      target.removeAttribute("aria-invalid");
      const error = editingStage.querySelector<HTMLElement>('[data-field-error="cover.prompt"]');
      if (error) error.textContent = "";
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
    if (!(target instanceof pageView.HTMLInputElement) || !target.checked) return;
    if (target.name === "creationMethod" && (target.value === "manual" || target.value === "ai")) {
      updateMethod(target.value);
    } else if (target.name === "coverMode") {
      if (target.value === "none") state = setCreationCoverIntent(state, { mode: "none" });
      else if (target.value === "retained_asset") state = setCreationCoverIntent(state, { mode: "retained_asset", assetId: "" });
      else if (target.value === "generated") state = setCreationCoverIntent(state, { mode: "generated", prompt: "" });
      renderCover();
    }
  }

  function onClick(event: Event): void {
    const target = event.target;
    if (!(target instanceof pageView.Element)) return;
    const stageButton = target.closest<HTMLButtonElement>("button[data-stage]");
    if (stageButton?.dataset.stage && !stageButton.disabled) {
      const previousStage = state.stage;
      const previousIndex = STAGE_ORDER.indexOf(previousStage);
      const targetStage = stageButton.dataset.stage as CreationStage;
      const targetIndex = STAGE_ORDER.indexOf(targetStage);
      if (targetIndex > previousIndex && !pendingAssetsJsonIsValid()) return;
      state = setCreationStage(state, targetStage);
      if (state.stage !== previousStage) {
        if (assetsJsonInvalid && previousStage === "cover") assetsJsonInvalid = false;
        if (state.stage === "canon") activeCollection = "entities";
        if (state.stage === "mechanics") activeCollection = "rpgStats";
        renderStage();
      } else if (STAGE_ORDER.indexOf(targetStage) > previousIndex) {
        focusStageIssue();
      }
      return;
    }
    const issueLink = target.closest<HTMLAnchorElement>("[data-review-issue-stage]");
    if (issueLink?.dataset.reviewIssueStage) {
      event.preventDefault();
      const issuePath = issueLink.dataset.reviewIssuePath ?? "";
      if (issuePath === "entities" || issuePath === "relationships" ||
          issuePath === "rpgStats" || issuePath === "defaultTriggers" || issuePath === "eventTriggers") {
        activeCollection = issuePath;
      }
      state = setCreationStage(state, issueLink.dataset.reviewIssueStage as CreationStage);
      renderStage();
      let focusTarget: HTMLElement | null = null;
      if (issuePath === "method") {
        focusTarget = root.querySelector<HTMLElement>('[name="creationMethod"]:checked, [name="creationMethod"]');
      } else if (issuePath === "world") {
        focusTarget = root.querySelector<HTMLElement>('[name="world.title"]');
      } else if (issuePath === "entities" || issuePath === "relationships" ||
          issuePath === "rpgStats" || issuePath === "defaultTriggers" || issuePath === "eventTriggers") {
        focusTarget = root.querySelector<HTMLElement>(`[data-collection-target="${issuePath}"]`);
      } else if (issuePath === "defaults") {
        focusTarget = root.querySelector<HTMLElement>("[data-defaults-json]");
      } else if (issuePath === "assets") {
        focusTarget = root.querySelector<HTMLElement>('[name="coverMode"]:checked, [name="coverMode"]');
      } else if (issuePath) {
        focusTarget = root.querySelector<HTMLElement>(`[name="${issuePath}"]`);
      }
      (focusTarget ?? root.querySelector<HTMLElement>(`#${state.stage}-heading`))?.focus();
      return;
    }
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
    else if (action === "create-world") void submitCreation();
    else if (action === "retry-cover") void retryCover();
    else if (action === "open-created-world" && createdWorld) {
      navigate(createdWorldDestination(createdWorld.id, "recovery"));
    }
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
    else if (action === "apply-assets-json") applyAssetsJson();
    else if (action === "apply-defaults-json") applyDefaultsJson();
  }

  function onKeyDown(event: Event): void {
    const keyboardEvent = event as KeyboardEvent;
    const target = keyboardEvent.target;
    if (!dialogIsOpen() && target instanceof pageView.Element &&
      (keyboardEvent.key === "Enter" || keyboardEvent.key === " ")) {
      const stageButton = target.closest<HTMLButtonElement>("button[data-stage]:not([disabled])");
      if (stageButton) {
        keyboardEvent.preventDefault();
        stageButton.click();
        return;
      }
    }
    if (!dialogIsOpen()) return;
    if (keyboardEvent.key === "Escape") {
      keyboardEvent.preventDefault();
      closeDialog();
      return;
    }
    trapDialogFocus(keyboardEvent);
  }

  function consumeCharacterHandoff(useCurrentRoster = false): void {
    if (!activeCharacterHandoff || !characterSessionStore) return;
    const pending = characterSessionStore.peek(
      activeCharacterHandoff.key,
      "world-creation",
      activeCharacterHandoff.workflowId
    );
    if (!pending) return;

    let nextState = state;
    if (pending.result.status === "accepted") {
      try {
        nextState = useCurrentRoster
          ? { ...state, stage: "characters" }
          : {
              ...state,
              stage: "characters",
              draft: structuredClone(pending.session.parentDraft)
            };
        nextState = pending.session.mode === "edit" && pending.session.candidate
          ? replaceCreationCharacter(nextState, pending.session.candidate.id, pending.result.candidate)
          : appendCreationCharacter(nextState, pending.result.candidate);
      } catch {
        state = { ...state, stage: "characters" };
        characterHandoffError = pending.session.mode === "edit"
          ? "This character could not be updated because the roster changed. The result is preserved; retry it or return to the character workspace."
          : "This character could not be added because it is invalid, duplicated, or the roster is full. The result is preserved; adjust the roster and retry it, or return to the character workspace.";
        renderStage();
        setDirtyGuard(state.navigationDirty);
        return;
      }
    }

    const consumed = characterSessionStore.consume(
      activeCharacterHandoff.key,
      "world-creation",
      activeCharacterHandoff.workflowId
    );
    if (!consumed) {
      state = { ...state, stage: "characters" };
      characterHandoffError = "The character result could not be applied. It may still be recoverable; retry it or return to the character workspace.";
      renderStage();
      setDirtyGuard(state.navigationDirty);
      return;
    }
    state = nextState;
    activeCharacterHandoff = null;
    characterHandoffError = null;
    renderStage();
    setDirtyGuard(state.navigationDirty);
  }

  const onPageShow = () => consumeCharacterHandoff();
  const onRootInput = (event: Event) => {
    onInput(event);
    setDirtyGuard(state.navigationDirty);
  };
  const onRootChange = (event: Event) => {
    onChange(event);
    setDirtyGuard(state.navigationDirty);
  };
  const onRootClick = (event: Event) => {
    onClick(event);
    setDirtyGuard(state.navigationDirty);
  };

  root.addEventListener("input", onRootInput);
  root.addEventListener("change", onRootChange);
  root.addEventListener("click", onRootClick);
  document.addEventListener("keydown", onKeyDown);
  pageView.addEventListener("pageshow", onPageShow);
  renderStage();

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      clearPollTimer();
      generationController?.abort(new DOMException("World creation closed", "AbortError"));
      generationController = null;
      creationController?.abort(new DOMException("World creation closed", "AbortError"));
      creationController = null;
      setDirtyGuard(false);
      root.removeEventListener("input", onRootInput);
      root.removeEventListener("change", onRootChange);
      root.removeEventListener("click", onRootClick);
      document.removeEventListener("keydown", onKeyDown);
      pageView.removeEventListener("pageshow", onPageShow);
      theme.dispose();
    }
  };
}
