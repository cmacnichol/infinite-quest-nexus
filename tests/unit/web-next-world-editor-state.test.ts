import { describe, expect, it } from "vitest";
import type { WorldAggregate } from "../../apps/web-next/src/world-editor-model.js";
import {
  beginDraftSave,
  completeDraftSave,
  createWorldEditorState,
  draftReadiness,
  editWorldDraft,
  failDraftSave,
  removeCollectionItem,
  restoreCollectionItem,
  validateWorldDraft
} from "../../apps/web-next/src/world-editor-state.js";

const worldAggregateFixture: WorldAggregate = {
  id: "22222222-2222-4222-8222-222222222222",
  title: "The Glass Observatory",
  status: "draft",
  imageUrl: "",
  forkedFromWorldId: null,
  forkedFromWorldVersionId: null,
  createdAt: "2026-08-11T12:00:00.000Z",
  updatedAt: "2026-08-11T12:30:00.000Z",
  draftRevision: 8,
  draftContent: {
    schemaVersion: 5,
    world: {
      title: "The Glass Observatory",
      genre: "Science fantasy",
      tone: "Numinous",
      premise: "A glass observatory watches impossible stars.",
      backgroundStory: "Its astronomers vanished.",
      firstAction: "Open the western dome.",
      rules: "Reflections remember.",
      customLore: { constellation: "The Pilgrim" }
    },
    playableCharacters: [{ id: "character-1", name: "Mara" }],
    entities: [{ id: "entity-1", name: "Western Dome" }],
    relationships: [],
    rpgStats: [],
    defaultTriggers: [],
    eventTriggers: [],
    assets: [],
    defaults: {},
    importedLore: { source: "portable-export" }
  },
  draftBasedOnWorldVersionId: null,
  draftUpdatedAt: "2026-08-11T12:30:00.000Z",
  versions: [],
  campaigns: []
};

