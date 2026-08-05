import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { logger } from "../../packages/logger/src/index.js";
import { ProviderDestinationNotAllowedError } from "../../packages/security/src/provider-network-policy.js";
import { ProviderResponseTooLargeError } from "../../packages/story-engine/src/provider-response.js";
import {
  ProviderTransportError,
  type ProviderRequest,
  type ProviderResult
} from "../../packages/story-engine/src/providers.js";
import {
  generatedWorldProviderError,
  generateTemplateWorld,
  generateWorldPreviewForOwner,
  incompleteGeneratedCharacterError,
  incompleteGeneratedWorldError,
  type TemplateWorldGenerationDependencies,
  type WorldGenerationProviderDependencies,
  worldGenerationFailureDiagnostic
} from "../../services/runtime/src/provider-world-generation-adapter.js";

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
  const seedMatch = /^Character (\d+)$/.exec(name);
  return {
    id: seedMatch ? `seed-${seedMatch[1]}` : `provider-${name.toLocaleLowerCase().replaceAll(" ", "-")}`,
    name,
    character_text: `${name} follows roads that move beneath moonlight.`,
    profile: profile(),
    rpg_statistics: [],
    default_triggers: []
  };
}

function seed(index: number) {
  return {
    id: `seed-${index}`,
    name: `Character ${index}`,
    role: `Role ${index}`,
    concept: `Concept ${index}`,
    narrative_hook: `Hook ${index}`
  };
}

function worldDraftResponse(seedCount = 3): string {
  return JSON.stringify({
    title: "The Moving Roads",
    genre: "Weird fantasy",
    tone: "Hopeful",
    backgroundStory: "Cartographers once governed the coast.",
    premise: "Roads rearrange beneath moonlight.",
    firstAction: "A forbidden road appears outside the city.",
    story_rules: "Every road remembers its maker.",
    character_seeds: Array.from({ length: seedCount }, (_, index) => seed(index + 1)),
    rpg_statistics: [],
    default_triggers: [],
    event_triggers: []
  });
}

function worldDraftResponseWithTitle(title: string, seedCount = 3): string {
  const world = JSON.parse(worldDraftResponse(seedCount)) as Record<string, unknown>;
  world.title = title;
  return JSON.stringify(world);
}

function providerResult(
  content: string,
  responseId = "response-id",
  override: Partial<ProviderResult> = {}
): ProviderResult {
  return {
    content,
    responseId,
    finishReason: "stop",
    outputLimited: false,
    modelInstanceId: "model-instance",
    usage: { inputTokens: 100, outputTokens: 200, totalTokens: 300 },
    reportedCost: null,
    rawMetadata: {},
    ...override
  };
}

function generationHarness(outcomes: Array<ProviderResult | Error>) {
  const requests: ProviderRequest[] = [];
  const progressUpdates: Array<{ phase: string; percent: number; message: string }> = [];
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
    progressUpdates,
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
      async (phase, percent, message) => {
        progressUpdates.push({ phase, percent, message });
      },
      dependencies
    )
  };
}

