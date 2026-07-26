import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  generatedWorldIssues,
  parseCompleteGeneratedWorld,
  projectGeneratedWorldIssues
} from "../../packages/domain/src/generated-world.js";
import {
  applicationOwnedCharacterIds,
  applicationOwnedDefaultTriggers,
  applicationOwnedEventTriggers,
  applicationOwnedRpgStats,
  incompleteGeneratedWorldError,
  selectCompleteGeneratedCharacters,
  worldGenerationFailureDiagnostic
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
  it("retains complete characters and replaces incomplete entries", () => {
    const candidates = [
      { id: "complete", name: "Complete", character_text: "Guidance", profile: profile(), rpg_statistics: [], default_triggers: [] },
      { id: "no-profile", name: "No Profile", character_text: "Guidance", rpg_statistics: [], default_triggers: [] },
      { id: "no-guidance", name: "No Guidance", character_text: "", profile: profile(), rpg_statistics: [], default_triggers: [] }
    ];

    const selected = selectCompleteGeneratedCharacters(candidates);

    expect(selected.characters.map((character) => character.id)).toEqual(["complete"]);
    expect(selected.needed).toBe(2);
  });

  it("deduplicates complete candidates by normalized name in provider order", () => {
    const candidates = [
      { id: "first", name: "Mira Vale", character_text: "Guidance", profile: profile(), rpg_statistics: [], default_triggers: [] },
      { id: "duplicate", name: "  mira vale  ", character_text: "Other guidance", profile: profile(), rpg_statistics: [], default_triggers: [] },
      { id: "unique", name: "Oren Pike", character_text: "Guidance", profile: profile(), rpg_statistics: [], default_triggers: [] }
    ];

    const selected = selectCompleteGeneratedCharacters(candidates);

    expect(selected.characters.map((character) => character.id)).toEqual(["first", "unique"]);
    expect(selected.characters.map((character) => character.name)).toEqual(["Mira Vale", "Oren Pike"]);
    expect(selected.needed).toBe(1);
  });

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

  it("rejects duplicate normalized character names with a safe name path", () => {
    const content = completeWorld();
    content.playableCharacters[1]!.name = "  character 1  ";
    let validationError: unknown;
    try {
      parseCompleteGeneratedWorld(content);
    } catch (error) {
      validationError = error;
    }

    expect(generatedWorldIssues(validationError)).toContainEqual({
      path: "playableCharacters.1.name",
      code: "custom",
      message: "Generated character names must be distinct."
    });
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

  it("replaces repeated provider event-trigger IDs while preserving trigger fields", () => {
    const eventTriggers = applicationOwnedEventTriggers([
      { id: "provider-event", name: "Storm warning", condition: "Sky darkens", source: { kind: "provider" } },
      { id: "provider-event", name: "Road shift", condition: "Moon rises", source: { kind: "provider" } }
    ], "generated-world");

    expect(eventTriggers.map((trigger) => (trigger as { id?: string }).id)).toEqual([
      "generated-world-event-1",
      "generated-world-event-2"
    ]);
    expect(new Set(eventTriggers.map((trigger) => (trigger as { id?: string }).id)).size).toBe(eventTriggers.length);
    expect(eventTriggers).toMatchObject([
      { name: "Storm warning", condition: "Sky darkens", source: { kind: "provider" } },
      { name: "Road shift", condition: "Moon rises", source: { kind: "provider" } }
    ]);
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

  it("replaces arbitrary Zod messages even when a secret starts the message", () => {
    const marker = "SECRET_AT_START_OF_ZOD_MESSAGE";
    const issues = generatedWorldIssues(new z.ZodError([{
      path: ["world", "genre"],
      code: "custom",
      message: `${marker} generated genre detail`
    }]));

    expect(issues).toEqual([{
      path: "world.genre",
      code: "custom",
      message: "Generated genre is required."
    }]);
    expect(JSON.stringify(issues)).not.toContain(marker);
  });

  it("maps projected issue categories to controlled messages", () => {
    const marker = "SECRET_AT_START_OF_PROJECTED_MESSAGE";
    const issues = projectGeneratedWorldIssues([{
      path: "playableCharacters.0.profile",
      code: "invalid_type",
      message: `${marker} private rejected profile`
    }]);

    expect(issues).toEqual([{
      path: "playableCharacters.0.profile",
      code: "invalid_type",
      message: "Generated content has an invalid type."
    }]);
    expect(JSON.stringify(issues)).not.toContain(marker);
  });

  it("exposes safe structured issues without provider content", () => {
    let validationError: unknown;
    try {
      parseCompleteGeneratedWorld({
        world: { title: "PRIVATE_TITLE" },
        playableCharacters: []
      });
    } catch (error) {
      validationError = error;
    }
    const failure = incompleteGeneratedWorldError(validationError) as Error & {
      statusCode: number;
      expose: boolean;
      details: { code: string; issues: Array<{ path: string }> };
    };

    expect(failure).toMatchObject({
      statusCode: 502,
      expose: true,
      details: { code: "incomplete_generated_world" }
    });
    expect(failure.details.issues.some((issue) => issue.path === "world.genre")).toBe(true);
    expect(JSON.stringify(failure.details)).not.toContain("PRIVATE_TITLE");
  });

  it("reports malformed JSON without exposing the syntax error body", () => {
    const marker = "PRIVATE_MALFORMED_PROVIDER_BODY";
    const failure = incompleteGeneratedWorldError(
      new SyntaxError(`Unexpected token near ${marker}`)
    ) as Error & {
      details: {
        code: string;
        issues: Array<{ path: string; code: string; message: string }>;
      };
    };

    expect(failure.details).toEqual({
      code: "incomplete_generated_world",
      issues: [{
        path: "generatedWorld",
        code: "invalid_json",
        message: "Generated world JSON is malformed."
      }]
    });
    expect(JSON.stringify(failure)).not.toContain(marker);
  });

  it("bounds every issue field before attaching public error details", () => {
    const marker = "PRIVATE_OVERSIZED_ISSUE";
    const validationError = new z.ZodError([{
      path: [`world.${"p".repeat(500)}${marker}`],
      code: `${"c".repeat(100)}${marker}` as "custom",
      message: `${"m".repeat(500)}${marker}`
    }]);
    const failure = incompleteGeneratedWorldError(validationError) as Error & {
      details: {
        issues: Array<{ path: string; code: string; message: string }>;
      };
    };

    const issue = failure.details.issues[0]!;
    expect(issue.path.length).toBeLessThanOrEqual(500);
    expect(issue.code.length).toBeLessThanOrEqual(100);
    expect(issue.message.length).toBeLessThanOrEqual(500);
    expect(JSON.stringify(failure.details)).not.toContain(marker);
  });

  it("formats at most four safe validation issues for durable progress", () => {
    let validationError: unknown;
    try {
      parseCompleteGeneratedWorld({
        world: { title: "PRIVATE_TITLE" },
        playableCharacters: []
      });
    } catch (error) {
      validationError = error;
    }

    const diagnostic = worldGenerationFailureDiagnostic(
      incompleteGeneratedWorldError(validationError)
    );

    expect(diagnostic.message).toContain("world.genre: Generated genre is required.");
    expect(diagnostic.message).toContain("world.backgroundStory: Generated background and canon are required.");
    expect(diagnostic.message).not.toContain("world.firstAction");
    expect(diagnostic.message).not.toContain("PRIVATE_TITLE");
    expect(diagnostic.message.length).toBeLessThanOrEqual(500);
  });

  it("drops rejected values from diagnostic issue objects", () => {
    const diagnostic = worldGenerationFailureDiagnostic({
      statusCode: 502,
      details: {
        code: "incomplete_generated_world",
        issues: [{
          path: "world.genre",
          code: "custom",
          message: "Generated genre is required.",
          value: "PRIVATE_REJECTED_VALUE"
        }]
      }
    });

    expect(diagnostic.issues).toEqual([{
      path: "world.genre",
      code: "custom",
      message: "Generated genre is required."
    }]);
    expect(JSON.stringify(diagnostic)).not.toContain("PRIVATE_REJECTED_VALUE");
  });
});
