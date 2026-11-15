import { describe, expect, it } from "vitest";
import { playableCharacterSchema } from "@infinite-quest/contracts";
import { filterWorldCharacters, sectionsForContext, summarizeEditorSections, worldCharacterSummary, type EditorSectionSummary } from "../../packages/client-core/src/characters/authoring-presentation.js";

const character = (id: string, campaignUse = "playable", personality = "") => playableCharacterSchema.parse({ id, name: id, campaignUse, profile: { story: { personality, role: "Guide" }, identity: { aliases: ["Watcher"] } } });
describe("character presentation policy", () => {
  it("accepts the agreed read-only Sources summary shape", () => {
    const summary: EditorSectionSummary = { id: "sources", label: "Sources and history", detail: "Not added", populated: 0, errors: 0 };
    expect(summary.id).toBe("sources");
  });
  it("prefers structured summary and bounds Unicode display without mutating", () => {
    expect(worldCharacterSummary(character("Mira", "playable", "Patient guide"))).toBe("Patient guide");
    const value = character("Mira", "playable", "😀".repeat(161));
    expect(worldCharacterSummary(value)).toBe("😀".repeat(160) + "…");
    expect(value.profile!.story.personality).toBe("😀".repeat(161));
  });
  it("filters exact use and searches aliases and roles in authored order", () => {
    const roster = [character("A"), character("B", "supporting"), character("C", "both")];
    expect(filterWorldCharacters(roster, { query: "watcher", use: "supporting" }).map(x => x.id)).toEqual(["B"]);
    expect(filterWorldCharacters(roster, { query: "guide", use: "all" })).toEqual(roster);
  });
  it("searches sparse imported profiles safely and keeps duplicate-name IDs in order", () => {
    const roster = [{ id: "one", name: "Mira", profile: { story: { role: "Guide" } } }, { id: "two", name: "Mira", profile: {} }] as any;
    expect(filterWorldCharacters(roster, { query: "mira", use: "all" }).map(row => row.id)).toEqual(["one", "two"]);
    expect(worldCharacterSummary(roster[1])).toBe("");
  });
  it("assigns fields once, counts populated fields and separates mechanics counts", () => {
    const summaries = summarizeEditorSections("world-draft", { name: "Mira", "story.role": "Guide", "story.personality": "Patient", "identity.aliases": ["A", "B"] }, ["identity.aliases"], { statistics: 2, trackers: 3 });
    expect(summaries.find(x => x.id === "overview")).toMatchObject({ populated: 3, detail: "3 details" });
    expect(summaries.find(x => x.id === "identity")).toMatchObject({ populated: 1, errors: 1, hasErrors: true });
    expect(summaries.find(x => x.id === "mechanics")!.detail).toBe("2 statistics, 3 trackers");
    expect(sectionsForContext("campaign-supporting")).not.toContain("mechanics");
    expect(sectionsForContext("world-draft")).not.toContain("sources");
  });
});
