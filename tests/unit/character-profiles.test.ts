import { describe, expect, it, vi } from "vitest";
import {
  characterProfileSchema,
  worldContentSchema
} from "../../packages/contracts/src/world-library.js";
import {
  characterLegacyText,
  characterNarrativeContext,
  characterVisualReference,
  effectiveCampaignCharacter,
  hasCharacterProfileGuidance
} from "../../packages/domain/src/world-characters.js";
import { composeIllustrationProviderPrompt } from "../../packages/domain/src/illustrations.js";
import {
  CHARACTER_PROFILE_ORGANIZER_PROTOCOL_VERSION,
  characterProfileOrganizerInput,
  characterProfileOrganizerPrompt,
  characterProfileOrganizerRepairInput,
  characterProfileOrganizerRepairPrompt,
  characterProfileOrganizerSources,
  validateOrganizerResultWithRepair,
  validateOrganizerResult
} from "../../services/api/src/character-profile-service.js";

const profile = characterProfileSchema.parse({
  identity: { aliases: ["The Fox"], pronouns: "she/her" },
  story: {
    role: "Scout",
    personality: "Patient",
    goals: "Find the vanished road."
  },
  appearance: {
    apparentAge: "early thirties",
    build: "lean",
    eyes: "green",
    hair: "black braid",
    distinguishingFeatures: ["crescent scar"],
    clothing: "weathered blue cloak"
  }
});

describe("structured character profiles", () => {
  it("keeps schema-v4 legacy worlds readable and round-trips schema-v5 profiles", () => {
    const legacy = worldContentSchema.parse({
      schemaVersion: 4,
      world: { title: "Legacy" },
      playableCharacters: [{ id: "legacy", name: "Mira", characterText: "A cautious guide." }]
    });
    expect(legacy.schemaVersion).toBe(4);
    expect(legacy.playableCharacters[0]?.profile).toBeUndefined();

    const structured = worldContentSchema.parse({
      schemaVersion: 5,
      world: { title: "Structured" },
      playableCharacters: [{
        id: "mira",
        name: "Mira",
        characterText: "Original source remains intact.",
        profile,
        importedExtension: { keep: true }
      }]
    });
    expect(structured.playableCharacters[0]).toMatchObject({
      profile,
      importedExtension: { keep: true }
    });
  });

  it("prefers the editable campaign copy, then the immutable snapshot, then legacy guidance", () => {
    const snapshot = { name: "Snapshot Mira", profile, characterText: "Legacy source." };
    const campaign = {
      name: "Campaign Mira",
      profile: characterProfileSchema.parse({ story: { role: "Captain" } })
    };
    expect(effectiveCampaignCharacter(campaign, snapshot)).toMatchObject({
      name: "Campaign Mira",
      profile: { story: { role: "Captain" } },
      legacyGuidance: "Legacy source."
    });
    expect(effectiveCampaignCharacter(null, snapshot)).toMatchObject({
      name: "Snapshot Mira",
      profile
    });
    expect(effectiveCampaignCharacter(null, {
      name: "Legacy Mira",
      characterText: "A cautious guide."
    })).toEqual({
      name: "Legacy Mira",
      profile: null,
      legacyGuidance: "A cautious guide."
    });
  });

  it("compiles targeted narrative and compatibility projections without empty fields", () => {
    const narrative = characterNarrativeContext({ name: "Mira", profile }, null);
    expect(narrative).toMatchObject({
      name: "Mira",
      identity: { aliases: ["The Fox"], pronouns: "she/her" },
      story: { role: "Scout", goals: "Find the vanished road." }
    });
    expect(JSON.stringify(narrative)).not.toContain('""');
    expect(characterLegacyText({ name: "Mira", profile }, null)).toContain("Appearance");
    expect(hasCharacterProfileGuidance(profile)).toBe(true);
    expect(hasCharacterProfileGuidance(characterProfileSchema.parse({}))).toBe(false);
    expect(hasCharacterProfileGuidance(characterProfileSchema.parse({
      appearance: { clothing: "a blue cloak" }
    }))).toBe(false);
  });

  it("builds a bounded appearance-only reference and sanitizes legacy mechanics", () => {
    const visual = characterVisualReference({ name: "Mira", profile }, null, 900);
    expect(visual).toContain("Name: Mira");
    expect(visual).toContain("weathered blue cloak");
    expect(visual).not.toContain("Find the vanished road");
    expect(visual).not.toContain("Patient");

    const fallback = characterVisualReference(null, {
      name: "Legacy Mira",
      characterText: "Silver cloak and black hair.\nDice roll: 19\nArmor Class: 16"
    });
    expect(fallback).toContain("Silver cloak and black hair.");
    expect(fallback).not.toMatch(/dice|armor class/i);
    expect(characterVisualReference({
      name: "Mira",
      profile: characterProfileSchema.parse({ story: { role: "Scout" } })
    }, null)).toBe("");
  });

  it("composes the canonical reference once and keeps it conditional", () => {
    const composed = composeIllustrationProviderPrompt("Mira crosses the bridge.", "Name: Mira\nHair: black braid");
    expect(composed).toContain("only if this character is depicted");
    expect(composed.match(/CANONICAL CHARACTER REFERENCE:/g)).toHaveLength(1);
    expect(composeIllustrationProviderPrompt(composed, "Name: Mira\nHair: black braid")
      .match(/CANONICAL CHARACTER REFERENCE:/g)).toHaveLength(1);
    expect(composeIllustrationProviderPrompt("An empty bridge.", "")).toBe("An empty bridge.");
  });
});

