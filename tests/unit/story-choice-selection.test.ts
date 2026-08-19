import { describe, expect, it } from "vitest";
import {
  createChoiceDraftSelection,
  resetChoiceDraftSelection,
  turnInputModeForControlStyle,
  toggleChoiceDraftSelection
// @ts-expect-error Browser JavaScript modules intentionally do not publish TypeScript declarations.
} from "../../apps/web/src/story-choice-selection.js";
import {
  createChoiceDraftSelection as createSharedChoiceDraftSelection,
  resetChoiceDraftSelection as resetSharedChoiceDraftSelection,
  turnInputModeForControlStyle as turnInputModeForSharedControlStyle,
  toggleChoiceDraftSelection as toggleSharedChoiceDraftSelection
} from "../../packages/client-core/src/index.js";

describe("legacy Story Player generated choice selection", () => {
  it("re-exports the shared Story input policy", () => {
    expect(turnInputModeForControlStyle).toBe(turnInputModeForSharedControlStyle);
    expect(createChoiceDraftSelection).toBe(createSharedChoiceDraftSelection);
    expect(resetChoiceDraftSelection).toBe(resetSharedChoiceDraftSelection);
    expect(toggleChoiceDraftSelection).toBe(toggleSharedChoiceDraftSelection);
  });

  it("maps every campaign turn-control preference to its generated-choice input mode", () => {
    expect(turnInputModeForControlStyle("flexible_auto")).toBe("auto");
    expect(turnInputModeForControlStyle("flexible_action")).toBe("action");
    expect(turnInputModeForControlStyle("flexible_scene")).toBe("scene");
    expect(turnInputModeForControlStyle("action_only")).toBe("action");
  });

  it("preserves the existing draft while selecting and deselecting multiple choices", () => {
    const choices = ["Open the gate.", "Call for the keeper.", "Open the gate."];
    let selection = createChoiceDraftSelection();

    const first = toggleChoiceDraftSelection(selection, choices, 0, "Keep watch.", 12_000);
    selection = first.selection;
    expect(first).toMatchObject({
      text: "Keep watch.\nOpen the gate.",
      selected: true,
      overLimit: false
    });

    const second = toggleChoiceDraftSelection(selection, choices, 1, first.text, 12_000);
    selection = second.selection;
    expect(second.text).toBe("Keep watch.\nOpen the gate.\nCall for the keeper.");
    expect(second.selection.selectedIndexes).toEqual([0, 1]);

    const deselected = toggleChoiceDraftSelection(selection, choices, 0, second.text, 12_000);
    expect(deselected.text).toBe("Keep watch.\nCall for the keeper.");
    expect(deselected.selection.selectedIndexes).toEqual([1]);

    const duplicate = toggleChoiceDraftSelection(deselected.selection, choices, 2, deselected.text, 12_000);
    expect(duplicate.text).toBe("Keep watch.\nCall for the keeper.\nOpen the gate.");
    expect(duplicate.selection.selectedIndexes).toEqual([1, 2]);
  });

  it("leaves the draft and selection unchanged when another choice would exceed the limit", () => {
    const selection = createChoiceDraftSelection();
    const result = toggleChoiceDraftSelection(selection, ["Too much."], 0, "x".repeat(11_995), 12_000);

    expect(result.overLimit).toBe(true);
    expect(result.text).toBe("x".repeat(11_995));
    expect(result.selection).toEqual(selection);
  });

  it("accepts a composed draft exactly at the character limit", () => {
    const result = toggleChoiceDraftSelection(
      createChoiceDraftSelection(),
      ["y"],
      0,
      "x".repeat(11_998),
      12_000
    );

    expect(result.overLimit).toBe(false);
    expect(result.text).toHaveLength(12_000);
    expect(result.selection.selectedIndexes).toEqual([0]);
  });

  it("makes a manually edited draft authoritative by clearing generated selections", () => {
    const selection = {
      baseText: "Keep watch.",
      selectedIndexes: [0, 1]
    };

    expect(resetChoiceDraftSelection("Rewrite everything.")).toEqual({
      baseText: "Rewrite everything.",
      selectedIndexes: []
    });
    expect(selection.selectedIndexes).toEqual([0, 1]);
  });
});