describe("generateTemplateWorld orchestration", () => {
  it("generates one world and one sequential profile for each seed", async () => {
    const harness = generationHarness([
      providerResult(worldDraftResponse(3), "world-response"),
      providerResult(JSON.stringify(character("Character 1")), "character-1"),
      providerResult(JSON.stringify(character("Character 2")), "character-2"),
      providerResult(JSON.stringify(character("Character 3")), "character-3")
    ]);

    const generated = await harness.run();

    expect(generated.content.playableCharacters).toHaveLength(3);
    expect(harness.requests).toHaveLength(4);
    expect(harness.requests[0]?.systemPrompt).toContain("character_seeds");
    for (const [index, request] of harness.requests.slice(1).entries()) {
      const input = JSON.parse(request.input);
      expect(input.seed.name).toBe(`Character ${index + 1}`);
      expect(input.world).toMatchObject({
        title: "The Moving Roads",
        premise: "Roads rearrange beneath moonlight."
      });
      expect(input.otherSeeds).toHaveLength(2);
      expect(input.acceptedCharacterNames).toEqual(
        Array.from({ length: index }, (_, accepted) => `Character ${accepted + 1}`)
      );
    }
  });

  it("generates four profiles when the world returns four seeds", async () => {
    const harness = generationHarness([
      providerResult(worldDraftResponse(4)),
      ...[1, 2, 3, 4].map((index) => providerResult(JSON.stringify(character(`Character ${index}`))))
    ]);

    await expect(harness.run()).resolves.toMatchObject({
      content: { playableCharacters: expect.arrayContaining([
        expect.objectContaining({ name: "Character 4" })
      ]) }
    });
    expect(harness.requests).toHaveLength(5);
  });

  it("does not log provider-controlled generated titles", async () => {
    const marker = "PRIVATE_GENERATED_TITLE_MARKER";
    const debugLog = vi.spyOn(logger, "debug").mockImplementation(() => undefined);
    const infoLog = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    let logCalls: unknown[][] = [];
    const harness = generationHarness([
      providerResult(worldDraftResponseWithTitle(marker)),
      ...[1, 2, 3].map((index) => providerResult(JSON.stringify(character(`Character ${index}`))))
    ]);

    try {
      const generated = await harness.run();
      expect(generated.title).toBe(marker);
    } finally {
      logCalls = [...debugLog.mock.calls, ...infoLog.mock.calls];
      debugLog.mockRestore();
      infoLog.mockRestore();
    }

    expect(JSON.stringify(logCalls)).not.toContain(marker);
  });

  it("recovers an invalid world before starting character generation", async () => {
    const harness = generationHarness([
      providerResult('{"title":"partial"', "partial-world", { finishReason: "length", outputLimited: true }),
      providerResult(worldDraftResponse(3), "recovered-world"),
      ...[1, 2, 3].map((index) => providerResult(JSON.stringify(character(`Character ${index}`))))
    ]);

    await harness.run();

    expect(harness.requests[1]).toMatchObject({
      previousResponseId: "partial-world",
      rejectedResponse: '{"title":"partial"',
      recoveryInput: expect.stringContaining("complete replacement")
    });
  });

  it("recovers only the failed character seed", async () => {
    const harness = generationHarness([
      providerResult(worldDraftResponse(3)),
      providerResult(JSON.stringify(character("Character 1"))),
      providerResult('{"id":"seed-2","name":"Character 2"', "partial-character", {
        finishReason: "length",
        outputLimited: true
      }),
      providerResult(JSON.stringify(character("Character 2")), "recovered-character"),
      providerResult(JSON.stringify(character("Character 3")))
    ]);

    const generated = await harness.run();

    expect(generated.content.playableCharacters.map((entry) => entry.name)).toEqual([
      "Character 1",
      "Character 2",
      "Character 3"
    ]);
    expect(harness.requests[3]).toMatchObject({
      previousResponseId: "partial-character",
      rejectedResponse: '{"id":"seed-2","name":"Character 2"',
      recoveryInput: expect.stringContaining("complete replacement")
    });
    expect(harness.requests).toHaveLength(5);
  });

  it("recovers duplicate seeds before character generation", async () => {
    const harness = generationHarness([
      providerResult(JSON.stringify({
        ...JSON.parse(worldDraftResponse(3)),
        character_seeds: [seed(1), seed(1), seed(3)]
      })),
      providerResult(worldDraftResponse(3)),
      ...[1, 2, 3].map((index) => providerResult(JSON.stringify(character(`Character ${index}`))))
    ]);

    await expect(harness.run()).resolves.toBeDefined();
    expect(harness.requests).toHaveLength(5);
  });

  it.each([
    ["character_seeds", []],
    ["character_seeds", null],
    ["character_seeds", {}],
    ["characterSeeds", []],
    ["characterSeeds", null],
    ["characterSeeds", {}]
  ])("recovers an explicitly invalid %s value before deriving legacy characters", async (seedKey, seedValue) => {
    const draft = JSON.parse(worldDraftResponse(3)) as Record<string, unknown>;
    if (seedKey === "characterSeeds") delete draft.character_seeds;
    draft[seedKey] = seedValue;
    const harness = generationHarness([
      providerResult(JSON.stringify({
        ...draft,
        playable_characters: [
          character("Legacy Character 1"),
          character("Legacy Character 2"),
          character("Legacy Character 3")
        ]
      }), "invalid-seeds"),
      providerResult(worldDraftResponse(3), "recovered-world"),
      ...[1, 2, 3].map((index) => providerResult(JSON.stringify(character(`Character ${index}`))))
    ]);

    await expect(harness.run()).resolves.toBeDefined();

    expect(harness.requests[1]).toMatchObject({
      previousResponseId: "invalid-seeds"
    });
    expect(harness.requests).toHaveLength(5);
  });

  it("returns a typed safe 502 when a character remains incomplete after recovery", async () => {
    const harness = generationHarness([
      providerResult(worldDraftResponse(3)),
      providerResult(JSON.stringify(character("Character 1"))),
      providerResult('{"name":"Character 2"}', "invalid-2"),
      providerResult('{"name":"Character 2"}', "invalid-2-recovery")
    ]);

    await expect(harness.run()).rejects.toMatchObject({
      statusCode: 502,
      expose: true,
      details: {
        code: "incomplete_generated_character",
        characterIndex: 1,
        seedName: "Character 2"
      }
    });
    expect(harness.requests).toHaveLength(4);
  });

  it.each([
    ["missing ID", { ...character("Character 2"), id: "" }],
    ["mismatched ID", { ...character("Character 2"), id: "other-seed" }],
    ["mismatched name", { ...character("Different Character"), id: "seed-2" }]
  ])("recovers and rejects a child profile with a $label", async (_label, invalidCharacter) => {
    const harness = generationHarness([
      providerResult(worldDraftResponse(3)),
      providerResult(JSON.stringify(character("Character 1"))),
      providerResult(JSON.stringify(invalidCharacter), "invalid-character"),
      providerResult(JSON.stringify(invalidCharacter), "invalid-character-recovery")
    ]);

    await expect(harness.run()).rejects.toMatchObject({
      statusCode: 502,
      expose: true,
      details: {
        code: "incomplete_generated_character",
        characterIndex: 1,
        seedName: "Character 2"
      }
    });
    expect(harness.requests[3]).toMatchObject({
      previousResponseId: "invalid-character",
      rejectedResponse: JSON.stringify(invalidCharacter)
    });
  });

  it("reports sequential character and recovery progress", async () => {
    const harness = generationHarness([
      providerResult(worldDraftResponse(3)),
      providerResult(JSON.stringify(character("Character 1"))),
      providerResult('{"name":"Character 2"}', "invalid-2"),
      providerResult(JSON.stringify(character("Character 2"))),
      providerResult(JSON.stringify(character("Character 3")))
    ]);

    await harness.run();

    expect(harness.progressUpdates).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: "generating_world" }),
      expect.objectContaining({ phase: "generating_character", message: expect.stringContaining("1 of 3") }),
      expect.objectContaining({ phase: "generating_character", message: expect.stringContaining("2 of 3") }),
      expect.objectContaining({ phase: "generating_character", message: expect.stringContaining("3 of 3") }),
      expect.objectContaining({ phase: "recovering_character" }),
      expect.objectContaining({ phase: "formatting" }),
      expect.objectContaining({ phase: "completed", percent: 100 })
    ]));
  });

  it("replaces provider HTTP failures with a safe categorized error", async () => {
    const marker = "SECRET_AT_START_OF_429_BODY";
    const providerError = Object.assign(new Error(`Provider request failed (429): ${marker}`), {
      statusCode: 429,
      providerMessage: marker
    });
    const harness = generationHarness([providerError]);

    let thrown: unknown;
    try {
      await harness.run();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).not.toBe(providerError);
    expect(thrown).toMatchObject({
      name: "WorldGenerationProviderError",
      message: "The text provider request failed with HTTP 429.",
      statusCode: 429,
      expose: true,
      code: "provider_http_error",
      details: {
        code: "provider_http_error",
        category: "http",
        providerStatus: 429
      }
    });
    expect(thrown).not.toHaveProperty("cause");
    expect(JSON.stringify(thrown)).not.toContain(marker);
    expect(harness.requests).toHaveLength(1);
  });

  it("replaces provider transport failures with a safe distinct category", async () => {
    const marker = "SECRET_AT_START_OF_TRANSPORT_CAUSE";
    const providerError = new ProviderTransportError(
      marker,
      {
        providerType: "lmstudio",
        operation: "story generation",
        endpoint: "http://lmstudio.test/v1/responses",
        model: "test-model",
        timeoutMs: 300_000,
        durationMs: 75,
        timedOut: false,
        transportCode: "ECONNRESET",
        causeCategory: "network",
        causeMessage: "The provider connection failed."
      }
    );
    const harness = generationHarness([providerError]);

    let thrown: unknown;
    try {
      await harness.run();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).not.toBe(providerError);
    expect(thrown).toMatchObject({
      name: "WorldGenerationProviderError",
      message: "The text provider connection failed.",
      code: "provider_transport_error",
      statusCode: 502,
      expose: true,
      details: {
        code: "provider_transport_error",
        category: "transport"
      }
    });
    expect(thrown).not.toHaveProperty("cause");
    expect(JSON.stringify(thrown)).not.toContain(marker);
    expect(harness.requests).toHaveLength(1);
  });

  it.each([
    {
      label: "destination policy",
      rawError: () => new ProviderDestinationNotAllowedError("address"),
      expected: {
        name: "ProviderDestinationNotAllowedError",
        message: "The provider destination is not allowed by the server network policy.",
        statusCode: 422,
        code: "PROVIDER_DESTINATION_NOT_ALLOWED",
        details: {
          code: "PROVIDER_DESTINATION_NOT_ALLOWED",
          category: "destination",
          permanent: true,
          retryable: false
        }
      }
    },
    {
      label: "response size",
      rawError: () => new ProviderResponseTooLargeError(4 * 1024 * 1024),
      expected: {
        name: "ProviderResponseTooLargeError",
        message: "The provider response exceeded the server's safe size limit.",
        statusCode: 502,
        code: "provider_response_too_large",
        details: {
          code: "provider_response_too_large",
          category: "response_limit",
          permanent: true,
          retryable: false
        }
      }
    }
  ])("preserves the safe typed $label boundary without retaining private data", async ({ rawError, expected }) => {
    const marker = "SECRET_AT_START_OF_TYPED_PROVIDER_FAILURE";
    const providerError = Object.assign(rawError(), {
      cause: new Error(`${marker}: private cause`),
      providerMessage: `${marker}: private provider body`,
      prompt: `${marker}: private prompt`,
      credentials: `${marker}: private credentials`
    });
    const harness = generationHarness([providerError]);

    let thrown: unknown;
    try {
      await harness.run();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).not.toBe(providerError);
    expect(thrown).toMatchObject({
      ...expected,
      expose: true,
      permanent: true,
      retryable: false
    });
    expect(thrown).not.toHaveProperty("cause");
    expect(JSON.stringify(thrown)).not.toContain(marker);
    expect(harness.requests).toHaveLength(1);
  });

  it("logs validation metadata from the response that produced each failing stage", async () => {
    const malformedInitial = generationHarness([
      providerResult("{", "initial-response"),
      providerResult("{", "recovery-response")
    ]);
    const malformedCharacter = generationHarness([
      providerResult(worldDraftResponse(3), "initial-response"),
      providerResult(JSON.stringify(character("Character 1"))),
      providerResult("{", "character-response"),
      providerResult("{", "character-recovery-response")
    ]);
    const warnLog = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const errorLog = vi.spyOn(logger, "error").mockImplementation(() => undefined);

    try {
      await expect(malformedInitial.run()).rejects.toMatchObject({ statusCode: 502 });
      expect(warnLog.mock.calls.at(-1)?.[0]).toMatchObject({ responseId: "initial-response" });
      expect(errorLog.mock.calls.at(-1)?.[0]).toMatchObject({ responseId: "recovery-response" });

      await expect(malformedCharacter.run()).rejects.toMatchObject({ statusCode: 502 });
      expect(errorLog.mock.calls.at(-1)?.[0]).toMatchObject({ responseId: "character-recovery-response" });
    } finally {
      warnLog.mockRestore();
      errorLog.mockRestore();
    }
  });
});

