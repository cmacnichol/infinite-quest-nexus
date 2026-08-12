import { describe, expect, it } from "vitest";
import {
  addCreationCollectionItem,
  appendCreationCharacter,
  applyGeneratedPreview,
  beginCreation,
  completeCreation,
  createWorldCreationState,
  creationReadiness,
  creationStageProgress,
  creationReview,
  editCreationDraft,
  failCreation,
  hasLocalWorldCreationContent,
  isWorldCreationPath,
  removeCreationCharacter,
  removeCreationCollectionItem,
  replaceCreationCharacter,
  restoreCreationCharacter,
  restoreCreationCollectionItem,
  selectCreationMethod,
  setCreationCoverIntent,
  setCreationStage,
  updateCreationCollectionItem,
  validateCreationStage,
  worldCreationPath,
  worldCreationSubmissionSnapshot
} from "../../apps/web-next/src/world-creation-model.js";
import { MAX_PLAYABLE_CHARACTERS } from "../../packages/contracts/src/world-library.js";

function character(id: string, name = id) {
  return {
    id,
    name,
    characterText: `${name} protects the atlas.`,
    profile: {
      identity: { aliases: [], pronouns: "they/them" },
      story: {},
      appearance: {},
      unclassifiedNotes: ""
    },
    rpgStats: [],
    defaultTriggers: [],
    source: {}
  };
}

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

  it("keeps protected roots canonical and lets only reviewed transitions introduce characters", () => {
    const initial = createWorldCreationState();
    const schemaEdited = editCreationDraft(initial, ["schemaVersion"], 4);
    const directlyEdited = editCreationDraft(schemaEdited, ["playableCharacters"], [character("forbidden")]);
    const appended = appendCreationCharacter(directlyEdited, character("keeper", "Keeper"));

    expect(schemaEdited.draft.schemaVersion).toBe(5);
    expect(directlyEdited.draft.playableCharacters).toEqual([]);
    expect(appended.draft.playableCharacters).toEqual([
      expect.objectContaining({ id: "keeper", name: "Keeper", characterText: "Keeper protects the atlas." })
    ]);
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
    const revisitedMethod = setCreationStage(mechanics, "method");
    expect(revisitedMethod.stage).toBe("method");
    expect(setCreationStage(revisitedMethod, "mechanics").stage).toBe("mechanics");

    const invalidRevisit = editCreationDraft(setCreationStage(mechanics, "foundation"), ["world", "title"], "");
    expect(setCreationStage(invalidRevisit, "mechanics")).toBe(invalidRevisit);
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

  it("reports readiness for all seven stages without requiring invented lore volume", () => {
    const initial = createWorldCreationState();
    expect(creationReadiness(initial).stages).toEqual([
      { stage: "method", ready: false, issueCount: 1 },
      { stage: "foundation", ready: false, issueCount: 1 },
      { stage: "canon", ready: true, issueCount: 0 },
      { stage: "mechanics", ready: true, issueCount: 0 },
      { stage: "cover", ready: true, issueCount: 0 },
      { stage: "characters", ready: true, issueCount: 0 },
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

  it("canonicalizes generated previews without injecting provider characters or replacing the reviewed roster", () => {
    let local = editCreationDraft(createWorldCreationState(), ["world", "title"], "Local Atlas");
    local = appendCreationCharacter(local, character("reviewed", "Reviewed Keeper"));
    const generated = applyGeneratedPreview(local, {
      title: "Generated Atlas",
      content: { ...providerDraft, playableCharacters: [character("injected", "Injected Stranger")] }
    });

    expect(generated.draft.schemaVersion).toBe(5);
    expect(generated.draft.world.title).toBe("Generated Atlas");
    expect(generated.draft.playableCharacters).toEqual([
      expect.objectContaining({ id: "reviewed", name: "Reviewed Keeper" })
    ]);
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
    const complete = completeCreation(beginCreation(failed), "world-1");

    expect(creating.status).toBe("creating");
    expect(creating.navigationDirty).toBe(true);
    expect(failed.status).toBe("error");
    expect(failed.creationError).toEqual({ kind: "request_failed", message: "Creation failed." });
    expect(failed.navigationDirty).toBe(true);
    expect(complete.status).toBe("created");
    expect(complete.navigationDirty).toBe(false);
    expect(complete.creationError).toBeNull();
    expect(complete.createdWorldId).toBe("world-1");
  });

  it("defaults cover to none and validates only fields required by the selected cover mode", () => {
    const initial = createWorldCreationState();
    expect(initial.coverIntent).toEqual({ mode: "none" });
    expect(validateCreationStage(initial, "cover").issues).toEqual([]);

    const retained = setCreationCoverIntent(initial, { mode: "retained_asset", assetId: " " });
    expect(validateCreationStage(retained, "cover").issues).toEqual([
      { path: "cover.assetId", message: "Choose a retained cover asset." }
    ]);
    const generated = setCreationCoverIntent(retained, { mode: "generated", prompt: " " });
    expect(validateCreationStage(generated, "cover").issues).toEqual([
      { path: "cover.prompt", message: "Describe the cover to generate." }
    ]);
    expect(setCreationCoverIntent(generated, { mode: "none" }).coverIntent).toEqual({ mode: "none" });
  });

  it("builds a factual review with provenance, readiness, warnings, and reviewed character counts", () => {
    let state = selectCreationMethod(createWorldCreationState(), "ai");
    state = editCreationDraft(state, ["world", "title"], "Glass Atlas");
    state = editCreationDraft(state, ["entities"], [{ name: "City" }, { name: "Star" }]);
    state = editCreationDraft(state, ["relationships"], [{ source: "City", target: "Star" }]);
    state = editCreationDraft(state, ["rpgStats"], [{ name: "Resolve" }]);
    state = editCreationDraft(state, ["defaultTriggers"], [{ name: "Dusk" }]);
    state = editCreationDraft(state, ["eventTriggers"], [{ name: "Alarm" }]);
    state = editCreationDraft(state, ["assets"], [{ id: "asset-1" }]);
    state = appendCreationCharacter(state, character("keeper", "Keeper"));

    const review = creationReview(state);

    expect(review.provenance).toBe("ai");
    expect(review.ready).toBe(true);
    expect(review.warnings).toEqual(["No cover will be attached."]);
    expect(review.warningCount).toBe(1);
    expect(review.coverIntent).toEqual({ mode: "none" });
    expect(review.readiness).toEqual([
      { stage: "method", ready: true, issueCount: 0 },
      { stage: "foundation", ready: true, issueCount: 0 },
      { stage: "canon", ready: true, issueCount: 0 },
      { stage: "mechanics", ready: true, issueCount: 0 },
      { stage: "cover", ready: true, issueCount: 0 },
      { stage: "characters", ready: true, issueCount: 0 },
      { stage: "review", ready: true, issueCount: 0 }
    ]);
    expect(review.counts).toEqual({
      entities: 2,
      relationships: 1,
      stats: 1,
      triggers: 2,
      assets: 1,
      characters: 1
    });
    expect(review.draft.playableCharacters).toEqual([
      expect.objectContaining({ id: "keeper", name: "Keeper" })
    ]);
  });

  it("appends, replaces, removes, and restores reviewed characters immutably", () => {
    const initial = createWorldCreationState();
    const appended = appendCreationCharacter(initial, {
      ...character("keeper", "Keeper"),
      ownerUserId: "attacker",
      customLore: { oath: "North", user_id: "nested-attacker" }
    });
    const replaced = replaceCreationCharacter(appended, "keeper", {
      ...character("keeper", "Keeper Prime"),
      customLore: { oath: "East" }
    });
    const removed = removeCreationCharacter(replaced, "keeper");
    const removalId = removed.pendingRemovals.at(-1)?.id;
    if (!removalId) throw new Error("Character removal metadata missing.");
    const restored = restoreCreationCharacter(removed, removalId);

    expect(initial.draft.playableCharacters).toEqual([]);
    expect(appended.draft.playableCharacters[0]).toMatchObject({
      id: "keeper",
      customLore: { oath: "North" }
    });
    expect(appended.draft.playableCharacters[0]).not.toHaveProperty("ownerUserId");
    expect(appended.draft.playableCharacters[0]).not.toHaveProperty("customLore.user_id");
    expect(replaced.draft.playableCharacters[0]).toMatchObject({ name: "Keeper Prime", customLore: { oath: "East" } });
    expect(appended.draft.playableCharacters[0]).toMatchObject({ name: "Keeper", customLore: { oath: "North" } });
    expect(removed.draft.playableCharacters).toEqual([]);
    expect(restored.draft.playableCharacters).toEqual(replaced.draft.playableCharacters);
    expect(removed.draft.playableCharacters).toEqual([]);
    expect(restored.pendingRemovals).toEqual([]);
  });

  it("restores multiple character removals to their original roster order", () => {
    let state = createWorldCreationState();
    for (const id of ["a", "b", "c"]) state = appendCreationCharacter(state, character(id, id.toUpperCase()));
    const removedA = removeCreationCharacter(state, "a");
    const removedB = removeCreationCharacter(removedA, "b");
    const removalA = removedB.pendingRemovals.find(({ value }) => (value as { id?: unknown }).id === "a");
    const removalB = removedB.pendingRemovals.find(({ value }) => (value as { id?: unknown }).id === "b");
    if (!removalA || !removalB) throw new Error("Character removals missing.");

    const restoredA = restoreCreationCharacter(removedB, removalA.id);
    const restoredB = restoreCreationCharacter(restoredA, removalB.id);

    expect(restoredB.draft.playableCharacters.map((candidate) => (candidate as { id: string }).id))
      .toEqual(["a", "b", "c"]);
  });

  it("rejects duplicate, mismatched, missing, malformed, and over-bound reviewed characters", () => {
    const one = appendCreationCharacter(createWorldCreationState(), character("keeper", "Keeper"));
    expect(() => appendCreationCharacter(one, character("keeper", "Duplicate"))).toThrow(/unique/u);
    expect(() => replaceCreationCharacter(one, "keeper", character("other", "Other"))).toThrow(/ID/u);
    expect(() => replaceCreationCharacter(one, "missing", character("missing", "Missing"))).toThrow(RangeError);
    expect(() => appendCreationCharacter(one, { id: "broken" })).toThrow(/contract/u);

    const full = {
      ...createWorldCreationState(),
      draft: {
        ...createWorldCreationState().draft,
        playableCharacters: Array.from({ length: MAX_PLAYABLE_CHARACTERS }, (_, index) =>
          character(`character-${index}`))
      }
    };
    expect(() => appendCreationCharacter(full, character("overflow"))).toThrow(/more than/u);
  });

  it("submits the exact reviewed roster while stripping owner keys and retaining safe unknown fields", () => {
    const state = appendCreationCharacter(createWorldCreationState(), {
      ...character("keeper", "Keeper"),
      owner_user_id: "attacker",
      preservedLore: { oath: "North", ownerUserId: "nested-attacker" }
    });

    const snapshot = worldCreationSubmissionSnapshot(state.draft);

    expect(snapshot.playableCharacters).toEqual([
      expect.objectContaining({ id: "keeper", name: "Keeper", preservedLore: { oath: "North" } })
    ]);
    expect(snapshot.playableCharacters[0]).not.toHaveProperty("owner_user_id");
    expect(snapshot.playableCharacters[0]).not.toHaveProperty("preservedLore.ownerUserId");
  });

  it("reports completed, current, revisitable, and unavailable stages", () => {
    let state = selectCreationMethod(createWorldCreationState(), "manual");
    state = setCreationStage(state, "foundation");
    state = editCreationDraft(state, ["world", "title"], "Atlas");
    state = setCreationStage(state, "canon");
    state = setCreationStage(state, "foundation");

    expect(creationStageProgress(state)).toEqual([
      { stage: "method", state: "completed" },
      { stage: "foundation", state: "current" },
      { stage: "canon", state: "revisitable" },
      { stage: "mechanics", state: "upcoming" },
      { stage: "cover", state: "upcoming" },
      { stage: "characters", state: "upcoming" },
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
