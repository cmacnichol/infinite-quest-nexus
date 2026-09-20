import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  characterProfileSchema,
  worldContentSchema
} from "../../packages/contracts/src/world-library.js";
import {
  characterLegacyText,
  characterFictionAuthority,
  characterNarrativeContext,
  characterVisualReference,
  effectiveCampaignCharacter,
  hasCharacterProfileGuidance
} from "../../packages/domain/src/world-characters.js";
import { composeIllustrationProviderPrompt } from "../../packages/domain/src/illustrations.js";
import { ProviderHttpError } from "../../packages/story-engine/src/providers.js";
import {
  CHARACTER_PROFILE_ORGANIZER_PROTOCOL_VERSION,
  characterProfileOrganizerInput,
  characterProfileOrganizerPrompt,
  characterProfileOrganizerRepairInput,
  characterProfileOrganizerRepairPrompt,
  characterProfileOrganizerSources,
  organizeWorldCharacterProfileForOwner,
  validateOrganizerResultWithRepair,
  validateOrganizerResult
} from "../../services/runtime/src/provider-character-organization-adapter.js";

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
  it("projects every known fiction field without preview caps and denies extensions and mechanics", () => {
    const relationship = "trusted navigator ".repeat(120);
    const authority = characterFictionAuthority({
      name: "Campaign Mira",
      profile: characterProfileSchema.parse({
        identity: { aliases: ["The Fox"], pronouns: "she/her", unknownIdentity: "PRIVATE_EXTENSION" },
        story: { role: "Scout", keyRelationships: relationship, unknownStory: "PRIVATE_EXTENSION" },
        appearance: { clothing: "blue cloak", unknownAppearance: "PRIVATE_EXTENSION" },
        unclassifiedNotes: "A complete private fiction note.",
        extension: "PRIVATE_EXTENSION"
      })
    }, {
      name: "Origin Mira",
      characterText: "Dice roll: 19. Original guidance."
    });

    expect(authority).toMatchObject({
      source: "campaign_profile",
      name: "Campaign Mira",
      profile: {
        identity: { aliases: ["The Fox"], pronouns: "she/her" },
        story: { role: "Scout", keyRelationships: relationship.trim() },
        appearance: { clothing: "blue cloak" },
        unclassifiedNotes: "A complete private fiction note."
      },
      omittedExtensionFieldCount: 4
    });
    expect(JSON.stringify(authority)).not.toContain("PRIVATE_EXTENSION");
    expect(JSON.stringify(authority)).not.toContain("Original guidance.");
    expect(JSON.stringify(authority)).not.toMatch(/dice|rpgStats|defaultTriggers/i);
  });

  it("removes recognized credential and configuration leakage from every admitted fiction field", () => {
    const secret = "fixture-private-provider-token-T04";
    const authority = characterFictionAuthority({
      name: "Mira",
      profile: characterProfileSchema.parse({
        identity: { aliases: [`Provider token: ${secret}`, "The Fox"] },
        story: { role: `API key=${secret}`, background: "Mira maps safe roads." },
        appearance: { clothing: `Authorization: Bearer ${secret}`, distinguishingFeatures: [`token=${secret}`, "silver pin"] },
        unclassifiedNotes: `https://example.test/path?api_key=${secret}\nShe trusts the old bridge.`
      })
    }, null);

    expect(JSON.stringify(authority)).not.toContain(secret);
    expect(authority.profile).toMatchObject({
      identity: { aliases: ["The Fox"] },
      story: { background: "Mira maps safe roads." },
      appearance: { distinguishingFeatures: ["silver pin"] },
      unclassifiedNotes: "She trusts the old bridge."
    });
  });

  it("keeps complete known fiction or reports protected overflow to the caller; it never clips it", () => {
    const longBackground = "The complete background remains whole. ".repeat(500);
    const storedProfile = characterProfileSchema.parse({ story: { background: longBackground } });
    const authority = characterFictionAuthority({
      name: "Mira",
      profile: storedProfile
    }, null);

    expect(authority.profile?.story.background).toBe(storedProfile.story.background);
    expect(authority.profile?.story.background).toHaveLength(storedProfile.story.background.length);
  });

  it("keeps profile guidance separate from dynamic continuity precedence", () => {
    const authority = characterFictionAuthority({
      name: "Mira Renamed",
      profile: characterProfileSchema.parse({
        story: { background: "Earlier dialogue may retain the old name." },
        appearance: { clothing: "starting blue cloak", equipmentAndAccessories: "starting sword" }
      })
    }, null);

    expect(authority).toMatchObject({
      source: "campaign_profile",
      name: "Mira Renamed",
      profile: { appearance: { clothing: "starting blue cloak", equipmentAndAccessories: "starting sword" } }
    });
    // Current location, possessions, clothing, and relationship state are resolved
    // by the correction-aware continuity component, never merged into this origin.
    expect(authority).not.toHaveProperty("currentContinuity");
  });
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
    expect(CHARACTER_PROFILE_ORGANIZER_PROTOCOL_VERSION).toBe("character-profile-organizer-v3");
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

  it("normalizes provider evidence aliases and removes them before strict parsing", () => {
    const result = validateOrganizerResult({
      candidate: { appearance: { clothing: "weathered blue cloak" } },
      evidence: [{
        field: "appearance.clothing",
        sourceKey: "legacyGuidance",
        content: "weathered blue cloak",
        verbatim: "weathered blue cloak"
      }],
      unassignedText: [], conflicts: [], warnings: [], protocolVersion: "ignored-by-server"
    }, sources);
    expect(result.evidence).toEqual([{
      path: "appearance.clothing",
      source: "legacyGuidance",
      quote: "weathered blue cloak"
    }]);
  });

  it("rejects conflicting canonical and provider evidence aliases", () => {
    expect(() => validateOrganizerResult({
      candidate: { appearance: { clothing: "weathered blue cloak" } },
      evidence: [{
        path: "appearance.clothing",
        field: "appearance.eyes",
        source: "legacyGuidance",
        quote: "weathered blue cloak"
      }],
      unassignedText: [], conflicts: [], warnings: [], protocolVersion: "ignored-by-server"
    }, sources)).toThrow();
  });

  it("rejects evidence that names an inherited source key", () => {
    expect(() => validateOrganizerResult({
      candidate: { appearance: { clothing: "weathered blue cloak" } },
      evidence: [{ path: "appearance.clothing", source: "constructor", quote: "weathered blue cloak" }],
      unassignedText: [], conflicts: [], warnings: [], protocolVersion: "ignored-by-server"
    }, sources)).toThrow("was not found");
  });

  it("rejects evidence paths for empty fields and mechanics in incomplete organizer candidates", () => {
    expect(() => validateOrganizerResult({
      candidate: {},
      evidence: [{ path: "appearance.clothing", source: "legacyGuidance", quote: "weathered blue cloak" }],
      unassignedText: [], conflicts: [], warnings: [], protocolVersion: "ignored-by-server"
    }, sources)).toThrow("must refer to a populated profile field");

    expect(() => validateOrganizerResult({
      candidate: { story: { otherGuidance: "Roll 1d20 to cross the bridge." } },
      evidence: [{ path: "story.otherGuidance", source: "legacyGuidance", quote: "Mira wears a weathered blue cloak." }],
      unassignedText: [], conflicts: [], warnings: [], protocolVersion: "ignored-by-server"
    }, { ...sources, legacyGuidance: "Roll 1d20 to cross the bridge." })).toThrow();

    expect(() => validateOrganizerResult({
      candidate: { privateReasoning: "never save" }, evidence: [],
      unassignedText: [], conflicts: [], warnings: [], protocolVersion: "ignored-by-server"
    }, sources)).toThrow();
  });

  it.each([
    [{ privateReasoning: "never save" }, "privateReasoning"],
    [{ appearance: { credentials: { password: 42 } } }, "appearance.credentials.password"],
    [{ extensions: [{ hiddenMetadata: false }] }, "extensions.0.hiddenMetadata"],
    [{ extensions: { api_key: null } }, "extensions.api_key"]
  ])("rejects prohibited organizer metadata even with valid source evidence: %j", (candidate, path) => {
    expect(() => validateOrganizerResult({
      candidate, evidence: [{ path, source: "legacyGuidance", quote: "Blue coat" }],
      unassignedText: [], conflicts: [], warnings: []
    }, { legacyGuidance: "Blue coat" })).toThrow("prohibited provider metadata");
  });

  it.each([true, false])("repairs evidence-backed prohibited organizer metadata once (valid replacement: %s)", async (validReplacement) => {
    const invalid = { candidate: { privateReasoning: "never save" }, evidence: [{ path: "privateReasoning", source: "legacyGuidance", quote: "Blue coat" }], unassignedText: [], conflicts: [], warnings: [] };
    const valid = { ...invalid, candidate: { appearance: { clothing: "Blue coat" } }, evidence: [{ path: "appearance.clothing", source: "legacyGuidance", quote: "Blue coat" }] };
    const responses = [invalid, validReplacement ? valid : invalid];
    const requests: Array<{ input: string }> = [];
    const content = worldContentSchema.parse({ world: { title: "Organizer world" } });
    const result = organizeWorldCharacterProfileForOwner(
      { query: async () => ({ rows: [{ status: "draft", revision: 1, content }] }) } as never,
      "owner", "world", { expectedRevision: 1, character: { id: "mira", name: "Mira", characterText: "Blue coat", rpgStats: [], defaultTriggers: [], source: {} } },
      {
        resolution: { resolveDirect: async () => ({ status: "resolved", providerProfileId: "provider", model: "model" }) },
        execution: { text: async () => ({ execute: async (request: { input: string }) => { requests.push(request); return { content: JSON.stringify(responses.shift()), responseId: "response", finishReason: "stop", outputLimited: false, modelInstanceId: "model", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, reportedCost: null, rawMetadata: {} }; } }) },
        prompts: { loadCharacterOrganizationPromptSnapshot: async () => ({ snapshot: {} }) },
        promptTools: { content: () => "Organize supplied character facts." }
      } as never
    );
    if (validReplacement) {
      await expect(result).resolves.toMatchObject({ candidate: { appearance: { clothing: "Blue coat" }, story: { role: "", background: "" } } });
    } else {
      const failure = await result.catch((error) => error);
      expect(failure).toMatchObject({ name: "AuthoringResponseError", authoringFailure: { stage: "organizer", code: "invalid_authoring_output", issues: [{ path: "profile", code: "custom", message: "Generated character contains prohibited provider metadata." }] } });
      expect(JSON.stringify(failure.authoringFailure)).not.toMatch(/never save|privateReasoning/);
    }
    expect(requests).toHaveLength(2);
    expect(JSON.parse(requests[1]!.input).validationFailures).toEqual([{ path: "profile", code: "custom", message: "Generated character contains prohibited provider metadata." }]);
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

  it("keeps the direct repair helper bounded for structural organizer failures", async () => {
    const repair = vi.fn(async (issues) => {
      expect(issues).toEqual([{
        path: "evidence",
        code: "invalid_type",
        message: "Generated content has an invalid type."
      }]);
      return { candidate: {}, evidence: [], unassignedText: [], conflicts: [], warnings: [] };
    });
    await expect(validateOrganizerResultWithRepair({
      candidate: {}, evidence: "not an array", unassignedText: [], conflicts: [], warnings: []
    }, sources, repair)).resolves.toMatchObject({ candidate: {}, evidence: [] });
    expect(repair).toHaveBeenCalledTimes(1);
  });

  it("sends the effective organizer contract on initial and repair provider calls", async () => {
    const providerProfileId = "33333333-3333-4333-8333-333333333333";
    const requests: Array<{ systemPrompt: string; input: string }> = [];
    const invocations: any[] = [];
    const executePrepared = vi.fn(async (invocation: any) => {
      const { request } = invocation;
      invocations.push(invocation);
      requests.push(request);
      return { content: JSON.stringify(responses.shift()), responseId: "response", finishReason: "stop", outputLimited: false, modelInstanceId: "model", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, reportedCost: null, rawMetadata: {} };
    });
    const getPreset = vi.fn(async () => ({ slug: "organizer", name: "Organizer", versionId: "v1", version: 1, configHash: "a".repeat(64), config: { models: ["native-model"] }, systemPrompt: "Preset instructions." }));
    const listModels = vi.fn(async () => [{ id: "native-model", contextWindowTokens: 8192, maxOutputTokens: 1024 }]);
    const responses = [
      { candidate: { appearance: { clothing: "weathered blue cloak" } }, evidence: [{ path: "appearance.clothing", source: "legacyGuidance", quote: "wrong quote" }], unassignedText: [], conflicts: [], warnings: [] },
      { candidate: { appearance: { clothing: "weathered blue cloak" } }, evidence: [{ path: "appearance.clothing", source: "legacyGuidance", quote: "weathered blue cloak" }], unassignedText: [], conflicts: [], warnings: [] }
    ];
    const content = worldContentSchema.parse({ world: { title: "Organizer world" } });
    const result = await organizeWorldCharacterProfileForOwner(
      { query: async () => ({ rows: [{ status: "draft", revision: 1, content }] }) } as never,
      "owner", "world", { expectedRevision: 1, character: { id: "mira", name: "Mira", characterText: "Mira wears a weathered blue cloak.", rpgStats: [], defaultTriggers: [], source: {} } },
      {
        resolution: { resolveDirect: async () => ({ status: "resolved", providerProfileId, model: "model" }) },
        execution: { text: async () => ({ id: providerProfileId, name: "Native", providerRole: "text", providerType: "openrouter", model: "model", contextWindowTokens: 8192, maxOutputTokens: 1024, temperature: 0.7, requestTimeoutMs: 30_000, configuration: {}, executionRevision: "execution", authorityRevision: "authority", textSelection: { kind: "openrouter_preset", slug: "organizer" }, execute: async () => { throw new Error("legacy execute must not receive enabled native work"); } }) },
        prompts: { loadCharacterOrganizationPromptSnapshot: async () => ({ snapshot: {} }) },
        promptTools: { content: (_snapshot: unknown, key: string) => key === "character_profile_repair" ? "Repair organizer response." : "Organize supplied character facts." },
        authoringTextPlans: { nativePresetPlansEnabled: true, preparedExecutor: { execute: executePrepared }, loadAuthority: async () => ({ id: providerProfileId, providerRole: "text", authorityRevision: "authority" }), ports: { resolvePreset: async () => getPreset(), discoverModels: async () => listModels() } }
      } as never
    );
    expect(result.candidate.appearance.clothing).toBe("weathered blue cloak");
    expect(requests).toHaveLength(2);
    expect(getPreset).toHaveBeenCalledTimes(1);
    expect(listModels).toHaveBeenCalledTimes(1);
    expect(executePrepared.mock.calls.map(([input]) => input.operation)).toEqual(["character_organizer", "character_organizer_repair"]);
    for (const request of requests) {
      expect(request.systemPrompt).toContain('"path":"appearance.clothing","source":"legacyGuidance","quote":"exact source excerpt"');
      expect(request.systemPrompt).toContain("character-profile-organizer-v3");
      expect(request.systemPrompt).toContain("untrusted reference");
      expect(request.systemPrompt).toContain("Preset instructions.");
      expect((request as Record<string, unknown>).responseFormatFallback).toBe("forbid");
      expect(request).not.toHaveProperty("previousResponseId");
    }
    expect(JSON.parse(requests[1]!.input).validationFailures).toEqual([{
      path: "evidence.0.source",
      code: "custom",
      message: "Organizer evidence does not support a populated profile field."
    }]);
    expect(requests[0]?.systemPrompt).not.toBe(requests[1]?.systemPrompt);
    expect(invocations.map((invocation) => JSON.parse(invocation.preparedRequest.body).response_format.json_schema.name))
      .toEqual(["infinite_quest_character_organizer_v1", "infinite_quest_character_organizer_v1"]);
    for (const invocation of invocations) {
      expect(invocation.preparedRequest.payloadHash).toBe(createHash("sha256").update(invocation.preparedRequest.body).digest("hex"));
      expect(invocation.preparedRequest.body.match(/Preset instructions\./g)).toHaveLength(1);
    }
  });

  it("retains the legacy organizer request and repair path", async () => {
    const requests: Array<{ systemPrompt: string; input: string }> = [];
    const responses = [
      { candidate: { appearance: { clothing: "weathered blue cloak" } }, evidence: [{ path: "appearance.clothing", source: "legacyGuidance", quote: "wrong quote" }], unassignedText: [], conflicts: [], warnings: [] },
      { candidate: { appearance: { clothing: "weathered blue cloak" } }, evidence: [{ path: "appearance.clothing", source: "legacyGuidance", quote: "weathered blue cloak" }], unassignedText: [], conflicts: [], warnings: [] }
    ];
    const content = worldContentSchema.parse({ world: { title: "Organizer world" } });
    await organizeWorldCharacterProfileForOwner(
      { query: async () => ({ rows: [{ status: "draft", revision: 1, content }] }) } as never,
      "owner", "world", { expectedRevision: 1, character: { id: "mira", name: "Mira", characterText: "Mira wears a weathered blue cloak.", rpgStats: [], defaultTriggers: [], source: {} } },
      {
        resolution: { resolveDirect: async () => ({ status: "resolved", providerProfileId: "provider", model: "model" }) },
        execution: { text: async () => ({ execute: async (request: unknown) => { requests.push(request as { systemPrompt: string; input: string }); return { content: JSON.stringify(responses.shift()), responseId: "response", finishReason: "stop", outputLimited: false, modelInstanceId: "model", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, reportedCost: null, rawMetadata: {} }; } }) },
        prompts: { loadCharacterOrganizationPromptSnapshot: async () => ({ snapshot: {} }) },
        promptTools: { content: () => "Organize supplied character facts." }
      } as never
    );
    expect(requests).toHaveLength(2);
    expect(requests[0]?.systemPrompt).toContain("character-profile-organizer-v3");
    expect(JSON.parse(requests[1]!.input).validationFailures).toEqual([{ path: "evidence.0.source", code: "custom", message: "Organizer evidence does not support a populated profile field." }]);
  });

  it("repairs malformed organizer output once and fails safely when the replacement is malformed", async () => {
    const requests: unknown[] = [];
    const content = worldContentSchema.parse({ world: { title: "Organizer world" } });
    await expect(organizeWorldCharacterProfileForOwner(
      { query: async () => ({ rows: [{ status: "draft", revision: 1, content }] }) } as never,
      "owner", "world", { expectedRevision: 1, character: { id: "mira", name: "Mira", characterText: "Mira wears a weathered blue cloak.", rpgStats: [], defaultTriggers: [], source: {} } },
      {
        resolution: { resolveDirect: async () => ({ status: "resolved", providerProfileId: "provider", model: "model" }) },
        execution: { text: async () => ({ execute: async (request: unknown) => { requests.push(request); return { content: "not JSON", responseId: "response", finishReason: "stop", outputLimited: false, modelInstanceId: "model", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, reportedCost: null, rawMetadata: {} }; } }) },
        prompts: { loadCharacterOrganizationPromptSnapshot: async () => ({ snapshot: {} }) },
        promptTools: { content: () => "Organize supplied character facts." }
      } as never
    )).rejects.toMatchObject({ name: "AuthoringResponseError", authoringFailure: { code: "invalid_authoring_output", stage: "organizer" } });
    expect(requests).toHaveLength(2);
  });

  it("maps an unavailable organizer resolution to a typed authoring failure", async () => {
    const content = worldContentSchema.parse({ world: { title: "Organizer world" } });
    await expect(organizeWorldCharacterProfileForOwner(
      { query: async () => ({ rows: [{ status: "draft", revision: 1, content }] }) } as never,
      "owner", "world", { expectedRevision: 1, character: { id: "mira", name: "Mira", characterText: "", rpgStats: [], defaultTriggers: [], source: {} } },
      { resolution: { resolveDirect: async () => ({ status: "unavailable" }) } } as never
    )).rejects.toMatchObject({ name: "AuthoringResponseError", statusCode: 503, authoringFailure: { code: "authoring_provider_unavailable", stage: "organizer" } });
  });

  it("maps a missing resolved organizer execution profile to the same typed failure", async () => {
    const content = worldContentSchema.parse({ world: { title: "Organizer world" } });
    await expect(organizeWorldCharacterProfileForOwner(
      { query: async () => ({ rows: [{ status: "draft", revision: 1, content }] }) } as never,
      "owner", "world", { expectedRevision: 1, character: { id: "mira", name: "Mira", characterText: "", rpgStats: [], defaultTriggers: [], source: {} } },
      {
        resolution: { resolveDirect: async () => ({ status: "resolved", providerProfileId: "missing", model: "model" }) },
        execution: { text: async () => { throw Object.assign(new Error("missing"), { statusCode: 404 }); } }
      } as never
    )).rejects.toMatchObject({ name: "AuthoringResponseError", statusCode: 503, authoringFailure: { code: "authoring_provider_unavailable", stage: "organizer" } });
  });

  it("waits for the bounded provider retry delay before a second organizer request", async () => {
    vi.useFakeTimers();
    try {
      const requests = vi.fn()
        .mockRejectedValueOnce(new ProviderHttpError(503, null, "unavailable"))
        .mockResolvedValueOnce({ content: JSON.stringify({ candidate: {}, evidence: [], unassignedText: [], conflicts: [], warnings: [] }), responseId: "response", finishReason: "stop", outputLimited: false, modelInstanceId: "model", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, reportedCost: null, rawMetadata: {} });
      const content = worldContentSchema.parse({ world: { title: "Organizer world" } });
      const pending = organizeWorldCharacterProfileForOwner(
        { query: async () => ({ rows: [{ status: "draft", revision: 1, content }] }) } as never,
        "owner", "world", { expectedRevision: 1, character: { id: "mira", name: "Mira", characterText: "", rpgStats: [], defaultTriggers: [], source: {} } },
        {
          resolution: { resolveDirect: async () => ({ status: "resolved", providerProfileId: "provider", model: "model" }) },
          execution: { text: async () => ({ execute: requests }) },
          prompts: { loadCharacterOrganizationPromptSnapshot: async () => ({ snapshot: {} }) },
          promptTools: { content: () => "Organize supplied character facts." }
        } as never
      );
      await vi.advanceTimersByTimeAsync(999);
      expect(requests).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toMatchObject({ candidate: {} });
      expect(requests).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
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
