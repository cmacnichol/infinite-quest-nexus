import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import {
  addEditableStateRow,
  buildCampaignStateUpdate,
  canonicalFactContent,
  collectCanonicalFactEditorValues,
  collectOpenThreadEditorValues,
  normalizeCanonicalFacts,
  normalizeTextItems,
  renderEditableStateCollection
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

  it("renders, adds, removes, and collects editable continuity rows", () => {
    const { document } = parseHTML('<div id="threads"></div><div id="facts"></div>');
    const threads = document.querySelector("#threads");
    const facts = document.querySelector("#facts");
    if (!threads || !facts) throw new Error("Test containers are required.");

    renderEditableStateCollection(document, threads, ["First thread"], "thread");
    renderEditableStateCollection(document, facts, [{
      id: "00000000-0000-4000-8000-000000000001",
      content: "The lens is moon glass."
    }], "fact");

    expect(threads.querySelector("textarea")?.value).toBe("First thread");
    expect(facts.querySelector("textarea")?.value).toBe("The lens is moon glass.");
    expect(facts.querySelector(".state-editor-row")?.getAttribute("data-item-id"))
      .toBe("00000000-0000-4000-8000-000000000001");

    addEditableStateRow(document, threads, "thread", "Second thread");
    expect(collectOpenThreadEditorValues(threads)).toEqual(["First thread", "Second thread"]);

    facts.querySelector("button")?.click();
    expect(collectCanonicalFactEditorValues(facts)).toEqual([]);
  });
});
