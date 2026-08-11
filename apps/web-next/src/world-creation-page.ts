import { initializeAppTheme, renderAppShell } from "./app-shell";
import {
  generateWorldPreview as generateWorldPreviewRequest,
  WorldCreationApiError,
  type WorldGenerationPreviewRequest,
  type WorldGenerationPreviewResponse
} from "./world-creation-api";
import {
  applyGeneratedPreview,
  createWorldCreationState,
  selectCreationMethod,
  type WorldCreationState
} from "./world-creation-model";
import type { MountedPage } from "./world-library-page";

export interface WorldCreationPageDependencies {
  generateWorldPreview?: (
    request: WorldGenerationPreviewRequest,
    signal?: AbortSignal
  ) => Promise<WorldGenerationPreviewResponse>;
  readClipboardText?: () => Promise<string>;
  writeClipboardText?: (value: string) => Promise<void>;
}

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
        <span aria-current="step">Method</span>
        <span aria-disabled="true">Foundation</span>
        <span aria-disabled="true">Canon</span>
        <span aria-disabled="true">Mechanics</span>
        <span aria-disabled="true">Cover</span>
        <span aria-disabled="true">Review</span>
      </nav>

      <section class="editor-canvas creation-canvas" data-creation-stage="method" aria-labelledby="method-heading">
        <div class="overview-editor creation-method-stage">
          <header>
            <div>
              <h2 id="method-heading">Choose how to begin</h2>
            </div>
            <p>Start from a blank structured draft, or describe a world for the Story Engine to organize.</p>
          </header>

          <fieldset class="creation-method-controls">
            <legend>Creation method</legend>
            <label class="creation-method-control" data-control-size="48">
              <input type="radio" name="creationMethod" value="manual" />
              <span>Manual</span>
            </label>
            <label class="creation-method-control" data-control-size="48">
              <input type="radio" name="creationMethod" value="ai" />
              <span>AI-assisted</span>
            </label>
          </fieldset>

          <section class="creation-prompt-authoring" data-ai-prompt hidden aria-labelledby="concept-heading">
            <div class="creation-prompt-heading">
              <div>
                <h3 id="concept-heading">World concept</h3>
                <p>Describe the setting, mood, conflicts, and rules that make this world distinct.</p>
              </div>
              <div class="creation-prompt-tools" aria-label="Prompt tools">
                <button type="button" data-action="copy-prompt" aria-label="Copy world concept">${copyIcon}</button>
                <button type="button" data-action="paste-prompt" aria-label="Paste into world concept">${pasteIcon}</button>
                <button type="button" data-action="expand-prompt">${expandIcon}<span>Expand</span></button>
              </div>
            </div>
            <label class="editor-field creation-prompt-field">
              <span>Concept prompt</span>
              <textarea rows="7" data-concept-prompt="compact" aria-describedby="creation-clipboard-status creation-generation-status" placeholder="A glass city follows a migrating star…"></textarea>
            </label>
            <p id="creation-clipboard-status" data-clipboard-status aria-live="polite"></p>
            <div id="creation-generation-status" data-generation-status aria-live="polite"></div>
            <button type="button" data-action="generate-world" disabled>Generate world draft</button>
          </section>

          <div class="creation-manual-action" data-manual-action hidden>
            <p>Begin with an empty world and author each section directly.</p>
            <button type="button" data-action="continue-manual">Continue manually</button>
          </div>
        </div>
      </section>
    </div>

    <dialog class="creation-prompt-dialog" data-prompt-dialog aria-labelledby="expanded-prompt-title">
      <div class="creation-prompt-dialog-header">
        <h2 id="expanded-prompt-title">World concept</h2>
        <button type="button" data-action="close-prompt-dialog" aria-label="Close expanded world concept">${closeIcon}</button>
      </div>
      <label class="editor-field creation-prompt-dialog-field">
        <span>Concept prompt</span>
        <textarea rows="14" data-concept-prompt="expanded" aria-describedby="creation-dialog-clipboard-status"></textarea>
      </label>
      <div class="creation-prompt-tools" aria-label="Expanded prompt tools">
        <button type="button" data-action="copy-prompt" aria-label="Copy world concept">${copyIcon}</button>
        <button type="button" data-action="paste-prompt" aria-label="Paste into world concept">${pasteIcon}</button>
      </div>
      <p id="creation-dialog-clipboard-status" data-dialog-clipboard-status aria-live="polite"></p>
    </dialog>
  </main>
