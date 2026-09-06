import { z } from "zod";
import { describe, expect, it } from "vitest";
import { characterProfileSchema, playableCharacterSchema, worldContentSchema } from "../../packages/contracts/src/world-library.js";
import {
  projectAuthoringIssues,
  validateGeneratedCharacter
} from "../../packages/domain/src/authoring-output.js";
import { parseCompleteGeneratedWorld } from "../../packages/domain/src/generated-world.js";

function creativeProfile(overrides: Record<string, unknown> = {}) {
  return characterProfileSchema.parse({
    story: {
      role: "Cartographer",
      background: "She learned the old roads from her grandmother.",
      motivations: "Keep travelers safe from shifting paths."
    },
    ...overrides
  });
}

function generatedCharacter(overrides: Record<string, unknown> = {}) {
  return {
    id: "test-character",
    name: "Iris",
    characterText: "A careful guide with a weathered map.",
    profile: creativeProfile(),
    ...overrides
  };
}

function generatedWorld(characterOverrides: Record<string, unknown> = {}) {
  return {
    world: {
      title: "Moving Roads",
      genre: "Fantasy",
      tone: "Hopeful",
      premise: "Roads shift under moonlight.",
      backgroundStory: "Cartographers once ruled the coast.",
      firstAction: "A forbidden road appears at the gate.",
      rules: "Roads remember their makers."
    },
    playableCharacters: [1, 2, 3].map((number) => generatedCharacter({
      id: `character-${number}`,
      name: `Character ${number}`,
      ...characterOverrides
    }))
  };
}

