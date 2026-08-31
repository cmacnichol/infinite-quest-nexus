import type { StoryTurnInputMode } from "@infinite-quest/client-core";
import type { CampaignSummary } from "@infinite-quest/contracts";

export type TurnControlStyle = CampaignSummary["turnControlStyle"];

export interface InputModeState {
  readonly style: TurnControlStyle;
  readonly value: StoryTurnInputMode;
  readonly disabled: boolean;
}

type InputModeOption = Readonly<{ value: StoryTurnInputMode; label: string }>;

const flexibleOptions: readonly InputModeOption[] = [
  { value: "action", label: "Story Action" },
  { value: "scene", label: "Story Direction" },
  { value: "auto", label: "Auto" }
];

const actionOnlyOptions: readonly InputModeOption[] = [
  { value: "action", label: "Story Action" }
];

export function inputModeOptions(style: TurnControlStyle): readonly InputModeOption[] {
  return style === "action_only" ? actionOnlyOptions : flexibleOptions;
}

export interface InputModeControl {
  readonly element: HTMLElement;
  update(state: InputModeState): void;
  dispose(): void;
}

function allowedMode(style: TurnControlStyle, value: unknown): StoryTurnInputMode | null {
  return inputModeOptions(style).some((option) => option.value === value)
    ? value as StoryTurnInputMode
    : null;
}

function resolvedMode(state: InputModeState): StoryTurnInputMode {
  return allowedMode(state.style, state.value) ?? "action";
}

export function mountInputMode(document: Document, onChange: (mode: StoryTurnInputMode) => void): InputModeControl {
  const element = document.createElement("section");
  element.className = "story-input-mode-control";
  const group = document.createElement("wa-radio-group");
  group.setAttribute("label", "Interpret prompt as");
  group.setAttribute("orientation", "horizontal");
  const help = document.createElement("p");
  help.className = "story-input-mode-help";
  help.textContent = "Auto classification happens when continuing, not while typing.";
  element.append(group, help);

  let state: InputModeState | undefined;
  let renderedStyle: TurnControlStyle | undefined;

  const render = () => {
    if (!state) return;
    const value = resolvedMode(state);
    if (renderedStyle !== state.style) {
      group.replaceChildren();
      for (const option of inputModeOptions(state.style)) {
        const radio = document.createElement("wa-radio");
        radio.setAttribute("value", option.value);
        radio.setAttribute("appearance", "button");
        radio.textContent = option.label;
        group.append(radio);
      }
      renderedStyle = state.style;
    }
    (group as unknown as { value: StoryTurnInputMode }).value = value;
    group.toggleAttribute("disabled", state.disabled);
  };

  const handleChange = () => {
    if (!state || state.disabled) return;
    const value = allowedMode(state.style, (group as unknown as { value: unknown }).value);
    if (value) onChange(value);
  };
  group.addEventListener("change", handleChange);

  return {
    element,
    update(nextState) {
      state = nextState;
      render();
    },
    dispose() {
      group.removeEventListener("change", handleChange);
    }
  };
}