`;

function requiredElement<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`The World Creation interface is missing ${selector}.`);
  return element;
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

  const aiPrompt = requiredElement<HTMLElement>(root, "[data-ai-prompt]");
  const manualAction = requiredElement<HTMLElement>(root, "[data-manual-action]");
  const compactPrompt = requiredElement<HTMLTextAreaElement>(root, '[data-concept-prompt="compact"]');
  const expandedPrompt = requiredElement<HTMLTextAreaElement>(root, '[data-concept-prompt="expanded"]');
  const generateButton = requiredElement<HTMLButtonElement>(root, '[data-action="generate-world"]');
  const expandButton = requiredElement<HTMLButtonElement>(root, '[data-action="expand-prompt"]');
  const dialog = requiredElement<HTMLDialogElement>(root, "[data-prompt-dialog]");
  const clipboardStatus = requiredElement<HTMLElement>(root, "[data-clipboard-status]");
  const dialogClipboardStatus = requiredElement<HTMLElement>(root, "[data-dialog-clipboard-status]");
  const generationStatus = requiredElement<HTMLElement>(root, "[data-generation-status]");

  const generateWorldPreview = dependencies.generateWorldPreview ?? generateWorldPreviewRequest;
  const readClipboardText = dependencies.readClipboardText ?? (async () => {
    if (!pageView.navigator.clipboard?.readText) throw new Error("Clipboard permission is unavailable.");
    return pageView.navigator.clipboard.readText();
  });
  const writeClipboardText = dependencies.writeClipboardText ?? (async (value: string) => {
    if (!pageView.navigator.clipboard?.writeText) throw new Error("Clipboard permission is unavailable.");
    await pageView.navigator.clipboard.writeText(value);
  });

  let state: WorldCreationState = createWorldCreationState();
  let concept = "";
  let disposed = false;
  let generationSequence = 0;
  let generationController: AbortController | null = null;

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
    generateButton.disabled = !concept.trim();
  }

  function updateMethod(method: "manual" | "ai"): void {
    state = selectCreationMethod(state, method);
    aiPrompt.hidden = method !== "ai";
    manualAction.hidden = method !== "manual";
    generationStatus.textContent = "";
  }

  function openDialog(): void {
    expandedPrompt.value = concept;
    const nativeDialog = dialog as HTMLDialogElement & { showModal?: () => void };
    if (typeof nativeDialog.showModal === "function") {
      nativeDialog.showModal();
    } else {
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
    try {
      await writeClipboardText(concept);
      clipboardAnnouncement("Copied world concept.");
    } catch {
      clipboardAnnouncement("We could not copy the world concept. Select the text and copy it manually.");
    }
    if (!disposed) editor.focus();
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
    if (!disposed) editor.focus();
  }

  async function generate(): Promise<void> {
    if (!concept.trim() || generationController) return;
    generationController = new AbortController();
    generateButton.disabled = true;
    generationStatus.textContent = "Generating a structured world draft…";
    generationSequence += 1;
    try {
      const preview = await generateWorldPreview({
        title: "",
        prompt: concept,
        progressKey: `world-gen:${Date.now()}-${generationSequence}`
      }, generationController.signal);
      if (disposed) return;
      state = applyGeneratedPreview(state, preview);
      generationStatus.textContent = "World draft generated. Continue to review its foundation.";
    } catch (error) {
      if (disposed || generationController.signal.aborted) return;
      if (error instanceof WorldCreationApiError && error.kind === "unavailable") {
        generationStatus.innerHTML = 'The text provider is unavailable. Check <a href="/nexus/?view=setup">Provider Setup</a>, then try again.';
      } else {
        generationStatus.textContent = "The world draft could not be generated. Your concept is safe; try again.";
      }
    } finally {
      generationController = null;
      if (!disposed) generateButton.disabled = !concept.trim();
    }
  }

  function trapDialogFocus(event: KeyboardEvent): void {
    if (event.key !== "Tab" || !dialogIsOpen()) return;
    const focusable = [...dialog.querySelectorAll<HTMLElement>("textarea, button:not([disabled])")];
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function onInput(event: Event): void {
    const target = event.target;
    if (target === compactPrompt || target === expandedPrompt) syncPrompt(target as HTMLTextAreaElement);
  }

  function onChange(event: Event): void {
    const target = event.target;
    if (!(target instanceof pageView.HTMLInputElement) || target.name !== "creationMethod" || !target.checked) return;
    if (target.value === "manual" || target.value === "ai") updateMethod(target.value);
  }

  function onClick(event: Event): void {
    const target = event.target;
    if (!(target instanceof pageView.Element)) return;
    const action = target.closest<HTMLElement>("[data-action]")?.dataset.action;
    if (action === "expand-prompt") openDialog();
    else if (action === "close-prompt-dialog") closeDialog();
    else if (action === "copy-prompt") void copyPrompt();
    else if (action === "paste-prompt") void pastePrompt();
    else if (action === "generate-world") void generate();
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
  root.addEventListener("keydown", onKeyDown);

  return {
    dispose() {
      disposed = true;
      generationController?.abort();
      root.removeEventListener("input", onInput);
      root.removeEventListener("change", onChange);
      root.removeEventListener("click", onClick);
      root.removeEventListener("keydown", onKeyDown);
      theme.dispose();
    }
  };
}
