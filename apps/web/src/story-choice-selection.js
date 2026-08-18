export function turnInputModeForControlStyle(turnControlStyle) {
  if (turnControlStyle === "flexible_auto") return "auto";
  if (turnControlStyle === "flexible_scene") return "scene";
  return "action";
}

export function createChoiceDraftSelection(baseText = "") {
  return {
    baseText: String(baseText),
    selectedIndexes: []
  };
}

export function resetChoiceDraftSelection(text = "") {
  return createChoiceDraftSelection(text);
}

function composeChoiceDraft(baseText, selectedIndexes, choices) {
  const selectedText = selectedIndexes
    .map(index => String(choices[index] || "").trim())
    .filter(Boolean)
    .join("\n");
  if (!baseText) return selectedText;
  if (!selectedText) return baseText;
  return `${baseText}${baseText.endsWith("\n") ? "" : "\n"}${selectedText}`;
}

export function toggleChoiceDraftSelection(selection, choices, choiceIndex, currentText, maxLength) {
  const selectedIndexes = [...selection.selectedIndexes];
  const existingIndex = selectedIndexes.indexOf(choiceIndex);
  const selected = existingIndex < 0;
  if (selected) selectedIndexes.push(choiceIndex);
  else selectedIndexes.splice(existingIndex, 1);

  const baseText = selection.selectedIndexes.length ? selection.baseText : String(currentText || "");
  const text = composeChoiceDraft(baseText, selectedIndexes, choices);
  if (text.length > maxLength) {
    return {
      selection,
      text: String(currentText || ""),
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