describe("World Editor draft state", () => {
  it("edits a cloned draft without changing the authoritative aggregate or prior state", () => {
    const state = createWorldEditorState(worldAggregateFixture);
    const edited = editWorldDraft(state, ["world", "premise"], "A changed premise");

    expect(edited.status).toBe("unsaved");
    expect(edited.draft.world.premise).toBe("A changed premise");
    expect(state.draft.world.premise).not.toBe("A changed premise");
    expect(worldAggregateFixture.draftContent?.world.premise).not.toBe("A changed premise");
  });

  it("records a reversible collection removal with its original position and value", () => {
    const state = createWorldEditorState(worldAggregateFixture);
    const removed = removeCollectionItem(state, "entities", 0);

    expect(removed.draft.entities).toHaveLength(0);
    expect(removed.pendingRemovals).toHaveLength(1);
    expect(removed.pendingRemovals[0]).toMatchObject({
      collection: "entities",
      originalIndex: 0,
      value: { id: "entity-1", name: "Western Dome" }
    });

    const restored = restoreCollectionItem(removed, removed.pendingRemovals[0]!.id);
    expect(restored.draft.entities).toEqual([{ id: "entity-1", name: "Western Dome" }]);
    expect(restored.pendingRemovals).toHaveLength(0);
    expect(removed.draft.entities).toHaveLength(0);
  });

  it("allocates monotonic removal ids that are not reused after undo", () => {
    const state = editWorldDraft(createWorldEditorState(worldAggregateFixture), ["entities"], [
      { id: "a" }, { id: "b" }
    ]);
    const firstRemoval = removeCollectionItem(state, "entities", 0);
    const firstId = firstRemoval.pendingRemovals[0]!.id;
    const restored = restoreCollectionItem(firstRemoval, firstId);
    const secondRemoval = removeCollectionItem(restored, "entities", 0);

    expect(firstId).toBe("draft-removal-1");
    expect(secondRemoval.pendingRemovals[0]!.id).toBe("draft-removal-2");
    expect(restoreCollectionItem(secondRemoval, firstId)).toBe(secondRemoval);
  });

  it.each(["first-then-second", "second-then-first"] as const)(
    "restores four-item removals in exact original order when undoing %s",
    (restorationOrder) => {
      const state = editWorldDraft(createWorldEditorState(worldAggregateFixture), ["entities"], [
        { id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }
      ]);
      const withoutB = removeCollectionItem(state, "entities", 1);
      const withoutBOrC = removeCollectionItem(withoutB, "entities", 1);
      const [first, second] = withoutBOrC.pendingRemovals;
      const ids = restorationOrder === "first-then-second"
        ? [first!.id, second!.id]
        : [second!.id, first!.id];

      const partiallyRestored = restoreCollectionItem(withoutBOrC, ids[0]!);
      const restored = restoreCollectionItem(partiallyRestored, ids[1]!);

      expect(restored.draft.entities).toEqual([
        { id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }
      ]);
    }
  );

  it("returns a stable title path when the required title is blank", () => {
    const state = createWorldEditorState(worldAggregateFixture);
    const validation = validateWorldDraft(editWorldDraft(state, ["world", "title"], "  "));

    expect(validation.issues).toEqual([
      { path: "world.title", severity: "error", message: "World title is required." }
    ]);
  });

  it("rejects malformed advanced JSON before changing draft state", () => {
    const state = createWorldEditorState(worldAggregateFixture);

    expect(() => editWorldDraft(state, ["defaults"], '{"startingLocation":')).toThrow("valid JSON");
    expect(state.draft.defaults).toEqual({});
  });

  it("parses valid advanced JSON into an immutable draft edit", () => {
    const state = createWorldEditorState(worldAggregateFixture);
    const edited = editWorldDraft(state, ["defaults"], '{"startingLocation":"western-dome"}');

    expect(edited.draft.defaults).toEqual({ startingLocation: "western-dome" });
    expect(state.draft.defaults).toEqual({});
  });

  it.each([
    ["defaults", "[]", "JSON object"],
    ["playableCharacters", "{}", "JSON array"],
    ["entities", "{}", "JSON array"],
    ["relationships", "{}", "JSON array"],
    ["rpgStats", "{}", "JSON array"],
    ["defaultTriggers", "{}", "JSON array"],
    ["eventTriggers", "{}", "JSON array"],
    ["assets", "null", "JSON array"]
  ])("rejects valid JSON with the wrong %s root shape before changing state", (root, json, message) => {
    const state = createWorldEditorState(worldAggregateFixture);

    expect(() => editWorldDraft(state, [root], json)).toThrow(message);
    expect(state.draft).toEqual(worldAggregateFixture.draftContent);
  });

  it("reports all five readiness sections, warning counts, and preserved-data notices", () => {
    const state = createWorldEditorState(worldAggregateFixture);
    const readiness = draftReadiness(state);

    expect(readiness.sections).toEqual([
      { section: "Overview", ready: true, issueCount: 0 },
      { section: "Characters", ready: true, issueCount: 0 },
      { section: "Canon", ready: true, issueCount: 0 },
      { section: "Mechanics", ready: true, issueCount: 0 },
      { section: "Assets", ready: true, issueCount: 0 }
    ]);
    expect(readiness.warningCount).toBe(2);
    expect(readiness.notices).toEqual([
      { path: "world.customLore", message: "Preserved unknown data will be saved unchanged." },
      { path: "importedLore", message: "Preserved unknown data will be saved unchanged." }
    ]);
  });

  it("marks Overview not ready when title validation fails", () => {
    const state = editWorldDraft(createWorldEditorState(worldAggregateFixture), ["world", "title"], "");

    expect(draftReadiness(state).sections[0]).toEqual({ section: "Overview", ready: false, issueCount: 1 });
  });

  it("keeps a section ready when its only validation issue is a warning", () => {
    const state = editWorldDraft(createWorldEditorState(worldAggregateFixture), ["world", "premise"], "");

    expect(validateWorldDraft(state).issues).toContainEqual({
      path: "world.premise",
      severity: "warning",
      message: "A world premise is recommended."
    });
    expect(draftReadiness(state).sections[0]).toEqual({ section: "Overview", ready: true, issueCount: 1 });
  });

  it("transitions through saving and completes with the server revision and content", () => {
    const state = editWorldDraft(createWorldEditorState(worldAggregateFixture), ["world", "premise"], "Changed");
    const saving = beginDraftSave(state);
    const savedContent = { ...saving.draft, world: { ...saving.draft.world, title: "Saved title" } };
    const saved = completeDraftSave(saving, { revision: 9, content: savedContent });

    expect(saving.status).toBe("saving");
    expect(saved.status).toBe("saved");
    expect(saved.revision).toBe(9);
    expect(saved.draft.world.title).toBe("Saved title");
    expect(saved.pendingRemovals).toEqual([]);
    expect(state.status).toBe("unsaved");
  });

  it("preserves the local draft when a save fails", () => {
    const state = editWorldDraft(createWorldEditorState(worldAggregateFixture), ["world", "premise"], "Changed");
    const saving = beginDraftSave(state);
    const failed = failDraftSave(saving, "conflict", "Reload required");

    expect(failed.status).toBe("error");
    expect(failed.saveError).toEqual({ kind: "conflict", message: "Reload required" });
    expect(failed.draft).toEqual(state.draft);
    expect(saving.status).toBe("saving");
  });
});
