import { mountDialog } from "../../ui/dialog.js";
import "./choices.css";

export interface ChoicesState {
  readonly choices: readonly string[];
  readonly selected: readonly number[];
  readonly disabled: boolean;
}

export interface ChoicesControl {
  readonly element: HTMLElement;
  update(state: ChoicesState): void;
  open(): void;
  dispose(): void;
}

type ChoiceButton = HTMLElement & { disabled: boolean };

function setDisabled(button: ChoiceButton, disabled: boolean) {
  button.disabled = disabled;
  button.toggleAttribute("disabled", disabled);
}

function choiceButton(
  document: Document,
  choice: string,
  index: number,
  selected: readonly number[],
  disabled: boolean,
  attribute: string,
  onClick: (button: ChoiceButton) => void
): ChoiceButton {
  const button = document.createElement("wa-button") as ChoiceButton;
  button.setAttribute(attribute, "");
  button.dataset.choiceIndex = String(index);
  button.textContent = choice;
  button.setAttribute("aria-pressed", String(selected.includes(index)));
  setDisabled(button, disabled);
  button.addEventListener("click", () => onClick(button));
  return button;
}

function sameChoices(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((choice, index) => choice === right[index]);
}

export function mountChoices(document: Document, onChoose: (index: number) => void): ChoicesControl {
  const element = document.createElement("section");
  element.className = "story-choice-controls";
  const inlineChoices = document.createElement("div");
  inlineChoices.className = "story-choices__inline";
  const expandButton = document.createElement("wa-button") as ChoiceButton;
  expandButton.className = "story-choices__expand";
  expandButton.setAttribute("data-expand-choices", "");
  expandButton.textContent = "All Story Actions";

  const dialog = mountDialog(document, { label: "All Story Actions" });
  dialog.element.classList.add("story-choices__dialog");
  dialog.body.classList.add("story-choices__dialog-body");
  element.append(inlineChoices, expandButton, dialog.element);

  let state: ChoicesState = { choices: [], selected: [], disabled: false };
  let disposed = false;
  let renderedChoices: readonly string[] = [];
  let inlineButtons: ChoiceButton[] = [];
  let dialogButtons: ChoiceButton[] = [];

  const choose = (index: number, button: ChoiceButton) => {
    if (disposed || state.disabled || !button.isConnected) return;
    onChoose(index);
    dialog.close();
  };

  const render = () => {
    const hasChoices = state.choices.length > 0;
    element.toggleAttribute("hidden", !hasChoices);
    if (!hasChoices) {
      dialog.close();
      setDisabled(expandButton, true);
      inlineChoices.replaceChildren();
      dialog.body.replaceChildren();
      renderedChoices = [];
      inlineButtons = [];
      dialogButtons = [];
      return;
    }

    if (sameChoices(renderedChoices, state.choices)) {
      [...inlineButtons, ...dialogButtons].forEach((button) => {
        const index = Number(button.dataset.choiceIndex);
        button.setAttribute("aria-pressed", String(state.selected.includes(index)));
        setDisabled(button, state.disabled);
      });
      setDisabled(expandButton, state.disabled);
      return;
    }

    inlineChoices.replaceChildren();
    dialog.body.replaceChildren();
    inlineButtons = [];
    dialogButtons = [];

    const dialogChoices = document.createElement("div");
    dialogChoices.className = "story-choices__dialog-grid";
    state.choices.forEach((choice, index) => {
      const inlineButton = choiceButton(
        document,
        choice,
        index,
        state.selected,
        state.disabled,
        "data-inline-choice",
        (button) => choose(index, button)
      );
      const dialogButton = choiceButton(
        document,
        choice,
        index,
        state.selected,
        state.disabled,
        "data-dialog-choice",
        (button) => choose(index, button)
      );
      inlineButtons.push(inlineButton);
      dialogButtons.push(dialogButton);
      inlineChoices.append(inlineButton);
      dialogChoices.append(dialogButton);
    });
    setDisabled(expandButton, state.disabled);
    dialog.body.append(dialogChoices);
    renderedChoices = state.choices;
  };

  const open = () => {
    if (disposed || state.disabled || state.choices.length === 0) return;
    dialog.open(expandButton);
  };

  expandButton.addEventListener("click", open);

  return {
    element,
    update(nextState) {
      if (disposed) return;
      state = nextState;
      render();
    },
    open,
    dispose() {
      if (disposed) return;
      disposed = true;
      expandButton.removeEventListener("click", open);
      dialog.dispose();
      element.remove();
    }
  };
}
