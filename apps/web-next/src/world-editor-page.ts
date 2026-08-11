import { initializeAppTheme, renderAppShell } from "./app-shell";
import {
  loadWorld as loadWorldRequest,
  saveWorldDraft as saveWorldDraftRequest,
  setWorldCoverAsset as setWorldCoverAssetRequest,
  WorldEditorApiError,
  type WorldCoverAssetResponse,
  type WorldDraftSaveResponse
} from "./world-editor-api";
import {
  collectionItemSummary,
  mergeStructuredFields,
  parseAdvancedJson,
  serializeAdvancedJson,
  structuredFieldsFor,
  type AdvancedJsonShape,
  type StructuredRecordKind
} from "./world-editor-fields";
import type { EditableWorldDraft, WorldAggregate } from "./world-editor-model";
import {
  addCollectionItem,
  beginDraftSave,
  completeDraftSave,
  createWorldEditorState,
  draftReadiness,
  editWorldDraft,
  failDraftSave,
  removeCollectionItem,
  restoreCollectionItem,
  updateCollectionItem,
  validateWorldDraft,
  type DraftCollectionName,
  type WorldEditorState
} from "./world-editor-state";
import type { MountedPage } from "./world-library-page";

export interface WorldEditorPageDependencies {
  loadWorld?: (worldId: string, signal?: AbortSignal) => Promise<WorldAggregate>;
  saveWorldDraft?: (
    worldId: string,
    expectedRevision: number,
    draft: EditableWorldDraft,
    signal?: AbortSignal
  ) => Promise<WorldDraftSaveResponse>;
  setWorldCoverAsset?: (
    worldId: string,
    assetId: string | null,
    signal?: AbortSignal
  ) => Promise<WorldCoverAssetResponse>;
  copyUnsavedDraft?: (serializedDraft: string) => Promise<void>;
  downloadUnsavedDraft?: (serializedDraft: string, filename: string) => void;
  confirmReload?: () => boolean;
}

type OverviewField = "title" | "genre" | "tone" | "premise" | "backgroundStory" | "firstAction" | "rules";
type EditorSection = "overview" | "characters" | "canon" | "mechanics" | "assets";
type CoverChoice = "keep" | "remove" | "select";

interface CollectionSpec {
  collection: DraftCollectionName;
  label: string;
  singular: string;
  kind: StructuredRecordKind;
}

const SECTION_LABELS: Record<EditorSection, string> = {
  overview: "Overview",
  characters: "Characters",
  canon: "Canon",
  mechanics: "Mechanics",
  assets: "Assets"
};

const COLLECTIONS: Record<DraftCollectionName, CollectionSpec> = {
  playableCharacters: { collection: "playableCharacters", label: "Characters", singular: "character", kind: "character" },
  entities: { collection: "entities", label: "Entities", singular: "entity", kind: "entity" },
  relationships: { collection: "relationships", label: "Relationships", singular: "relationship", kind: "relationship" },
  rpgStats: { collection: "rpgStats", label: "Stats", singular: "stat", kind: "stat" },
  defaultTriggers: { collection: "defaultTriggers", label: "Default trackers", singular: "tracker", kind: "trigger" },
  eventTriggers: { collection: "eventTriggers", label: "Event triggers", singular: "trigger", kind: "trigger" },
  assets: { collection: "assets", label: "Assets", singular: "asset", kind: "asset" }
};

const SECTION_COLLECTIONS: Record<Exclude<EditorSection, "overview">, DraftCollectionName[]> = {
  characters: ["playableCharacters"],
  canon: ["entities", "relationships"],
  mechanics: ["rpgStats", "defaultTriggers", "eventTriggers"],
  assets: ["assets"]
};

const STRUCTURED_FIELDS: Record<Exclude<StructuredRecordKind, "asset">, Array<{
  name: string;
  label: string;
  kind: "input" | "textarea" | "json";
  shape?: AdvancedJsonShape;
}>> = {
  character: [
    { name: "name", label: "Name", kind: "input" },
    { name: "narrativeGuidance", label: "Narrative guidance", kind: "textarea" },
    { name: "profileGroups", label: "Profile groups", kind: "json", shape: "object" },
    { name: "stats", label: "Stats", kind: "json", shape: "array" },
    { name: "defaultTrackers", label: "Default trackers", kind: "json", shape: "array" }
  ],
  entity: [
    { name: "name", label: "Name", kind: "input" },
    { name: "type", label: "Type", kind: "input" },
    { name: "description", label: "Description", kind: "textarea" }
  ],
  relationship: [
    { name: "source", label: "Source", kind: "input" },
    { name: "target", label: "Target", kind: "input" },
    { name: "type", label: "Type", kind: "input" },
    { name: "description", label: "Description", kind: "textarea" }
  ],
  stat: [
    { name: "name", label: "Name", kind: "input" },
    { name: "value", label: "Value", kind: "input" },
    { name: "note", label: "Note", kind: "textarea" }
  ],
  trigger: [
    { name: "name", label: "Name", kind: "input" },
    { name: "condition", label: "Condition", kind: "textarea" },
    { name: "effect", label: "Effect", kind: "textarea" }
  ]
};

