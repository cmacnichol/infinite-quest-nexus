import { describe, expect, it, vi } from "vitest";
import { worldContentSchema } from "../../packages/contracts/src/world-library.js";
import type { ProviderRequest, ProviderResult } from "../../packages/story-engine/src/providers.js";
import type { WorldGenerationProviderCollaborators } from "../../services/runtime/src/provider-application-composition.js";
import { generatePlayableCharacterPreviewForOwner } from "../../services/runtime/src/provider-world-generation-adapter.js";

function providerResult(content: string): ProviderResult {
  return {
    content, responseId: "response-id", finishReason: "stop", outputLimited: false,
    modelInstanceId: "model", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, reportedCost: null, rawMetadata: {}
  };
}

function validCharacterResponse() {
  return {
    name: "Iris",
    profile: {
      identity: { aliases: [], pronouns: "" },
      story: {
        role: "Cartographer", background: "Raised in a harbor", personality: "", motivations: "",
        goals: "Map the inland roads", fearsAndConflicts: "", keyRelationships: "", narrativeHooks: "", voiceAndMannerisms: "", otherGuidance: ""
      },
      appearance: { ancestryOrSpecies: "", apparentAge: "", genderPresentation: "", build: "", skinOrComplexion: "", face: "", eyes: "", hair: "", distinguishingFeatures: [], clothing: "", equipmentAndAccessories: "", otherVisualDetails: "" },
      unclassifiedNotes: ""
    },
    rpgStats: [], defaultTriggers: []
  };
}

function providersWithExecute(execute: (request: ProviderRequest) => Promise<ProviderResult>): WorldGenerationProviderCollaborators {
  return {
    resolution: { resolveDirect: async () => ({ status: "resolved", providerProfileId: "provider", model: "model" }) },
    execution: { text: async () => ({ execute }) },
    prompts: { loadWorldGenerationPromptSnapshot: async () => ({ snapshot: {} }) },
    promptTools: { content: () => "Write a playable character." }
  } as unknown as WorldGenerationProviderCollaborators;
}

describe("playable character authoring runtime", () => {
  it("repairs an incomplete structured preview without writes or provider continuation state", async () => {
    const rejectedContent = JSON.stringify({ name: "Iris", profile: "x".repeat(17_000) });
    const execute = vi.fn()
      .mockResolvedValueOnce(providerResult(rejectedContent))
      .mockResolvedValueOnce(providerResult(JSON.stringify(validCharacterResponse())));
    const progressDependencies = {
      createWorldGenerationProgress: vi.fn(),
      updateWorldGenerationProgress: vi.fn()
    };
    const request = {
      content: worldContentSchema.parse({ world: { title: "Road Atlas" }, playableCharacters: [] }),
      prompt: "Create a harbor cartographer."
    };

    const result = await generatePlayableCharacterPreviewForOwner(
      {} as never, "owner-id", request, providersWithExecute(execute), progressDependencies as never
    );

    expect(result.character.name).toBe("Iris");
    expect(result.character.characterText).toContain("Cartographer");
    expect(execute).toHaveBeenCalledTimes(2);
    const [initial, repair] = execute.mock.calls.map(([value]) => value as ProviderRequest);
    for (const providerRequest of [initial!, repair!]) {
      expect(providerRequest.responseFormatFallback).toBe("forbid");
      expect(providerRequest).not.toHaveProperty("previousResponseId");
      expect(providerRequest.systemPrompt).toContain("character-authoring-v3-validated-profile");
      expect(JSON.parse(providerRequest.input)).toMatchObject({
        task: "Create one new, distinct playable character for this world.",
        userPrompt: "Create a harbor cartographer.",
        world: { title: "Road Atlas" }
      });
    }
    expect(repair!.input).toBe(initial!.input);
    expect(repair!.rejectedResponse).toContain("[diagnostic truncated]");
    expect(Array.from(repair!.rejectedResponse || "")).toHaveLength(16_000);
    expect(JSON.parse(repair!.recoveryInput || "{}")).toMatchObject({
      issues: [expect.objectContaining({ path: "profile", code: "invalid_type" })]
    });
    expect(repair!.recoveryInput).not.toContain("Iris");
    expect(progressDependencies.createWorldGenerationProgress).not.toHaveBeenCalled();
    expect(progressDependencies.updateWorldGenerationProgress).not.toHaveBeenCalled();
  });
});
