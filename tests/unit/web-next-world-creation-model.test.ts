import { describe, expect, it } from "vitest";
import {
  addCreationCollectionItem,
  applyGeneratedPreview,
  beginCreation,
  completeCreation,
  createWorldCreationState,
  creationReadiness,
  creationStageProgress,
  editCreationDraft,
  failCreation,
  hasLocalWorldCreationContent,
  isWorldCreationPath,
  removeCreationCollectionItem,
  restoreCreationCollectionItem,
  selectCreationMethod,
  setCreationStage,
  updateCreationCollectionItem,
  validateCreationStage,
  worldCreationPath
} from "../../apps/web-next/src/world-creation-model.js";

const providerDraft = {
  schemaVersion: 4,
  world: {
    title: "Provider title",
    genre: "Science fantasy",
    tone: "Numinous",
    premise: "A glass city follows a migrating star.",
    backgroundStory: "The city remembers every prior orbit.",
    firstAction: "Open the observatory.",
    rules: "Reflections retain promises."
  },
  playableCharacters: [],
  entities: [{ id: "city", name: "The Glass City" }],
  relationships: [],
  rpgStats: [],
  defaultTriggers: [],
  eventTriggers: [],
  assets: [],
  defaults: {}
};

describe("World Creation local workflow", () => {
  it("reserves one exact creation route and starts with an empty canonical draft", () => {
    expect(worldCreationPath()).toBe("/app/worlds/new");
    expect(isWorldCreationPath("/app/worlds/new")).toBe(true);
    expect(isWorldCreationPath("/app/worlds/new/")).toBe(false);

    const state = createWorldCreationState();
    expect(state.stage).toBe("method");
    expect(state.method).toBeNull();
    expect(state.draft.schemaVersion).toBe(5);
    expect(state.draft.playableCharacters).toEqual([]);
    expect(state.status).toBe("pristine");
    expect(state.navigationDirty).toBe(false);
  });

  it("selects a method and edits nested fields without mutating prior states", () => {
    const initial = createWorldCreationState();
    const selected = selectCreationMethod(initial, "manual");
    const edited = editCreationDraft(selected, ["world", "title"], "Glass Atlas");

    expect(initial.method).toBeNull();
    expect(selected).not.toBe(initial);
    expect(selected.method).toBe("manual");
    expect(selected.status).toBe("unsaved");
    expect(edited.draft.world.title).toBe("Glass Atlas");
    expect(selected.draft.world.title).toBe("");
    expect(edited.draft.playableCharacters).toEqual([]);
    expect(edited.navigationDirty).toBe(true);
  });

  it("keeps protected root fields canonical during direct edits", () => {
    const initial = createWorldCreationState();
    const schemaEdited = editCreationDraft(initial, ["schemaVersion"], 4);
    const charactersEdited = editCreationDraft(schemaEdited, ["playableCharacters"], [
      { id: "forbidden", name: "Forbidden character" }
    ]);

    expect(schemaEdited.draft.schemaVersion).toBe(5);
    expect(charactersEdited.draft.schemaVersion).toBe(5);
    expect(charactersEdited.draft.playableCharacters).toEqual([]);
    expect(initial.draft.schemaVersion).toBe(5);
    expect(initial.draft.playableCharacters).toEqual([]);
  });

  it("allows adjacent valid stage movement, backwards movement, and rejects skips or an untitled Foundation", () => {
    const selected = selectCreationMethod(createWorldCreationState(), "manual");
    const foundation = setCreationStage(selected, "foundation");

    expect(foundation.stage).toBe("foundation");
    expect(validateCreationStage(foundation)).toEqual({
      issues: [{ path: "world.title", message: "World title is required." }]
    });
    expect(setCreationStage(foundation, "canon")).toBe(foundation);
    expect(setCreationStage(selected, "mechanics")).toBe(selected);

    const titled = editCreationDraft(foundation, ["world", "title"], "Glass Atlas");
    const canon = setCreationStage(titled, "canon");
    expect(canon.stage).toBe("canon");
    expect(setCreationStage(canon, "foundation").stage).toBe("foundation");
    const mechanics = setCreationStage(canon, "mechanics");
    expect(setCreationStage(mechanics, "method").stage).toBe("method");
  });

  it("removes and restores collection records with monotonic undo metadata", () => {
    let state = editCreationDraft(createWorldCreationState(), ["entities"], [
      { id: "a", name: "A" },
      { id: "b", name: "B" }
    ]);
    const removed = removeCreationCollectionItem(state, "entities", 0);
    const removalId = removed.pendingRemovals[0]?.id;
    if (!removalId) throw new Error("Removal metadata missing.");
    const restored = restoreCreationCollectionItem(removed, removalId);
    state = removeCreationCollectionItem(restored, "entities", 0);

    expect(removed.draft.entities).toEqual([{ id: "b", name: "B" }]);
    expect(restored.draft.entities).toEqual([{ id: "a", name: "A" }, { id: "b", name: "B" }]);
    expect(restored.pendingRemovals).toEqual([]);
    expect(state.pendingRemovals[0]?.id).toBe("creation-removal-2");
    expect(state.draft.playableCharacters).toEqual([]);
  });

  it("reports readiness for all six stages without requiring invented lore volume", () => {
    const initial = createWorldCreationState();
    expect(creationReadiness(initial).stages).toEqual([
      { stage: "method", ready: false, issueCount: 1 },
      { stage: "foundation", ready: false, issueCount: 1 },
      { stage: "canon", ready: true, issueCount: 0 },
      { stage: "mechanics", ready: true, issueCount: 0 },
      { stage: "cover", ready: true, issueCount: 0 },
      { stage: "review", ready: false, issueCount: 2 }
    ]);

    const ready = editCreationDraft(selectCreationMethod(initial, "manual"), ["world", "title"], "Glass Atlas");
    expect(creationReadiness(ready).stages.every((stage) => stage.ready)).toBe(true);
  });

  it.each([
    ["missing", undefined],
    ["non-object", null]
  ])("marks a %s Foundation world root unready and blocks forward navigation", (_case, world) => {
    const foundation = setCreationStage(
      selectCreationMethod(createWorldCreationState(), "manual"),
      "foundation"
    );
    const malformed = editCreationDraft(foundation, ["world"], world);
    const foundationReadiness = creationReadiness(malformed).stages.find(({ stage }) => stage === "foundation");

    expect(validateCreationStage(malformed, "foundation").issues).toContainEqual({
      path: "world",
      message: "World details must be an object."
    });
    expect(foundationReadiness).toEqual({ stage: "foundation", ready: false, issueCount: 1 });
    expect(setCreationStage(malformed, "canon")).toBe(malformed);
  });

  it("reports malformed final object and array roots instead of throwing", () => {
    const malformed = editCreationDraft(
      editCreationDraft(selectCreationMethod(createWorldCreationState(), "manual"), ["world"], null),
      ["entities"],
      {}
    );

    expect(validateCreationStage(malformed, "review").issues).toEqual(expect.arrayContaining([
      { path: "world", message: "World details must be an object." },
      { path: "entities", message: "entities must be an array." }
    ]));
  });

  it("detects local content across assets and imported world field shapes", () => {
    const empty = createWorldCreationState();
    expect(hasLocalWorldCreationContent(empty.draft)).toBe(false);
    expect(hasLocalWorldCreationContent(editCreationDraft(empty, ["assets"], [{ id: "cover" }]).draft)).toBe(true);
    expect(hasLocalWorldCreationContent(editCreationDraft(empty, ["world", "importedCount"], 3).draft)).toBe(true);
    expect(hasLocalWorldCreationContent(editCreationDraft(empty, ["world", "importedFlag"], true).draft)).toBe(true);
    expect(hasLocalWorldCreationContent(editCreationDraft(empty, ["world", "importedData"], { keep: true }).draft)).toBe(true);
  });

  it("canonicalizes generated previews, removes characters, and records replacement metadata", () => {
    const local = editCreationDraft(createWorldCreationState(), ["world", "title"], "Local Atlas");
    const generated = applyGeneratedPreview(local, {
      title: "Generated Atlas",
      content: { ...providerDraft, playableCharacters: [{ id: "forbidden" }] }
    });

    expect(generated.draft.schemaVersion).toBe(5);
    expect(generated.draft.world.title).toBe("Generated Atlas");
    expect(generated.draft.playableCharacters).toEqual([]);
    expect(generated.provenance).toBe("ai");
    expect(generated.status).toBe("unsaved");
    expect(generated.generationReplacement).toEqual({
      replacedLocalDraft: true,
      previousTitle: "Local Atlas",
      generatedTitle: "Generated Atlas"
    });
    expect(local.draft.world.title).toBe("Local Atlas");

    const methodOnly = selectCreationMethod(createWorldCreationState(), "ai");
    expect(applyGeneratedPreview(methodOnly, { title: "Generated Atlas", content: providerDraft })
      .generationReplacement?.replacedLocalDraft).toBe(false);
  });

  it("tracks create lifecycle and clears navigation dirtiness only after completion", () => {
    const dirty = selectCreationMethod(createWorldCreationState(), "ai");
    const creating = beginCreation(dirty);
    const failed = failCreation(creating, "request_failed", "Creation failed.");
    const complete = completeCreation(beginCreation(failed));

    expect(creating.status).toBe("creating");
    expect(creating.navigationDirty).toBe(true);
    expect(failed.status).toBe("error");
    expect(failed.creationError).toEqual({ kind: "request_failed", message: "Creation failed." });
    expect(failed.navigationDirty).toBe(true);
    expect(complete.status).toBe("created");
    expect(complete.navigationDirty).toBe(false);
    expect(complete.creationError).toBeNull();
  });

  it("reports current and completed editing stages without treating future stages as complete", () => {
    const foundation = setCreationStage(selectCreationMethod(createWorldCreationState(), "manual"), "foundation");
    expect(creationStageProgress(foundation)).toEqual([
      { stage: "method", state: "completed" },
      { stage: "foundation", state: "current" },
      { stage: "canon", state: "upcoming" },
      { stage: "mechanics", state: "upcoming" },
      { stage: "cover", state: "upcoming" },
      { stage: "review", state: "upcoming" }
    ]);
  });

  it("adds and updates creation collection records immutably while preserving unknown properties", () => {
    const initial = createWorldCreationState();
    const added = addCreationCollectionItem(initial, "entities", { id: "archive", title: "Archive", secret: 7 });
    const updated = updateCreationCollectionItem(added, "entities", 0, {
      id: "archive",
      title: "Living Archive",
      secret: 7
    });

    expect(initial.draft.entities).toEqual([]);
    expect(added.draft.entities).toEqual([{ id: "archive", title: "Archive", secret: 7 }]);
    expect(updated.draft.entities).toEqual([{ id: "archive", title: "Living Archive", secret: 7 }]);
    expect(updated.draft.playableCharacters).toEqual([]);
    expect(() => updateCreationCollectionItem(updated, "entities", 1, {})).toThrow(RangeError);
  });
});
