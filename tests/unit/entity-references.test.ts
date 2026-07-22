import { describe, expect, it } from "vitest";
import {
  buildScopedEntityCatalog,
  entityQueryTerms,
  expandEntityQuery,
  extractCapitalizationFallback,
  findEntityReferences,
  normalizeEntityTerm,
  resolveEntityMetadata
} from "../../packages/domain/src/entity-references.js";

describe("scoped entity references", () => {
  it("tolerantly builds stable references from world entities and a character snapshot", () => {
    const catalog = buildScopedEntityCatalog({
      worldContent: {
        entities: [
          { id: "faction-1", name: "The Ashen Guard", aliases: ["Ash Guard", "  Ash Guard  "], kind: "faction" },
          { key: "city-1", title: "Lumé Port", alias: "The Port", type: "location" },
          { label: "Nameless Wood" },
          null,
          { id: "invalid" }
        ]
      },
      characterSnapshot: { key: "hero-1", label: "Éowyn Vale", aliases: ["Shield Maiden"] }
    });

    expect(catalog).toEqual([
      { id: "world:faction-1", displayName: "The Ashen Guard", aliases: ["The Ashen Guard", "Ash Guard"], kind: "faction", source: "world" },
      { id: "world:city-1", displayName: "Lumé Port", aliases: ["Lumé Port", "The Port"], kind: "location", source: "world" },
      { id: "world:entity:nameless-wood", displayName: "Nameless Wood", aliases: ["Nameless Wood"], kind: "entity", source: "world" },
      { id: "character:hero-1", displayName: "Éowyn Vale", aliases: ["Éowyn Vale", "Shield Maiden"], kind: "character", source: "character" }
    ]);
  });

  it("also accepts keyed entity maps and positional arguments", () => {
    const catalog = buildScopedEntityCatalog(
      { entities: { moon: { name: "Silver Moon", kind: "artifact" } } },
      { id: "hero", name: "Ada" }
    );
    expect(catalog.map(({ id, displayName }) => ({ id, displayName }))).toEqual([
      { id: "world:moon", displayName: "Silver Moon" },
      { id: "character:hero", displayName: "Ada" }
    ]);
  });

  it("normalizes Unicode compatibility forms, case, and whitespace", () => {
    expect(normalizeEntityTerm("  ＴHE\tCafé  ")).toBe("the café");
  });

  it("matches whole phrases longest-first", () => {
    const catalog = buildScopedEntityCatalog({ worldContent: { entities: [
      { id: "guard", name: "Guard" },
      { id: "red-guard", name: "Red Guard" }
    ] } });

    expect(findEntityReferences("The RED   GUARD arrived; guarded doors stayed shut.", catalog).map((entry) => entry.id))
      .toEqual(["world:red-guard"]);
  });

  it("does not resolve an alias shared by multiple scoped entities", () => {
    const catalog = buildScopedEntityCatalog({ worldContent: { entities: [
      { id: "north", name: "Northern Watch", alias: "the Watch" },
      { id: "south", name: "Southern Watch", aliases: ["the Watch"] }
    ] } });

    expect(findEntityReferences("Ask the Watch.", catalog)).toEqual([]);
    expect(findEntityReferences("Ask Northern Watch.", catalog).map((entry) => entry.id)).toEqual(["world:north"]);
  });

  it("expands queries only with aliases for entities actually mentioned", () => {
    const catalog = buildScopedEntityCatalog({ worldContent: { entities: [
      { id: "guard", name: "The Ashen Guard", aliases: ["Ash Guard", "Cinder Shields"] },
      { id: "port", name: "Lumé Port", alias: "The Port" }
    ] } });

    expect(entityQueryTerms("Where did the Ash Guard go?", catalog))
      .toEqual(["The Ashen Guard", "Ash Guard", "Cinder Shields"]);
    expect(expandEntityQuery("Where did the Ash Guard go?", catalog))
      .toBe("Where did the Ash Guard go? The Ashen Guard Ash Guard Cinder Shields");
  });

  it("returns capitalization-based discoveries separately from known references", () => {
    const catalog = buildScopedEntityCatalog({ worldContent: { entities: [
      { id: "guard", name: "Ashen Guard" }
    ] } });
    expect(extractCapitalizationFallback("Mara greeted the Ashen Guard beside River Gate.", catalog))
      .toEqual(["Mara", "River Gate"]);
  });

  it("keeps stable IDs separate from prompt-safe display names and discoveries", () => {
    const catalog = buildScopedEntityCatalog({ worldContent: { entities: [
      { id: "guard", name: "Ashen Guard", alias: "Cinder Shields" }
    ] } });
    expect(resolveEntityMetadata("Mara warned the Cinder Shields.", catalog)).toEqual({
      entityIds: ["world:guard"],
      entities: ["Ashen Guard", "Mara"]
    });
  });
});