describe("generated authoring output", () => {
  it("rejects an empty generated profile while storage keeps incomplete drafts valid", () => {
    const empty = {
      id: "test-character",
      name: "Iris",
      characterText: "",
      profile: characterProfileSchema.parse({})
    };

    expect(playableCharacterSchema.safeParse(empty).success).toBe(true);
    expect(() => validateGeneratedCharacter(empty, "creative")).toThrow();
  });

  it("requires creative role, background, and one drive while allowing unknown appearance", () => {
    const noDrive = generatedCharacter({
      profile: characterProfileSchema.parse({
        story: { role: "Cartographer", background: "She maps dangerous roads." }
      })
    });
    const sparseAppearance = generatedCharacter({
      characterText: "",
      profile: creativeProfile({ appearance: {} })
    });

    expect(() => validateGeneratedCharacter(noDrive, "creative")).toThrow();
    expect(validateGeneratedCharacter(sparseAppearance, "creative")).toMatchObject({ name: "Iris" });
  });

  it("accepts source-mode story facts without inventing the creative minimum", () => {
    const source = generatedCharacter({
      characterText: "",
      profile: characterProfileSchema.parse({ story: { background: "Named in the supplied journal." } })
    });

    expect(validateGeneratedCharacter(source, "source")).toMatchObject({ name: "Iris" });
  });

  it("rejects malformed character structures and mechanics-contaminated fiction", () => {
    expect(() => validateGeneratedCharacter(null, "creative")).toThrow();
    expect(() => validateGeneratedCharacter(generatedCharacter({ profile: [] }), "creative")).toThrow();
    expect(() => validateGeneratedCharacter(generatedCharacter({
      profile: { ...creativeProfile(), identity: { aliases: [42], pronouns: "they/them" } }
    }), "creative")).toThrow();
    expect(() => validateGeneratedCharacter(generatedCharacter({
      profile: creativeProfile({ story: {
        role: "Cartographer",
        background: "She rolls a d20 and applies a +4 modifier.",
        motivations: "Keep travelers safe."
      } })
    }), "creative")).toThrow();
    expect(validateGeneratedCharacter(generatedCharacter({
      profile: creativeProfile({ story: {
        role: "Cartographer",
        background: "She keeps three worn maps in her coat.",
        motivations: "Keep travelers safe."
      } })
    }), "creative")).toMatchObject({ name: "Iris" });
  });

  it("recursively rejects mechanics and prohibited model metadata in persisted profile values", () => {
    for (const profile of [
      creativeProfile({ private_reasoning: "I rolled a d20." }),
      creativeProfile({ identity: { aliases: [], pronouns: "they/them", hiddenNote: "I rolled a d20." } }),
      creativeProfile({ story: { role: "Cartographer", background: "She maps roads.", motivations: "Keep travelers safe.", scratchpad: "I rolled a d20." } }),
      creativeProfile({ appearance: { clothing: "Blue coat", providerToken: "secret" } })
    ]) {
      expect(() => validateGeneratedCharacter(generatedCharacter({ profile }), "creative")).toThrow();
    }
    expect(() => validateGeneratedCharacter(generatedCharacter({ name: "D20 Cartographer" }), "creative")).toThrow();
  });

  it("applies shared completion checks to generated world rosters, including duplicate names", () => {
    expect(() => parseCompleteGeneratedWorld(generatedWorld({
      name: "Iris"
    }))).toThrow();
  });

  it.each([
    ["backgroundStory", "Roll d20 with modifier +3 to enter the harbor."],
    ["premise", "Apply modifier +3 at the harbor."],
    ["firstAction", "Private reasoning: the harbor is safe."],
    ["title", "D20 Harbor"],
    ["genre", "Dice roll adventures"],
    ["tone", "Hidden analysis: hopeful"]
  ])("rejects generated world fiction contamination at world.%s while storage remains permissive", (field, text) => {
    const candidate = generatedWorld();
    Object.assign(candidate.world, { [field]: text });
    expect(worldContentSchema.safeParse(candidate).success).toBe(true);
    let failure: unknown;
    try { parseCompleteGeneratedWorld(candidate); } catch (error) { failure = error; }
    expect(projectAuthoringIssues(failure)).toContainEqual({
      path: `world.${field}`, code: "custom",
      message: "Generated fictional content contains mechanics language."
    });
  });

  it("preserves diegetic world numbers and separately typed mechanics rules", () => {
    const candidate = generatedWorld();
    candidate.world.backgroundStory = "Three ships arrived in 1842 with 20 sailors.";
    candidate.world.rules = "Roll d20 with modifier +3.";
    const mechanics = [{ name: "Navigation", value: 50, note: "Roll d20 with modifier +3." }];
    const accepted = parseCompleteGeneratedWorld({ ...candidate, rpgStats: mechanics });
    expect(accepted.world).toMatchObject(candidate.world);
    expect(accepted.rpgStats).toEqual(mechanics);
  });

  it("projects only allowlisted paths and fixed messages", () => {
    const marker = "PRIVATE_PROVIDER_ERROR_TEXT";
    const issues = projectAuthoringIssues(new z.ZodError([
      { path: ["profile", "story", "background"], code: "custom", message: marker },
      { path: ["unexpected", marker], code: "custom", message: marker }
    ]));

    expect(issues).toContainEqual({
      path: "profile.story.background",
      code: "custom",
      message: "Generated character background is required."
    });
    expect(issues).toContainEqual({
      path: "generatedWorld",
      code: "custom",
      message: "Generated content failed validation."
    });
    expect(JSON.stringify(issues)).not.toContain(marker);
  });

  it("preserves controlled validator reasons without exposing params", () => {
    let mechanicsError: unknown;
    let metadataError: unknown;
    try {
      validateGeneratedCharacter(generatedCharacter({
        profile: creativeProfile({ story: {
          role: "She rolls a d20.",
          background: "She maps roads.",
          motivations: "Keep travelers safe."
        } })
      }), "creative");
    } catch (error) {
      mechanicsError = error;
    }
    try {
      validateGeneratedCharacter(generatedCharacter({
        profile: creativeProfile({ private_reasoning: "provider metadata" })
      }), "creative");
    } catch (error) {
      metadataError = error;
    }

    expect(projectAuthoringIssues(mechanicsError)).toContainEqual({
      path: "profile.story.role",
      code: "custom",
      message: "Generated fictional content contains mechanics language."
    });
    expect(projectAuthoringIssues(metadataError)).toContainEqual({
      path: "profile",
      code: "custom",
      message: "Generated character contains prohibited provider metadata."
    });
  });
});
