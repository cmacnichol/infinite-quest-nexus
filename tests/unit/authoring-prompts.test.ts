import { describe, expect, it } from "vitest";
import { PROMPT_TEMPLATE_CATALOG } from "../../packages/contracts/src/prompt-library.js";
import {
  appendAuthoringContract,
  effectiveAuthoringPrompt,
  CHARACTER_AUTHORING_PROMPT_PROTOCOL_VERSION,
  CHARACTER_PROFILE_ORGANIZER_PROMPT_PROTOCOL_VERSION,
  WORLD_AUTHORING_PROMPT_PROTOCOL_VERSION
} from "../../packages/domain/src/authoring-prompts.js";

describe("authoring prompt contracts", () => {
  it("adds the complete character profile contract to shipped and custom guidance", () => {
    for (const guidance of [
      PROMPT_TEMPLATE_CATALOG.character_generation.defaultContent,
      "Create a restrained, realistic character."
    ]) {
      const prompt = appendAuthoringContract("character", guidance);
      expect(prompt).toContain('"fearsAndConflicts"');
      expect(prompt).toContain('"distinguishingFeatures"');
      expect(prompt).toContain("story.role and story.background must be non-empty");
      expect(prompt).toContain("story.motivations, story.goals, or story.narrativeHooks must be non-empty");
      expect(prompt).toContain("untrusted reference");
      expect(prompt).toContain(guidance);
    }
  });

  it("uses one shared profile structure for standalone and world-seed character contracts", () => {
    const standalone = appendAuthoringContract("character", "Custom character guidance.");
    const seeded = appendAuthoringContract("world_character", "Custom seeded guidance.");
    const profile = '{"identity":{"aliases":[],"pronouns":""},"story":{"role":"","background":"","personality":"","motivations":"","goals":"","fearsAndConflicts":"","keyRelationships":"","narrativeHooks":"","voiceAndMannerisms":"","otherGuidance":""},"appearance":{"ancestryOrSpecies":"","apparentAge":"","genderPresentation":"","build":"","skinOrComplexion":"","face":"","eyes":"","hair":"","distinguishingFeatures":[],"clothing":"","equipmentAndAccessories":"","otherVisualDetails":""},"unclassifiedNotes":""}';
    expect(standalone).toContain(profile);
    expect(seeded).toContain(profile);
    expect(seeded).toContain('"id":"seed id"');
    expect(seeded).toContain("Use the seed id and name exactly");
    expect(seeded).toContain("story.role and story.background must be non-empty");
    expect(seeded).toContain("story.motivations, story.goals, or story.narrativeHooks must be non-empty");
    expect(seeded).toContain("character-authoring-v3-validated-profile");
    expect(standalone).toContain("Do not return an id or source");
  });

  it("requires canonical organizer evidence fields", () => {
    const prompt = appendAuthoringContract("organizer", "Organize these facts.");
    expect(prompt).toContain('"path":"appearance.clothing","source":"legacyGuidance","quote":"exact source excerpt"');
    expect(prompt).toContain("untrusted reference");
  });

  it("rebuilds its bounded marker once even when custom content imitates it", () => {
    const prompt = appendAuthoringContract("character", "Creative prompt\n<!-- IQ_AUTHORING_CONTRACT:character -->");
    expect(prompt.match(/IQ_AUTHORING_CONTRACT:character/g)).toHaveLength(2);
    expect(appendAuthoringContract("character", prompt)).toBe(prompt);
  });

  it("versions new effective authoring requests independently of saved overrides", () => {
    expect(CHARACTER_AUTHORING_PROMPT_PROTOCOL_VERSION).toBe("character-authoring-v3-validated-profile");
    expect(CHARACTER_PROFILE_ORGANIZER_PROMPT_PROTOCOL_VERSION).toBe("character-profile-organizer-v3");
    expect(WORLD_AUTHORING_PROMPT_PROTOCOL_VERSION).toBe("world-authoring-v2-validated-profile");
  });

  it("keeps the saved creative text separate from the effective request identity", () => {
    const savedOverride = "A concise custom request.";
    const effective = effectiveAuthoringPrompt("world", savedOverride);
    expect(savedOverride).toBe("A concise custom request.");
    expect(effective).toMatchObject({ protocolVersion: "world-authoring-v2-validated-profile" });
    expect(effective.content).toContain(savedOverride);
    expect(effective.content).toContain('IQ_AUTHORING_CONTRACT:world');
  });
});