describe("generateWorldPreview provider failures", () => {
  it("maps incomplete child profiles to a safe preview diagnostic", () => {
    expect(worldGenerationFailureDiagnostic(
      incompleteGeneratedCharacterError(1, "Character 2")
    )).toEqual({
      message: "The text provider did not return a complete character profile. Review the missing fields and try again.",
      statusCode: 502,
      code: "incomplete_generated_character"
    });
  });

  it("logs only bounded projected generated-world issue fields", async () => {
    const marker = "PRIVATE_OVERSIZED_LOG_ISSUE";
    const generatedError = incompleteGeneratedWorldError(new z.ZodError([{
      path: [`world.${"p".repeat(500)}${marker}`],
      code: `${"c".repeat(100)}${marker}` as "custom",
      message: `${"m".repeat(500)}${marker}`
    }]));
    const dependencies = {
      resolveEffectiveProviderId: async () => "provider-id",
      createWorldGenerationProgress: async () => undefined,
      updateWorldGenerationProgress: async () => undefined,
      generateTemplateWorld: async () => {
        throw generatedError;
      }
    } as unknown as WorldGenerationProviderDependencies;
    const errorLog = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    let errorLogCalls: unknown[][] = [];

    try {
      await generateWorldPreviewForOwner(
        {} as never,
        "owner-id",
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
        causeCategory: "network",
        causeMessage: "The provider connection failed."
      }
    );

    const diagnostic = worldGenerationFailureDiagnostic(error);

    expect(diagnostic).toEqual({
      message: "The text provider connection failed. Check the provider endpoint and server logs.",
      statusCode: 502,
      code: "provider_transport_error"
    });
    expect(JSON.stringify(diagnostic)).not.toContain(privateMarker);
  });

  it("logs and persists a bounded safe categorized provider diagnostic", async () => {
    const privateMarker = "PRIVATE_PROVIDER_BODY_AND_LORE";
    const providerError = Object.assign(
      new Error(`Provider request failed (500): ${privateMarker}${"x".repeat(2_000)}`),
      {
        statusCode: 500,
        providerMessage: `${privateMarker}${"x".repeat(2_000)}`
      }
    );
    const safeProviderError = generatedWorldProviderError(providerError);
    const progressUpdates: unknown[] = [];
    const dependencies = {
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
        throw safeProviderError;
      }
    } as unknown as WorldGenerationProviderDependencies;
    const errorLog = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    let errorLogCalls: unknown[][] = [];

    let thrown: unknown;
    try {
      await generateWorldPreviewForOwner(
        {} as never,
        "owner-id",
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

    expect(thrown).toBe(safeProviderError);
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

  it.each([
    {
      label: "destination policy",
      rawError: () => new ProviderDestinationNotAllowedError("redirect"),
      expectedStatus: 422,
      expectedCode: "PROVIDER_DESTINATION_NOT_ALLOWED",
      expectedMessage: "The provider destination is not allowed by the server network policy."
    },
    {
      label: "response size",
      rawError: () => new ProviderResponseTooLargeError(4 * 1024 * 1024),
      expectedStatus: 502,
      expectedCode: "provider_response_too_large",
      expectedMessage: "The provider response exceeded the server's safe size limit."
    }
  ])("keeps $label preview logs and progress typed, static, and private", async ({
    rawError,
    expectedStatus,
    expectedCode,
    expectedMessage
  }) => {
    const marker = "SECRET_AT_START_OF_PREVIEW_FAILURE";
    const safeProviderError = generatedWorldProviderError(Object.assign(rawError(), {
      cause: new Error(`${marker}: private cause`),
      providerMessage: `${marker}: private provider body`,
      prompt: `${marker}: private lore`,
      credentials: `${marker}: private credentials`
    }));
    const progressUpdates: unknown[] = [];
    const dependencies = {
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
        throw safeProviderError;
      }
    } as unknown as WorldGenerationProviderDependencies;
    const errorLog = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    let errorLogCalls: unknown[][] = [];
    let thrown: unknown;

    try {
      await generateWorldPreviewForOwner(
        {} as never,
        "owner-id",
        {
          title: "The Moving Roads",
          prompt: `${marker}: PRIVATE_WORLD_PROMPT`,
          progressKey: "world-gen:typed-provider-failure"
        },
        `${marker}: credential-secret`,
        dependencies
      );
    } catch (error) {
      thrown = error;
    } finally {
      errorLogCalls = [...errorLog.mock.calls];
      errorLog.mockRestore();
    }

    expect(thrown).toBe(safeProviderError);
    expect(thrown).toMatchObject({
      statusCode: expectedStatus,
      code: expectedCode,
      permanent: true,
      retryable: false
    });
    expect(progressUpdates.at(-1)).toMatchObject({
      status: "failed",
      phase: "failed",
      message: expectedMessage,
      errorMessage: expectedMessage
    });
    expect(errorLogCalls.at(-1)?.[0]).toMatchObject({
      statusCode: expectedStatus,
      code: expectedCode
    });
    expect(JSON.stringify({ thrown, progressUpdates, errorLogCalls })).not.toContain(marker);
  });
});
