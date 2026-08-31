import type { StoryLengthProfile } from "@infinite-quest/contracts";
import { mountDialog } from "../../ui/dialog.js";
import "./turn-length.css";

export interface TurnLengthState {
  readonly campaignDefault: StoryLengthProfile;
  readonly override: StoryLengthProfile | null;
  readonly disabled: boolean;
}

export interface TurnLengthControl {
  readonly element: HTMLElement;
  update(state: TurnLengthState): void;
  open(): void;
  dispose(): void;
}

type ValueControl = HTMLElement & { value: string; disabled: boolean };

const profiles: readonly Readonly<{ value: StoryLengthProfile; label: string }>[] = [
  { value: "brief", label: "Brief" },
  { value: "standard", label: "Standard" },
  { value: "long", label: "Long" },
  { value: "extended", label: "Extended" }
];

export function parseTurnLength(value: unknown): StoryLengthProfile | null | undefined {
  if (value === "") return null;
  return value === "brief" || value === "standard" || value === "long" || value === "extended" ? value : undefined;
}

function option(document: Document, value: string, label: string): HTMLElement {
  const element = document.createElement("wa-option");
  element.setAttribute("value", value);
  element.textContent = label;
  return element;
}

function setDisabled(control: HTMLElement, disabled: boolean) {
  (control as ValueControl).disabled = disabled;
  control.toggleAttribute("disabled", disabled);
}

function renderOptions(document: Document, select: HTMLElement, campaignDefault: StoryLengthProfile) {
  const defaultOption = select.querySelector<HTMLElement>('wa-option[value=""]');
  if (defaultOption) {
    defaultOption.textContent = `Campaign default — ${profiles.find((profile) => profile.value === campaignDefault)?.label ?? campaignDefault}`;
    return;
  }
  select.replaceChildren(
    option(document, "", `Campaign default — ${profiles.find((profile) => profile.value === campaignDefault)?.label ?? campaignDefault}`),
    ...profiles.map((profile) => option(document, profile.value, profile.label))
  );
}

export function mountTurnLength(document: Document, onChange: (value: StoryLengthProfile | null) => void): TurnLengthControl {
  const element = document.createElement("section");
  element.className = "story-turn-length";

  const select = document.createElement("wa-select") as ValueControl;
  select.className = "story-turn-length__select";
  select.dataset.turnLengthSelect = "";
  select.setAttribute("label", "Turn length");

  const details = document.createElement("button");
  details.type = "button";
  details.className = "story-turn-length__details";
  details.dataset.turnLengthDetails = "";
  details.textContent = "Turn length details";

  const dialog = mountDialog(document, { label: "Turn length details" });
  dialog.element.classList.add("story-turn-length__dialog");
  const explanation = document.createElement("p");
  explanation.className = "story-turn-length__explanation";
  explanation.textContent = "Applies to your next submission; the campaign default is unchanged.";
  const staged = document.createElement("wa-select") as ValueControl;
  staged.className = "story-turn-length__staged";
  staged.dataset.turnLengthStaged = "";
  staged.setAttribute("label", "Turn length for next submission");
  dialog.body.append(explanation, staged);

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "story-turn-length__cancel";
  cancel.dataset.turnLengthCancel = "";
  cancel.textContent = "Cancel";
  const apply = document.createElement("button");
  apply.type = "button";
  apply.className = "story-turn-length__apply";
  apply.dataset.turnLengthApply = "";
  apply.textContent = "Apply";
  dialog.footer.append(cancel, apply);
  element.append(select, details, dialog.element);

  let state: TurnLengthState | undefined;
  let disposed = false;

  const currentValue = () => state?.override ?? "";
  const render = (resetStagedValue: boolean) => {
    if (!state) return;
    renderOptions(document, select, state.campaignDefault);
    renderOptions(document, staged, state.campaignDefault);
    select.value = currentValue();
    if (resetStagedValue) staged.value = currentValue();
    setDisabled(select, state.disabled);
    setDisabled(staged, state.disabled);
    setDisabled(details, state.disabled);
    setDisabled(cancel, state.disabled);
    setDisabled(apply, state.disabled);
  };
  const handleInlineChange = () => {
    if (disposed || !state || state.disabled) return;
    const value = parseTurnLength(select.value);
    if (value === undefined) {
      select.value = currentValue();
      return;
    }
    onChange(value);
  };
  const open = () => {
    if (disposed || !state || state.disabled) return;
    staged.value = currentValue();
    dialog.open(details);
  };
  const cancelDialog = () => dialog.close();
  const applyDialog = () => {
    if (disposed || !state || state.disabled) return;
    const value = parseTurnLength(staged.value);
    if (value === undefined) {
      staged.value = currentValue();
      return;
    }
    onChange(value);
    dialog.close();
  };

  select.addEventListener("change", handleInlineChange);
  details.addEventListener("click", open);
  cancel.addEventListener("click", cancelDialog);
  apply.addEventListener("click", applyDialog);

  return {
    element,
    update(nextState) {
      if (disposed) return;
      const resetStagedValue = state === undefined || state.override !== nextState.override;
      state = nextState;
      render(resetStagedValue);
    },
    open,
    dispose() {
      if (disposed) return;
      disposed = true;
      select.removeEventListener("change", handleInlineChange);
      details.removeEventListener("click", open);
      cancel.removeEventListener("click", cancelDialog);
      apply.removeEventListener("click", applyDialog);
      dialog.dispose();
      element.remove();
    }
  };
}