const fieldDefinitions: Array<{ name: OverviewField; label: string; kind: "input" | "textarea"; rows?: number }> = [
  { name: "title", label: "Title", kind: "input" },
  { name: "genre", label: "Genre", kind: "input" },
  { name: "tone", label: "Tone", kind: "textarea", rows: 2 },
  { name: "premise", label: "Premise", kind: "textarea", rows: 4 },
  { name: "backgroundStory", label: "Background story", kind: "textarea", rows: 7 },
  { name: "firstAction", label: "First action", kind: "textarea", rows: 4 },
  { name: "rules", label: "Rules", kind: "textarea", rows: 6 }
];

function requiredElement<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error("The World Editor interface could not be initialized.");
  return element;
}

function overviewFieldsMarkup(): string {
  return fieldDefinitions.map((field) => {
    const id = `world-${field.name}`;
    const control = field.kind === "input"
      ? `<input id="${id}" name="world.${field.name}" type="text" disabled />`
      : `<textarea id="${id}" name="world.${field.name}" rows="${field.rows}" disabled></textarea>`;
    return `<label class="editor-field editor-field-${field.name}" for="${id}"><span>${field.label}</span>${control}</label>`;
  }).join("");
}

function sectionIndexMarkup(): string {
  return (Object.keys(SECTION_LABELS) as EditorSection[]).map((section) =>
    `<button type="button" data-section-target="${section}"${section === "overview" ? ' aria-current="page"' : ""}>${SECTION_LABELS[section]}</button>`
  ).join("");
}

const editorMarkup = `
  <main id="main-content" class="editor-main" data-page="world-editor" aria-busy="true">
    <section class="editor-command-row" aria-labelledby="editor-title">
      <div class="editor-identity">
        <a href="/app/">World Library</a>
        <h1 id="editor-title">World Editor</h1>
      </div>
      <p class="editor-command-status" data-editor-state aria-live="polite">Loading world editor…</p>
      <div class="editor-save-cell"><button type="button" data-action="save-draft" disabled>Save draft</button></div>
    </section>
    <div class="editor-workspace">
      <nav class="editor-section-index" data-section-index aria-label="World editor sections">${sectionIndexMarkup()}</nav>
      <div class="editor-canvas">
        <section id="overview" class="overview-editor" data-editor-section="overview" aria-labelledby="overview-heading">
          <header><h2 id="overview-heading">Overview</h2><p>Set the world’s identity and the opening frame the Story Engine can build from.</p></header>
          <div class="editor-load-state" data-load-state></div>
          <form class="overview-form" novalidate>${overviewFieldsMarkup()}</form>
        </section>
        <section class="overview-editor collection-section" data-editor-section="characters" hidden aria-labelledby="collection-section-heading">
          <header><h2 id="collection-section-heading" data-section-heading>Characters</h2><p data-section-description></p></header>
          <div data-section-content></div>
        </section>
        <p class="save-announcement" data-save-announcement aria-live="assertive"></p>
        <div data-conflict-host></div>
      </div>
    </div>
    <section class="draft-ledger" data-draft-ledger aria-label="Draft ledger">
      <div class="draft-ledger-summary">
        <span data-ledger-state>State —</span><span data-ledger-revision>Revision —</span>
        <span data-ledger-readiness>Readiness —</span><span data-ledger-warnings>Warnings —</span>
        <button type="button" data-action="toggle-ledger" aria-expanded="false" aria-controls="draft-ledger-details">Draft details</button>
      </div>
      <div id="draft-ledger-details" class="draft-ledger-details" hidden></div>
    </section>
  </main>`;

function serializeDraft(draft: EditableWorldDraft): string {
  return `${JSON.stringify(draft, null, 2)}\n`;
}

