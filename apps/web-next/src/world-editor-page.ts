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
import {
  mergeRootDraftExtras,
  mergeWorldExtras,
  rootDraftExtras,
  worldExtras
} from "./world-editor-extras";
import type { EditableWorldDraft, WorldAggregate } from "./world-editor-model";
import {
  characterWorkspacePath,
  createCharacterWorkspaceSessionStore,
  type CharacterWorkspaceSession,
  type CharacterWorkspaceSessionStore
} from "./character-workspace-session.js";
import {
  applyWorldEditorCharacterResult,
  beginWorldEditorCharacterSession
} from "./world-editor-character-workspace.js";
import {
  addCollectionItem,
  beginDraftSave,
  completeDraftSave,
  createWorldEditorState,
  draftReadiness,
  editWorldDraft,
  failDraftSave,
  removeCollectionItem,
  replaceWorldDraft,
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
  creationStatusSearch?: string;
  navigate?: (path: string) => void;
  characterSessionStore?: CharacterWorkspaceSessionStore;
  characterWorkflowIdFactory?: () => string;
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

interface PendingStructuredValidation {
  collection: DraftCollectionName;
  itemId: string;
  field: string;
  value: string;
  message: string;
}

interface PendingJsonInput {
  key: string;
  raw: string;
  shape: AdvancedJsonShape;
  error: string | null;
  section: EditorSection;
  collection?: DraftCollectionName;
  itemId?: string;
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
    { name: "characterText", label: "Narrative guidance", kind: "textarea" },
    { name: "profile", label: "Profile groups", kind: "json", shape: "object" },
    { name: "rpgStats", label: "Stats", kind: "json", shape: "array" },
    { name: "defaultTriggers", label: "Default trackers", kind: "json", shape: "array" }
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
    const errorId = `${id}-error`;
    const associatedControl = control.replace(" disabled", ` aria-describedby="${errorId}" disabled`);
    return `<label class="editor-field editor-field-${field.name}" for="${id}"><span>${field.label}</span>${associatedControl}<small id="${errorId}" class="field-error" data-overview-error="${field.name}"></small></label>`;
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
        <div class="editor-readonly-context" aria-label="Published world context">
          <p data-version-context></p>
          <p data-campaign-context></p>
        </div>
      </div>
    </section>
    <div class="editor-workspace">
      <nav class="editor-section-index" data-section-index aria-label="World editor sections">${sectionIndexMarkup()}</nav>
      <div class="editor-canvas">
        <section id="overview" class="overview-editor" data-editor-section="overview" aria-labelledby="overview-heading">
          <header><h2 id="overview-heading">Overview</h2><p>Set the world’s identity and the opening frame the Story Engine can build from.</p></header>
          <div class="editor-load-state" data-load-state></div>
          <form class="overview-form" novalidate>${overviewFieldsMarkup()}</form>
          <div class="overview-extras">
            <details class="advanced-json">
              <summary>Unknown world properties</summary>
              <textarea rows="10" data-world-extras-json data-json-editor-key="world-extras" data-json-shape="object" aria-label="Unknown world properties JSON" aria-describedby="world-extras-json-error"></textarea>
              <div class="advanced-json-actions">
                <button type="button" data-action="apply-world-extras-json" data-json-editor-key="world-extras">Apply JSON</button>
                <button type="button" data-action="discard-json" data-json-editor-key="world-extras">Discard changes</button>
              </div>
              <p id="world-extras-json-error" class="field-error" data-json-error="world-extras"></p>
            </details>
            <details class="advanced-json">
              <summary>Unknown root draft properties</summary>
              <textarea rows="10" data-root-extras-json data-json-editor-key="root-extras" data-json-shape="object" aria-label="Unknown root draft properties JSON" aria-describedby="root-extras-json-error"></textarea>
              <div class="advanced-json-actions">
                <button type="button" data-action="apply-root-extras-json" data-json-editor-key="root-extras">Apply JSON</button>
                <button type="button" data-action="discard-json" data-json-editor-key="root-extras">Discard changes</button>
              </div>
              <p id="root-extras-json-error" class="field-error" data-json-error="root-extras"></p>
            </details>
          </div>
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
        <span data-editor-state data-ledger-state aria-live="polite">Loading world editor…</span><span data-ledger-revision>Revision —</span>
        <span data-ledger-readiness>Readiness —</span><span data-ledger-warnings>Warnings —</span>
        <button type="button" data-action="toggle-ledger" aria-expanded="false" aria-controls="draft-ledger-details">Draft details</button>
        <div class="editor-save-cell"><button type="button" data-action="save-draft" disabled>Save draft</button></div>
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

function creationHandoffMessage(search: string): string {
  const parameters = new URLSearchParams(search);
  if (parameters.get("creation") !== "created") return "";
  const cover = parameters.get("cover");
  if (cover === "none") return "World created. You can continue editing its draft.";
  if (cover === "pending") return "World created. Cover generation is continuing in the background.";
  if (cover === "completed") return "World created. Its cover is ready.";
  if (cover === "recovery") return "World created. Its cover still needs attention; retry it from Assets.";
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
  const editorTitle = requiredElement<HTMLElement>(root, "#editor-title");
  const versionContext = requiredElement<HTMLElement>(root, "[data-version-context]");
  const campaignContext = requiredElement<HTMLElement>(root, "[data-campaign-context]");
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
  const creationMessage = creationHandoffMessage(
    dependencies.creationStatusSearch ?? pageView.location?.search ?? ""
  );

  let state: WorldEditorState | null = null;
  let authoritativeStatus: WorldAggregate["status"] | null = null;
  let currentCoverUrl = "";
  let activeSection: EditorSection = "overview";
  let activeCollection: DraftCollectionName = "playableCharacters";
  let coverChoice: CoverChoice = "keep";
  let coverAssetId = "";
  let coverChanged = false;
  let coverRetryOnly = false;
  let coverSaving = false;
  let disposed = false;
  let loadController: AbortController | null = null;
  let saveController: AbortController | null = null;
  let unloadInstalled = false;
  let activeCharacterHandoff: Pick<CharacterWorkspaceSession, "key" | "workflowId"> | null = null;
  let characterHandoffError: string | null = null;
  let characterHandoffResultInvalid = false;
  const selectedIndexes = new Map<DraftCollectionName, number>();
  const searches = new Map<DraftCollectionName, string>();
  const itemIdentities = new Map<DraftCollectionName, string[]>();
  const removedItemIdentities = new Map<string, string>();
  const pendingStructuredValidations = new Map<string, PendingStructuredValidation>();
  const pendingJsonInputs = new Map<string, PendingJsonInput>();
  let nextItemIdentity = 1;

  function createItemIdentity(): string {
    const identity = `editor-item-${nextItemIdentity}`;
    nextItemIdentity += 1;
    return identity;
  }

  function itemIdentity(collection: DraftCollectionName, index: number): string | undefined {
    return itemIdentities.get(collection)?.[index];
  }

  function resetItemIdentities(draft: EditableWorldDraft): void {
    removedItemIdentities.clear();
    itemIdentities.clear();
    for (const collection of Object.keys(COLLECTIONS) as DraftCollectionName[]) {
      itemIdentities.set(collection, draft[collection].map(() => createItemIdentity()));
    }
  }

  function structuredValidationKey(collection: DraftCollectionName, itemId: string, field: string): string {
    return `${collection}:${itemId}:${field}`;
  }

  function clearPendingStructuredValidations(collection: DraftCollectionName, itemId?: string): void {
    for (const [key, pending] of pendingStructuredValidations) {
      if (pending.collection === collection && (itemId === undefined || pending.itemId === itemId)) {
        pendingStructuredValidations.delete(key);
      }
    }
  }

  function clearPendingJsonInputs(collection: DraftCollectionName, itemId?: string): void {
    for (const [key, pending] of pendingJsonInputs) {
      if (pending.collection === collection && (itemId === undefined || pending.itemId === itemId)) {
        pendingJsonInputs.delete(key);
      }
    }
  }

  function firstPendingStructuredValidation(
    collection?: DraftCollectionName,
    itemId?: string
  ): PendingStructuredValidation | undefined {
    for (const [key, pending] of pendingStructuredValidations) {
      const remainsPresent = itemIdentities.get(pending.collection)?.includes(pending.itemId) ?? false;
      if (!remainsPresent) {
        pendingStructuredValidations.delete(key);
        continue;
      }
      if ((collection === undefined || pending.collection === collection) &&
        (itemId === undefined || pending.itemId === itemId)) return pending;
    }
    return undefined;
  }

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

  function jsonControl(key: string): HTMLTextAreaElement | null {
    return [...root.querySelectorAll<HTMLTextAreaElement>("textarea[data-json-editor-key]")]
      .find((control) => control.dataset.jsonEditorKey === key) ?? null;
  }

  function jsonError(key: string): HTMLElement | null {
    return [...root.querySelectorAll<HTMLElement>("[data-json-error]")]
      .find((error) => error.dataset.jsonError === key) ?? null;
  }

  function configureJsonEditor(
    textarea: HTMLTextAreaElement,
    error: HTMLElement,
    key: string,
    shape: AdvancedJsonShape,
    canonicalValue: unknown,
    location: Omit<PendingJsonInput, "key" | "raw" | "shape" | "error">
  ): void {
    const pending = pendingJsonInputs.get(key);
    textarea.dataset.jsonEditorKey = key;
    textarea.dataset.jsonShape = shape;
    textarea.dataset.jsonSection = location.section;
    if (location.collection) textarea.dataset.jsonCollection = location.collection;
    else delete textarea.dataset.jsonCollection;
    if (location.itemId) textarea.dataset.jsonItemId = location.itemId;
    else delete textarea.dataset.jsonItemId;
    textarea.value = pending?.raw ?? serializeAdvancedJson(canonicalValue);
    if (!error.id) error.id = `${key.replace(/[^a-z0-9-]/gi, "-")}-json-error`;
    error.dataset.jsonError = key;
    textarea.setAttribute("aria-describedby", error.id);
    if (pending) {
      error.textContent = pending.error ?? "Apply or discard JSON changes before saving.";
      if (pending.error) textarea.setAttribute("aria-invalid", "true");
      else textarea.removeAttribute("aria-invalid");
      Object.assign(pending, location);
    } else {
      error.textContent = "";
      textarea.removeAttribute("aria-invalid");
    }
  }

  function renderWorldContext(world: WorldAggregate): void {
    editorTitle.textContent = world.title;
    const latestVersion = world.versions.reduce((latest, version) =>
      latest === null || version.versionNumber > latest.versionNumber ? version : latest, null as WorldAggregate["versions"][number] | null);
    const activeCampaigns = world.campaigns.filter((campaign) => campaign.status === "active");
    const latestCampaign = world.campaigns.reduce((latest, campaign) =>
      latest === null || campaign.updatedAt > latest.updatedAt ? campaign : latest, null as WorldAggregate["campaigns"][number] | null);
    const latestTurn = world.campaigns.reduce((turn, campaign) => Math.max(turn, campaign.activeTurnNumber), 0);
    const versionLink = document.createElement("a");
    versionLink.href = "/nexus/#world-library";
    versionLink.textContent = "Manage published versions";
    versionContext.replaceChildren(
      `${world.versions.length} published version${world.versions.length === 1 ? "" : "s"}${latestVersion ? ` · Latest v${latestVersion.versionNumber}` : ""} · `,
      versionLink
    );
    const campaignLink = document.createElement("a");
    campaignLink.href = "/nexus/#campaigns";
    campaignLink.textContent = "Manage campaigns";
    campaignContext.replaceChildren(
      `${activeCampaigns.length} active campaign${activeCampaigns.length === 1 ? "" : "s"}${world.campaigns.length !== activeCampaigns.length ? ` · ${world.campaigns.length} total` : ""}${world.campaigns.length ? ` · Turn ${latestTurn}` : ""}${latestCampaign ? ` · Latest ${latestCampaign.title}` : ""} · `,
      campaignLink
    );
  }

  function renderOverviewValidation(): void {
    if (!state) return;
    const issues = validateWorldDraft(state).issues.filter((issue) => issue.severity === "error");
    for (const definition of fieldDefinitions) {
      const control = form.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="world.${definition.name}"]`);
      const error = form.querySelector<HTMLElement>(`[data-overview-error="${definition.name}"]`);
      const issue = issues.find((candidate) => candidate.path === `world.${definition.name}`);
      if (!control || !error) continue;
      error.textContent = issue?.message ?? "";
      if (issue) control.setAttribute("aria-invalid", "true");
      else control.removeAttribute("aria-invalid");
    }
  }

  function renderOverviewExtras(): void {
    if (!state) return;
    const worldTextarea = requiredElement<HTMLTextAreaElement>(root, "[data-world-extras-json]");
    const worldError = requiredElement<HTMLElement>(root, '[data-json-error="world-extras"]');
    configureJsonEditor(worldTextarea, worldError, "world-extras", "object", worldExtras(state.draft), { section: "overview" });
    const rootTextarea = requiredElement<HTMLTextAreaElement>(root, "[data-root-extras-json]");
    const rootError = requiredElement<HTMLElement>(root, '[data-json-error="root-extras"]');
    configureJsonEditor(rootTextarea, rootError, "root-extras", "object", rootDraftExtras(state.draft), { section: "overview" });
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
    for (const control of root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement>(
      ".overview-extras input, .overview-extras textarea, .overview-extras button, [data-section-content] input, [data-section-content] textarea, [data-section-content] button"
    )) {
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
    renderOverviewValidation();
    renderOverviewExtras();
    renderFieldAvailability();
  }

  function renderLedger(): void {
    if (!state) return;
    const readiness = draftReadiness(state);
    const readyCount = readiness.sections.filter((section) => section.ready).length;
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
    const hasInvalidInput = validateWorldDraft(state).issues.some((issue) => issue.severity === "error") ||
      pendingStructuredValidations.size > 0 || [...pendingJsonInputs.values()].some((input) => input.error);
    const hasConflict = state.status === "error" && state.saveError?.kind === "conflict";
    if (authoritativeStatus === "archived") editorState.textContent = "Archived worlds are read-only.";
    else if (state.revision === null) editorState.textContent = "No editable draft is available.";
    else if (state.status === "saving") editorState.textContent = "Saving draft…";
    else if (hasConflict) editorState.textContent = "Conflict — local draft preserved";
    else if (hasInvalidInput) editorState.textContent = "Invalid input — review highlighted fields";
    else if (pendingJsonInputs.size > 0) editorState.textContent = "Unsaved JSON changes";
    else if (coverSaving) editorState.textContent = "Draft saved · Updating cover…";
    else if (coverChanged && state.status === "saved") editorState.textContent = "Draft saved · Cover update pending";
    else if (state.status === "unsaved" || state.status === "error") editorState.textContent = "Unsaved changes";
    else editorState.textContent = "Draft saved";
    const canSaveDraft = state.status === "unsaved" || pendingStructuredValidations.size > 0 || pendingJsonInputs.size > 0 ||
      (state.status === "error" && state.saveError?.kind !== "conflict");
    saveButton.textContent = coverChanged && state.status === "saved" ? "Retry cover" : "Save draft";
    saveButton.disabled = isReadOnly() || state.status === "saving" || coverSaving || hasConflict || (!canSaveDraft && !coverChanged);
    setDirtyGuard(!isReadOnly() && (
      pendingStructuredValidations.size > 0 || pendingJsonInputs.size > 0 || coverChanged || state.status === "unsaved" ||
      state.status === "saving" || state.status === "error"
    ));
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

  function renderCharacterHandoffRecovery(host: HTMLElement): void {
    if (!activeCharacterHandoff || !characterHandoffError) return;
    const recovery = document.createElement("div");
    recovery.dataset.characterHandoffError = "";
    recovery.setAttribute("role", "alert");
    const message = document.createElement("p");
    message.textContent = characterHandoffError;
    const retry = button("retry-character-result", "Retry result");
    const returnLink = document.createElement("a");
    returnLink.href = characterWorkspacePath(activeCharacterHandoff.key);
    returnLink.textContent = "Return to character workspace";
    recovery.append(message, retry, returnLink);
    host.append(recovery);
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
        const currentItemId = itemIdentity(spec.collection, index);
        const pending = currentItemId
          ? pendingStructuredValidations.get(structuredValidationKey(spec.collection, currentItemId, definition.name))
          : undefined;
        control.value = pending?.value ?? (
          definition.kind === "json" ? serializeAdvancedJson(value ?? (definition.shape === "array" ? [] : {})) : textValue(value)
        );
        if (pending) control.setAttribute("aria-invalid", "true");
        if (control instanceof pageView.HTMLTextAreaElement) control.rows = definition.kind === "json" ? 6 : 3;
        const fieldError = document.createElement("p");
        fieldError.id = `structured-${spec.collection}-${currentItemId ?? index}-${definition.name}-error`;
        fieldError.dataset.structuredError = definition.name;
        fieldError.className = "field-error";
        fieldError.textContent = pending?.message ?? "";
        control.setAttribute("aria-describedby", fieldError.id);
        structuredForm.append(labelledControl(definition.label, control), fieldError);
      }
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
    json.setAttribute("aria-label", `Advanced JSON for selected ${spec.singular}`);
    const error = document.createElement("p");
    error.className = "field-error";
    const currentItemId = itemIdentity(spec.collection, index);
    const jsonKey = `record:${spec.collection}:${currentItemId ?? index}`;
    configureJsonEditor(json, error, jsonKey, "object", record, {
      section: activeSection,
      collection: spec.collection,
      itemId: currentItemId
    });
    const apply = button("apply-advanced-json", "Apply JSON");
    apply.dataset.jsonEditorKey = jsonKey;
    const discard = button("discard-advanced-json", "Discard changes");
    discard.dataset.jsonEditorKey = jsonKey;
    advanced.append(summary, json, apply, discard, error);
    detail.append(advanced);
    if (spec.collection === "playableCharacters") {
      const editCharacter = button("edit-character", "Edit in character workspace");
      editCharacter.dataset.characterId = textValue((record as { id?: unknown }).id);
      detail.append(editCharacter);
    }
    detail.append(button("remove-item", `Remove ${spec.singular}`));
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
    textarea.setAttribute("aria-label", "World defaults JSON");
    const error = document.createElement("p");
    error.dataset.defaultsError = "";
    error.className = "field-error";
    configureJsonEditor(textarea, error, "defaults", "object", state.draft.defaults, { section: "mechanics" });
    const apply = button("apply-defaults-json", "Apply defaults JSON");
    apply.dataset.jsonEditorKey = "defaults";
    const discard = button("discard-json", "Discard changes");
    discard.dataset.jsonEditorKey = "defaults";
    details.append(summary, textarea, apply, discard, error);
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
    textarea.setAttribute("aria-label", "Assets JSON");
    const error = document.createElement("p");
    error.dataset.collectionJsonError = "";
    error.className = "field-error";
    configureJsonEditor(textarea, error, "collection:assets", "array", state.draft.assets, {
      section: "assets",
      collection: "assets"
    });
    const apply = button("apply-collection-json", "Apply assets JSON");
    apply.dataset.jsonEditorKey = "collection:assets";
    const discard = button("discard-json", "Discard changes");
    discard.dataset.jsonEditorKey = "collection:assets";
    details.append(summary, textarea, apply, discard, error);
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
    assetInput.setAttribute("aria-describedby", "cover-asset-id-error");
    const error = document.createElement("p");
    error.id = "cover-asset-id-error";
    error.dataset.coverError = "";
    error.className = "field-error";
    region.append(heading, artwork, choices, assetInput, error);
    host.append(region);
  }

  function renderCollectionResults(
    count: HTMLElement,
    list: HTMLOListElement,
    spec: CollectionSpec,
    items: unknown[],
    selected: number,
    query: string
  ): void {
    const matches = items.map((value, index) => ({
      index,
      summary: collectionItemSummary(spec.kind, value, index)
    })).filter((item) => item.summary.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
    const visible = matches.slice(0, 100);
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

  function renderCollectionEditor(): void {
    if (!state || activeSection === "overview") return;
    const validCollections = SECTION_COLLECTIONS[activeSection];
    if (!validCollections.includes(activeCollection)) activeCollection = validCollections[0]!;
    const spec = COLLECTIONS[activeCollection];
    const items = state.draft[activeCollection];
    const selected = Math.min(selectedIndexes.get(activeCollection) ?? 0, Math.max(items.length - 1, 0));
    selectedIndexes.set(activeCollection, selected);
    const query = searches.get(activeCollection) ?? "";

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
    const list = document.createElement("ol");
    list.dataset.collectionList = "";
    renderCollectionResults(count, list, spec, items, selected, query);
    master.append(search, count, list);

    const detailHost = document.createElement("div");
    detailHost.className = "collection-detail-host";
    if (activeCollection === "playableCharacters") renderCharacterHandoffRecovery(detailHost);
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
    coverRetryOnly = false;
    state = createWorldEditorState(world);
    renderWorldContext(world);
    pendingStructuredValidations.clear();
    pendingJsonInputs.clear();
    activeCharacterHandoff = null;
    characterHandoffError = null;
    characterHandoffResultInvalid = false;
    resetItemIdentities(state.draft);
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
    announcement.textContent = creationMessage;
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

  function requestedCoverIntent(): string | null | undefined {
    if (!coverChanged) return undefined;
    if (coverChoice === "remove") return null;
    if (coverChoice === "select") return coverAssetId.trim();
    return undefined;
  }

  async function updateCover(requestedCover: string | null, controller: AbortController): Promise<void> {
    coverSaving = true;
    renderStatus();
    try {
      const cover = await setWorldCoverAsset(worldId, requestedCover, controller.signal);
      if (disposed || saveController !== controller || controller.signal.aborted) return;
      currentCoverUrl = cover.assetUrl;
      coverChoice = "keep";
      coverAssetId = "";
      coverChanged = false;
      coverRetryOnly = false;
      announcement.textContent = "Draft saved. Cover updated.";
    } catch {
      if (disposed || saveController !== controller || controller.signal.aborted) return;
      coverChanged = true;
      coverRetryOnly = true;
      announcement.textContent = requestedCover === null
        ? "Draft saved. The cover was not removed; cover work remains pending. Try again."
        : "Draft saved. The cover was not attached; cover work remains pending. Check the authorized retained asset id and try again.";
    } finally {
      if (!disposed && saveController === controller) {
        coverSaving = false;
        if (activeSection === "assets") renderCollectionEditor();
        renderStatus();
      }
    }
  }

  function focusPendingJsonInput(pending: PendingJsonInput): void {
    const selectedItemId = pending.collection
      ? itemIdentity(pending.collection, selectedIndexes.get(pending.collection) ?? 0)
      : undefined;
    const alreadyRendered = activeSection === pending.section &&
      (!pending.collection || (activeCollection === pending.collection && (!pending.itemId || selectedItemId === pending.itemId)));
    if (!alreadyRendered) {
      activeSection = pending.section;
      renderSection();
      if (pending.collection) {
        activeCollection = pending.collection;
        if (pending.itemId) {
          const index = itemIdentities.get(pending.collection)?.indexOf(pending.itemId) ?? -1;
          if (index >= 0) selectedIndexes.set(pending.collection, index);
        }
        renderCollectionEditor();
      }
    }
    const control = jsonControl(pending.key);
    const error = jsonError(pending.key);
    control?.closest("details")?.setAttribute("open", "");
    if (error && !pending.error) error.textContent = "Apply or discard JSON changes before saving.";
    control?.focus();
    announcement.textContent = pending.error ?? "Apply or discard JSON changes before saving.";
  }

  async function saveDraft(): Promise<void> {
    if (!state || isReadOnly() || state.status === "saving" || coverSaving) return;
    renderOverviewValidation();
    const firstError = validateWorldDraft(state).issues.find((issue) => issue.severity === "error");
    if (firstError) {
      form.querySelector<HTMLElement>(`[name="${firstError.path}"]`)?.focus();
      announcement.textContent = firstError.message;
      renderStatus();
      return;
    }
    const pendingJson = pendingJsonInputs.values().next().value as PendingJsonInput | undefined;
    if (pendingJson) {
      focusPendingJsonInput(pendingJson);
      return;
    }
    const pendingStructuredValidation = firstPendingStructuredValidation();
    if (pendingStructuredValidation) {
      const section = (Object.entries(SECTION_COLLECTIONS) as Array<[
        Exclude<EditorSection, "overview">,
        DraftCollectionName[]
      ]>).find(([, collections]) => collections.includes(pendingStructuredValidation.collection))?.[0];
      if (section) {
        activeSection = section;
        renderSection();
        activeCollection = pendingStructuredValidation.collection;
        const pendingIndex = itemIdentities.get(activeCollection)?.indexOf(pendingStructuredValidation.itemId) ?? -1;
        if (pendingIndex < 0) return;
        selectedIndexes.set(activeCollection, pendingIndex);
        renderCollectionEditor();
      }
      sectionContent.querySelector<HTMLElement>(
        `[data-structured-field="${pendingStructuredValidation.field}"]`
      )?.focus();
      announcement.textContent = pendingStructuredValidation.message;
      return;
    }
    const coverValidationMessage = coverChanged && coverChoice === "select" && !coverAssetId.trim()
      ? "Enter an authorized retained asset id."
      : null;
    if (coverValidationMessage) {
      activeSection = "assets";
      renderSection();
      const coverError = sectionContent.querySelector<HTMLElement>("[data-cover-error]");
      const coverInput = sectionContent.querySelector<HTMLInputElement>('[name="coverAssetId"]');
      if (coverError) coverError.textContent = coverValidationMessage;
      coverInput?.setAttribute("aria-invalid", "true");
      coverInput?.focus();
      announcement.textContent = "Enter a retained asset id before saving the cover.";
      return;
    }
    const coverError = sectionContent.querySelector<HTMLElement>("[data-cover-error]");
    const coverInput = sectionContent.querySelector<HTMLInputElement>('[name="coverAssetId"]');
    if (coverError) coverError.textContent = "";
    coverInput?.removeAttribute("aria-invalid");
    const requestedCover = requestedCoverIntent();
    saveController?.abort(new DOMException("Draft save replaced", "AbortError"));
    const controller = new AbortController();
    saveController = controller;
    if (state.status === "saved" && requestedCover !== undefined && coverRetryOnly) {
      await updateCover(requestedCover, controller);
      return;
    }
    if (state.status === "saved" && requestedCover === undefined) return;
    const expectedRevision = state.revision;
    if (expectedRevision === null) return;
    state = beginDraftSave(state);
    announcement.textContent = "Saving draft…";
    renderStatus();
    try {
      const result = await saveWorldDraft(worldId, expectedRevision, state.draft, controller.signal);
      if (disposed || saveController !== controller || controller.signal.aborted) return;
      state = completeDraftSave(state, { revision: result.revision, content: result.content });
      resetItemIdentities(state.draft);
      conflictHost.replaceChildren();
      renderOverviewFields();
      renderSection();
      renderStatus();
      announcement.textContent = "Draft saved.";
      if (requestedCover !== undefined) await updateCover(requestedCover, controller);
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

  function beginCharacterHandoff(characterId?: string): void {
    if (!state || state.revision === null || isReadOnly()) return;
    if (!characterSessionStore) {
      announcement.textContent = "Character editing is unavailable in this browser session. Your world draft is unchanged.";
      return;
    }
    try {
      const session = beginWorldEditorCharacterSession({
        store: characterSessionStore,
        worldId,
        workflowId: characterWorkflowIdFactory(),
        revision: state.revision,
        draft: state.draft,
        ...(characterId ? { characterId } : {})
      });
      activeCharacterHandoff = { key: session.key, workflowId: session.workflowId };
      characterHandoffError = null;
      characterHandoffResultInvalid = false;
      navigate(characterWorkspacePath(session.key));
    } catch {
      announcement.textContent = "The character workspace could not be opened. Your world draft is unchanged; try again.";
    }
  }

  function resetInvalidCharacterHandoff(): void {
    if (!activeCharacterHandoff || !characterSessionStore) return;
    const destination = characterWorkspacePath(activeCharacterHandoff.key);
    const reset = characterSessionStore.resetInvalidResult(
      activeCharacterHandoff.key,
      "world-editor",
      activeCharacterHandoff.workflowId
    );
    if (!reset) {
      characterHandoffError = "The invalid character result could not be safely removed. Your draft and handoff are unchanged; try again.";
      renderCollectionEditor();
      return;
    }
    characterHandoffError = null;
    characterHandoffResultInvalid = false;
    navigate(destination);
  }

  function consumeCharacterHandoff(): void {
    if (!state || !activeCharacterHandoff || !characterSessionStore) return;
    const pending = characterSessionStore.peek(
      activeCharacterHandoff.key,
      "world-editor",
      activeCharacterHandoff.workflowId
    );
    if (!pending) return;
    activeSection = "characters";
    activeCollection = "playableCharacters";
    if (pending.status === "invalid") {
      characterHandoffResultInvalid = true;
      characterHandoffError = "The stored character result is invalid and could not be recovered. It was not applied or removed; return to the character workspace to review the handoff.";
      renderSection();
      renderStatus();
      return;
    }

    let nextDraft = state.draft;
    if (pending.result.status === "accepted") {
      try {
        nextDraft = applyWorldEditorCharacterResult({
          draft: state.draft,
          session: pending.session,
          result: pending.result
        });
      } catch {
        characterHandoffResultInvalid = false;
        characterHandoffError = pending.session.mode === "edit"
          ? "This character could not be updated because the roster changed. The result is preserved; retry it or return to the character workspace."
          : "This character could not be added because it is invalid, duplicated, or the roster is full. The result is preserved; adjust the roster and retry it, or return to the character workspace.";
        renderSection();
        renderStatus();
        return;
      }
    }

    const consumed = characterSessionStore.consume(
      activeCharacterHandoff.key,
      "world-editor",
      activeCharacterHandoff.workflowId
    );
    if (!consumed) {
      characterHandoffResultInvalid = false;
      characterHandoffError = "The character result could not be applied. It may still be recoverable; retry it or return to the character workspace.";
      renderSection();
      renderStatus();
      return;
    }
    if (pending.result.status === "accepted") {
      state = replaceWorldDraft(state, nextDraft);
      clearPendingStructuredValidations("playableCharacters");
      clearPendingJsonInputs("playableCharacters");
      resetItemIdentities(state.draft);
      const acceptedId = pending.result.candidate.id;
      const acceptedIndex = state.draft.playableCharacters.findIndex((candidate) =>
        typeof candidate === "object" && candidate !== null && (candidate as { id?: unknown }).id === acceptedId
      );
      selectedIndexes.set("playableCharacters", Math.max(acceptedIndex, 0));
      announcement.textContent = pending.session.mode === "edit"
        ? "Character updated in the unsaved world draft. Save draft to persist it."
        : "Character added to the unsaved world draft. Save draft to persist it.";
    }
    activeCharacterHandoff = null;
    characterHandoffError = null;
    characterHandoffResultInvalid = false;
    renderSection();
    renderStatus();
  }

  function updateSelectedStructuredField(target: HTMLInputElement | HTMLTextAreaElement): void {
    if (!state || activeSection === "overview") return;
    const spec = COLLECTIONS[activeCollection];
    if (spec.kind === "asset") return;
    const index = selectedIndexes.get(activeCollection) ?? 0;
    const original = state.draft[activeCollection][index];
    if (original === undefined) return;
    const field = target.dataset.structuredField!;
    const currentItemId = itemIdentity(activeCollection, index);
    if (!currentItemId) return;
    const validationKey = structuredValidationKey(activeCollection, currentItemId, field);
    const fieldError = sectionContent.querySelector<HTMLElement>(`[data-structured-error="${field}"]`);
    let value: unknown = target.value;
    let validationMessage: string | undefined;
    if (target.dataset.jsonShape) {
      const parsed = parseAdvancedJson(target.value, target.dataset.jsonShape as AdvancedJsonShape);
      validationMessage = parsed.error ?? undefined;
      value = parsed.value;
    } else if (spec.kind === "stat" && field === "value" && typeof structuredFieldsFor("stat", original).value === "number") {
      const numericValue = target.value.trim() === "" ? Number.NaN : Number(target.value);
      if (!Number.isFinite(numericValue)) validationMessage = "Enter a valid number.";
      else value = numericValue;
    }
    if (validationMessage) {
      pendingStructuredValidations.set(validationKey, {
        collection: activeCollection,
        itemId: currentItemId,
        field,
        value: target.value,
        message: validationMessage
      });
      target.setAttribute("aria-invalid", "true");
      if (fieldError) fieldError.textContent = validationMessage;
      renderStatus();
      return;
    }
    pendingStructuredValidations.delete(validationKey);
    target.removeAttribute("aria-invalid");
    if (fieldError) fieldError.textContent = "";
    const merged = mergeStructuredFields(spec.kind, original, { [field]: value });
    state = updateCollectionItem(state, activeCollection, index, merged);
    const advanced = sectionContent.querySelector<HTMLTextAreaElement>("[data-advanced-json]");
    if (advanced && !pendingJsonInputs.has(advanced.dataset.jsonEditorKey ?? "")) {
      advanced.value = serializeAdvancedJson(merged);
    }
    announcement.textContent = "";
    conflictHost.replaceChildren();
    renderStatus();
  }

  const onInput = (event: Event) => {
    if (!state || isReadOnly() || state.status === "saving") return;
    const target = event.target;
    if (!(target instanceof pageView.HTMLInputElement) && !(target instanceof pageView.HTMLTextAreaElement)) return;
    if (target instanceof pageView.HTMLTextAreaElement && target.dataset.jsonEditorKey && target.dataset.jsonShape) {
      const key = target.dataset.jsonEditorKey;
      const parsed = parseAdvancedJson(target.value, target.dataset.jsonShape as AdvancedJsonShape);
      const existing = pendingJsonInputs.get(key);
      const section = existing?.section ?? (key === "root-extras" || key === "world-extras" ? "overview" : activeSection);
      pendingJsonInputs.set(key, {
        key,
        raw: target.value,
        shape: target.dataset.jsonShape as AdvancedJsonShape,
        error: parsed.error ?? null,
        section: (target.dataset.jsonSection as EditorSection | undefined) ?? section,
        collection: target.dataset.jsonCollection as DraftCollectionName | undefined,
        itemId: target.dataset.jsonItemId
      });
      const error = jsonError(key);
      if (error) error.textContent = parsed.error ?? "Apply or discard JSON changes before saving.";
      if (parsed.error) target.setAttribute("aria-invalid", "true");
      else target.removeAttribute("aria-invalid");
      renderStatus();
      return;
    }
    if (target.dataset.collectionSearch !== undefined) {
      searches.set(activeCollection, target.value);
      const count = sectionContent.querySelector<HTMLElement>("[data-result-count]");
      const list = sectionContent.querySelector<HTMLOListElement>("[data-collection-list]");
      if (count && list) {
        const items = state.draft[activeCollection];
        const selected = selectedIndexes.get(activeCollection) ?? 0;
        renderCollectionResults(count, list, COLLECTIONS[activeCollection], items, selected, target.value);
      }
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
    renderOverviewValidation();
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
      if (activeCollection === "playableCharacters") {
        beginCharacterHandoff();
        return;
      }
      state = addCollectionItem(state, activeCollection, {});
      itemIdentities.get(activeCollection)?.push(createItemIdentity());
      selectedIndexes.set(activeCollection, state.draft[activeCollection].length - 1);
      announcement.textContent = "";
      renderCollectionEditor();
      renderStatus();
    }
    if (action === "edit-character" && actionButton?.dataset.characterId && !isReadOnly()) {
      beginCharacterHandoff(actionButton.dataset.characterId);
      return;
    }
    if (action === "retry-character-result") {
      if (characterHandoffResultInvalid) resetInvalidCharacterHandoff();
      else consumeCharacterHandoff();
      return;
    }
    const returnToCharacterWorkspace = target.closest<HTMLAnchorElement>("[data-character-handoff-error] a");
    if (returnToCharacterWorkspace && characterHandoffResultInvalid) {
      event.preventDefault();
      resetInvalidCharacterHandoff();
      return;
    }
    if (action === "remove-item" && !isReadOnly()) {
      const index = selectedIndexes.get(activeCollection) ?? 0;
      const removedItemId = itemIdentity(activeCollection, index);
      const previousRemovalIds = new Set(state.pendingRemovals.map((removal) => removal.id));
      state = removeCollectionItem(state, activeCollection, index);
      const removal = state.pendingRemovals.find((candidate) => !previousRemovalIds.has(candidate.id));
      if (removedItemId) {
        clearPendingStructuredValidations(activeCollection, removedItemId);
        clearPendingJsonInputs(activeCollection, removedItemId);
        itemIdentities.get(activeCollection)?.splice(index, 1);
        if (removal) removedItemIdentities.set(removal.id, removedItemId);
      }
      selectedIndexes.set(activeCollection, Math.min(index, Math.max(state.draft[activeCollection].length - 1, 0)));
      renderCollectionEditor();
      renderStatus();
    }
    if (action === "undo-removal" && actionButton?.dataset.removalId && !isReadOnly()) {
      const removalId = actionButton.dataset.removalId;
      const removal = state.pendingRemovals.find((candidate) => candidate.id === removalId);
      if (removal) {
        const earlierPendingCount = state.pendingRemovals.filter((candidate) =>
          candidate.collection === removal.collection && candidate.originalIndex < removal.originalIndex
        ).length;
        const restorationIndex = removal.originalIndex - earlierPendingCount;
        state = restoreCollectionItem(state, removalId);
        const restoredItemId = removedItemIdentities.get(removalId) ?? createItemIdentity();
        const identities = itemIdentities.get(removal.collection) ?? [];
        identities.splice(restorationIndex, 0, restoredItemId);
        itemIdentities.set(removal.collection, identities);
        removedItemIdentities.delete(removalId);
      }
      renderCollectionEditor();
      renderStatus();
    }
    if ((action === "discard-json" || action === "discard-advanced-json") && actionButton?.dataset.jsonEditorKey) {
      pendingJsonInputs.delete(actionButton.dataset.jsonEditorKey);
      if (activeSection === "overview") renderOverviewExtras();
      else renderCollectionEditor();
      renderStatus();
    }
    if ((action === "apply-root-extras-json" || action === "apply-world-extras-json") && actionButton?.dataset.jsonEditorKey && !isReadOnly()) {
      const key = actionButton.dataset.jsonEditorKey;
      const textarea = jsonControl(key);
      if (textarea) {
        const parsed = parseAdvancedJson(textarea.value, "object");
        if (parsed.error) textarea.dispatchEvent(new pageView.Event("input", { bubbles: true }));
        else {
          state = replaceWorldDraft(state, action === "apply-root-extras-json"
            ? mergeRootDraftExtras(state.draft, parsed.value as Record<string, unknown>)
            : mergeWorldExtras(state.draft, parsed.value as Record<string, unknown>));
          pendingJsonInputs.delete(key);
          renderOverviewFields();
          renderStatus();
        }
      }
    }
    if (action === "apply-advanced-json" && !isReadOnly()) {
      const textarea = sectionContent.querySelector<HTMLTextAreaElement>("[data-advanced-json]");
      if (textarea) {
        const parsed = parseAdvancedJson(textarea.value, "object");
        if (parsed.error) textarea.dispatchEvent(new pageView.Event("input", { bubbles: true }));
        else {
          const index = selectedIndexes.get(activeCollection) ?? 0;
          const replacedItemId = itemIdentity(activeCollection, index);
          state = updateCollectionItem(state, activeCollection, index, parsed.value);
          pendingJsonInputs.delete(textarea.dataset.jsonEditorKey ?? "");
          if (replacedItemId) clearPendingStructuredValidations(activeCollection, replacedItemId);
          renderCollectionEditor();
          renderStatus();
        }
      }
    }
    if (action === "apply-defaults-json" && !isReadOnly()) {
      const textarea = sectionContent.querySelector<HTMLTextAreaElement>("[data-defaults-json]");
      if (textarea) {
        const parsed = parseAdvancedJson(textarea.value, "object");
        if (parsed.error) textarea.dispatchEvent(new pageView.Event("input", { bubbles: true }));
        else {
          state = editWorldDraft(state, ["defaults"], parsed.value);
          pendingJsonInputs.delete("defaults");
          renderCollectionEditor();
          renderStatus();
        }
      }
    }
    if (action === "apply-collection-json" && !isReadOnly()) {
      const textarea = sectionContent.querySelector<HTMLTextAreaElement>("[data-collection-json]");
      if (textarea) {
        const parsed = parseAdvancedJson(textarea.value, "array");
        if (parsed.error) textarea.dispatchEvent(new pageView.Event("input", { bubbles: true }));
        else {
          state = editWorldDraft(state, [activeCollection], parsed.value);
          pendingJsonInputs.delete(textarea.dataset.jsonEditorKey ?? "");
          clearPendingStructuredValidations(activeCollection);
          clearPendingJsonInputs(activeCollection);
          itemIdentities.set(activeCollection, state.draft[activeCollection].map(() => createItemIdentity()));
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

  const onPageShow = () => consumeCharacterHandoff();

  root.addEventListener("input", onInput);
  root.addEventListener("change", onChange);
  root.addEventListener("click", onClick);
  pageView.addEventListener("pageshow", onPageShow);
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
      pageView.removeEventListener("pageshow", onPageShow);
      theme.dispose();
    }
  };
}
