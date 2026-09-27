import { describe, expect, it } from "vitest";
import { ledgerDirectionExcerpt, selectStoryLedger } from "../../packages/application/src/memory/story-history-ledger.js";
import { estimateTokens, stableStringify } from "../../packages/domain/src/index.js";
import { generationContextAuthoritySchema } from "../../packages/application/src/memory/generation-context.js";

describe("story history intent ledger", () => {
  it("normalizes safe player directions, preserves chronology, and selects a newest whole suffix", () => {
    const expectedEntries = [
      { turnId: "two", turnNumber: 2, inputMode: "action" as const, direction: "Ask the keeper." },
      { turnId: "three", turnNumber: 3, inputMode: "scene" as const, direction: "Continue." }
    ];
    const ledger = selectStoryLedger([
      { turnId: "three", turnNumber: 3, inputMode: "scene", action: "  Continue.  " },
      { turnId: "one", turnNumber: 1, inputMode: "action", action: "  Take the lantern.  " },
      { turnId: "two", turnNumber: 2, inputMode: "action", action: "[roll d20] Ask the keeper.  " }
    ], { budgetTokens: estimateTokens(stableStringify({ version: "story-ledger-v1", entries: expectedEntries, omittedThroughTurn: 1 })), directionCharacters: 480 });

    expect(ledger).toEqual({
      version: "story-ledger-v1",
      entries: expectedEntries,
      omittedThroughTurn: 1
    });
  });

  it("keeps the ellipsis inside the exact 480-character direction boundary without splitting Unicode", () => {
    const source = `${"The lantern \u{1F3EE} burns beside the bridge. ".repeat(40)}END`;
    const excerpt = ledgerDirectionExcerpt(source, 480);

    expect(excerpt.length).toBeLessThanOrEqual(480);
    expect(excerpt.endsWith("…")).toBe(true);
    expect(excerpt).not.toMatch(/[\uD800-\uDBFF]$/u);
    expect(excerpt).not.toContain("END");
  });

  it("omits empty, whitespace, and mechanics-only directions without treating them as facts or events", () => {
    const ledger = selectStoryLedger([
      { turnId: "one", turnNumber: 1, inputMode: "action", action: "   " },
      { turnId: "two", turnNumber: 2, inputMode: "scene", action: "[roll d20] [difficulty 17]" }
    ], { budgetTokens: 100, directionCharacters: 480 });

    expect(ledger).toEqual({ version: "story-ledger-v1", entries: [], omittedThroughTurn: 2 });
    expect(JSON.stringify(ledger)).not.toMatch(/fact|event/i);
  });

  it("returns no entries when its exact serialized budget cannot fit a whole entry", () => {
    const ledger = selectStoryLedger([
      { turnId: "one", turnNumber: 1, inputMode: "action", action: "Open the sealed gate." }
    ], { budgetTokens: 0, directionCharacters: 480 });

    expect(ledger).toEqual({ version: "story-ledger-v1", entries: [], omittedThroughTurn: 1 });
  });

  it("admits an optional ledger authority without letting its entry name a fact or accepted event", () => {
    const result = generationContextAuthoritySchema.safeParse({
      rules: [], worldCanon: {}, selectedCharacterId: null, currentContinuity: { continuitySummary: "", openThreads: [], canonicalFacts: [], scratchpad: "", trackers: [], rpgStats: [], eventTriggers: [], pendingEventTriggers: [] },
      scratchpad: "", openThreads: [], canonicalFacts: [], trackers: [], rpgStats: [], eventTriggers: [], pendingEventTriggers: [], latestTurn: null,
      storyLedger: { version: "story-ledger-v1", entries: [{ turnId: "turn-1", turnNumber: 1, inputMode: "action", direction: "Ask the keeper." }], omittedThroughTurn: null }
    });

    expect(result.success).toBe(true);
    if (result.success) expect(JSON.stringify(result.data.storyLedger)).not.toMatch(/fact|event/i);
  });

  it("requires bounded omission coverage when a loader supplies it", () => {
    const result = generationContextAuthoritySchema.safeParse({
      rules: [], worldCanon: {}, selectedCharacterId: null, currentContinuity: { continuitySummary: "", openThreads: [], canonicalFacts: [], scratchpad: "", trackers: [], rpgStats: [], eventTriggers: [], pendingEventTriggers: [] },
      scratchpad: "", openThreads: [], canonicalFacts: [], trackers: [], rpgStats: [], eventTriggers: [], pendingEventTriggers: [], latestTurn: null,
      storyLedger: { version: "story-ledger-v1", entries: [], omittedThroughTurn: 2,
        coverage: { unreadThroughTurn: 2, missingTurnCount: 1, filteredDirectionCount: 3, oversizedDirectionCount: 4, loadedRows: 512 } }
    });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.storyLedger?.coverage).toEqual({ unreadThroughTurn: 2, missingTurnCount: 1, filteredDirectionCount: 3, oversizedDirectionCount: 4, loadedRows: 512 });
  });
});