describe("strict character profile organizer validation", () => {
  const sources = {
    legacyGuidance: "Mira wears a weathered blue cloak.",
    existingProfile: "",
    rpgStats: "[]",
    defaultTriggers: "[]",
    "world.genre": "Fantasy",
    "world.tone": "Eerie",
    "world.premise": "Roads move after dusk.",
    "world.backgroundStory": ""
  };

  it("uses a complete, exact output contract and dynamically lists allowed evidence sources", () => {
    const prompt = characterProfileOrganizerPrompt();
    const input = characterProfileOrganizerInput("Mira", sources);
    expect(CHARACTER_PROFILE_ORGANIZER_PROTOCOL_VERSION).toBe("character-profile-organizer-v2");
    expect(prompt).toContain("The top-level object must contain exactly");
    expect(prompt).toContain("Never use sourceKey, verbatim");
    expect(prompt).toContain("silently verify the output contract");
    expect(prompt).toContain('"unassignedText": []');
    expect(input.allowedEvidenceSourceKeys).toEqual(Object.keys(sources));
    expect(input.outputTemplate).toMatchObject({
      candidate: { identity: {}, story: {}, appearance: {} },
      evidence: [],
      unassignedText: [], conflicts: [], warnings: []
    });
  });

  it("accepts exact evidence for every populated field", () => {
    const result = validateOrganizerResult({
      candidate: { appearance: { clothing: "weathered blue cloak" } },
      evidence: [{
        path: "appearance.clothing",
        source: "legacyGuidance",
        quote: "weathered blue cloak"
      }],
      unassignedText: [],
      conflicts: [],
      warnings: [],
      protocolVersion: "ignored-by-server"
    }, sources);
    expect(result.protocolVersion).toBe(CHARACTER_PROFILE_ORGANIZER_PROTOCOL_VERSION);
  });

  it("normalizes sourceKey and verbatim evidence aliases before validating the exact source", () => {
    const result = validateOrganizerResult({
      candidate: { appearance: { clothing: "weathered blue cloak" } },
      evidence: [{
        path: "appearance.clothing",
        sourceKey: "legacyGuidance",
        verbatim: "weathered blue cloak"
      }],
      unassignedText: [],
      conflicts: [],
      warnings: [],
      protocolVersion: "ignored-by-server"
    }, sources);
    expect(result.evidence).toEqual([{
      path: "appearance.clothing",
      source: "legacyGuidance",
      quote: "weathered blue cloak"
    }]);
  });

  it("normalizes single organizer notices into their required text lists", () => {
    const result = validateOrganizerResult({
      candidate: {},
      evidence: [],
      unassignedText: "The scar placement is not established.",
      conflicts: "The cloak is described as both blue and green.",
      warnings: "Keep the age field blank.",
      protocolVersion: "ignored-by-server"
    }, sources);
    expect(result.unassignedText).toEqual(["The scar placement is not established."]);
    expect(result.conflicts).toEqual(["The cloak is described as both blue and green."]);
    expect(result.warnings).toEqual(["Keep the age field blank."]);
  });

  it("accepts evidence with only whitespace differences from the submitted source", () => {
    const result = validateOrganizerResult({
      candidate: { appearance: { clothing: "weathered blue cloak" } },
      evidence: [{
        path: "appearance.clothing",
        source: "legacyGuidance",
        quote: "weathered\n  blue cloak"
      }],
      unassignedText: [], conflicts: [], warnings: [], protocolVersion: "ignored-by-server"
    }, sources);
    expect(result.evidence[0]?.quote).toBe("weathered\n  blue cloak");
  });

  it("repairs one invalid evidence response and validates the replacement strictly", async () => {
    const invalid = {
      candidate: { appearance: { clothing: "weathered blue cloak" } },
      evidence: [{ path: "appearance.clothing", source: "legacyGuidance", quote: "blue travel cloak" }],
      unassignedText: [], conflicts: [], warnings: [], protocolVersion: "ignored-by-server"
    };
    const repair = vi.fn(async (failure) => {
      expect(failure).toEqual({ path: "appearance.clothing", source: "legacyGuidance", quote: "blue travel cloak" });
      return {
        ...invalid,
        evidence: [{ path: "appearance.clothing", source: "legacyGuidance", quote: "weathered blue cloak" }]
      };
    });
    const result = await validateOrganizerResultWithRepair(invalid, sources, repair);
    expect(repair).toHaveBeenCalledTimes(1);
    expect(result.evidence[0]?.quote).toBe("weathered blue cloak");
  });

  it("supplies the failed evidence and original result to a bounded repair prompt", () => {
    const prompt = characterProfileOrganizerRepairPrompt();
    const priorResponse = { candidate: {}, evidence: [], unassignedText: [], conflicts: [], warnings: [] };
    const input = characterProfileOrganizerRepairInput("Mira", sources, priorResponse, {
      path: "story.background", source: "legacyGuidance", quote: "unsupported quote"
    });
    expect(prompt).toContain("REPAIR MODE");
    expect(prompt).toContain("complete replacement response, not a patch");
    expect(input.validationFailures).toEqual([{ path: "story.background", source: "legacyGuidance", quote: "unsupported quote" }]);
    expect(input.priorResponse).toBe(priorResponse);
  });

  it("rejects invented values and evidence excerpts absent from the submitted sources", () => {
    expect(() => validateOrganizerResult({
      candidate: { appearance: { eyes: "violet" } },
      evidence: [],
      unassignedText: [],
      conflicts: [],
      warnings: [],
      protocolVersion: CHARACTER_PROFILE_ORGANIZER_PROTOCOL_VERSION
    }, sources)).toThrow("unsupported profile fields");

    expect(() => validateOrganizerResult({
      candidate: { appearance: { clothing: "weathered blue cloak" } },
      evidence: [{
        path: "appearance.clothing",
        source: "legacyGuidance",
        quote: "a jeweled crown"
      }],
      unassignedText: [],
      conflicts: [],
      warnings: [],
      protocolVersion: CHARACTER_PROFILE_ORGANIZER_PROTOCOL_VERSION
    }, sources)).toThrow("was not found");
  });

  it("includes world lore, background, and canon as read-only evidence sources", () => {
    const content = worldContentSchema.parse({
      schemaVersion: 5,
      world: {
        title: "Organized World",
        backgroundStory: "Mira once guarded the moon gate.",
        lore: "The moon gate remembers Mira's oath.",
        background: "Mira was raised in the gatehouse.",
        canon: "Mira carries the gatehouse key."
      },
      entities: [{ name: "Moon Gate", description: "Mira's former post." }],
      relationships: [{ from: "Mira", to: "Moon Gate", type: "former guardian" }]
    });
    const sources = characterProfileOrganizerSources({
      id: "mira",
      name: "Mira",
      characterText: "",
      profile: characterProfileSchema.parse({}),
      rpgStats: [],
      defaultTriggers: [],
      source: {}
    }, content);

    expect(sources["world.backgroundAndCanon"]).toContain("Mira once guarded the moon gate");
    expect(sources["world.lore"]).toContain("moon gate remembers Mira's oath");
    expect(sources["world.lore"]).toContain("Mira's former post");
    expect(sources["world.background"]).toContain("raised in the gatehouse");
    expect(sources["world.canon"]).toContain("gatehouse key");
  });
});
