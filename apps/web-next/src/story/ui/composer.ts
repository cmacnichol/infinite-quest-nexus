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
}

export interface Composer {
  readonly element: HTMLElement;
  readonly footer: HTMLElement;
  update(state: ComposerState): void;
  focusDraft(): void;
  dispose(): void;
}

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

  element.append(input.element, choices.element, draft.element, footer);

  let disposed = false;
  const retryTurn = () => {
    if (!disposed && !retry.disabled) actions.retryTurn();
  };
  const continueTurn = () => {
    if (!disposed && !continueStory.disabled) actions.continueStory();
  };
  const openHistory = () => {
    if (!disposed && !history.disabled) actions.history();
  };

  retry.addEventListener("click", retryTurn);
  continueStory.addEventListener("click", continueTurn);
  history.addEventListener("click", openHistory);

  return {
    element,
    footer,
    update(state) {
      if (disposed) return;
      if (state.input.style === "flexible_scene") input.element.remove();
      else if (!element.contains(input.element)) element.insertBefore(input.element, choices.element);
      input.update(state.input);
      choices.update(state.choices);
      draft.update(state.draft);
      length.update(state.length);
      retry.disabled = !state.canRetry;
      continueStory.disabled = !state.canContinue;
      status.textContent = state.status ?? "";
    },
    focusDraft() {
      if (!disposed) draft.focus();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
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
