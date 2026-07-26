import { describe, expect, it } from "vitest";
import {
  generatedWorldIssues,
  parseCompleteGeneratedWorld
} from "../../packages/domain/src/generated-world.js";
import {
  applicationOwnedCharacterIds,
  applicationOwnedDefaultTriggers,
  applicationOwnedRpgStats
} from "../../services/api/src/world-generator-service.js";

function profile() {
  return {
    identity: { aliases: [], pronouns: "they/them" },
    story: {
      role: "Explorer",
      background: "Raised among moving roads.",
      personality: "Careful and curious.",
      motivations: "Map the impossible.",
      goals: "Find the vanished road.",
      fearsAndConflicts: "Fears becoming lost.",
      keyRelationships: "Trusts the lantern keeper.",
      narrativeHooks: "Carries an unfinished map.",
      voiceAndMannerisms: "Speaks precisely.",
      otherGuidance: ""
    },
    appearance: {
      ancestryOrSpecies: "Human",
      apparentAge: "Adult",
      genderPresentation: "",
      build: "Lean",
      skinOrComplexion: "",
      face: "",
      eyes: "Brown",
      hair: "Black",
      distinguishingFeatures: ["Ink-stained hands"],
      clothing: "Weathered blue coat",
      equipmentAndAccessories: "Brass compass",
      otherVisualDetails: ""
    },
    unclassifiedNotes: ""
  };
}

function completeWorld(characterCount = 3) {
  return {
    world: {
      title: "The Moving Roads",
      genre: "Weird fantasy",
      tone: "Hopeful",
      premise: "Roads rearrange beneath moonlight.",
      backgroundStory: "Cartographers once governed the coast.",
      firstAction: "A forbidden road appears outside the city.",
      rules: "Every road remembers its maker."
    },
    playableCharacters: Array.from({ length: characterCount }, (_, index) => index + 1).map((number) => ({
      id: `character-${number}`,
      name: `Character ${number}`,
      characterText: `Complete narrative guidance for character ${number}.`,
      profile: profile(),
      rpgStats: [],
      defaultTriggers: [],
      source: {}
    }))
  };
}

describe("generated world completion", () => {
  it("accepts a complete world with three structured characters", () => {
    expect(parseCompleteGeneratedWorld(completeWorld()).playableCharacters).toHaveLength(3);
  });

  it("accepts a complete world with four structured characters", () => {
    expect(parseCompleteGeneratedWorld(completeWorld(4)).playableCharacters).toHaveLength(4);
  });

  it("rejects a world with five playable characters", () => {
    expect(() => parseCompleteGeneratedWorld(completeWorld(5))).toThrow();
  });

  it("rejects an empty characterText even when profile is complete", () => {
    const content = completeWorld();
    content.playableCharacters[1]!.characterText = "";
    expect(() => parseCompleteGeneratedWorld(content)).toThrow();
  });

  it("rejects a missing profile even when characterText is complete", () => {
    const content = completeWorld();
    delete (content.playableCharacters[1] as { profile?: unknown }).profile;
    expect(() => parseCompleteGeneratedWorld(content)).toThrow();
  });

  it("rejects duplicate canonical character IDs", () => {
    const content = completeWorld();
    content.playableCharacters[1]!.id = content.playableCharacters[0]!.id;
    expect(() => parseCompleteGeneratedWorld(content)).toThrow();
  });

  it("replaces provider character IDs with unique application-owned IDs", () => {
    const ids = applicationOwnedCharacterIds([
      { id: "provider-character", name: "Lantern Keeper" },
      { id: "provider-character", name: "Road Cartographer" },
      { id: "provider-character", name: "Moon Courier" }
    ]);

    expect(ids).not.toContain("provider-character");
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("replaces repeated provider stat and trigger IDs with application-owned child IDs", () => {
    const characterId = "char-1-lantern-keeper";
    const rpgStats = applicationOwnedRpgStats([
      { id: "provider-child", name: "Navigation", value: 70 },
      { id: "provider-child", name: "Survival", value: 60 }
    ], characterId);
    const defaultTriggers = applicationOwnedDefaultTriggers([
      { id: "provider-child", name: "Storm danger", value: "Low" },
      { id: "provider-child", name: "Road progress", value: "0" }
    ], characterId);

    expect(rpgStats.map((stat) => stat.id)).toEqual([
      "char-1-lantern-keeper-stat-1",
      "char-1-lantern-keeper-stat-2"
    ]);
    expect(defaultTriggers.map((trigger) => trigger.id)).toEqual([
      "char-1-lantern-keeper-tracker-1",
      "char-1-lantern-keeper-tracker-2"
    ]);
    expect(new Set(rpgStats.map((stat) => stat.id)).size).toBe(rpgStats.length);
    expect(new Set(defaultTriggers.map((trigger) => trigger.id)).size).toBe(defaultTriggers.length);
  });

  it("rejects missing world fields and character counts outside three to four", () => {
    const content = completeWorld();
    content.world.rules = "";
    content.playableCharacters = content.playableCharacters.slice(0, 2);
    expect(() => parseCompleteGeneratedWorld(content)).toThrow();
  });

  it("projects only safe issue paths, codes, and static messages", () => {
    const marker = "PRIVATE_LORE_MARKER";
    const content = completeWorld();
    content.playableCharacters[0]!.characterText = marker.repeat(100_000);
    let thrown: unknown;
    try {
      parseCompleteGeneratedWorld(content);
    } catch (error) {
      thrown = error;
    }
    const issues = generatedWorldIssues(thrown);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]).toEqual(expect.objectContaining({
      path: expect.any(String),
      code: expect.any(String),
      message: expect.any(String)
    }));
    expect(JSON.stringify(issues)).not.toContain(marker);
  });
});
