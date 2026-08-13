import { describe, expect, it } from "vitest";
import type { EditableWorldDraft } from "../../apps/web-next/src/world-editor-model.js";
import {
  mergeRootDraftExtras,
  mergeWorldExtras,
  rootDraftExtras,
  worldExtras
} from "../../apps/web-next/src/world-editor-extras.js";

const draft: EditableWorldDraft = {
  schemaVersion: 5,
  world: {
    title: "The Glass Observatory",
    genre: "Science fantasy",
    tone: "Numinous",
    premise: "Impossible stars gather.",
    backgroundStory: "The astronomers vanished.",
    firstAction: "Open the dome.",
    rules: "Reflections remember.",
    importedWorld: { constellation: "glass" }
  },
  playableCharacters: [],
  entities: [],
  relationships: [],
  rpgStats: [],
  defaultTriggers: [],
  eventTriggers: [],
  assets: [],
  defaults: {},
  importedRoot: { source: "archive" }
};

describe("World Editor unknown-property adapters", () => {
  it("exposes only unknown root and world properties", () => {
    expect(rootDraftExtras(draft)).toEqual({ importedRoot: { source: "archive" } });
    expect(worldExtras(draft)).toEqual({ importedWorld: { constellation: "glass" } });
  });

  it("applies root extras without allowing known fields or other unknown scopes to change", () => {
    const merged = mergeRootDraftExtras(draft, {
      schemaVersion: 99,
      world: { title: "Injected title" },
      importedRoot: { source: "edited" },
      newRootExtension: true
    });

    expect(merged.schemaVersion).toBe(5);
    expect(merged.world.title).toBe("The Glass Observatory");
    expect(merged.world.importedWorld).toEqual({ constellation: "glass" });
    expect(rootDraftExtras(merged)).toEqual({
      importedRoot: { source: "edited" },
      newRootExtension: true
    });
    expect(draft.importedRoot).toEqual({ source: "archive" });
  });

  it("applies world extras without allowing known overview fields or root extras to change", () => {
    const merged = mergeWorldExtras(draft, {
      title: "Injected title",
      importedWorld: { constellation: "edited" },
      newWorldExtension: ["kept"]
    });

    expect(merged.world.title).toBe("The Glass Observatory");
    expect(merged.importedRoot).toEqual({ source: "archive" });
    expect(worldExtras(merged)).toEqual({
      importedWorld: { constellation: "edited" },
      newWorldExtension: ["kept"]
    });
    expect(draft.world.importedWorld).toEqual({ constellation: "glass" });
  });
});