function downloadDraft(document: Document, serializedDraft: string, filename: string): void {
  const view = document.defaultView;
  if (!view || typeof view.URL?.createObjectURL !== "function") return;
  const url = view.URL.createObjectURL(new Blob([serializedDraft], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  view.URL.revokeObjectURL(url);
}

function textValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

export function mountWorldEditorPage(
  root: HTMLElement,
  worldId: string,
  dependencies: WorldEditorPageDependencies = {}
): MountedPage {
  renderAppShell(root, editorMarkup, "world-editor");
  const theme = initializeAppTheme(root);
  const document = root.ownerDocument;
  const view = document.defaultView;
  if (!view) {
    theme.dispose();
    throw new Error("The World Editor interface could not be initialized.");
  }
  const pageView = view;

  const main = requiredElement<HTMLElement>(root, '[data-page="world-editor"]');
  const form = requiredElement<HTMLFormElement>(root, ".overview-form");
  const overviewSection = requiredElement<HTMLElement>(root, '[data-editor-section="overview"]');
  const collectionSection = requiredElement<HTMLElement>(root, ".collection-section");
  const sectionContent = requiredElement<HTMLElement>(root, "[data-section-content]");
  const sectionHeading = requiredElement<HTMLElement>(root, "[data-section-heading]");
  const sectionDescription = requiredElement<HTMLElement>(root, "[data-section-description]");
  const saveButton = requiredElement<HTMLButtonElement>(root, '[data-action="save-draft"]');
  const editorState = requiredElement<HTMLElement>(root, "[data-editor-state]");
  const loadState = requiredElement<HTMLElement>(root, "[data-load-state]");
  const announcement = requiredElement<HTMLElement>(root, "[data-save-announcement]");
  const conflictHost = requiredElement<HTMLElement>(root, "[data-conflict-host]");
  const ledgerState = requiredElement<HTMLElement>(root, "[data-ledger-state]");
  const ledgerRevision = requiredElement<HTMLElement>(root, "[data-ledger-revision]");
  const ledgerReadiness = requiredElement<HTMLElement>(root, "[data-ledger-readiness]");
  const ledgerWarnings = requiredElement<HTMLElement>(root, "[data-ledger-warnings]");
  const ledgerDetails = requiredElement<HTMLElement>(root, "#draft-ledger-details");
  const ledgerToggle = requiredElement<HTMLButtonElement>(root, '[data-action="toggle-ledger"]');

  const loadWorld = dependencies.loadWorld ?? loadWorldRequest;
  const saveWorldDraft = dependencies.saveWorldDraft ?? saveWorldDraftRequest;
  const setWorldCoverAsset = dependencies.setWorldCoverAsset ?? setWorldCoverAssetRequest;
  const copyUnsavedDraft = dependencies.copyUnsavedDraft ?? (async (serializedDraft: string) => {
    if (!pageView.navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable.");
    await pageView.navigator.clipboard.writeText(serializedDraft);
  });
  const downloadUnsavedDraft = dependencies.downloadUnsavedDraft ?? ((serializedDraft: string, filename: string) =>
    downloadDraft(document, serializedDraft, filename));
  const confirmReload = dependencies.confirmReload ?? (() => pageView.confirm(
    "Reload the authoritative draft? Your unsaved changes will be discarded."
  ));

  let state: WorldEditorState | null = null;
  let authoritativeStatus: WorldAggregate["status"] | null = null;
  let currentCoverUrl = "";
  let activeSection: EditorSection = "overview";
  let activeCollection: DraftCollectionName = "playableCharacters";
  let coverChoice: CoverChoice = "keep";
  let coverAssetId = "";
  let coverChanged = false;
  let disposed = false;
  let loadController: AbortController | null = null;
  let saveController: AbortController | null = null;
  let unloadInstalled = false;
  const selectedIndexes = new Map<DraftCollectionName, number>();
  const searches = new Map<DraftCollectionName, string>();

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

  function overviewFields(): Array<HTMLInputElement | HTMLTextAreaElement> {
    return fieldDefinitions.flatMap((field) => {
      const control = form.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="world.${field.name}"]`);
      return control ? [control] : [];
    });
  }

  function isReadOnly(): boolean {
    return authoritativeStatus === "archived" || state?.revision === null;
  }

  function renderFieldAvailability(): void {
    if (!state) return;
    const readOnly = authoritativeStatus === "archived";
    const disabled = state.revision === null || state.status === "saving";
    for (const field of overviewFields()) {
      field.disabled = disabled;
      field.readOnly = readOnly;
      field.setAttribute("aria-readonly", String(readOnly));
    }
    for (const control of sectionContent.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement>("input, textarea, button")) {
      if (control.dataset.sectionNavigation !== undefined) continue;
      control.disabled = disabled || readOnly;
      if (control instanceof pageView.HTMLInputElement || control instanceof pageView.HTMLTextAreaElement) {
        control.readOnly = readOnly;
        control.setAttribute("aria-readonly", String(readOnly));
      }
    }
  }

  function renderOverviewFields(): void {
    if (!state) return;
    for (const definition of fieldDefinitions) {
      const field = form.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="world.${definition.name}"]`);
      if (field) field.value = state.draft.world[definition.name];
    }
    renderFieldAvailability();
  }

  function renderLedger(): void {
    if (!state) return;
    const readiness = draftReadiness(state);
    const readyCount = readiness.sections.filter((section) => section.ready).length;
    ledgerState.textContent = `State ${state.status === "unsaved" || state.status === "error" ? "Unsaved" : state.status === "saving" ? "Saving" : "Saved"}`;
    ledgerRevision.textContent = state.revision === null ? "Revision Not created" : `Revision ${state.revision}`;
    ledgerReadiness.textContent = `Readiness ${readyCount === readiness.sections.length ? "Ready" : `${readyCount} of ${readiness.sections.length}`}`;
    ledgerWarnings.textContent = `Warnings ${readiness.warningCount}`;
    ledgerDetails.replaceChildren();
    for (const section of readiness.sections) {
      const row = document.createElement("p");
      row.textContent = `${section.section}: ${section.ready ? "ready" : "needs attention"}${section.issueCount ? ` · ${section.issueCount} issue${section.issueCount === 1 ? "" : "s"}` : ""}`;
      ledgerDetails.append(row);
    }
  }

  function renderStatus(): void {
    if (!state) return;
    if (authoritativeStatus === "archived") editorState.textContent = "Archived worlds are read-only.";
    else if (state.revision === null) editorState.textContent = "No editable draft is available.";
    else if (state.status === "saving") editorState.textContent = "Saving draft…";
    else if (state.status === "unsaved" || state.status === "error") editorState.textContent = "Unsaved changes";
    else editorState.textContent = "Draft saved";
    const canSaveDraft = state.status === "unsaved" ||
      (state.status === "error" && state.saveError?.kind !== "conflict");
    saveButton.disabled = isReadOnly() || state.status === "saving" || (!canSaveDraft && !coverChanged);
    setDirtyGuard(!isReadOnly() && (coverChanged || state.status === "unsaved" || state.status === "saving" || state.status === "error"));
    renderFieldAvailability();
    renderLedger();
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

  function renderPendingRemovals(host: HTMLElement, collection: DraftCollectionName): void {
    if (!state) return;
    const removals = state.pendingRemovals.filter((removal) => removal.collection === collection);
    const region = document.createElement("div");
    region.dataset.pendingRemovals = "";
    region.className = "pending-removals";
    for (const removal of removals) {
      const message = document.createElement("p");
      message.textContent = `${collectionItemSummary(COLLECTIONS[collection].kind, removal.value, removal.originalIndex)} removed.`;
      const undo = button("undo-removal", "Undo removal");
      undo.dataset.removalId = removal.id;
      message.append(" ", undo);
      region.append(message);
    }
    host.append(region);
  }

  function renderRecordDetail(host: HTMLElement, spec: CollectionSpec, index: number): void {
    if (!state) return;
    const record = state.draft[spec.collection][index];
    if (record === undefined) {
      const empty = document.createElement("p");
      empty.className = "collection-empty";
      empty.textContent = `No ${spec.label.toLowerCase()} yet. Add one to begin.`;
      host.append(empty);
      return;
    }
    const detail = document.createElement("div");
    detail.className = "collection-detail";
    detail.dataset.recordDetail = "";
    const heading = document.createElement("h3");
    heading.textContent = collectionItemSummary(spec.kind, record, index);
    detail.append(heading);

    if (spec.kind !== "asset") {
      const structured = structuredFieldsFor(spec.kind, record);
      const structuredForm = document.createElement("div");
      structuredForm.className = "structured-fields";
      for (const definition of STRUCTURED_FIELDS[spec.kind]) {
        const control = definition.kind === "input" ? document.createElement("input") : document.createElement("textarea");
        control.name = `structured.${definition.name}`;
        control.dataset.structuredField = definition.name;
        if (definition.shape) control.dataset.jsonShape = definition.shape;
        const value = structured[definition.name];
        control.value = definition.kind === "json" ? serializeAdvancedJson(value ?? (definition.shape === "array" ? [] : {})) : textValue(value);
        if (control instanceof pageView.HTMLTextAreaElement) control.rows = definition.kind === "json" ? 6 : 3;
        structuredForm.append(labelledControl(definition.label, control));
      }
      const fieldError = document.createElement("p");
      fieldError.dataset.structuredError = "";
      fieldError.className = "field-error";
      structuredForm.append(fieldError);
      detail.append(structuredForm);
    }

    const advanced = document.createElement("details");
    advanced.className = "advanced-json";
    advanced.dataset.advancedDisclosure = "";
    const summary = document.createElement("summary");
    summary.textContent = "Advanced JSON";
    const json = document.createElement("textarea");
    json.dataset.advancedJson = "";
    json.rows = 12;
    json.value = serializeAdvancedJson(record);
    json.setAttribute("aria-label", `Advanced JSON for selected ${spec.singular}`);
    const error = document.createElement("p");
    error.className = "field-error";
    error.dataset.jsonError = "";
    advanced.append(summary, json, button("apply-advanced-json", "Apply JSON"), error);
    detail.append(advanced, button("remove-item", `Remove ${spec.singular}`));
    host.append(detail);
  }

  function renderDefaultsEditor(host: HTMLElement): void {
    if (!state) return;
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
    error.dataset.defaultsError = "";
    error.className = "field-error";
    details.append(summary, textarea, button("apply-defaults-json", "Apply defaults JSON"), error);
    host.append(details);
  }

  function renderCollectionJson(host: HTMLElement, collection: DraftCollectionName): void {
    if (!state || collection !== "assets") return;
    const details = document.createElement("details");
    details.className = "advanced-json collection-json";
    const summary = document.createElement("summary");
    summary.textContent = "Assets JSON";
    const textarea = document.createElement("textarea");
    textarea.dataset.collectionJson = "";
    textarea.rows = 10;
    textarea.value = serializeAdvancedJson(state.draft.assets);
    textarea.setAttribute("aria-label", "Assets JSON");
    const error = document.createElement("p");
    error.dataset.collectionJsonError = "";
    error.className = "field-error";
    details.append(summary, textarea, button("apply-collection-json", "Apply assets JSON"), error);
    host.append(details);
  }

  function renderCoverEditor(host: HTMLElement): void {
    const region = document.createElement("section");
    region.className = "cover-editor";
    region.setAttribute("aria-labelledby", "cover-editor-heading");
    const heading = document.createElement("h3");
    heading.id = "cover-editor-heading";
    heading.textContent = "World cover";
    const artwork = document.createElement("div");
    artwork.className = "cover-artwork";
    if (currentCoverUrl) {
      const image = document.createElement("img");
      image.dataset.coverArt = "";
      image.src = currentCoverUrl;
      image.alt = "Current world cover";
      artwork.append(image);
    } else {
      const empty = document.createElement("p");
      empty.textContent = "No cover artwork selected.";
      artwork.append(empty);
    }
    const choices = document.createElement("fieldset");
    const legend = document.createElement("legend");
    legend.textContent = "Cover update";
    choices.append(legend);
    for (const [value, labelText] of [["keep", "Keep current cover"], ["remove", "Remove cover"], ["select", "Use a retained asset id"]] as const) {
      const label = document.createElement("label");
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "coverChoice";
      radio.value = value;
      radio.checked = coverChoice === value;
      label.append(radio, ` ${labelText}`);
      choices.append(label);
    }
    const assetInput = document.createElement("input");
    assetInput.type = "text";
    assetInput.name = "coverAssetId";
    assetInput.value = coverAssetId;
    assetInput.placeholder = "Authorized retained asset id";
    assetInput.setAttribute("aria-label", "Retained cover asset id");
    const error = document.createElement("p");
    error.dataset.coverError = "";
    error.className = "field-error";
    region.append(heading, artwork, choices, assetInput, error);
    host.append(region);
  }

  function renderCollectionEditor(): void {
    if (!state || activeSection === "overview") return;
    const validCollections = SECTION_COLLECTIONS[activeSection];
    if (!validCollections.includes(activeCollection)) activeCollection = validCollections[0]!;
    const spec = COLLECTIONS[activeCollection];
    const items = state.draft[activeCollection];
    const selected = Math.min(selectedIndexes.get(activeCollection) ?? 0, Math.max(items.length - 1, 0));
    selectedIndexes.set(activeCollection, selected);
    const query = searches.get(activeCollection) ?? "";
    const matches = items.map((value, index) => ({ value, index, summary: collectionItemSummary(spec.kind, value, index) }))
      .filter((item) => item.summary.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
    const visible = matches.slice(0, 100);

    sectionContent.replaceChildren();
    if (activeSection === "assets") renderCoverEditor(sectionContent);
    const editor = document.createElement("div");
    editor.className = "collection-editor";
    editor.dataset.collectionEditor = "";
    editor.dataset.activeCollection = activeCollection;
    const toolbar = document.createElement("div");
    toolbar.className = "collection-toolbar";
    const name = document.createElement("h3");
    name.dataset.collectionName = "";
    name.textContent = spec.label;
    const switches = document.createElement("div");
    switches.className = "collection-switches";
    for (const collection of validCollections) {
      const switchButton = button("switch-collection", COLLECTIONS[collection].label);
      switchButton.dataset.collectionTarget = collection;
      switchButton.setAttribute("aria-pressed", String(collection === activeCollection));
      switches.append(switchButton);
    }
    toolbar.append(name, switches, button("add-item", `Add ${spec.singular}`));

    const master = document.createElement("div");
    master.className = "collection-master";
    const search = document.createElement("input");
    search.type = "search";
    search.dataset.collectionSearch = "";
    search.value = query;
    search.placeholder = `Search ${spec.label.toLowerCase()}`;
    search.setAttribute("aria-label", `Search ${spec.label.toLowerCase()}`);
    const count = document.createElement("p");
    count.dataset.resultCount = "";
    count.textContent = `${visible.length} of ${items.length} items shown${matches.length !== items.length ? ` · ${matches.length} match` : ""}`;
    const list = document.createElement("ol");
    list.dataset.collectionList = "";
    for (const item of visible) {
      const row = document.createElement("li");
      row.dataset.collectionRow = "";
      const select = button("select-item", item.summary);
      select.dataset.itemIndex = String(item.index);
      select.setAttribute("aria-current", String(item.index === selected));
      row.append(select);
      list.append(row);
    }
    master.append(search, count, list);

    const detailHost = document.createElement("div");
    detailHost.className = "collection-detail-host";
    renderRecordDetail(detailHost, spec, selected);
    renderPendingRemovals(detailHost, activeCollection);
    editor.append(toolbar, master, detailHost);
    sectionContent.append(editor);
    if (activeSection === "mechanics") renderDefaultsEditor(sectionContent);
    renderCollectionJson(sectionContent, activeCollection);
    renderFieldAvailability();
  }

  function renderSection(): void {
    for (const navigation of root.querySelectorAll<HTMLButtonElement>("[data-section-target]")) {
      if (navigation.dataset.sectionTarget === activeSection) navigation.setAttribute("aria-current", "page");
      else navigation.removeAttribute("aria-current");
    }
    overviewSection.hidden = activeSection !== "overview";
    collectionSection.hidden = activeSection === "overview";
    if (activeSection === "overview") {
      collectionSection.dataset.editorSection = "characters";
      return;
    }
    collectionSection.dataset.editorSection = activeSection;
    sectionHeading.textContent = SECTION_LABELS[activeSection];
    sectionDescription.textContent = activeSection === "characters"
      ? "Shape playable identities, narrative guidance, profiles, stats, and trackers."
      : activeSection === "canon"
        ? "Maintain the people, places, and relationships that define this world."
        : activeSection === "mechanics"
          ? "Set stats, trackers, triggers, and world defaults without mixing mechanics into narration."
          : "Manage retained world assets and update the cover independently from draft content.";
    activeCollection = SECTION_COLLECTIONS[activeSection][0]!;
    renderCollectionEditor();
  }

  function adoptWorld(world: WorldAggregate): void {
    authoritativeStatus = world.status;
    currentCoverUrl = world.imageUrl;
    coverChoice = "keep";
    coverAssetId = "";
    coverChanged = false;
    state = createWorldEditorState(world);
    main.setAttribute("aria-busy", "false");
    loadState.replaceChildren();
    if (world.draftRevision === null) {
      const blockedState = document.createElement("section");
      blockedState.dataset.noEditableDraft = "";
      const heading = document.createElement("h2");
      heading.textContent = "No editable draft is available";
      const guidance = document.createElement("p");
      guidance.textContent = "This world cannot be edited because Nexus has no draft revision to update.";
      blockedState.append(heading, guidance);
      loadState.append(blockedState);
    }
    conflictHost.replaceChildren();
    announcement.textContent = "";
    renderOverviewFields();
    renderSection();
    renderStatus();
  }

  function renderLoadError(error: unknown): void {
    main.setAttribute("aria-busy", "false");
    for (const field of overviewFields()) field.disabled = true;
    saveButton.disabled = true;
    loadState.replaceChildren();
    const heading = document.createElement("h2");
    const guidance = document.createElement("p");
    const notFound = error instanceof WorldEditorApiError && error.kind === "not_found";
    heading.textContent = notFound ? "World not found" : "The World Editor could not be loaded.";
    guidance.textContent = notFound
      ? "This world is unavailable or is not owned by the current account."
      : "Check that Nexus is running, then try again.";
    loadState.append(heading, guidance);
    editorState.textContent = heading.textContent;
    if (!notFound) {
      const retry = button("retry-load", "Try again");
      retry.addEventListener("click", () => void requestWorld(), { once: true });
      loadState.append(retry);
    }
  }

  async function requestWorld(): Promise<void> {
    loadController?.abort(new DOMException("World request replaced", "AbortError"));
    const controller = new AbortController();
    loadController = controller;
    main.setAttribute("aria-busy", "true");
    editorState.textContent = "Loading world editor…";
    loadState.replaceChildren();
    try {
      const world = await loadWorld(worldId, controller.signal);
      if (!disposed && loadController === controller && !controller.signal.aborted) adoptWorld(world);
    } catch (error) {
      if (!disposed && loadController === controller && !controller.signal.aborted) renderLoadError(error);
    }
  }

  function renderConflict(): void {
    conflictHost.replaceChildren();
    const region = document.createElement("section");
    region.className = "save-conflict";
    region.dataset.saveConflict = "";
    region.setAttribute("aria-labelledby", "save-conflict-title");
    const heading = document.createElement("h2");
    heading.id = "save-conflict-title";
    heading.tabIndex = -1;
    heading.textContent = "This draft changed elsewhere";
    const message = document.createElement("p");
    message.textContent = "Your fields are still here. Preserve a copy, or reload the authoritative draft before continuing.";
    const actions = document.createElement("div");
    actions.className = "save-conflict-actions";
    for (const [action, label] of [["copy-unsaved-draft", "Copy unsaved draft"], ["download-unsaved-draft", "Download unsaved draft"], ["reload-authoritative-draft", "Reload authoritative draft"]] as const) {
      actions.append(button(action, label));
    }
    region.append(heading, message, actions);
    conflictHost.append(region);
    heading.focus();
  }

  async function saveDraft(): Promise<void> {
    if (!state || isReadOnly() || state.status === "saving") return;
    if (state.status === "saved" && !coverChanged) return;
    if (coverChanged && coverChoice === "select" && !coverAssetId.trim()) {
      const coverError = sectionContent.querySelector<HTMLElement>("[data-cover-error]");
      if (coverError) coverError.textContent = "Enter an authorized retained asset id.";
      announcement.textContent = "Enter a retained asset id before saving the cover.";
      return;
    }
    const validation = validateWorldDraft(state);
    const firstError = validation.issues.find((issue) => issue.severity === "error");
    if (firstError) {
      form.querySelector<HTMLElement>(`[name="${firstError.path}"]`)?.focus();
      announcement.textContent = firstError.message;
      return;
    }
    const expectedRevision = state.revision;
    if (expectedRevision === null) return;
    const requestedCover = coverChanged ? (coverChoice === "remove" ? null : coverChoice === "select" ? coverAssetId.trim() : undefined) : undefined;
    state = beginDraftSave(state);
    announcement.textContent = "Saving draft…";
    renderStatus();
    saveController?.abort(new DOMException("Draft save replaced", "AbortError"));
    const controller = new AbortController();
    saveController = controller;
    try {
      const result = await saveWorldDraft(worldId, expectedRevision, state.draft, controller.signal);
      if (disposed || saveController !== controller || controller.signal.aborted) return;
      state = completeDraftSave(state, { revision: result.revision, content: result.content });
      conflictHost.replaceChildren();
      coverChanged = false;
      renderOverviewFields();
      renderSection();
      renderStatus();
      announcement.textContent = "Draft saved.";
      if (requestedCover !== undefined) {
        try {
          const cover = await setWorldCoverAsset(worldId, requestedCover, controller.signal);
          if (disposed || saveController !== controller || controller.signal.aborted) return;
          currentCoverUrl = cover.assetUrl;
          coverChoice = "keep";
          coverAssetId = "";
          if (activeSection === "assets") renderCollectionEditor();
          announcement.textContent = "Draft saved. Cover updated.";
        } catch {
          if (disposed || saveController !== controller || controller.signal.aborted) return;
          coverChanged = true;
          renderStatus();
          announcement.textContent = "Draft saved. The cover was not updated; choose an authorized retained asset and try again.";
        }
      }
    } catch (error) {
      if (disposed || saveController !== controller || controller.signal.aborted) return;
      const kind = error instanceof WorldEditorApiError ? error.kind : "request_failed";
      const message = error instanceof Error ? error.message : "The draft could not be saved.";
      state = failDraftSave(state, kind, message);
      renderStatus();
      if (kind === "conflict") {
        announcement.textContent = "Save conflict. Your unsaved draft has been preserved.";
        renderConflict();
      } else {
        announcement.textContent = "The draft could not be saved. Your changes are still here; try again.";
      }
    }
  }

  function updateSelectedStructuredField(target: HTMLInputElement | HTMLTextAreaElement): void {
    if (!state || activeSection === "overview") return;
    const spec = COLLECTIONS[activeCollection];
    if (spec.kind === "asset") return;
    const index = selectedIndexes.get(activeCollection) ?? 0;
    const original = state.draft[activeCollection][index];
    if (original === undefined) return;
    let value: unknown = target.value;
    if (target.dataset.jsonShape) {
      const parsed = parseAdvancedJson(target.value, target.dataset.jsonShape as AdvancedJsonShape);
      const error = sectionContent.querySelector<HTMLElement>("[data-structured-error]");
      if (error) error.textContent = parsed.error ?? "";
      if (parsed.error) return;
      value = parsed.value;
    }
    const merged = mergeStructuredFields(spec.kind, original, { [target.dataset.structuredField!]: value });
    state = updateCollectionItem(state, activeCollection, index, merged);
    const advanced = sectionContent.querySelector<HTMLTextAreaElement>("[data-advanced-json]");
    if (advanced) advanced.value = serializeAdvancedJson(merged);
    announcement.textContent = "";
    conflictHost.replaceChildren();
    renderStatus();
  }

  const onInput = (event: Event) => {
    if (!state || isReadOnly() || state.status === "saving") return;
    const target = event.target;
    if (!(target instanceof pageView.HTMLInputElement) && !(target instanceof pageView.HTMLTextAreaElement)) return;
    if (target.dataset.collectionSearch !== undefined) {
      searches.set(activeCollection, target.value);
      renderCollectionEditor();
      return;
    }
    if (target.name === "coverAssetId") {
      coverAssetId = target.value;
      if (coverChoice === "select") coverChanged = true;
      renderStatus();
      return;
    }
    if (target.dataset.structuredField) {
      updateSelectedStructuredField(target);
      return;
    }
    const match = /^world\.(.+)$/.exec(target.name);
    const field = match?.[1] as OverviewField | undefined;
    if (!field || !fieldDefinitions.some((definition) => definition.name === field)) return;
    state = editWorldDraft(state, ["world", field], target.value);
    announcement.textContent = "";
    conflictHost.replaceChildren();
    renderStatus();
  };

  const onChange = (event: Event) => {
    if (!state || isReadOnly() || state.status === "saving") return;
    const target = event.target;
    if (!(target instanceof pageView.HTMLInputElement) || target.name !== "coverChoice") return;
    coverChoice = target.value as CoverChoice;
    coverChanged = coverChoice !== "keep";
    renderStatus();
  };

  const onClick = (event: Event) => {
    const target = event.target;
    if (!(target instanceof pageView.Element)) return;
    const sectionButton = target.closest<HTMLButtonElement>("button[data-section-target]");
    if (sectionButton?.dataset.sectionTarget) {
      activeSection = sectionButton.dataset.sectionTarget as EditorSection;
      renderSection();
      return;
    }
    const actionButton = target.closest<HTMLButtonElement>("button[data-action]");
    const action = actionButton?.dataset.action;
    if (action === "save-draft") void saveDraft();
    if (action === "toggle-ledger") {
      const expanded = ledgerToggle.getAttribute("aria-expanded") === "true";
      ledgerToggle.setAttribute("aria-expanded", String(!expanded));
      ledgerDetails.hidden = expanded;
    }
    if (!state) return;
    if (action === "switch-collection" && actionButton?.dataset.collectionTarget) {
      activeCollection = actionButton.dataset.collectionTarget as DraftCollectionName;
      renderCollectionEditor();
    }
    if (action === "select-item" && actionButton?.dataset.itemIndex) {
      selectedIndexes.set(activeCollection, Number(actionButton.dataset.itemIndex));
      renderCollectionEditor();
    }
    if (action === "add-item" && !isReadOnly()) {
      state = addCollectionItem(state, activeCollection, {});
      selectedIndexes.set(activeCollection, state.draft[activeCollection].length - 1);
      announcement.textContent = "";
      renderCollectionEditor();
      renderStatus();
    }
    if (action === "remove-item" && !isReadOnly()) {
      const index = selectedIndexes.get(activeCollection) ?? 0;
      state = removeCollectionItem(state, activeCollection, index);
      selectedIndexes.set(activeCollection, Math.min(index, Math.max(state.draft[activeCollection].length - 1, 0)));
      renderCollectionEditor();
      renderStatus();
    }
    if (action === "undo-removal" && actionButton?.dataset.removalId && !isReadOnly()) {
      state = restoreCollectionItem(state, actionButton.dataset.removalId);
      renderCollectionEditor();
      renderStatus();
    }
    if (action === "apply-advanced-json" && !isReadOnly()) {
      const textarea = sectionContent.querySelector<HTMLTextAreaElement>("[data-advanced-json]");
      const error = sectionContent.querySelector<HTMLElement>("[data-json-error]");
      if (textarea) {
        const parsed = parseAdvancedJson(textarea.value, "object");
        if (error) error.textContent = parsed.error ?? "";
        if (!parsed.error) {
          const index = selectedIndexes.get(activeCollection) ?? 0;
          state = updateCollectionItem(state, activeCollection, index, parsed.value);
          renderCollectionEditor();
          renderStatus();
        }
      }
    }
    if (action === "apply-defaults-json" && !isReadOnly()) {
      const textarea = sectionContent.querySelector<HTMLTextAreaElement>("[data-defaults-json]");
      const error = sectionContent.querySelector<HTMLElement>("[data-defaults-error]");
      if (textarea) {
        const parsed = parseAdvancedJson(textarea.value, "object");
        if (error) error.textContent = parsed.error ?? "";
        if (!parsed.error) {
          state = editWorldDraft(state, ["defaults"], parsed.value);
          renderStatus();
        }
      }
    }
    if (action === "apply-collection-json" && !isReadOnly()) {
      const textarea = sectionContent.querySelector<HTMLTextAreaElement>("[data-collection-json]");
      const error = sectionContent.querySelector<HTMLElement>("[data-collection-json-error]");
      if (textarea) {
        const parsed = parseAdvancedJson(textarea.value, "array");
        if (error) error.textContent = parsed.error ?? "";
        if (!parsed.error) {
          state = editWorldDraft(state, [activeCollection], parsed.value);
          selectedIndexes.set(activeCollection, 0);
          renderCollectionEditor();
          renderStatus();
        }
      }
    }
    const serialized = serializeDraft(state.draft);
    if (action === "copy-unsaved-draft") {
      void copyUnsavedDraft(serialized).then(
        () => { announcement.textContent = "Unsaved draft copied."; },
        () => { announcement.textContent = "The unsaved draft could not be copied. Download it instead."; }
      );
    }
    if (action === "download-unsaved-draft") {
      downloadUnsavedDraft(serialized, `${worldId}-unsaved-draft.json`);
      announcement.textContent = "Unsaved draft downloaded.";
    }
    if (action === "reload-authoritative-draft" && confirmReload()) void requestWorld();
  };

  root.addEventListener("input", onInput);
  root.addEventListener("change", onChange);
  root.addEventListener("click", onClick);
  void requestWorld();

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      loadController?.abort(new DOMException("World Editor closed", "AbortError"));
      saveController?.abort(new DOMException("World Editor closed", "AbortError"));
      setDirtyGuard(false);
      root.removeEventListener("input", onInput);
      root.removeEventListener("change", onChange);
      root.removeEventListener("click", onClick);
      theme.dispose();
    }
  };
}
