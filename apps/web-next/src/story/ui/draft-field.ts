export interface DraftFieldState {
  readonly ownerKey: string;
  readonly value: string;
  readonly disabled: boolean;
}

export interface DraftField {
  readonly element: HTMLElement;
  update(state: DraftFieldState): void;
  focus(): void;
  clear(): void;
  dispose(): void;
}

type DraftTextarea = HTMLElement & {
  value: string | null;
  disabled: boolean;
  focus(options?: FocusOptions): void;
};

const MAX_LENGTH = 12_000;
let nextFieldId = 0;

function draftCount(value: string): string {
  return `${value.length.toLocaleString()} / 12,000`;
}

export function mountDraftField(
  document: Document,
  onInput: (text: string) => void,
  onClear?: () => void
): DraftField {
  const fieldId = `story-draft-field-${++nextFieldId}`;
  const element = document.createElement("section");
  element.className = "story-draft-field";

  const textarea = document.createElement("wa-textarea") as DraftTextarea;
  textarea.setAttribute("label", "Custom Action");
  textarea.setAttribute("resize", "auto");
  textarea.setAttribute("maxlength", String(MAX_LENGTH));
  textarea.setAttribute("aria-describedby", `${fieldId}-help ${fieldId}-count`);

  const clearButton = document.createElement("button");
  clearButton.type = "button";
  clearButton.className = "story-clear-draft";
  clearButton.textContent = "Clear";
  clearButton.setAttribute("aria-label", "Clear custom action");

  const help = document.createElement("p");
  help.id = `${fieldId}-help`;
  help.className = "story-draft-help";
  help.textContent = "Choose a suggestion or describe the next moment.";

  const count = document.createElement("p");
  count.id = `${fieldId}-count`;
  count.className = "story-draft-count";
  count.setAttribute("role", "status");
  count.setAttribute("aria-live", "polite");

  element.append(textarea, clearButton, help, count);

  let ownerKey: string | undefined;
  let composing = false;

  const currentValue = () => textarea.value ?? "";
  const renderCount = () => {
    count.textContent = draftCount(currentValue());
    clearButton.disabled = !currentValue() || textarea.disabled;
  };
  const handleInput = () => {
    renderCount();
    onInput(currentValue());
  };
  const handleCompositionStart = () => {
    composing = true;
  };
  const handleCompositionEnd = () => {
    composing = false;
  };
  const handleClear = () => {
    textarea.value = "";
    renderCount();
    if (onClear) onClear();
    else onInput("");
    textarea.focus();
  };

  textarea.addEventListener("input", handleInput);
  textarea.addEventListener("compositionstart", handleCompositionStart);
  textarea.addEventListener("compositionend", handleCompositionEnd);
  clearButton.addEventListener("click", handleClear);
  renderCount();

  return {
    element,
    update(state) {
      const ownerChanged = ownerKey !== state.ownerKey;
      ownerKey = state.ownerKey;
      textarea.disabled = state.disabled;
      if (ownerChanged || (!composing && currentValue() !== state.value)) textarea.value = state.value;
      renderCount();
    },
    focus() {
      textarea.focus();
    },
    clear() {
      handleClear();
    },
    dispose() {
      textarea.removeEventListener("input", handleInput);
      textarea.removeEventListener("compositionstart", handleCompositionStart);
      textarea.removeEventListener("compositionend", handleCompositionEnd);
      clearButton.removeEventListener("click", handleClear);
    }
  };
}
