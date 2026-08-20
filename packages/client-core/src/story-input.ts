export type StoryTurnInputMode = "auto" | "action" | "scene";

export type ChoiceDraftSelection = {
  baseText: string;
  selectedIndexes: number[];
};

export type ChoiceDraftSelectionResult = {
  selection: ChoiceDraftSelection;
  text: string;
  selected: boolean;
  overLimit: boolean;
};

export function turnInputModeForControlStyle(turnControlStyle: unknown): StoryTurnInputMode {
  if (turnControlStyle === "flexible_auto") return "auto";
  if (turnControlStyle === "flexible_scene") return "scene";
  return "action";
}

export function createChoiceDraftSelection(baseText: unknown = ""): ChoiceDraftSelection {
  return {
    baseText: String(baseText),
    selectedIndexes: []
  };
}

export function resetChoiceDraftSelection(text: unknown = ""): ChoiceDraftSelection {
  return createChoiceDraftSelection(text);
}

function composeChoiceDraft(baseText: string, selectedIndexes: readonly number[], choices: readonly unknown[]): string {
  const selectedText = selectedIndexes
    .map((index) => String(choices[index] || "").trim())
    .filter(Boolean)
    .join("\n");
  if (!baseText) return selectedText;
  if (!selectedText) return baseText;
  return `${baseText}${baseText.endsWith("\n") ? "" : "\n"}${selectedText}`;
}

export function toggleChoiceDraftSelection(
  selection: ChoiceDraftSelection,
  choices: readonly unknown[],
  choiceIndex: number,
  currentText: unknown,
  maxLength: number
): ChoiceDraftSelectionResult {
  const selectedIndexes = [...selection.selectedIndexes];
  const existingIndex = selectedIndexes.indexOf(choiceIndex);
  const selected = existingIndex < 0;
  if (selected) selectedIndexes.push(choiceIndex);
  else selectedIndexes.splice(existingIndex, 1);

  const normalizedCurrentText = String(currentText || "");
  const baseText = selection.selectedIndexes.length ? selection.baseText : normalizedCurrentText;
  const text = composeChoiceDraft(baseText, selectedIndexes, choices);
  if (text.length > maxLength) {
    return {
      selection,
      text: normalizedCurrentText,
      selected: false,
      overLimit: true
    };
  }

  return {
    selection: { baseText, selectedIndexes },
    text,
    selected,
    overLimit: false
  };
}
