import { describe, expect, it } from "vitest";
import {
  activeTurnNumber,
  appendExpectedTurnNumber,
  latestTurnNumber,
  recentTurnSpine,
  selectedTurnNumber,
  turnIndexForNumber,
  undoTargetTurnNumber
} from "../../apps/web/src/story-turn-window.js";
import {
  activeTurnNumber as activeSharedTurnNumber,
  appendExpectedTurnNumber as appendExpectedSharedTurnNumber,
  latestTurnNumber as latestSharedTurnNumber,
  recentTurnSpine as recentSharedTurnSpine,
  selectedTurnNumber as selectedSharedTurnNumber,
  turnIndexForNumber as turnIndexForSharedNumber,
  undoTargetTurnNumber as undoTargetSharedTurnNumber
} from "../../packages/client-core/src/index.js";

const windowTurns = Array.from({ length: 50 }, (_, offset) => ({
  id: `turn-${offset + 51}`,
  turnNumber: offset + 51
}));

describe("Story Player bounded turn window commands", () => {
  it("re-exports the shared persisted-turn policy", () => {
    expect(activeTurnNumber).toBe(activeSharedTurnNumber);
    expect(appendExpectedTurnNumber).toBe(appendExpectedSharedTurnNumber);
    expect(undoTargetTurnNumber).toBe(undoTargetSharedTurnNumber);
    expect(latestTurnNumber).toBe(latestSharedTurnNumber);
    expect(selectedTurnNumber).toBe(selectedSharedTurnNumber);
    expect(turnIndexForNumber).toBe(turnIndexForSharedNumber);
    expect(recentTurnSpine).toBe(recentSharedTurnSpine);
  });

  it("declares the generic latest-five facade for typed legacy callers", () => {
    const spine = recentTurnSpine([
      { id: "turn-28", turnNumber: 28 },
      { id: "turn-24", turnNumber: 24 }
    ]);
    const firstId: string = spine[0]!.id;

    expect(firstId).toBe("turn-24");
  });

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
