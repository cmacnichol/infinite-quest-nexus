import { describe, expect, it } from "vitest";
import {
  appendExpectedTurnNumber,
  latestTurnNumber,
  selectedTurnNumber,
  turnIndexForNumber,
  undoTargetTurnNumber
} from "../../apps/web/src/story-turn-window.js";

const windowTurns = Array.from({ length: 50 }, (_, offset) => ({
  id: `turn-${offset + 51}`,
  turnNumber: offset + 51
}));

describe("Story Player bounded turn window commands", () => {
  it("keeps append, undo, retry, inspection, and branch targets in absolute campaign turn numbers", () => {
    expect(appendExpectedTurnNumber({ activeTurnNumber: 100 })).toBe(101);
    expect(undoTargetTurnNumber({ activeTurnNumber: 100 })).toBe(99);
    expect(latestTurnNumber(windowTurns)).toBe(100);
    expect(selectedTurnNumber(windowTurns, 0)).toBe(51);
    expect(selectedTurnNumber(windowTurns, 49)).toBe(100);
  });

  it("derives transient indexes from absolute campaign turn numbers", () => {
    expect(turnIndexForNumber(windowTurns, 51)).toBe(0);
    expect(turnIndexForNumber(windowTurns, 75)).toBe(24);
    expect(turnIndexForNumber(windowTurns, 100)).toBe(49);
    expect(turnIndexForNumber(windowTurns, 50)).toBe(-1);
    expect(turnIndexForNumber(windowTurns, null)).toBe(-1);
  });
});
