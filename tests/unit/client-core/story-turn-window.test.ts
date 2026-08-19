import { describe, expect, it } from "vitest";
import {
  activeTurnNumber,
  appendExpectedTurnNumber,
  latestTurnNumber,
  recentTurnSpine,
  selectedTurnNumber,
  turnIndexForNumber,
  undoTargetTurnNumber
} from "../../../packages/client-core/src/index.js";

describe("shared Story turn-window policy", () => {
  it("uses persisted turn numbers for campaign commands and transient indexes", () => {
    const turns = [
      { id: "turn-51", turnNumber: 51 },
      { id: "turn-75", turnNumber: 75 },
      { id: "turn-100", turnNumber: 100 }
    ];

    expect(activeTurnNumber({ activeTurnNumber: 100 })).toBe(100);
    expect(appendExpectedTurnNumber({ activeTurnNumber: 100 })).toBe(101);
    expect(undoTargetTurnNumber({ activeTurnNumber: 100 })).toBe(99);
    expect(latestTurnNumber(turns)).toBe(100);
    expect(selectedTurnNumber(turns, 1)).toBe(75);
    expect(turnIndexForNumber(turns, 75)).toBe(1);
    expect(turnIndexForNumber(turns, 50)).toBe(-1);
  });

  it("returns the campaign's latest five persisted turns while older history is inspected", () => {
    const turns = [28, 21, 26, 24, 22, 27, 23, 25].map((turnNumber) => ({ turnNumber }));

    expect(recentTurnSpine(turns).map((turn) => turn.turnNumber)).toEqual([24, 25, 26, 27, 28]);
  });
});
