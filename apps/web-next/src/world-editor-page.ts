import { initializeAppTheme, renderAppShell } from "./app-shell";
import {
  loadWorld as loadWorldRequest,
  saveWorldDraft as saveWorldDraftRequest,
  WorldEditorApiError,
  type WorldDraftSaveResponse
} from "./world-editor-api";
import type { EditableWorldDraft, WorldAggregate } from "./world-editor-model";
import {
  beginDraftSave,
  completeDraftSave,
  createWorldEditorState,
  draftReadiness,
  editWorldDraft,
  failDraftSave,
  validateWorldDraft,
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
  copyUnsavedDraft?: (serializedDraft: string) => Promise<void>;
  downloadUnsavedDraft?: (serializedDraft: string, filename: string) => void;
  confirmReload?: () => boolean;
}

type OverviewField = "title" | "genre" | "tone" | "premise" | "backgroundStory" | "firstAction" | "rules";

function requiredElement<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error("The World Editor interface could not be initialized.");
  return element;
}

const fieldDefinitions: Array<{
  name: OverviewField;
  label: string;
  kind: "input" | "textarea";
  rows?: number;
}> = [
  { name: "title", label: "Title", kind: "input" },
  { name: "genre", label: "Genre", kind: "input" },
  { name: "tone", label: "Tone", kind: "textarea", rows: 2 },
  { name: "premise", label: "Premise", kind: "textarea", rows: 4 },
  { name: "backgroundStory", label: "Background story", kind: "textarea", rows: 7 },
  { name: "firstAction", label: "First action", kind: "textarea", rows: 4 },
  { name: "rules", label: "Rules", kind: "textarea", rows: 6 }
];

function overviewFieldsMarkup(): string {
  return fieldDefinitions.map((field) => {
    const id = `world-${field.name}`;
    const control = field.kind === "input"
      ? `<input id="${id}" name="world.${field.name}" type="text" disabled />`
      : `<textarea id="${id}" name="world.${field.name}" rows="${field.rows}" disabled></textarea>`;
    return `<label class="editor-field editor-field-${field.name}" for="${id}"><span>${field.label}</span>${control}</label>`;
  }).join("");
}

const editorMarkup = `
  <main id="main-content" class="editor-main" data-page="world-editor" aria-busy="true">
    <section class="editor-command-row" aria-labelledby="editor-title">
      <div class="editor-identity">
        <a href="/app/">World Library</a>
        <h1 id="editor-title">World Overview</h1>
      </div>
      <p class="editor-command-status" data-editor-state aria-live="polite">Loading world editor…</p>
      <div class="editor-save-cell">
        <button type="button" data-action="save-draft" disabled>Save draft</button>
      </div>
    </section>

    <div class="editor-workspace">
      <nav class="editor-section-index" data-section-index aria-label="World editor sections">
        <a href="#overview" aria-current="page">Overview</a>
        <span aria-disabled="true">Characters</span>
        <span aria-disabled="true">Canon</span>
        <span aria-disabled="true">Mechanics</span>
        <span aria-disabled="true">Assets</span>
      </nav>

      <section id="overview" class="overview-editor" data-editor-section="overview" aria-labelledby="overview-heading">
        <header>
          <h2 id="overview-heading">Overview</h2>
          <p>Set the world’s identity and the opening frame the Story Engine can build from.</p>
        </header>
        <div class="editor-load-state" data-load-state></div>
        <form class="overview-form" novalidate>
          ${overviewFieldsMarkup()}
        </form>
        <p class="save-announcement" data-save-announcement aria-live="assertive"></p>
        <div data-conflict-host></div>
      </section>
    </div>

    <section class="draft-ledger" data-draft-ledger aria-label="Draft ledger">
      <div class="draft-ledger-summary">
        <span data-ledger-state>State —</span>
        <span data-ledger-revision>Revision —</span>
        <span data-ledger-readiness>Readiness —</span>
        <span data-ledger-warnings>Warnings —</span>
        <button type="button" data-action="toggle-ledger" aria-expanded="false" aria-controls="draft-ledger-details">Draft details</button>
      </div>
      <div id="draft-ledger-details" class="draft-ledger-details" hidden></div>
    </section>
  </main>
`;

function serializeDraft(draft: EditableWorldDraft): string {
  return `${JSON.stringify(draft, null, 2)}\n`;
}

