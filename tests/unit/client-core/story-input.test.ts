import { describe, expect, it } from "vitest";
import {
  createChoiceDraftSelection,
  resetChoiceDraftSelection,
  toggleChoiceDraftSelection,
  turnInputModeForControlStyle
} from "../../../packages/client-core/src/index.js";

describe("shared Story input policy", () => {
  it("maps campaign control styles to the supported input modes", () => {
    expect(turnInputModeForControlStyle("flexible_auto")).toBe("auto");
    expect(turnInputModeForControlStyle("flexible_action")).toBe("action");
    expect(turnInputModeForControlStyle("flexible_scene")).toBe("scene");
    expect(turnInputModeForControlStyle("action_only")).toBe("action");
  });

  it("keeps duplicate choices distinct and preserves the personal draft", () => {
    const choices = ["Open the door", "Open the door"];
    const first = toggleChoiceDraftSelection(createChoiceDraftSelection("Wait"), choices, 0, "Wait", 12_000);
    const second = toggleChoiceDraftSelection(first.selection, choices, 1, first.text, 12_000);

    expect(second.selection.selectedIndexes).toEqual([0, 1]);
    expect(second.text).toBe("Wait\nOpen the door\nOpen the door");
  });

  it("removes only the deselected choice and composes selections on new lines", () => {
    const choices = ["Open the gate", "Call for the keeper"];
    const first = toggleChoiceDraftSelection(createChoiceDraftSelection("Keep watch\n"), choices, 0, "Keep watch\n", 12_000);
    const second = toggleChoiceDraftSelection(first.selection, choices, 1, first.text, 12_000);
    const deselected = toggleChoiceDraftSelection(second.selection, choices, 0, second.text, 12_000);

    expect(second.text).toBe("Keep watch\nOpen the gate\nCall for the keeper");
    expect(deselected.selection.selectedIndexes).toEqual([1]);
    expect(deselected.text).toBe("Keep watch\nCall for the keeper");
  });

  it("resets generated-choice provenance while retaining the manually edited base draft", () => {
    const reset = resetChoiceDraftSelection("Rewrite everything.");

    expect(reset).toEqual({
      baseText: "Rewrite everything.",
      selectedIndexes: []
    });
  });

  it("rejects a choice atomically when composition would exceed 12,000 characters", () => {
    const selection = createChoiceDraftSelection();
    const currentText = "x".repeat(11_999);
    const result = toggleChoiceDraftSelection(selection, ["y"], 0, currentText, 12_000);

    expect(result).toEqual({
      selection,
      text: currentText,
      selected: false,
      overLimit: true
    });
  });
});
