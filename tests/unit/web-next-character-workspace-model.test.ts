import { describe, expect, it } from "vitest";
import {
  MAX_CHARACTER_MECHANICS_ITEMS,
  type PlayableCharacter
} from "../../packages/contracts/src/world-library.js";
import {
  applyGeneratedCharacter,
  characterHandoffCandidate,
  characterReview,
  createCharacterWorkspaceState,
  editCharacterCandidate,
  setCharacterStage,
  validateCharacterStage
} from "../../apps/web-next/src/character-workspace-model.js";

const completeCharacter = (overrides: Partial<PlayableCharacter> = {}): PlayableCharacter => ({
  id: "trusted-character",
  name: "Mara",
  characterText: "A patient observer.",
  rpgStats: [],
  defaultTriggers: [],
  source: {},
  ...overrides
});

describe("character workspace model", () => {
  it("creates a canonical empty candidate with a collision-safe trusted ID", () => {
    const roster = [completeCharacter({ id: "collision" })];
    const generatedIds = ["collision", "collision", "trusted-character"];
    const state = createCharacterWorkspaceState({
      roster,
      idFactory: () => generatedIds.shift() ?? "trusted-character"
    });

    expect(state).toMatchObject({
      stage: "method",
      furthestStageIndex: 0,
      method: null,
      candidate: {
        id: "trusted-character",
        name: "",
        characterText: "",
        profile: {
          identity: { aliases: [], pronouns: "" },
          story: {},
          appearance: { distinguishingFeatures: [] },
          unclassifiedNotes: ""
        },
        rpgStats: [],
        defaultTriggers: [],
        source: {}
      }
    });
    expect(state.roster).not.toBe(roster);

    const repeatedCollision = createCharacterWorkspaceState({
      roster: [completeCharacter({ id: "collision" }), completeCharacter({ id: "collision-2" })],
      idFactory: () => "collision"
    });
    expect(repeatedCollision.candidate.id).toBe("collision-3");

    const whitespaceCollision = createCharacterWorkspaceState({
      roster: [completeCharacter({ id: " collision " })],
      idFactory: () => "collision"
    });
    expect(whitespaceCollision.candidate.id).toBe("collision-2");

    const canonicalFactoryId = createCharacterWorkspaceState({
      roster: [],
      idFactory: () => "  trusted-character  "
    });
    expect(canonicalFactoryId.candidate.id).toBe("trusted-character");

    const maximumId = "x".repeat(200);
    const boundedSuffix = createCharacterWorkspaceState({
      roster: [completeCharacter({ id: maximumId })],
      idFactory: () => maximumId
    });
    expect(boundedSuffix.candidate.id).toBe(`${"x".repeat(198)}-2`);
    expect(boundedSuffix.candidate.id).toHaveLength(200);

    const repairedOverlongId = createCharacterWorkspaceState({
      roster: [],
      idFactory: () => "x".repeat(201)
    });
    expect(repairedOverlongId.candidate.id).toBe("character-2");
  });

  it("performs immutable nested edits while preserving unknown safe properties", () => {
    const initial = createCharacterWorkspaceState({ roster: [], candidate: {
      ...completeCharacter(),
      importedExtension: { keep: true }
    } });
    const edited = editCharacterCandidate(initial, ["profile", "story", "role"], "Cartographer");

    expect(edited.candidate.profile?.story.role).toBe("Cartographer");
    expect(edited.candidate.importedExtension).toEqual({ keep: true });
    expect(initial.candidate.profile?.story.role).toBe("");
    expect(edited).not.toBe(initial);
    expect(edited.candidate).not.toBe(initial.candidate);
    expect(edited.candidate.profile).not.toBe(initial.candidate.profile);
  });

  it("reports exact required text, duplicate identity, and duplicate-name warning issues", () => {
    const state = createCharacterWorkspaceState({
      roster: [completeCharacter({ id: "trusted-character", name: "  MARA  " })],
      candidate: completeCharacter({ id: "trusted-character", name: "mara", characterText: "   " })
    });

    expect(validateCharacterStage(state, "identity").issues).toEqual([
      expect.objectContaining({ path: "candidate.id", severity: "error", message: "Character ID must be unique in this world draft." }),
      expect.objectContaining({ path: "candidate.name", severity: "warning", message: "Another character already uses this name." })
    ]);
    expect(validateCharacterStage(state, "story").issues).toEqual([
      expect.objectContaining({ path: "candidate.characterText", severity: "error", message: "Narrative guidance is required." })
    ]);

    const longName = editCharacterCandidate(state, ["name"], "n".repeat(201));
    const longGuidance = editCharacterCandidate(longName, ["characterText"], "g".repeat(200_001));
    expect(validateCharacterStage(longGuidance, "identity").issues)
      .toContainEqual(expect.objectContaining({ path: "candidate.name", message: "Character name must contain 200 characters or fewer." }));
    expect(validateCharacterStage(longGuidance, "story").issues)
      .toContainEqual(expect.objectContaining({ path: "candidate.characterText", message: "Narrative guidance must contain 200000 characters or fewer." }));
  });

  it("accepts exact text boundaries and rejects one character beyond them", () => {
    const exact = createCharacterWorkspaceState({
      roster: [],
      method: "manual",
      candidate: completeCharacter({
        id: "i".repeat(200),
        name: "n".repeat(200),
        characterText: "g".repeat(200_000)
      })
    });

    expect(validateCharacterStage(exact, "review").issues.filter(({ severity }) => severity === "error")).toEqual([]);
    expect(characterHandoffCandidate(exact)).not.toBeNull();

    const overlongId = editCharacterCandidate(exact, ["id"], "i".repeat(201));
    const overlongName = editCharacterCandidate(exact, ["name"], "n".repeat(201));
    const overlongStory = editCharacterCandidate(exact, ["characterText"], "g".repeat(200_001));
    expect(characterHandoffCandidate(overlongId)).toBeNull();
    expect(characterHandoffCandidate(overlongName)).toBeNull();
    expect(characterHandoffCandidate(overlongStory)).toBeNull();
  });

  it("surfaces malformed profile roots and sections without throwing during review", () => {
    const malformedProfiles: Array<{ profile: unknown; stage: "identity" | "story" | "appearance"; path: string }> = [
      { profile: null, stage: "identity", path: "candidate.profile" },
      { profile: "invalid", stage: "story", path: "candidate.profile" },
      { profile: { identity: null }, stage: "identity", path: "candidate.profile.identity" },
      { profile: { story: null }, stage: "story", path: "candidate.profile.story" },
      { profile: { appearance: null }, stage: "appearance", path: "candidate.profile.appearance" }
    ];

    for (const malformed of malformedProfiles) {
      const state = createCharacterWorkspaceState({
        roster: [],
        method: "manual",
        candidate: { ...completeCharacter(), profile: malformed.profile } as PlayableCharacter
      });
      expect(validateCharacterStage(state, malformed.stage).issues)
        .toContainEqual(expect.objectContaining({ path: malformed.path, severity: "error" }));
      expect(() => characterReview(state)).not.toThrow();
      expect(characterReview(state).ready).toBe(false);
      expect(characterHandoffCandidate(state)).toBeNull();
    }
  });

  it("keeps review readiness aligned with final handoff schema eligibility", () => {
    const malformed = createCharacterWorkspaceState({
      roster: [],
      method: "manual",
      candidate: { ...completeCharacter(), source: null } as unknown as PlayableCharacter
    });

    expect(() => characterReview(malformed)).not.toThrow();
    expect(characterReview(malformed).ready).toBe(false);
    expect(characterHandoffCandidate(malformed)).toBeNull();
  });

  it("applies generated fields without trusting generated identity or owner keys", () => {
    const initial = createCharacterWorkspaceState({ roster: [], idFactory: () => "trusted-character" });
    const generated = applyGeneratedCharacter(initial, {
      id: "model-id",
      name: "Mara",
      characterText: "A patient observer.",
      ownerUserId: "attacker",
      importedExtension: { keep: true }
    });

    expect(generated.method).toBe("ai");
    expect(generated.candidate.id).toBe("trusted-character");
    expect(generated.candidate).not.toHaveProperty("ownerUserId");
    expect(generated.candidate.importedExtension).toEqual({ keep: true });
    expect(initial.candidate.name).toBe("");

    for (const key of ["user_id", "userId", "owner_user_id", "ownerUserId"] as const) {
      const applied = applyGeneratedCharacter(initial, {
        ...completeCharacter({ id: "generated" }),
        [key]: "spoofed"
      });
      expect(applied.candidate).not.toHaveProperty(key);
    }
  });

  it("enforces shared mechanics bounds and stage readiness", () => {
    let state = createCharacterWorkspaceState({ roster: [], method: "manual", idFactory: () => "trusted-character" });
    state = setCharacterStage(state, "identity");
    expect(state.stage).toBe("identity");
    expect(setCharacterStage(state, "story").stage).toBe("identity");

    state = editCharacterCandidate(state, ["name"], "Mara");
    state = setCharacterStage(state, "story");
    expect(state.stage).toBe("story");
    expect(setCharacterStage(state, "appearance").stage).toBe("story");

    state = editCharacterCandidate(state, ["characterText"], "Guidance");
    state = setCharacterStage(state, "appearance");
    state = setCharacterStage(state, "mechanics");
    expect(state.stage).toBe("mechanics");

    const overfull = editCharacterCandidate(
      state,
      ["rpgStats"],
      Array.from({ length: MAX_CHARACTER_MECHANICS_ITEMS + 1 }, () => ({}))
    );
    expect(validateCharacterStage(overfull, "mechanics").issues).toContainEqual(expect.objectContaining({
      path: "candidate.rpgStats",
      severity: "error"
    }));
    expect(setCharacterStage(overfull, "review").stage).toBe("mechanics");
  });

  it("summarizes factual counts, readiness, and warnings", () => {
    const state = createCharacterWorkspaceState({
      roster: [completeCharacter({ id: "other", name: "MARA" })],
      method: "manual",
      candidate: completeCharacter({
        profile: {
          identity: { aliases: ["Mapmaker"], pronouns: "she/her" },
          story: {
            role: "Guide", background: "", personality: "Patient", motivations: "", goals: "",
            fearsAndConflicts: "", keyRelationships: "", narrativeHooks: "", voiceAndMannerisms: "", otherGuidance: ""
          },
          appearance: {
            ancestryOrSpecies: "Human", apparentAge: "", genderPresentation: "", build: "", skinOrComplexion: "",
            face: "", eyes: "", hair: "", distinguishingFeatures: ["Ink-stained hands"], clothing: "",
            equipmentAndAccessories: "", otherVisualDetails: ""
          },
          unclassifiedNotes: ""
        },
        rpgStats: [{ name: "Insight", value: 70 }],
        defaultTriggers: [{ name: "Debt", value: "Owed" }]
      })
    });

    expect(characterReview(state)).toMatchObject({
      provenance: "manual",
      ready: true,
      warningCount: 1,
      counts: {
        aliases: 1,
        completedStoryFields: 2,
        completedAppearanceFields: 2,
        stats: 1,
        triggers: 1
      }
    });
  });

  it("returns only canonical, duplicate-proof handoff candidates", () => {
    const valid = createCharacterWorkspaceState({ roster: [], method: "manual", candidate: completeCharacter({
      name: "  Mara  ",
      owner_user_id: "spoofed",
      importedExtension: { keep: true }
    }) });
    const handoff = characterHandoffCandidate(valid);

    expect(handoff).toMatchObject({ id: "trusted-character", name: "Mara", importedExtension: { keep: true } });
    expect(handoff).not.toHaveProperty("owner_user_id");
    expect(handoff).not.toBe(valid.candidate);

    const duplicate = createCharacterWorkspaceState({
      roster: [completeCharacter()],
      method: "manual",
      candidate: completeCharacter({ id: " trusted-character " })
    });
    expect(characterHandoffCandidate(duplicate)).toBeNull();
    expect(characterHandoffCandidate(editCharacterCandidate(valid, ["characterText"], "   "))).toBeNull();
  });
});
