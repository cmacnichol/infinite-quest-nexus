import { describe, expect, it } from "vitest";
import {
  collectionItemSummary,
  mergeStructuredFields,
  parseAdvancedJson,
  serializeAdvancedJson,
  structuredFieldsFor
} from "../../apps/web-next/src/world-editor-fields.js";

describe("World Editor field adapters", () => {
  it.each([
    ["entity", { title: "Glass Dome", kind: "location", notes: "Faces west." }, { name: "Glass Dome", type: "location", description: "Faces west." }],
    ["relationship", { from: "dome", targetId: "star", kind: "observes", notes: "At dusk." }, { source: "dome", target: "star", type: "observes", description: "At dusk." }],
    ["stat", { skill: "Resolve", score: 7, covers: "Fear" }, { name: "Resolve", value: 7, note: "Fear" }],
    ["trigger", { label: "Dusk", when: "Sun sets", rules: "Open dome" }, { name: "Dusk", condition: "Sun sets", effect: "Open dome" }]
  ] as const)("reads %s aliases into canonical structured fields", (kind, record, expected) => {
    expect(structuredFieldsFor(kind, record)).toEqual(expected);
  });

  it("merges structured changes into a clone using existing aliases and preserving extras", () => {
    const original = {
      id: "entity-1",
      title: "Glass Dome",
      kind: "location",
      notes: "Faces west.",
      importedExtension: { keep: true }
    };

    const merged = mergeStructuredFields("entity", original, {
      name: "Western Dome",
      type: "observatory",
      description: "Opens at dusk."
    });

    expect(merged).toEqual({
      id: "entity-1",
      title: "Western Dome",
      kind: "observatory",
      notes: "Opens at dusk.",
      importedExtension: { keep: true }
    });
    expect(merged).not.toBe(original);
    expect(merged.importedExtension).not.toBe(original.importedExtension);
    expect(merged).not.toHaveProperty("name");
    expect(merged).not.toHaveProperty("type");
    expect(merged).not.toHaveProperty("description");
  });

  it("exposes character guidance, profile groups, stats, and default trackers without dropping extensions", () => {
    const character = {
      id: "mara",
      name: "Mara",
      characterText: "A patient observer.",
      profile: { identity: { pronouns: "she/her" }, importedGroup: { keep: true } },
      rpgStats: [{ id: "resolve", value: 7 }],
      defaultTriggers: [{ id: "torch", value: "lit" }],
      importedExtension: true
    };

    expect(structuredFieldsFor("character", character)).toEqual({
      name: "Mara",
      narrativeGuidance: "A patient observer.",
      profileGroups: character.profile,
      stats: character.rpgStats,
      defaultTrackers: character.defaultTriggers
    });
    expect(mergeStructuredFields("character", character, {
      narrativeGuidance: "A decisive observer.",
      profileGroups: { ...character.profile, story: { role: "Scout" } }
    })).toMatchObject({
      characterText: "A decisive observer.",
      profile: { importedGroup: { keep: true }, story: { role: "Scout" } },
      importedExtension: true
    });
  });

  it("returns field errors for malformed JSON and wrong root shapes without throwing", () => {
    expect(parseAdvancedJson("{", "object")).toEqual({ value: null, error: "Enter valid JSON." });
    expect(parseAdvancedJson("[]", "object")).toEqual({ value: null, error: "Expected a JSON object." });
    expect(parseAdvancedJson("{}", "array")).toEqual({ value: null, error: "Expected a JSON array." });
    expect(parseAdvancedJson('[{"name":"Mara"}]', "array")).toEqual({
      value: [{ name: "Mara" }],
      error: null
    });
  });

  it("serializes advanced values deterministically without changing them", () => {
    const value = { imported: { preserve: true }, list: [1, "two"] };
    expect(serializeAdvancedJson(value)).toBe(`${JSON.stringify(value, null, 2)}\n`);
    expect(value).toEqual({ imported: { preserve: true }, list: [1, "two"] });
  });

  it("keeps summaries useful for empty, scalar, and legacy records", () => {
    expect(collectionItemSummary("entity", {}, 0)).toBe("Untitled entity · Item 1");
    expect(collectionItemSummary("entity", { title: "Western Dome", kind: "location" }, 1)).toBe("Western Dome · location");
    expect(collectionItemSummary("relationship", { from: "dome", to: "star" }, 2)).toBe("dome → star · relationship");
    expect(collectionItemSummary("asset", "legacy-cover.png", 3)).toBe("legacy-cover.png · Asset 4");
  });
});
