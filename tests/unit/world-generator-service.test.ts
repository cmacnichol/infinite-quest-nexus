import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { logger } from "../../packages/logger/src/index.js";
import {
  ProviderTransportError,
  type ProviderRequest,
  type ProviderResult
} from "../../packages/story-engine/src/providers.js";
import {
  generateTemplateWorld,
  generateWorldPreview,
  incompleteGeneratedWorldError,
  type TemplateWorldGenerationDependencies,
  type WorldGenerationPreviewDependencies,
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

function character(name: string) {
  return {
    id: `provider-${name.toLocaleLowerCase().replaceAll(" ", "-")}`,
    name,
    character_text: `${name} follows roads that move beneath moonlight.`,
    profile: profile(),
    rpg_statistics: [],
    default_triggers: []
  };
}

function worldResponse(playableCharacters: unknown[]): string {
  return JSON.stringify({
    title: "The Moving Roads",
    genre: "Weird fantasy",
    tone: "Hopeful",
    backgroundStory: "Cartographers once governed the coast.",
    premise: "Roads rearrange beneath moonlight.",
    firstAction: "A forbidden road appears outside the city.",
    story_rules: "Every road remembers its maker.",
    playable_characters: playableCharacters,
    rpg_statistics: [],
    default_triggers: [],
    event_triggers: []
  });
}

function providerResult(content: string): ProviderResult {
  return {
    content,
    responseId: "response-id",
    finishReason: "stop",
    outputLimited: false,
    modelInstanceId: "model-instance",
    usage: { inputTokens: 100, outputTokens: 200, totalTokens: 300 },
    reportedCost: null,
    rawMetadata: {}
  };
}

function generationHarness(outcomes: Array<ProviderResult | Error>) {
  const requests: ProviderRequest[] = [];
  const dependencies = {
    loadTextProvider: async () => ({
      id: "provider-id",
      name: "Test Provider",
      providerType: "lmstudio" as const,
      baseUrl: "http://lmstudio.test/v1",
      model: "test-model",
      contextWindowTokens: 32_000,
      maxOutputTokens: 8_000,
      temperature: 0
    }),
    resolvePromptSnapshot: async () => ({} as never),
    callTextProvider: async (_profile: unknown, request: ProviderRequest) => {
      requests.push(request);
      const outcome = outcomes.shift();
      if (!outcome) throw new Error("Unexpected provider call.");
      if (outcome instanceof Error) throw outcome;
      return outcome;
    }
  } as unknown as TemplateWorldGenerationDependencies;

  return {
    requests,
    run: () => generateTemplateWorld(
      {} as never,
      "owner-id",
      "provider-id",
      "credential-secret",
      {
        sourceName: "test-prompt",
        sourceKind: "prompt",
        title: "The Moving Roads",
        summary: "Roads move beneath moonlight.",
        keywords: [],
        excerpts: []
      },
      undefined,
      undefined,
      dependencies
    )
  };
}

describe("generateTemplateWorld orchestration", () => {
  it("makes exactly one supplement call for the exact missing roster count", async () => {
    const harness = generationHarness([
      providerResult(worldResponse([character("Mira Vale")])),
      providerResult(JSON.stringify({
        playable_characters: [character("Oren Pike"), character("Sela Moon")]
      }))
    ]);

    const generated = await harness.run();

    expect(generated.content.playableCharacters).toHaveLength(3);
    expect(harness.requests).toHaveLength(2);
    expect(harness.requests[1]!.systemPrompt).toContain("exactly 2 complete replacement characters");
    expect(harness.requests[1]!.systemPrompt).not.toContain("{{needed}}");
    expect(JSON.parse(harness.requests[1]!.input)).toMatchObject({
      existingCharacters: [{ name: "Mira Vale" }]
    });
  });

  it("returns a typed safe 502 when the supplement is malformed", async () => {
    const harness = generationHarness([
      providerResult(worldResponse([character("Mira Vale")])),
      providerResult("{\"playable_characters\":[")
    ]);

    await expect(harness.run()).rejects.toMatchObject({
      statusCode: 502,
      expose: true,
      details: { code: "incomplete_generated_world" }
    });
    expect(harness.requests).toHaveLength(2);
  });

  it("returns a typed safe 502 when the supplement count does not match needed", async () => {
    const harness = generationHarness([
      providerResult(worldResponse([character("Mira Vale")])),
      providerResult(JSON.stringify({ playable_characters: [] }))
    ]);

    await expect(harness.run()).rejects.toMatchObject({
      statusCode: 502,
      expose: true,
      details: { code: "incomplete_generated_world" }
    });
    expect(harness.requests).toHaveLength(2);
  });

  it("preserves provider error identity instead of converting it to an incomplete-world error", async () => {
    const providerError = Object.assign(new Error("Provider request failed (503): unavailable"), {
      statusCode: 503,
      providerMessage: "unavailable"
    });
    const harness = generationHarness([providerError]);

    await expect(harness.run()).rejects.toBe(providerError);
    expect(harness.requests).toHaveLength(1);
  });

  it("preserves provider transport-error identity and semantics", async () => {
    const providerError = new ProviderTransportError(
      "LM Studio story generation could not complete because the provider connection failed (ECONNRESET).",
      {
        providerType: "lmstudio",
        operation: "story generation",
        endpoint: "http://lmstudio.test/v1/responses",
        model: "test-model",
        timeoutMs: 300_000,
        durationMs: 75,
        timedOut: false,
        transportCode: "ECONNRESET",
        causeName: "TypeError",
        causeMessage: "connection reset"
      },
      new Error("connection reset")
    );
    const harness = generationHarness([providerError]);

    await expect(harness.run()).rejects.toBe(providerError);
    expect(providerError).toMatchObject({
      code: "provider_transport_error",
      statusCode: 502,
      expose: true
    });
    expect(harness.requests).toHaveLength(1);
  });

  it("caps a provider roster at four complete characters", async () => {
    const harness = generationHarness([
      providerResult(worldResponse([
        character("Mira Vale"),
        character("Oren Pike"),
        character("Sela Moon"),
        character("Tarin Reed"),
        character("Veya North")
      ]))
    ]);

    const generated = await harness.run();

    expect(generated.content.playableCharacters.map((entry) => entry.name)).toEqual([
      "Mira Vale",
      "Oren Pike",
      "Sela Moon",
      "Tarin Reed"
    ]);
    expect(harness.requests).toHaveLength(1);
  });

  it("uses complete provider replacements without fabricating fallback characters", async () => {
    const harness = generationHarness([
      providerResult(worldResponse([
        { id: "empty-guidance", name: "Incomplete", character_text: "", profile: profile() }
      ])),
      providerResult(JSON.stringify({
        playable_characters: [
          character("Mira Vale"),
          character("Oren Pike"),
          character("Sela Moon")
        ]
      }))
    ]);

    const generated = await harness.run();
    const names = generated.content.playableCharacters.map((entry) => entry.name);

    expect(names).toEqual(["Mira Vale", "Oren Pike", "Sela Moon"]);
    expect(names.some((name) => name.startsWith("Character Option"))).toBe(false);
    expect(harness.requests).toHaveLength(2);
  });
});

describe("generateWorldPreview provider failures", () => {
  it("logs only bounded projected generated-world issue fields", async () => {
    const marker = "PRIVATE_OVERSIZED_LOG_ISSUE";
    const generatedError = incompleteGeneratedWorldError(new z.ZodError([{
      path: [`world.${"p".repeat(500)}${marker}`],
      code: `${"c".repeat(100)}${marker}` as "custom",
      message: `${"m".repeat(500)}${marker}`
    }]));
    const dependencies = {
      initialOwnerId: async () => "owner-id",
      resolveEffectiveProviderId: async () => "provider-id",
      createWorldGenerationProgress: async () => undefined,
      updateWorldGenerationProgress: async () => undefined,
      generateTemplateWorld: async () => {
        throw generatedError;
      }
    } as unknown as WorldGenerationPreviewDependencies;
    const errorLog = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    let errorLogCalls: unknown[][] = [];

    try {
      await generateWorldPreview(
        {} as never,
        { title: "The Moving Roads", prompt: "Moving roads.", progressKey: "world-gen:test" },
        "credential-secret",
        dependencies
      );
    } catch {
      // Expected failure.
    } finally {
      errorLogCalls = [...errorLog.mock.calls];
      errorLog.mockRestore();
    }

    const logFields = errorLogCalls.at(-1)?.[0] as {
      issues: Array<{ path: string; code: string; message: string }>;
    };
    const issue = logFields.issues[0]!;
    expect(issue.path.length).toBeLessThanOrEqual(500);
    expect(issue.code.length).toBeLessThanOrEqual(100);
    expect(issue.message.length).toBeLessThanOrEqual(500);
    expect(JSON.stringify(logFields)).not.toContain(marker);
  });

  it("keeps transport diagnostics distinct without exposing transport causes", () => {
    const privateMarker = "PRIVATE_TRANSPORT_CAUSE";
    const error = new ProviderTransportError(
      "private wrapper message",
      {
        providerType: "lmstudio",
        operation: "story generation",
        endpoint: "http://lmstudio.test/v1/responses",
        model: "test-model",
        timeoutMs: 300_000,
        durationMs: 75,
        timedOut: false,
        transportCode: "ECONNRESET",
        causeName: "TypeError",
        causeMessage: privateMarker
      },
      new Error(privateMarker)
    );

    const diagnostic = worldGenerationFailureDiagnostic(error);

    expect(diagnostic).toEqual({
      message: "The text provider connection failed. Check the provider endpoint and server logs.",
      statusCode: 502,
      code: "provider_transport_error"
    });
    expect(JSON.stringify(diagnostic)).not.toContain(privateMarker);
  });

  it("logs and persists a bounded safe diagnostic while preserving the provider error", async () => {
    const privateMarker = "PRIVATE_PROVIDER_BODY_AND_LORE";
    const providerError = Object.assign(
      new Error(`Provider request failed (500): ${privateMarker}${"x".repeat(2_000)}`),
      {
        statusCode: 500,
        providerMessage: `${privateMarker}${"x".repeat(2_000)}`
      }
    );
    const progressUpdates: unknown[] = [];
    const dependencies = {
      initialOwnerId: async () => "owner-id",
      resolveEffectiveProviderId: async () => "provider-id",
      createWorldGenerationProgress: async () => undefined,
      updateWorldGenerationProgress: async (
        _pool: unknown,
        _ownerUserId: string,
        _progressKey: string,
        progress: unknown
      ) => {
        progressUpdates.push(progress);
      },
      generateTemplateWorld: async () => {
        throw providerError;
      }
    } as unknown as WorldGenerationPreviewDependencies;
    const errorLog = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    let errorLogCalls: unknown[][] = [];

    let thrown: unknown;
    try {
      await generateWorldPreview(
        {} as never,
        {
          title: "The Moving Roads",
          prompt: "PRIVATE_WORLD_PROMPT",
          progressKey: "world-gen:test"
        },
        "credential-secret",
        dependencies
      );
    } catch (error) {
      thrown = error;
    } finally {
      errorLogCalls = [...errorLog.mock.calls];
      errorLog.mockRestore();
    }

    expect(thrown).toBe(providerError);
    const persisted = progressUpdates.at(-1) as { status: string; message: string; errorMessage: string };
    expect(persisted).toMatchObject({
      status: "failed",
      message: "The text provider request failed with HTTP 500. Check the provider endpoint and server logs.",
      errorMessage: "The text provider request failed with HTTP 500. Check the provider endpoint and server logs."
    });
    expect(persisted.message.length).toBeLessThanOrEqual(500);
    expect(JSON.stringify({ progressUpdates, errorLogs: errorLogCalls })).not.toContain(privateMarker);
    expect(JSON.stringify({ progressUpdates, errorLogs: errorLogCalls })).not.toContain("PRIVATE_WORLD_PROMPT");
  });
});
