import type { StoryTurnInputMode } from "@infinite-quest/client-core";
import type { StoryLengthProfile } from "@infinite-quest/contracts";
import { mountChoices, type ChoicesState } from "./choices.js";
import { mountDraftField, type DraftFieldState } from "./draft-field.js";
import { mountInputMode, type InputModeState } from "./input-mode.js";
import { mountTurnLength, type TurnLengthState } from "./turn-length.js";
import "./choices.css";
import "./composer.css";
import "./draft-field.css";
import "./input-mode.css";
import "./turn-length.css";

export interface ComposerState {
  readonly draft: DraftFieldState;
  readonly input: InputModeState;
  readonly choices: ChoicesState;
  readonly length: TurnLengthState;
  readonly canContinue: boolean;
  readonly canRetry: boolean;
  readonly status: string | null;
  readonly confirmation: Readonly<{ action: string }> | null;
}

export interface ComposerActions {
  draft(text: string): void;
  clearDraft(): void;
  mode(mode: StoryTurnInputMode): void;
  choose(index: number): void;
  length(profile: StoryLengthProfile | null): void;
  continueStory(): void;
  retryTurn(): void;
  history(): void;
  confirm(mode: "action" | "scene"): void;
  returnToEditor(): void;
}

export interface Composer {
  readonly element: HTMLElement;
  readonly footer: HTMLElement;
  update(state: ComposerState): void;
  focusDraft(): void;
  dispose(): void;
}

let nextConfirmationId = 0;

function button(document: Document, text: string, dataAttribute: string): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = text;
  element.dataset[dataAttribute] = "";
  return element;
}

export function mountComposer(document: Document, actions: ComposerActions): Composer {
  const element = document.createElement("section");
  element.className = "quiet-leaf-composer-control";
  element.dataset.storyComposer = "";

  const input = mountInputMode(document, actions.mode);
  const choices = mountChoices(document, actions.choose);
  const draft = mountDraftField(document, actions.draft, actions.clearDraft);

  const confirmation = document.createElement("section");
  confirmation.className = "quiet-leaf-intent-confirmation";
  confirmation.dataset.storyIntentConfirmation = "";
  confirmation.hidden = true;
  confirmation.setAttribute("role", "region");
  const confirmationTitle = document.createElement("h2");
  confirmationTitle.className = "quiet-leaf-intent-confirmation__title";
  confirmationTitle.textContent = "Confirm prompt interpretation";
  const confirmationText = document.createElement("p");
  confirmationText.className = "quiet-leaf-intent-confirmation__text";
  const confirmationActions = document.createElement("div");
  confirmationActions.className = "quiet-leaf-intent-confirmation__actions";
  const confirmAction = button(document, "Use as Story Action", "confirmIntentAction");
  const confirmScene = button(document, "Use as Story Direction", "confirmIntentScene");
  const returnToEditor = button(document, "Return to editor", "returnToEditor");
  confirmationActions.append(confirmAction, confirmScene, returnToEditor);
  confirmation.append(confirmationTitle, confirmationText, confirmationActions);
  confirmationTitle.id = `quiet-leaf-intent-confirmation-title-${++nextConfirmationId}`;
  confirmation.setAttribute("aria-labelledby", confirmationTitle.id);

  const footer = document.createElement("footer");
  footer.className = "quiet-leaf-composer-footer";
  footer.dataset.composerFooter = "";

  const retryZone = document.createElement("div");
  retryZone.className = "quiet-leaf-composer-retry";
  retryZone.dataset.retryZone = "";
  const retry = button(document, "Retry Turn", "retryTurn");
  retryZone.append(retry);

  const primaryZone = document.createElement("div");
  primaryZone.className = "quiet-leaf-composer-primary";
  primaryZone.dataset.primaryZone = "";
  const length = mountTurnLength(document, actions.length);
  const continueStory = button(document, "Continue Story", "continueStory");
  continueStory.classList.add("quiet-leaf-composer-continue");
  primaryZone.append(length.element, continueStory);

  const history = button(document, "History", "history");
  history.classList.add("quiet-leaf-composer-history");
  const status = document.createElement("p");
  status.className = "quiet-leaf-composer-status";
  status.dataset.composerStatus = "";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  footer.append(retryZone, history, primaryZone, status);

  element.append(input.element, choices.element, draft.element, confirmation, footer);

  let disposed = false;
  const confirmAsAction = () => {
    if (!disposed && !confirmAction.disabled) actions.confirm("action");
  };
  const confirmAsScene = () => {
    if (!disposed && !confirmScene.disabled) actions.confirm("scene");
  };
  const returnToDraft = () => {
    if (disposed) return;
    actions.returnToEditor();
    draft.focus();
  };
  const retryTurn = () => {
    if (!disposed && !retry.disabled) actions.retryTurn();
  };
  const continueTurn = () => {
    if (!disposed && !continueStory.disabled) actions.continueStory();
  };
  const openHistory = () => {
    if (!disposed && !history.disabled) actions.history();
  };

  confirmAction.addEventListener("click", confirmAsAction);
  confirmScene.addEventListener("click", confirmAsScene);
  returnToEditor.addEventListener("click", returnToDraft);
  retry.addEventListener("click", retryTurn);
  continueStory.addEventListener("click", continueTurn);
  history.addEventListener("click", openHistory);

  return {
    element,
    footer,
    update(state) {
      if (disposed) return;
      input.update(state.input);
      choices.update(state.choices);
      draft.update(state.draft);
      length.update(state.length);
      retry.disabled = !state.canRetry;
      continueStory.disabled = !state.canContinue;
      const confirmationDisabled = state.confirmation === null || !state.canContinue;
      confirmAction.disabled = confirmationDisabled;
      confirmScene.disabled = confirmationDisabled;
      status.textContent = state.status ?? "";
      confirmation.hidden = state.confirmation === null;
      confirmationText.textContent = state.confirmation === null
        ? ""
        : `Choose how to continue: ${state.confirmation.action}`;
    },
    focusDraft() {
      if (!disposed) draft.focus();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      confirmAction.removeEventListener("click", confirmAsAction);
      confirmScene.removeEventListener("click", confirmAsScene);
      returnToEditor.removeEventListener("click", returnToDraft);
      retry.removeEventListener("click", retryTurn);
      continueStory.removeEventListener("click", continueTurn);
      history.removeEventListener("click", openHistory);
      input.dispose();
      choices.dispose();
      draft.dispose();
      length.dispose();
      element.remove();
      footer.remove();
    }
  };
}
