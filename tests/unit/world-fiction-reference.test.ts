import { describe, expect, it } from "vitest";
import { selectWorldFictionReferences, WORLD_FICTION_REFERENCE_SHAPE_TABLE } from "../../packages/domain/src/world-fiction-reference.js";

describe("pinned world fiction references", () => {
  it("selects a complete sibling relationship after direct alias matches without flooding the roster", () => {
    const result = selectWorldFictionReferences({
      worldVersionId: "00000000-0000-4000-8000-000000000001",
      worldContent: {
        world: { title: "Harbor", rules: "The sea is sacred." },
        entities: [
          { id: "captain", name: "Captain Vale", aliases: ["Vale"], description: "A retired navigator." },
          { key: "quay", title: "Moon Quay", summary: "A fogbound pier." },
          { id: "unrelated", name: "Unrelated Guard", description: "Never enters this scene." }
        ],
        relationships: [{ id: "oath", from: "captain", to: "quay", description: "Vale swore to protect Moon Quay." }]
      },
      direction: "Ask Vale about Moon Quay.", currentScene: "Fog gathers at the quay.", openThreads: [], selectedCharacterAliases: []
    });

    expect(result.entries.map((entry) => entry.sourcePath)).toEqual(["/entities/0", "/entities/1", "/relationships/0"]);
    expect(result.entries.map((entry) => entry.content)).toEqual(expect.arrayContaining([
      expect.stringContaining("retired navigator"), expect.stringContaining("swore to protect")
    ]));
    expect(JSON.stringify(result)).not.toContain("Unrelated Guard");
  });

  it("keeps ambiguous aliases, unsupported shapes, missing endpoints and oversized records out with safe reasons", () => {
    const result = selectWorldFictionReferences({
      worldVersionId: "00000000-0000-4000-8000-000000000001",
      worldContent: { entities: [
        { id: "one", name: "Warden", description: "First." }, { id: "two", name: "Warden", description: "Second." },
        { id: "large", name: "Large", description: "x".repeat(30_000) }, { mystery: { hidden: "raw" } }
      ], relationships: [{ from: "one", to: "missing", description: "Broken." }, { source: { nested: true } }] },
      direction: "Speak with Warden and Large.", currentScene: "", openThreads: [], selectedCharacterAliases: []
    });
    expect(result.entries).toEqual([]);
    expect(result.omissions).toEqual(expect.objectContaining({ ambiguousAliasCount: 1, oversizedRecordCount: 1, unrecognizedRecordCount: 2, missingEndpointCount: 1 }));
  });

  it("recognizes each documented legacy identity, display, relationship endpoint and fiction shape", () => {
    const result = selectWorldFictionReferences({
      worldVersionId: "00000000-0000-4000-8000-000000000001",
      worldContent: {
        entities: [
          { id: "one", name: "One", description: "First lore." },
          { key: "two", title: "Two", summary: "Second lore." },
          { id: "three", label: "Three", background: "Third lore." },
          { id: "four", name: "Four", lore: "Fourth lore." },
          { id: "five", name: "Five", details: "Fifth lore." },
          { id: "six", name: "Six", notes: "Sixth lore." },
          { id: "seven", name: "Seven", role: "Seventh lore." }
        ],
        relationships: [
          { id: "a", from: "one", to: "two", description: "one to two" },
          { key: "b", source: "two", target: "three", summary: "two to three" },
          { fromId: "three", toId: "four", background: "three to four" },
          { sourceId: "four", targetId: "five", lore: "four to five" }
        ]
      },
      direction: "One Two Three Four Five Six Seven", currentScene: "", openThreads: [], selectedCharacterAliases: []
    });

    expect(WORLD_FICTION_REFERENCE_SHAPE_TABLE).toMatchObject({ stableIdentity: ["id", "key"], displayIdentity: ["name", "title", "label"] });
    expect(result.entries.map((entry) => entry.sourcePath)).toEqual([
      "/entities/0", "/entities/1", "/entities/2", "/entities/3", "/entities/4", "/entities/5", "/entities/6",
      "/relationships/0", "/relationships/1", "/relationships/2", "/relationships/3"
    ]);
  });

  it("uses whole-phrase selected-character aliases and rejects substring collisions", () => {
    const input = {
      worldVersionId: "00000000-0000-4000-8000-000000000001",
      worldContent: { entities: [
        { id: "vale", name: "Vale", description: "A captain." },
        { id: "other", name: "Other", description: "A stranger." }
      ], relationships: [{ id: "oath", from: "vale", to: "other", description: "They share an oath." }] },
      direction: "The weather is unavailable.", currentScene: "", openThreads: []
    };
    expect(selectWorldFictionReferences({ ...input, selectedCharacterAliases: [] }).entries).toEqual([]);
    expect(selectWorldFictionReferences({ ...input, selectedCharacterAliases: ["Vale"] }).entries.map((entry) => entry.sourcePath)).toEqual(["/entities/0", "/relationships/0"]);
  });

  it("bounds maximum-sized source arrays deterministically without selecting unsupported or duplicate aliases", () => {
    const entities = Array.from({ length: 80 }, (_, index) => ({ id: `guard-${index}`, name: `Guard ${index}`, description: `Relevant watch ${index}.` }));
    const result = selectWorldFictionReferences({
      worldVersionId: "00000000-0000-4000-8000-000000000001",
      worldContent: { entities, relationships: Array.from({ length: 80 }, (_, index) => ({ id: `r-${index}`, from: `guard-${index}`, to: `guard-${(index + 1) % 80}`, description: `Link ${index}.` })) },
      direction: entities.map((entity) => entity.name).join(" "), currentScene: "", openThreads: [], selectedCharacterAliases: []
    });
    expect(result.entries.filter((entry) => entry.kind === "entity")).toHaveLength(24);
    expect(result.entries.filter((entry) => entry.kind === "relationship")).toHaveLength(32);
    expect(result.omissions).toEqual(expect.objectContaining({ entityCapCount: 56, relationshipCapCount: 48 }));
  });
});