function downloadDraft(document: Document, serializedDraft: string, filename: string): void {
  const view = document.defaultView;
  if (!view) return;
  const urlApi = view.URL;
  if (typeof urlApi?.createObjectURL !== "function") return;
  const url = urlApi.createObjectURL(new Blob([serializedDraft], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  urlApi.revokeObjectURL(url);
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

  const main = requiredElement<HTMLElement>(root, '[data-page="world-editor"]');
  const form = requiredElement<HTMLFormElement>(root, ".overview-form");
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

  const lifecycleTarget = view;
  const loadWorld = dependencies.loadWorld ?? loadWorldRequest;
  const saveWorldDraft = dependencies.saveWorldDraft ?? saveWorldDraftRequest;
  const copyUnsavedDraft = dependencies.copyUnsavedDraft ?? (async (serializedDraft: string) => {
    if (!view.navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable.");
    await view.navigator.clipboard.writeText(serializedDraft);
  });
  const downloadUnsavedDraft = dependencies.downloadUnsavedDraft ?? ((serializedDraft: string, filename: string) =>
    downloadDraft(document, serializedDraft, filename));
  const confirmReload = dependencies.confirmReload ?? (() => view.confirm(
    "Reload the authoritative draft? Your unsaved changes will be discarded."
  ));

  let state: WorldEditorState | null = null;
  let authoritativeStatus: WorldAggregate["status"] | null = null;
  let disposed = false;
  let loadController: AbortController | null = null;
  let saveController: AbortController | null = null;
  let unloadInstalled = false;

  const beforeUnload = (event: Event) => {
    event.preventDefault();
  };

  function setDirtyGuard(dirty: boolean): void {
    if (dirty && !unloadInstalled) {
      lifecycleTarget.addEventListener("beforeunload", beforeUnload);
      unloadInstalled = true;
    } else if (!dirty && unloadInstalled) {
      lifecycleTarget.removeEventListener("beforeunload", beforeUnload);
      unloadInstalled = false;
    }
  }

  function fields(): Array<HTMLInputElement | HTMLTextAreaElement> {
    return fieldDefinitions.flatMap((field) => {
      const control = form.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="world.${field.name}"]`);
      return control ? [control] : [];
    });
  }

  function renderFieldAvailability(): void {
    if (!state) return;
    const readOnly = authoritativeStatus === "archived";
    const disabled = state.revision === null || state.status === "saving";
    for (const field of fields()) {
      field.disabled = disabled;
      field.readOnly = readOnly;
      field.setAttribute("aria-readonly", String(readOnly));
    }
  }

  function renderFields(): void {
    if (!state) return;
    for (const definition of fieldDefinitions) {
      const field = form.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="world.${definition.name}"]`);
      if (field) field.value = state.draft.world[definition.name];
    }
    renderFieldAvailability();
  }

  function renderLedger(): void {
    if (!state) {
      ledgerState.textContent = "State —";
      ledgerRevision.textContent = "Revision —";
      ledgerReadiness.textContent = "Readiness —";
      ledgerWarnings.textContent = "Warnings —";
      ledgerDetails.replaceChildren();
      return;
    }
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
    const readOnly = authoritativeStatus === "archived";
    if (readOnly) editorState.textContent = "Archived worlds are read-only.";
    else if (state.revision === null) editorState.textContent = "No editable draft is available.";
    else if (state.status === "saving") editorState.textContent = "Saving draft…";
    else if (state.status === "unsaved" || state.status === "error") editorState.textContent = "Unsaved changes";
    else editorState.textContent = "Draft saved";
    const canSave = state.status === "unsaved" ||
      (state.status === "error" && state.saveError?.kind !== "conflict");
    saveButton.disabled = readOnly || state.revision === null || !canSave;
    setDirtyGuard(!readOnly && state.revision !== null &&
      (state.status === "unsaved" || state.status === "saving" || state.status === "error"));
    renderFieldAvailability();
    renderLedger();
  }

  function adoptWorld(world: WorldAggregate): void {
    authoritativeStatus = world.status;
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
    renderFields();
    renderStatus();
  }

  function renderLoadError(error: unknown): void {
    main.setAttribute("aria-busy", "false");
    for (const field of fields()) field.disabled = true;
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
    editorState.textContent = notFound ? "World not found" : "The World Editor could not be loaded.";
    if (!notFound) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.dataset.action = "retry-load";
      retry.textContent = "Try again";
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
    if (!state) return;
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
    const actionDefinitions = [
      ["copy-unsaved-draft", "Copy unsaved draft"],
      ["download-unsaved-draft", "Download unsaved draft"],
      ["reload-authoritative-draft", "Reload authoritative draft"]
    ] as const;
    for (const [action, label] of actionDefinitions) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.action = action;
      button.textContent = label;
      actions.append(button);
    }
    region.append(heading, message, actions);
    conflictHost.append(region);
    heading.focus();
  }

  async function saveDraft(): Promise<void> {
    if (!state || authoritativeStatus === "archived" || state.status === "saving" || state.revision === null) return;
    const validation = validateWorldDraft(state);
    const firstError = validation.issues.find((issue) => issue.severity === "error");
    if (firstError) {
      const invalidField = form.querySelector<HTMLElement>(`[name="${firstError.path}"]`);
      invalidField?.focus();
      announcement.textContent = firstError.message;
      return;
    }

    const expectedRevision = state.revision;
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
      renderFields();
      renderStatus();
      announcement.textContent = "Draft saved.";
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

  const onInput = (event: Event) => {
    if (!state || authoritativeStatus === "archived" || state.revision === null || state.status === "saving") return;
    const target = event.target;
    if (!(target instanceof view.HTMLInputElement) && !(target instanceof view.HTMLTextAreaElement)) return;
    const match = /^world\.(.+)$/.exec(target.name);
    const field = match?.[1] as OverviewField | undefined;
    if (!field || !fieldDefinitions.some((definition) => definition.name === field)) return;
    state = editWorldDraft(state, ["world", field], target.value);
    announcement.textContent = "";
    conflictHost.replaceChildren();
    renderStatus();
  };

  const onClick = (event: Event) => {
    const target = event.target;
    if (!(target instanceof view.Element)) return;
    const button = target.closest<HTMLButtonElement>("button[data-action]");
    const action = button?.dataset.action;
    if (action === "save-draft") void saveDraft();
    if (action === "toggle-ledger") {
      const expanded = ledgerToggle.getAttribute("aria-expanded") === "true";
      ledgerToggle.setAttribute("aria-expanded", String(!expanded));
      ledgerDetails.hidden = expanded;
    }
    if (!state) return;
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

  form.addEventListener("input", onInput);
  root.addEventListener("click", onClick);
  void requestWorld();

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      loadController?.abort(new DOMException("World Editor closed", "AbortError"));
      saveController?.abort(new DOMException("World Editor closed", "AbortError"));
      setDirtyGuard(false);
      form.removeEventListener("input", onInput);
      root.removeEventListener("click", onClick);
      theme.dispose();
    }
  };
}
