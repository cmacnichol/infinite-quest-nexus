import { describe, expect, it } from "vitest";
import {
  buildCampaignStateUpdate,
  canonicalFactContent,
  normalizeCanonicalFacts,
  normalizeTextItems
} from "../../apps/web/public/story-state-editor.js";

describe("Story Player campaign state editor", () => {
  it("renders structured canonical facts by content", () => {
    expect(canonicalFactContent({
      id: "00000000-0000-4000-8000-000000000001",
      content: "The lens is moon glass."
    })).toBe("The lens is moon glass.");
    expect(canonicalFactContent("Legacy fact")).toBe("Legacy fact");
    expect(canonicalFactContent({ invalid: true })).toBe("");
  });

  it("trims text collections and omits blank rows", () => {
    expect(normalizeTextItems([" First thread ", "", "   ", "Second thread"])).toEqual([
      "First thread",
      "Second thread"
    ]);
  });

  it("preserves canonical IDs and assigns null to new facts", () => {
    expect(normalizeCanonicalFacts([
      { id: "00000000-0000-4000-8000-000000000001", content: " Existing fact " },
      { id: "", content: " New fact " },
      { id: null, content: " " }
    ])).toEqual([
      { id: "00000000-0000-4000-8000-000000000001", content: "Existing fact" },
      { id: null, content: "New fact" }
    ]);
  });

  it("builds a complete update while preserving loaded mechanics", () => {
    const payload = buildCampaignStateUpdate({
      activeTurnNumber: 4,
      revision: 7,
      rpgStats: [{ id: "resolve", name: "Resolve", value: 61, note: "" }],
      eventTriggers: [{ id: "lens-lit" }],
      pendingEventTriggers: [{ id: "sea-road" }]
    }, {
      continuitySummary: " Corrected summary. ",
      openThreads: [" Find the keeper. ", ""],
      canonicalFacts: [{
        id: "00000000-0000-4000-8000-000000000001",
        content: " The lens is moon glass. "
      }],
      scratchpad: "Private continuity.",
      trackers: [{ id: "trust", name: "Trust", value: "wary", rules: "" }]
    });

    expect(payload).toEqual({
      expectedTurnNumber: 4,
      expectedRevision: 7,
      continuitySummary: " Corrected summary. ",
      openThreads: ["Find the keeper."],
      canonicalFacts: [{
        id: "00000000-0000-4000-8000-000000000001",
        content: "The lens is moon glass."
      }],
      scratchpad: "Private continuity.",
      trackers: [{ id: "trust", name: "Trust", value: "wary", rules: "" }],
      rpgStats: [{ id: "resolve", name: "Resolve", value: 61, note: "" }],
      eventTriggers: [{ id: "lens-lit" }],
      pendingEventTriggers: [{ id: "sea-road" }]
    });
  });
});
